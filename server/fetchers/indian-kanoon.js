// Indian Kanoon — court judgment search across all Indian courts.
//
// Two modes (automatic fallback):
//   1. API mode  — set env INDIAN_KANOON_KEY (paid plan, free developer credits
//                  on signup at https://api.indiankanoon.org/). Structured JSON,
//                  fast, reliable. One credit consumed per search.
//   2. Web mode  — no key needed. Scrapes indiankanoon.org search HTML directly.
//                  Completely free, no registration. ~1 req per politician, with
//                  a short polite delay. Falls back automatically when no key set.
//
// Either way, GLM gets case titles, courts, dates, and snippet text. On top of
// the search snippets we then open the top-N judgments and pull their FULL body
// text (bounded by INDIAN_KANOON_FULLTEXT_LIMIT, default 4), so the downstream
// `indian_kanoon` extractor has real judgment prose — not just a ~320-char
// headline — to match politician names against. Full-text fetching is best
// effort: any failure silently falls back to the snippet-only line, and a total
// failure reproduces the original search-only output exactly.

import { fetchText, fetchJsonEx, htmlToText, mapLimit, sleep , TIMEOUT_SLOW } from "./http.js";
import { logger } from "../util/log.js";

const log = logger("indian-kanoon");

const IK_API = "https://api.indiankanoon.org/search/";
const IK_WEB = "https://indiankanoon.org/search/";
const IK_DOC_API = "https://api.indiankanoon.org/doc/"; // + <tid>/
const UA = "PandorosBox/0.1 (public-accountability research)";

// How many of the top search hits to open for full body text. Default 4; set
// INDIAN_KANOON_FULLTEXT_LIMIT=0 to disable full-text fetching entirely.
function fulltextLimit() {
  const n = parseInt(process.env.INDIAN_KANOON_FULLTEXT_LIMIT ?? "", 10);
  return Number.isInteger(n) && n >= 0 ? n : 4;
}

export async function fetchIndianKanoon(p) {
  const key = process.env.INDIAN_KANOON_KEY;
  return key ? fetchViaApi(p, key) : fetchViaWeb(p);
}

async function fetchViaApi(p, key) {
  const body = new URLSearchParams({ formInput: `"${p.name}" doctypes:judgments`, pagenum: "0" });
  const r = await fetchJsonEx(IK_API, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    log.warn({ url: IK_API, status: r.status, err: r.error?.message }, "kanoon search failed");
    return [];
  }
  const data = r.data;

  const docs = data?.docs ?? [];
  if (!docs.length) return [];

  const top = docs.slice(0, 8);
  const lines = top.map((d) => {
    const court = d.docsource ?? "court";
    const date = d.publishdate ? ` (${d.publishdate})` : "";
    const snippet = (d.headline ?? "").slice(0, 300);
    return `• [${court}${date}] ${d.title}: ${snippet}`;
  });

  // Open each of the top-N judgments via the doc API and append its body text.
  const merged = await enrichWithFullText(lines, top, (d) => fetchDocApi(d.tid, key));
  return [makeResult(p, docs.length, merged)];
}

async function fetchViaWeb(p) {
  const searchUrl = `${IK_WEB}?formInput=${encodeURIComponent(`"${p.name}" doctypes:judgments`)}`;
  let html;
  try {
    html = await fetchText(searchUrl, { timeoutMs: TIMEOUT_SLOW });
  } catch { return []; }

  // Real results live in <div class="result_title"><a href="/docfragment/NUM/…">
  // Title</a></div>, followed by a snippet block. (The old parser matched bare
  // /doc/ links — those are citation/UI elements, which is why it returned the
  // "Full Document Search within these results" junk.) We anchor on result_title.
  const results = [];
  const titlePattern = /class="result_title">\s*<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(titlePattern)) {
    let href = m[1];
    if (href.startsWith("/")) href = "https://indiankanoon.org" + href;
    href = href.split("?")[0]; // drop the formInput query
    const rawTitle = m[2].replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    if (!rawTitle || rawTitle.length < 5) continue;
    // Title usually ends "… on 30 September, 2013" — split off the date.
    const dm = rawTitle.match(/\son\s+(\d{1,2}\s+\w+,?\s+\d{4})\s*$/i);
    const title = dm ? rawTitle.slice(0, dm.index).trim() : rawTitle;
    const date = dm ? dm[1] : "";
    // Snippet: the text block that follows this result_title, tags stripped.
    const ctx = html.slice(m.index + m[0].length, m.index + m[0].length + 700)
      .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ").trim().slice(0, 320);
    results.push({ href, title, date, ctx });
    if (results.length >= 8) break;
  }

  if (!results.length) return [];

  const lines = results.map((r) => `• ${r.title}${r.date ? ` (${r.date})` : ""}${r.ctx ? `\n    ${r.ctx}` : ""}\n    ${r.href}`);

  // Open each of the top-N judgment pages and append the body text.
  const merged = await enrichWithFullText(lines, results, (r) => fetchDocWeb(r.href));
  return [makeResult(p, results.length, merged, true)];
}

