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
// Either way, GLM gets case titles, courts, dates, and snippet text.

import { fetchText } from "./http.js";

const IK_API = "https://api.indiankanoon.org/search/";
const IK_WEB = "https://indiankanoon.org/search/";

export async function fetchIndianKanoon(p) {
  const key = process.env.INDIAN_KANOON_KEY;
  return key ? fetchViaApi(p, key) : fetchViaWeb(p);
}

async function fetchViaApi(p, key) {
  let data;
  try {
    const body = new URLSearchParams({ formInput: `"${p.name}" doctypes:judgments`, pagenum: "0" });
    const res = await fetch(IK_API, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "User-Agent": "PandorosBox/0.1 (public-accountability research)",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch { return []; }

  const docs = data?.docs ?? [];
  if (!docs.length) return [];

  const lines = docs.slice(0, 8).map((d) => {
    const court = d.docsource ?? "court";
    const date = d.publishdate ? ` (${d.publishdate})` : "";
    const snippet = (d.headline ?? "").slice(0, 300);
    return `• [${court}${date}] ${d.title}: ${snippet}`;
  });

  return [makeResult(p, docs.length, lines)];
}

async function fetchViaWeb(p) {
  const searchUrl = `${IK_WEB}?formInput=${encodeURIComponent(`"${p.name}" doctypes:judgments`)}`;
  let html;
  try {
    html = await fetchText(searchUrl, { timeoutMs: 25000 });
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
  return [makeResult(p, results.length, lines, true)];
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