// ── Full-text enrichment ────────────────────────────────────────────────────

// PURE (no network). Merge fetched judgment bodies into the formatted result
// lines. `lines` are the snippet lines already built by either mode; `bodies` is
// a parallel array of full-text strings ("" / null / undefined where a fetch was
// skipped or failed). Only the first `limit` lines receive a body — this both
// bounds cost upstream and makes the cap unit-testable here. Each incorporated
// body is whitespace-collapsed and trimmed to `excerptLen` chars, appended as a
// "Full text: …" line. Lines without a usable body are returned unchanged, so a
// total fetch failure reproduces the original snippet-only output exactly.
export function mergeFullText(lines, bodies = [], { limit = 4, excerptLen = 1500 } = {}) {
  return lines.map((line, i) => {
    if (i >= limit) return line;
    const body = String(bodies?.[i] ?? "").replace(/\s+/g, " ").trim();
    if (!body) return line;
    return `${line}\n    Full text: ${body.slice(0, excerptLen)}`;
  });
}

// Bounded, fail-safe full-text enrichment shared by both modes. Returns the
// original `lines` untouched when the limit is 0 or anything throws, so the
// caller's evidence row matches the pre-enrichment behaviour exactly. Never
// throws.
async function enrichWithFullText(lines, targets, fetchOne) {
  const limit = fulltextLimit();
  if (limit <= 0) return lines;
  try {
    const bodies = await fetchBodies(targets, limit, fetchOne);
    return mergeFullText(lines, bodies, { limit });
  } catch {
    return lines;
  }
}

// Fetch up to `limit` judgment bodies with bounded concurrency (3) and a polite
// 700ms delay between a worker's fetches. `fetchOne(target)` returns body text,
// or "" on failure. Per-target failures collapse to "" and never propagate.
async function fetchBodies(targets, limit, fetchOne) {
  const pick = targets.slice(0, Math.max(0, limit));
  if (!pick.length) return [];
  return mapLimit(pick, 3, async (t, i) => {
    if (i > 0) await sleep(700); // polite spacing between fetches
    try { return await fetchOne(t); } catch { return ""; }
  });
}

// API mode: POST the doc endpoint for a judgment `tid`; its JSON carries the
// judgment HTML in `doc`. Returns readable body text, "" on any failure.
async function fetchDocApi(tid, key) {
  if (tid === undefined || tid === null || tid === "") return "";
  const r = await fetchJsonEx(`${IK_DOC_API}${tid}/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (!r.ok) {
    log.warn({ tid, status: r.status, err: r.error?.message }, "kanoon doc fetch failed");
    return "";
  }
  const rawHtml = r.data?.doc ?? r.data?.content ?? "";
  return htmlToText(rawHtml, 6000);
}

// Web mode: fetch the judgment page and reduce it to plain body text. Returns
// "" on any failure (fetchText already fails soft to "").
async function fetchDocWeb(href) {
  if (!href) return "";
  const html = await fetchText(href, { timeoutMs: TIMEOUT_SLOW });
  return htmlToText(html, 6000);
}

function makeResult(p, count, lines, isWebScrape = false) {
  return {
    politician_id: p.id,
    source_type: "indian_kanoon",
    tier: 4,
    admissible: true,
    title: `Indian Kanoon court judgments — ${p.name}`,
    url: `${IK_WEB}?formInput=${encodeURIComponent(`"${p.name}"`)}`,
    date: null,
    summary: `Indian Kanoon returned ${count} judgment(s) matching "${p.name}"${isWebScrape ? " (web search)" : " (API)"}. Cross-check that the party named is this politician before drawing conclusions.`,
    content: `Court judgment matches for "${p.name}" via Indian Kanoon (verify identity):\n${lines.join("\n")}`,
  };
}
