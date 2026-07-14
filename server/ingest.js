// Evidence ingestion: pulls every configured source for each politician and
// stores deduplicated evidence rows. Run manually (`npm run ingest`) or it is
// invoked automatically before each weekly report generation.
//
// Sources are split into:
//   • link/pointer sources  → officialSourceLinks, archiveLinks (no content)
//   • real-content fetchers → everything else (return a `content` field GLM reads)
// Content fetchers degrade gracefully: missing API keys or network failures
// just yield [] and never break ingest.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { listPoliticians, addEvidence, recordFetchRun } from "./store.js";
import { dataGovKey } from "./config.js";
import { fetchText, htmlToText, fetchPdfText, UA, fetchJson, sleep, mapLimit, isPdf } from "./fetchers/http.js";
import { fetchMyNetaProfile } from "./sources/myneta-full.js";
import { fetchWikipedia } from "./sources/wikipedia.js";
import { fetchNews } from "./sources/news.js";
import { enrichNewsBodies } from "./fetchers/article-body.js";
import { fetchPressReleases } from "./fetchers/press-releases.js";
import { fetchIndianKanoon } from "./fetchers/indian-kanoon.js";
import { fetchICIJ } from "./fetchers/icij.js";
import { fetchSEBIOrders } from "./fetchers/sebi-orders.js";
import { fetchSansadMP } from "./fetchers/sansad-mp.js";
import { fetchElectionExpenditure } from "./fetchers/election-expenditure.js";
import { fetchPartyFunding } from "./fetchers/party-funding.js";
import { fetchMPLADS } from "./fetchers/mplads.js";
import { fetchCPPPProcurement } from "./fetchers/cppp-procurement.js";
import { fetchMultilingualNews } from "./fetchers/news-multilingual.js";
import { fetchFactChecks } from "./fetchers/factcheck.js";
import { fetchWikidata } from "./fetchers/wikidata.js";
import { fetchCompanyRegistry } from "./fetchers/company-registry.js";
import { fetchPIBProjects } from "./fetchers/pib-projects.js";
import { fetchSECEdgar } from "./fetchers/sec-edgar.js";

// We ONLY ingest sources that return real, readable content (or news leads,
// whose headline IS the content). The old navigational "pointer" sources
// (officialSourceLinks, archiveLinks) — generic "search portal X for this name"
// URLs with no content — are gone: they were 59% of the DB, unreadable by GLM,
// and dishonestly inflated the "evidence retrieved" count.
// The source registry — every per-politician fetcher, one entry each. Restructured
// out of a bare 21-way Promise.all so the fan-out is bounded (mapLimit) and each
// fetcher's outcome is RECORDED (fetch_runs), not silently swallowed. Order here
// is preserved into the addEvidence() call below so dedup behaviour is unchanged.
export const FETCHERS = [
  { name: "myneta",               run: (p) => fetchMyNetaProfile(p) },      // FULL affidavit (cases, IPC sections, asset growth)
  { name: "wikipedia",            run: (p) => fetchWikipedia(p) },          // biographical/career narrative
  { name: "news",                 run: (p) => fetchNews(p) },               // GDELT headlines (English; 429-resilient)
  { name: "news_intl",            run: (p) => fetchMultilingualNews(p) },   // English + Hindi + state-language news (Google News RSS)
  { name: "press_releases",       run: (p) => fetchPressReleases(p) },      // ED/CBI listing + linked full releases (PDF-aware)
  { name: "indian_kanoon",        run: (p) => fetchIndianKanoon(p) },       // court judgment excerpts (API key OR free web scrape)
  { name: "icij",                 run: (p) => fetchICIJ(p) },               // ICIJ offshore leaks (free, no key)
  { name: "sebi",                 run: (p) => fetchSEBIOrders(p) },         // SEBI enforcement orders (free, no key)
  // NOTE: no standalone "cag" fetcher — cag.gov.in/en/audit-report ignores the
  // ?title= query param server-side (verified: identical result set for any
  // query, including nonsense strings), so a per-politician live search is not
  // possible. CAG coverage instead comes from the bulk `cag-audit-index` L1
  // dataset below (crawls the full national report-title archive, matched
  // locally per politician — see L1_SOURCES).
  { name: "sansad",               run: (p) => fetchSansadMP(p) },           // FULL parliamentary record, MP/RS (sansad.in JSON API)
  { name: "election_expenditure", run: (p) => fetchElectionExpenditure(p) },// sworn campaign-spend declaration (MyNeta, free)
  { name: "party_funding",        run: (p) => fetchPartyFunding(p) },       // full party financials + donations (MyNeta, free)
  { name: "mplads",               run: (p) => fetchMPLADS(p) },             // MP fund sanctioned/released/utilised (MoSPI API, MP-only)
  { name: "cppp",                 run: (p) => fetchCPPPProcurement(p) },    // govt contracts award trail (local SQLite, env CPPP_DB_PATH)
  // NOTE: no "mca_directors" fetcher — there is NO freely-available MCA bulk
  // Director dataset (data.gov.in exposes Company Master Data, not directors).
  // Director NAMES come from the free Tofler path instead (server/tofler-enrich.js,
  // flag-triggered per company); company STATUS from `company_registry` below.
  { name: "factcheck",            run: (p) => fetchFactChecks(p) },         // fact-checks from Alt News/BOOM/Factly etc. (free)
  { name: "wikidata",             run: (p) => fetchWikidata(p) },           // structured named relatives + positions (free) → graph
  { name: "company_registry",     run: (p) => fetchCompanyRegistry(p) },    // MCA registry check of declared companies (status/CIN)
  { name: "sec_edgar",            run: (p) => fetchSECEdgar(p) },           // US SEC EDGAR full-text filing search (free, no key)
  { name: "pib_projects",         run: (p) => fetchPIBProjects(p) },        // PIB/ministry project announcements (free)
  { name: "l1_datasets",          run: (p) => fetchL1Datasets(p) },         // level-1 dataset sources (registry-driven, local cache)
  { name: "case_monitors",        run: (p) => fetchL1CaseMonitors(p) },     // P21 single-case monitors
];

// The registry's source names — the roster the health CLI checks for STALE
// (zero-run) sources against.
export const FETCHER_NAMES = FETCHERS.map((f) => f.name);

// Bounded, observed executor. Runs each fetcher through mapLimit(concurrency),
// records exactly one fetch_runs row per fetcher, and degrades a failure to []
// WITHOUT breaking ingestion. Returns [{ name, ok, items, result }] in registry
// order. Exported so tests can drive it with fake fetchers (no network).
export async function runFetchers(fetchers, p, { limit = 6 } = {}) {
  return await mapLimit(fetchers, limit, async (f) => {
    const t0 = Date.now();
    try {
      const result = await f.run(p);
      const items = Array.isArray(result) ? result.length : result == null ? 0 : 1;
      recordFetchRun({ source: f.name, politician_id: p?.id ?? null, ok: 1, items, ms: Date.now() - t0 });
      return { name: f.name, ok: true, items, result };
    } catch (err) {
      // A fetcher failure is degraded to [] so ingestion continues, but it is
      // RECORDED (message only) so the source can't rot silently.
      recordFetchRun({ source: f.name, politician_id: p?.id ?? null, ok: 0, items: 0, ms: Date.now() - t0, error: err?.message ?? String(err) });
      return { name: f.name, ok: false, items: 0, result: [] };
    }
  });
}

export async function ingestFor(p) {
  const results = await runFetchers(FETCHERS, p, { limit: 6 });
  const by = {};
  for (const r of results) by[r.name] = r.result;

  // Upgrade headline news → full article body text (free, no key; PDF-aware).
  // Enrichment of the news results, not a source of its own → not health-tracked.
  const newsBodies = await enrichNewsBodies([...(by.news ?? []), ...(by.news_intl ?? [])], { limit: 14 });

  // Same order (and same flatten) as the original bare Promise.all, so evidence
  // dedup/merge behaviour is byte-for-byte identical.
  const added = addEvidence([
    by.myneta, by.wikipedia, by.news, by.news_intl, newsBodies,
    by.press_releases, by.indian_kanoon, by.icij, by.sebi, by.sansad,
    by.election_expenditure, by.party_funding, by.mplads, by.cppp,
    by.factcheck, by.wikidata, by.company_registry, by.sec_edgar, by.pib_projects,
    by.l1_datasets, by.case_monitors,
  ].flat());
  // Report honestly: how much was actually RETRIEVED (real content or a news
  // lead) versus added at all — so the counts mean something.
  const withContent = added.filter((e) => e.content && String(e.content).length > 120).length;
  const newsLeads = added.filter((e) => !e.content && e.source_type === "news").length;
  return { total: added.length, withContent, newsLeads };
}

export async function ingestAll({ office, state, mps = false } = {}) {
  let list = listPoliticians().filter((p) => !p.is_demo);
  // mps = both houses (Lok Sabha MP + Rajya Sabha RS) in one run.
  if (mps)         list = list.filter((p) => p.office === "MP" || p.office === "RS");
  else if (office) list = list.filter((p) => p.office === office);
  if (state)  list = list.filter((p) => (p.state ?? "").toLowerCase() === state.toLowerCase());
  console.log(`[ingest] Running for ${list.length} politicians${office ? ` (office=${office})` : ""}${state ? ` (state=${state})` : ""}…`);
  await refreshL1Caches(); // download/refresh level-1 datasets once per run
  let total = 0, content = 0, noData = 0;
  for (const p of list) {
    const r = await ingestFor(p);
    total += r.total; content += r.withContent;
    const retrieved = r.withContent + r.newsLeads;
    if (retrieved === 0) noData++;
    console.log(`[ingest] ${p.name}: ${r.total} new (${r.withContent} with content, ${r.newsLeads} news leads${retrieved === 0 ? " — NO CONTENT RETRIEVED" : ""})`);
  }
  console.log(`[ingest] summary: ${content} content rows added; ${noData}/${list.length} reps got NO content this run.`);
  // NOTE: scandal discovery is NOT here — it is GLM-driven work and now runs as
  // part of the report generator (task #14), not the ingester.
  return total;
}

/* ============================================================================
 * LEVEL-1 DATASET SOURCES (registry-driven, cache-backed; PLAN-L1-FETCHERS.md)
 * One engine + config array. Refreshed once per ingest run; matched per
 * politician from local cache. No new files: everything lives here by design.
 * ==========================================================================*/
const L1_CACHE_DIR = path.join(process.cwd(), "server", "data", "l1-cache");
const L1_TTL_MS = 7 * 24 * 3600 * 1000;

const l1Path = (id) => { fs.mkdirSync(L1_CACHE_DIR, { recursive: true }); return path.join(L1_CACHE_DIR, `${id}.json`); };
function l1Read(id) { try { return JSON.parse(fs.readFileSync(l1Path(id), "utf8")); } catch { return null; } }
function l1Write(id, rows, meta = {}) { fs.writeFileSync(l1Path(id), JSON.stringify({ fetched_at: new Date().toISOString(), count: rows.length, ...meta, rows })); }

// Insecure buffer fetch for gov sites with broken TLS chains.
function l1FetchInsecure(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: UA, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
async function l1FetchBuffer(url, { insecure = false, timeoutMs = 60000 } = {}) {
  if (insecure) return l1FetchInsecure(url, timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

// Parse all <table>s in HTML → array of tables, each an array of cell-text rows.
function l1HtmlTables(html) {
  const tables = [];
  for (const t of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const tr of t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => htmlToText(m[1], 500));
      if (cells.some((c) => c)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// Minimal CSV parser (quoted fields, embedded commas/newlines).
function l1ParseCsv(text, maxRows = 200000) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  return rows;
}

let l1XlsxWarned = false, l1ZipWarned = false;
async function l1Xlsx() { try { return await import("xlsx"); } catch { if (!l1XlsxWarned) { console.warn("[l1] xlsx not installed — run: npm install xlsx"); l1XlsxWarned = true; } return null; } }
async function l1Zip()  { try { return await import("fflate"); } catch { if (!l1ZipWarned) { console.warn("[l1] fflate not installed — run: npm install fflate"); l1ZipWarned = true; } return null; } }

// v2: expand a cfg into its concrete URL list. Supports {page} ranges and
// {val} iteration (years, district slugs, sub-report paths).
function l1Urls(cfg) {
  if (cfg.iterate) return cfg.iterate.map((v) => cfg.url.replaceAll("{val}", String(v)));
  if (cfg.pages) { const out = []; for (let i = cfg.pages[0]; i <= cfg.pages[1]; i++) out.push(cfg.url.replaceAll("{page}", String(i))); return out; }
  return [cfg.url];
}
// v2: extract anchor rows [text, absoluteHref] from HTML; linkRe (string regex)
// keeps only matching hrefs (e.g. "\\.pdf$").
function l1AnchorRows(html, baseUrl, linkRe) {
  const rows = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = m[1];
    const text = htmlToText(m[2], 300);
    try { href = new URL(href, baseUrl).href; } catch { continue; }
    if (linkRe && !new RegExp(linkRe, "i").test(href)) continue;
    if (text || linkRe) rows.push([text, href]);
  }
  return rows;
}

// Download one source into cache. v2: multi-URL (pages/iterate), html-list,
// json-api. cfg: { id, url, format, insecure?, table?, sheet?, csvInZip?,
//                  maxRows?, pages?, iterate?, linkRe?, rowsPath?, apiKeyEnv?, delayMs? }
async function l1Refresh(cfg) {
  try {
    if (!cfg.format || !cfg.url) return { id: cfg.id, ok: false, why: "skipped/no url" };
    // Multi-page HTML formats accumulate rows across every expanded URL.
    if (cfg.format === "html-table" || cfg.format === "html-list") {
      const urls = l1Urls(cfg);
      const rows = []; let emptyStreak = 0;
      for (const u of urls) {
        const html = cfg.insecure ? (await l1FetchInsecure(u))?.toString("utf8") ?? "" : await fetchText(u, { timeoutMs: cfg.timeoutMs ?? 30000 });
        let pageRows = [];
        if (html) {
          if (cfg.format === "html-list") pageRows = l1AnchorRows(html, u, cfg.linkRe);
          else {
            const tables = l1HtmlTables(html);
            if (tables.length) pageRows = cfg.table != null ? (tables[cfg.table] ?? []) : tables.reduce((a, b) => (b.length > a.length ? b : a));
          }
        }
        if (!pageRows.length) { if (++emptyStreak >= 3) break; }
        else { emptyStreak = 0; rows.push(...(cfg.iterate ? pageRows.map((r) => [String(cfg.iterate[urls.indexOf(u)]), ...r]) : pageRows)); }
        if (urls.length > 1) await sleep(cfg.delayMs ?? 700); // politeness on multi-page
        if (rows.length >= (cfg.maxRows ?? 20000)) break;
      }
      if (!rows.length) return { id: cfg.id, ok: false, why: "no rows found" };
      // readBodies: for a PDF-INDEX source (html-list of PDF links), download the
      // linked PDFs and append each one's extracted body text as a 3rd cell, so a
      // politician named INSIDE a report — not just in its title — is matched. The
      // download is bounded (maxDocs) and reuses body text already in the prior
      // cache, so a weekly refresh only fetches genuinely-new documents. Scanned
      // PDFs are handled too — fetchPdfText OCRs them when PDF_OCR=1.
      const finalRows = cfg.readBodies ? await l1ReadBodies(cfg, rows) : rows;
      l1Write(cfg.id, finalRows, { url: cfg.url });
      return { id: cfg.id, ok: true, count: finalRows.length };
    }
    if (cfg.format === "json-api") {
      let u = cfg.url;
      if (cfg.apiKeyEnv) {
        let k = process.env[cfg.apiKeyEnv];
        if (!k && ["DATA_GOV_API_KEY", "DATA_GOV_KEY", "DATA_GOV_IN_KEY", "OGD_API_KEY"].includes(cfg.apiKeyEnv)) {
          k = dataGovKey();
        }
        if (!k) return { id: cfg.id, ok: false, why: `env ${cfg.apiKeyEnv} not set — skipped` };
        u = u.replaceAll("{key}", encodeURIComponent(k));
      }
      const data = await fetchJson(u, { timeoutMs: cfg.timeoutMs ?? 30000 });
      if (!data) return { id: cfg.id, ok: false, why: "fetch/parse failed" };
      let arr = data;
      for (const seg of (cfg.rowsPath ?? "").split(".").filter(Boolean)) arr = arr?.[seg];
      if (!Array.isArray(arr) || !arr.length) return { id: cfg.id, ok: false, why: `rowsPath '${cfg.rowsPath}' empty` };
      const rows = arr.slice(0, cfg.maxRows ?? 50000).map((o) =>
        Array.isArray(o) ? o.map(String) : Object.values(o).map((v) => typeof v === "object" ? JSON.stringify(v) : String(v)));
      l1Write(cfg.id, rows, { url: cfg.url });
      return { id: cfg.id, ok: true, count: rows.length };
    }
    if (cfg.format === "csv") {
      let buf = await l1FetchBuffer(cfg.url, cfg);
      if (!buf) return { id: cfg.id, ok: false, why: "fetch failed" };
      if (cfg.csvInZip) {
        const z = await l1Zip(); if (!z) return { id: cfg.id, ok: false, why: "fflate missing" };
        const files = z.unzipSync(new Uint8Array(buf));
        const name = Object.keys(files).find((n) => n.toLowerCase().includes(cfg.csvInZip.toLowerCase()) && n.endsWith(".csv"))
          ?? Object.keys(files).find((n) => n.endsWith(".csv"));
        if (!name) return { id: cfg.id, ok: false, why: "no csv in zip" };
        buf = Buffer.from(files[name]);
      }
      const rows = l1ParseCsv(buf.toString("utf8"), cfg.maxRows ?? 200000);
      l1Write(cfg.id, rows, { url: cfg.url });
      return { id: cfg.id, ok: true, count: rows.length };
    }
    if (cfg.format === "xlsx") {
      const buf = await l1FetchBuffer(cfg.url, cfg);
      if (!buf) return { id: cfg.id, ok: false, why: "fetch failed" };
      const X = await l1Xlsx(); if (!X) return { id: cfg.id, ok: false, why: "xlsx missing" };
      const wb = X.read(buf, { type: "buffer" });
      const sheet = cfg.sheet ?? wb.SheetNames[0];
      const rows = X.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: "" })
        .filter((r) => r.some((c) => String(c).trim() !== "")).slice(0, cfg.maxRows ?? 200000);
      l1Write(cfg.id, rows, { url: cfg.url, sheet });
      return { id: cfg.id, ok: true, count: rows.length };
    }
    if (cfg.format === "pdf") {
      let text;
      if (cfg.insecure) {
        const buf = await l1FetchInsecure(cfg.url);
        if (!buf) return { id: cfg.id, ok: false, why: "fetch failed" };
        try {
          const { PDFParse } = await import("pdf-parse");
          const parsed = await new PDFParse({ data: new Uint8Array(buf) }).getText();
          text = (parsed.text ?? "").replace(/\s+/g, " ").trim();
        } catch { return { id: cfg.id, ok: false, why: "pdf-parse failed" }; }
      } else text = await fetchPdfText(cfg.url, { maxLen: 100000 });
      if (!text) return { id: cfg.id, ok: false, why: "no text" };
      l1Write(cfg.id, [[text.slice(0, 60000)]], { url: cfg.url });
      return { id: cfg.id, ok: true, count: 1 };
    }
    return { id: cfg.id, ok: false, why: `unknown format ${cfg.format}` };
  } catch (e) { return { id: cfg.id, ok: false, why: e.message }; }
}

// readBodies helper: turn a list of [linkText, href] anchor rows into
// [linkText, href, bodyText] by downloading each linked PDF and extracting its
// text. Bounded by cfg.maxDocs; reuses body text from the previous cache (keyed
// by href) so a re-refresh only fetches new documents. Non-PDF hrefs are left
// body-less. fetchPdfText handles OCR for scanned PDFs (when PDF_OCR=1).
export async function l1ReadBodies(cfg, rows) {
  const prev = l1Read(cfg.id);
  const prevBody = new Map();
  for (const r of prev?.rows ?? []) if (r[1] && r[2]) prevBody.set(r[1], r[2]);
  const cap = cfg.maxDocs ?? 80;
  const docChars = cfg.docChars ?? 8000;
  const out = [];
  let fetched = 0;
  for (const r of rows) {
    const [text, href] = r;
    if (out.length && href && isPdf(href) && !prevBody.has(href) && fetched < cap) {
      // politeness gap before each genuine network fetch
      await sleep(cfg.delayMs ?? 700);
    }
    let body = "";
    if (href && isPdf(href)) {
      if (prevBody.has(href)) body = prevBody.get(href);
      else if (fetched < cap) { body = await fetchPdfText(href, { maxLen: docChars, timeoutMs: cfg.timeoutMs ?? 30000 }); fetched++; }
    }
    out.push(body ? [text, href, body] : [text, href]);
  }
  console.log(`[l1] ${cfg.id}: readBodies fetched ${fetched} new PDF bod${fetched === 1 ? "y" : "ies"} (${prevBody.size} reused)`);
  return out;
}

// Refresh ONE L1 source by id, ignoring TTL (targeted re-pull). `overrides`
// shallow-merge into the cfg — handy for a bounded test run (e.g. maxDocs:3).
// Returns the l1Refresh result, or { ok:false } for an unknown id.
export async function refreshL1Source(id, overrides = {}) {
  const cfg = L1_SOURCES.find((c) => c.id === id);
  if (!cfg) return { id, ok: false, why: "unknown id" };
  return await l1Refresh({ ...cfg, ...overrides });
}

// Refresh every stale/missing cache once per ingest run.
export async function refreshL1Caches() {
  for (const cfg of L1_SOURCES) {
    if (!cfg.format || !cfg.url) continue;
    const c = l1Read(cfg.id);
    if (c && Date.now() - Date.parse(c.fetched_at) < L1_TTL_MS) continue;
    const r = await l1Refresh(cfg);
    console.log(r.ok ? `[l1] ${cfg.id}: refreshed, ${r.count} rows` : `[l1] ${cfg.id}: refresh FAILED (${r.why})${c ? " — using stale cache" : ""}`);
  }
}

// Per-politician matching against cached datasets (local-only, no network).
const l1Norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Shared matcher: cfg supplies metadata, cache supplies rows. Used both for
// L1_SOURCES caches and for mega caches written by server/mega-ingest.js
// (mega caches embed their own cfg metadata under `meta`).
export function l1Match(cfg, cache, p) {
  if (!cache?.rows?.length || cfg.match === "none") return null;
  const needle = cfg.match === "party" ? l1Norm(p.party) : l1Norm(p.name);
  if (!needle || needle.length < 4) return null;
  const hits = cache.rows.filter((row) => l1Norm(row.join(" | ")).includes(needle));
  if (!hits.length) return null;
  // Display: short cells print in full; a long cell (a PDF body from readBodies)
  // is shown as a ~360-char window around the matched name, not its opening 160
  // chars — so the excerpt is the relevant passage, not the document's preamble.
  const snippetAround = (cell) => {
    const i = l1Norm(cell).indexOf(needle);
    if (i < 0) return String(cell).slice(0, 160);
    const raw = String(cell);
    return "…" + raw.slice(Math.max(0, i - 160), i + needle.length + 200).replace(/\s+/g, " ").trim() + "…";
  };
  const lines = hits.slice(0, 12).map((r) =>
    "• " + r.map((c) => (String(c).length > 200 ? snippetAround(c) : String(c).slice(0, 160))).join(" | "));
  return {
    politician_id: p.id,
    source_type: `l1_${cfg.id.replaceAll("-", "_")}`,
    tier: cfg.tier ?? 6,
    admissible: cfg.admissible ?? true,
    title: `${cfg.title} — ${cfg.match === "party" ? p.party : p.name}`,
    url: cfg.url ?? null,
    date: null,
    summary: cfg.summary,
    content: `${cfg.title} (${hits.length} matching row${hits.length > 1 ? "s" : ""}, dataset of ${cache.total ?? cache.count}):\n${lines.join("\n")}`,
  };
}

export function fetchL1Datasets(p) {
  const out = [];
  for (const cfg of L1_SOURCES) {
    if (!cfg.format) continue;
    const row = l1Match(cfg, l1Read(cfg.id), p);
    if (row) out.push(row);
  }
  // Mega caches (written manually via `node server/mega-ingest.js --refresh …`).
  // Each file is { fetched_at, count, total, meta: {id,title,summary,match,tier,url}, rows }
  // where rows are already pre-filtered to lines mentioning ANY politician.
  try {
    for (const f of fs.readdirSync(L1_CACHE_DIR).filter((n) => n.startsWith("mega-") && n.endsWith(".json"))) {
      const cache = JSON.parse(fs.readFileSync(path.join(L1_CACHE_DIR, f), "utf8"));
      if (!cache?.meta) continue;
      const row = l1Match(cache.meta, cache, p);
      if (row) out.push(row);
    }
  } catch { /* no mega caches yet — fine */ }
  return out;
}

// Single-case monitors (pattern P21): known article pages; emit a lead only
// when the politician is named. Secondary source → tier 4, not admissible.
const L1_CASE_MONITORS = [
  { id: "neet-2026", title: "2026 NEET-UG controversy / CBI investigation",
    url: "https://en.wikipedia.org/wiki/2026_NEET_controversy" },
  { id: "punjabi-univ-scholarship-scam", title: "Punjabi University UGC scholarship scam (Rs 14 cr, ED probe)",
    url: "https://www.tribuneindia.com/news/punjab/ed-seeks-land-records-in-rs-14-crore-ugc-scholarship-scam-probe/amp" },
  { id: "cbse-osm-2026", title: "CBSE OSM 2026 results scandal (vendor Coempt Edu Teck)",
    url: "https://theprobe.in/education/cbse-osm-result-2026-examination-failure-india-11891206" },
];
export async function fetchL1CaseMonitors(p) {
  const out = [];
  for (const c of L1_CASE_MONITORS) {
    try {
      const html = await fetchText(c.url, { timeoutMs: 15000 });
      if (!html) continue;
      const text = htmlToText(html, 30000);
      const i = text.toLowerCase().indexOf(p.name.toLowerCase());
      if (i < 0) continue;
      out.push({
        politician_id: p.id, source_type: "case_monitor", tier: 4, admissible: false,
        title: `${c.title} — mentions ${p.name}`, url: c.url, date: null,
        summary: "Ongoing-case monitor page mentions this politician; corroborate via court records before use.",
        content: `${c.title}: …${text.slice(Math.max(0, i - 800), i + 800)}…`,
      });
    } catch { /* fail soft */ }
  }
  return out;
}

const L1_SOURCES = [
  // ---- Batch A — static HTML tables (6) ----
  { id: "rbi-nbfc", title: "RBI Registered NBFCs (page index)", format: "html-table",
    url: "https://rbi.org.in/Scripts/BS_NBFCList.aspx", match: "name", tier: 6,
    summary: "RBI registry of NBFCs/ARCs incl. cancelled registrations — shadow-banking legitimacy check.",
    note: "Page links XLSX files. If the page table is just download links, find the .xlsx href in the HTML and add a second entry rbi-nbfc-xlsx with format:'xlsx' pointing at that file." },
  { id: "rec-banned", title: "REC List of Banned Firms", format: "html-table",
    url: "https://recindia.nic.in/list-of-banned-firms.php", match: "name", tier: 6,
    summary: "PSU procurement blacklist: firm, ban date, duration, reason (fraud, fake certificates)." },
  { id: "ugc-fake", title: "UGC Fake/Blacklisted Universities & Defaulter HEIs", format: "html-table",
    url: "https://www.ugc.gov.in/universitydetails/HEIs_Violating_Regulations", match: "name", tier: 6,
    summary: "UGC lists of fake universities and regulation-violating HEIs." },
  { id: "panchayat-elections", title: "Status of Panchayat Elections in PRIs", format: "html-table",
    url: "https://panchayat.gov.in/en/status-of-panchayat-elections-in-pris/", match: "none",
    summary: "State-wise panchayat election due/held dates (aggregate context)." },
  { id: "tn-lokayukta-stats", title: "Tamil Nadu Lokayukta Case Statistics", format: "html-table",
    url: "https://tamilnadulokayukta.tn.gov.in/en/case-status/", match: "none",
    summary: "Aggregate complaint/disposal statistics by official rank (no names)." },
  { id: "ka-excise-licences", title: "Karnataka Excise Licence Counts", format: "html-table",
    url: "https://stateexcise.karnataka.gov.in/47/licences/en", match: "none",
    summary: "District-wise liquor licence counts (aggregate, no names)." },

  // ---- Batch B — GitHub raw CSVs/XLSX (5) ----
  { id: "pocso-judgements", title: "CivicDataLab POCSO case-law analysis", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/POCSO_case_law_analysis/master/pocso_judgements_analyser/processed_judgements.csv",
    match: "name", tier: 5, maxRows: 60000,
    summary: "Processed POCSO judgments with extracted fields (research snapshot)." },
  { id: "up-flood-tenders", title: "UP e-tender corpus (flood-data-ecosystem)", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/flood-data-ecosystem-UP/main/Sources/TENDERS/data/all_UP_tenders.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Full UP e-tender corpus: department, bidder, awarded value — reveals contractor links." },
  { id: "balasore-treasury", title: "Balasore district treasury transactions", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/district_treasury_analysis/master/data/balasore_fy_2014_2018_cleaned.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Daily district treasury payment records, Balasore Odisha 2014-18 (payee names)." },
  { id: "assam-budget-justice", title: "Assam justice-sector budget line items", format: "csv",
    url: "https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/datasets/state-budgets/assam/budget_head_categories.csv",
    match: "none",
    summary: "Assam Police/Prisons/Justice budget heads (aggregate context)." },
  { id: "hp-health-procurement", title: "HP health procurement (OCDS)", format: "xlsx",
    url: "https://raw.githubusercontent.com/CivicDataLab/himachal-pradesh-health-procurement-OCDS/master/HP%20Health%20Procurements(FY%202017-18%20to%202020-21%20July).xlsx",
    match: "name", tier: 5,
    summary: "HP health-sector tenders & awards 2017-2021, OCDS-structured (buyer/supplier names)." },

  // ---- Batch C — Justice Hub (CKAN) datasets (6) ----
  { id: "electoral-bonds-purchased", title: "Electoral Bonds — Purchasers (SBI disclosure)", format: "csv",
    url: "https://justicehub.in/dataset/9914f7ed-626b-4ec6-8419-377c8169cdce/resource/3b7cbdd7-e57d-423b-80b5-edd572831a52/download/purchaser.csv",
    match: "name", tier: 6,
    summary: "SBI electoral bond purchases: date, purchaser name, denomination (2019–2024)." },
  { id: "electoral-bonds-encashed", title: "Electoral Bonds — Encashments by party", format: "csv",
    url: "https://justicehub.in/dataset/9914f7ed-626b-4ec6-8419-377c8169cdce/resource/cafd9f6e-7d44-418a-b527-e532216ee605/download/encashment.csv",
    match: "party", tier: 6,
    summary: "Electoral bond encashments: date, political party, denomination." },
  { id: "khoj-judges", title: "Know Your High Court Judges (KHOJ)", format: "csv",
    url: "https://raw.githubusercontent.com/justicehub-in/know-your-high-court-judges/main/data/final-files/khoj-data-package.zip",
    match: "name", tier: 5, csvInZip: "master",
    summary: "~43 variables per High Court judge — career, appointments, kinship signals." },
  { id: "calpra-cases", title: "CALPRA child-labour cases 2015-2023", format: "csv",
    url: "https://justicehub.in/dataset/aa8d01a0-f166-42f9-b265-0fedd50ec2b6/resource/7b0ff70c-1d71-4107-8bf4-f71aed96bcde/download/case_details.csv",
    match: "name", tier: 5,
    summary: "~10,800 CALPRA court cases across 6 states from eCourts (party names present)." },
  { id: "ijr-2022", title: "India Justice Report 2022 state indicators", format: "xlsx",
    url: "https://justicehub.in/dataset/f38b750b-399a-4bd3-80e8-d98b0091a3f3/resource/4feb9e0d-38a2-49c6-97f7-08d21c583e80/download/data.xlsx",
    match: "none",
    summary: "State-level justice-system indicator data (aggregate context)." },
  { id: "ijr-2020", title: "India Justice Report 2020 ranks data", format: null, match: "none",
    skipped: "Ranks Data ZIP contains only XLSX (xlsx-in-zip unsupported by the L1 csv engine); aggregate no-name data, emits no evidence — nothing lost.",
    summary: "IJR 2020 indicator-level data (aggregate context)." },

  // ---- Batch D — PDFs & remaining (3) ----
  { id: "wb-dmm-brochure", title: "WB Directorate of Mines & Minerals — Mineral Prospects", format: "pdf",
    url: "https://www.wbindustries.gov.in/files/Mineral_Report/DMM_Brochure_rev%2005.pdf",
    insecure: true, match: "none",
    summary: "District-wise WB mineral reserves (context for mining-lease conflict checks)." },
  { id: "rajkaj-circulars", title: "RAJKAJ Circulars & Orders (GAD Rajasthan)", format: "html-table",
    url: "https://rajkaj.rajasthan.gov.in/knowledge-bank/circulars-and-orders.php", match: "none",
    note: "If no <table> found, mark skipped (admin HR circulars, low investigative value).",
    summary: "Rajasthan GAD circulars incl. IPR (immovable property return) filing orders." },
  { id: "pocso-datewise", title: "POCSO date-wise case counts", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/POCSO_case_law_analysis/master/pocso_judgements_analyser/date_wise_cases.csv",
    match: "none", summary: "Daily POCSO case counts (aggregate context)." },

  // ==== Batch E — single static HTML tables/pages, R1 (8) ====
  { id: "ppp-india", title: "PPP in India — infrastructure project database", format: "html-table",
    url: "https://www.pppinindia.gov.in/all_infrastructure_projects", match: "name", tier: 5,
    timeoutMs: 90000, maxRows: 20000,
    summary: "~4,000 PPP projects: name, cost (Rs cr), sector, awarding authority, state, status.",
    note: "3.8MB server-rendered page — the big timeout is deliberate." },
  { id: "punjab-sand-mines", title: "Punjab Sand Portal — operational mining sites", format: "html-table",
    url: "https://minesandgeology.punjab.gov.in/operational-minings/", match: "name", tier: 6,
    note: "If 404, find the exact 'operational minings' path from the homepage nav HTML.",
    summary: "Active sand/gravel mining sites by district with owner and status." },
  { id: "acb-jk-fir", title: "ACB Jammu & Kashmir — FIR cases", format: "html-table",
    url: "https://acb.jk.gov.in/fir-cases.htm", match: "name", tier: 6,
    summary: "FIR listing: FIR no./date, allegation, accused name(s) and designation." },
  { id: "punjab-vb-investigations", title: "Punjab Vigilance Bureau — range-wise FIR/VE counts", format: "html-table",
    url: "https://vigilancebureau.punjab.gov.in/investigations.php", insecure: true, match: "none",
    summary: "Range-wise counts of corruption cases under investigation (aggregate)." },
  { id: "punjab-vb-press", title: "Punjab Vigilance Bureau — press releases", format: "html-list",
    url: "https://vigilancebureau.punjab.gov.in/", insecure: true, match: "name", tier: 6,
    summary: "Rotating press-release links naming arrested/charged officials." },
  { id: "prs-16fc", title: "16th Finance Commission — PRS summary tables", format: "html-table",
    url: "https://prsindia.org/policy/report-summaries/report-of-the-16th-finance-commission-for-2026-31",
    match: "none", summary: "Tax devolution weightages and state-wise shares (secondary source, context)." },
  { id: "fira-rejections", title: "FSSAI Food Import Rejection Alerts (FIRA)", format: "html-table",
    url: "https://fira.fssai.gov.in/", match: "name", tier: 6,
    note: "If the homepage has no table (JS shell), look for a results/listing path in the HTML; if none, skip (likely SPA).",
    summary: "Rejected food imports: product, origin country, rejection reason, date." },
  { id: "ireps-banned", title: "IREPS — banned/suspended firms", format: "html-table",
    url: "", match: "name", tier: 6,
    note: "Find the banned/suspended-firms listing link in https://www.ireps.gov.in/ homepage HTML (anchor text contains 'banned' or 'suspend'); hard-code it. If only reachable via POST/session, skip.",
    summary: "Railways procurement banned-firm registry." },

  // ==== Batch F — document/PDF listing pages, R2 (10) ====
  { id: "sfio-investigations", title: "SFIO — investigations completed / convicted directors", format: "html-list",
    url: "https://sfio.gov.in/en/investigations-completed/", linkRe: "\\.(pdf|htm)", match: "name", tier: 6,
    note: "Exact path may differ — locate 'Investigations Completed', 'Directors Convicted', 'Proclaimed Offenders' links in sfio.gov.in nav; add one entry per section (ids sfio-convicted, sfio-offenders) reusing this shape.",
    summary: "SFIO fraud investigation outcomes and convicted-director lists." },
  { id: "fiu-publications", title: "FIU-IND annual reports", format: "html-list",
    url: "https://fiuindia.gov.in/files/Publication/Publication.html", linkRe: "\\.pdf", match: "none",
    summary: "17 FIU annual reports 2007-2025 (aggregate STR/CTR stats, named penalty actions in PDFs)." },
  { id: "ncb-reports", title: "Narcotics Control Bureau — reports & judgments", format: "html-list",
    url: "https://narcoticsindia.nic.in/", linkRe: "\\.pdf", match: "none",
    summary: "State-wise seizure statistics and annual report PDFs." },
  { id: "ap-lokayukta", title: "AP Lokayukta — reports & press releases", format: "html-list",
    url: "https://lokayukta.ap.gov.in/", linkRe: "\\.pdf", match: "name", tier: 6,
    summary: "Annual reports/press releases naming officials under investigation." },
  { id: "ts-lokayukta", title: "Telangana Lokayukta — reports & circulars", format: "html-list",
    url: "https://lokayukta.telangana.gov.in/", linkRe: "\\.pdf", match: "name", tier: 6,
    summary: "Annual reports and case circulars." },
  { id: "kerala-lokayukta", title: "Kerala Lok Ayukta — cause lists", format: "html-list",
    url: "https://www.lokayuktakerala.gov.in/", linkRe: "\\.pdf", match: "name", tier: 6,
    summary: "Cause lists by bench — named respondents and case numbers." },
  { id: "kerala-vacb", title: "Kerala VACB — news/press releases", format: "html-list",
    url: "https://vigilance.kerala.gov.in/", match: "name", tier: 6,
    summary: "Conviction and case press releases (named officials)." },
  { id: "uk-vigilance", title: "Uttarakhand Vigilance — news & statistics", format: "html-list",
    url: "https://vigilance.uk.gov.in/", match: "name", tier: 6,
    summary: "Trap-case news items and yearly statistics." },
  { id: "dgcis-coastal", title: "DGCIS coastal cargo statistics", format: "html-list",
    url: "https://www.dgciskol.gov.in/pub_coastal.aspx", linkRe: "\\.(pdf|xls)", match: "none",
    summary: "Annual coastal/inland cargo aggregate publications." },
  { id: "aishe-reports", title: "AISHE higher-education survey reports", format: "html-list",
    url: "https://aishe.gov.in/", linkRe: "\\.(pdf|xls)", match: "none",
    note: "If homepage is JS-shell, try the 'reports' path linked in raw HTML; else skip.",
    summary: "AISHE final report downloads (aggregate education stats)." },

  // ==== Batch G — paged / iterated listings, R3 (7) ====
  { id: "nia-most-wanted", title: "NIA Most Wanted", format: "html-list",
    url: "https://nia.gov.in/most-wanted/page/{page}", pages: [1, 12], match: "name", tier: 6,
    note: "If /page/N 404s, check pagination href format on page 1 (could be ?page=N) and fix the template.",
    summary: "~180 terror-case absconders: name, aliases, reward, case refs." },
  { id: "delhi-budget-archive", title: "Delhi Finance Dept — budget notification archive", format: "html-list",
    url: "https://finance.delhi.gov.in/finance/budget-notification?page={page}", pages: [0, 6],
    linkRe: "\\.pdf", match: "none",
    summary: "Delhi budget PDFs 2016-2022: demands for grants, revised estimates." },
  { id: "dipam-receipts", title: "DIPAM disinvestment receipts (year-wise)", format: "html-table",
    url: "https://dipam.gov.in/disinvestmentReceiptsDtls?year={val}",
    iterate: ["2015-16","2016-17","2017-18","2018-19","2019-20","2020-21","2021-22","2022-23","2023-24","2024-25","2025-26","2026-27"],
    match: "none",
    note: "Confirm the year query-param name by inspecting the dropdown <select name=…> in page HTML; fix template accordingly.",
    summary: "CPSE disinvestment transactions per FY: method, receipts, residual GoI stake." },
  { id: "adr-electoral-bonds", title: "ADR/MyNeta electoral bonds reports", format: "html-table",
    url: "https://www.myneta.info/electoral_bonds/index.php?action={val}",
    iterate: ["donor_wise","party_wise","encashment"], match: "name", tier: 6,
    note: "Open the index page once, copy the 7 sub-report hrefs, and set iterate to their actual query values (or switch to iterating full URLs with url:'{val}' and iterate:[full urls]).",
    summary: "Donor→party electoral bond mappings with bond numbers and dates. Also matches parties via donor rows." },
  { id: "hp-svacb-firs", title: "HP Vigilance & Anti-Corruption — district FIRs", format: "html-table",
    url: "{val}",
    iterate: [], match: "name", tier: 6,
    note: "Collect the 13 district FIR sub-page URLs from https://hpsvacb.hp.gov.in/ nav HTML and put them in iterate (full URLs; the url template is just '{val}').",
    summary: "District-wise FIR listings: case number, accused name, date." },
  { id: "odisha-dmf-districts", title: "Odisha DMF district dashboards", format: "html-table",
    url: "https://dmf.odisha.gov.in/district/{val}", insecure: true,
    iterate: ["ANGUL","BALASORE","BARGARH","BHADRAK","BOLANGIR","BOUDH","CUTTACK","DEOGARH","DHENKANAL","GAJAPATI","GANJAM","JAGATSINGHPUR","JAJPUR","JHARSUGUDA","KALAHANDI","KANDHAMAL","KENDRAPARA","KEONJHAR","KHORDHA","KORAPUT","MALKANGIRI","MAYURBHANJ","NABARANGPUR","NAYAGARH","NUAPADA","PURI","RAYAGADA","SAMBALPUR","SONEPUR","SUNDARGARH"],
    match: "none",
    note: "Values are injected by JS on some pages; if tables come back empty for all districts, skip (needs browser automation — complexity 4 per catalog note).",
    summary: "Per-district DMF fund collection/expenditure (aggregate)." },
  { id: "gst-statistics", title: "GST portal statistics downloads", format: "html-list",
    url: "https://www.gst.gov.in/download/gststatistics", linkRe: "\\.(xlsx|pdf)", match: "none",
    summary: "Index of GST statistics XLSX files by year/category (listing cached; files fetched on demand)." },

  // ==== Batch H — JSON APIs, R4 (3) — skip silently without DATA_GOV_API_KEY ====
  { id: "fci-stock", title: "FCI daily food stock position (data.gov.in)", format: "json-api",
    url: "https://api.data.gov.in/resource/RESOURCE-ID?api-key={key}&format=json&limit=5000",
    apiKeyEnv: "DATA_GOV_API_KEY", rowsPath: "records", match: "none",
    note: "Catalog: https://www.data.gov.in/catalog/region-wise-district-wise-commodity-wise-daily-food-stock-position-fci (403s to plain fetch — resolve the UUID in a browser once).",
    summary: "Region/district/commodity-wise FCI foodgrain stocks (aggregate)." },
  { id: "pmfby-claims", title: "PMFBY crop-insurance claims (data.gov.in)", format: "json-api",
    url: "https://api.data.gov.in/resource/RESOURCE-ID?api-key={key}&format=json&limit=5000",
    apiKeyEnv: "DATA_GOV_API_KEY", rowsPath: "records", match: "none",
    note: "Catalog: https://www.data.gov.in/resource/stateut-wise-details-claims-paid-under-pradhan-mantri-fasal-bima-yojana-pmfby-and",
    summary: "State/insurer-wise PMFBY claims vs premium (aggregate)." },
  { id: "dilrmp-progress", title: "DILRMP land-records digitisation progress (data.gov.in)", format: "json-api",
    url: "https://api.data.gov.in/resource/RESOURCE-ID?api-key={key}&format=json&limit=5000",
    apiKeyEnv: "DATA_GOV_API_KEY", rowsPath: "records", match: "none",
    note: "Catalog: https://www.data.gov.in/resource/state-wise-details-various-components-activities-digital-india-land-records-modernization",
    summary: "State-wise land-record computerisation progress (aggregate)." },

  // ==== Batch I — GitHub / CKAN CSVs, R6 (6) ====
  { id: "hp-flood-tenders", title: "HP e-tender corpus (flood-data-ecosystem)", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/flood-data-ecosystem-Himachal-Pradesh/main/Sources/TENDERS/data/all_tenders_HP.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Every HP govt tender: value, awardee, department, flood-flag, geotag." },
  { id: "odisha-flood-tenders", title: "Odisha tender corpus (flood-data-ecosystem)", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/flood-data-ecosystem-Odisha/main/Sources/TENDERS/data/odisha_all_tenders.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Full Odisha e-tender corpus: title, work description, issuing authority, value — reveals contractor/authority links (resolved 2026-07: combined odisha_all_tenders.csv, ~49 MB)." },
  { id: "bihar-flood-tenders", title: "Bihar tender corpus (flood-data-ecosystem)", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/flood-data-ecosystem-Bihar/main/Sources/TENDERS/tender_data_csv/all_tenders_bihar.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Full Bihar e-tender corpus: title, procurement amount, issuing authority name/designation, dates (resolved 2026-07: combined all_tenders_bihar.csv)." },
  { id: "ap-child-treasury", title: "AP child-budget-tagged treasury spend", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/child-budget-tracker/develop_0.1/data/processed_data/andhra_pradesh_child_treasury.csv",
    match: "name", tier: 5, maxRows: 150000,
    note: "Branch is develop_0.1 (NOT main).",
    summary: "AP treasury expenditure tagged to child-welfare schemes (payee names)." },
  { id: "daksh-mappings", title: "DAKSH judicial data mapping tables", format: "csv",
    url: "", match: "none",
    note: "CKAN slug on justicehub.in: dakshs-database-on-judicial-data → pick Databaseppln.csv resource (PLAN-L1 Batch C resolution rule).",
    summary: "eCourts case-type/stage mapping metadata (context for judicial joins)." },
  { id: "assam-risk-scores", title: "IDS-DRR Assam flood risk scores", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/IDS-DRR-Assam-Risk-Model/main/RiskScoreModel/data/risk_score_final_district.csv",
    match: "none",
    summary: "District flood-risk model outputs (cross-ref against relief spending)." },

  // ==== Batch J — file downloads, R5 (2) ====
  { id: "ijr-consumer-2026", title: "IJR Consumer Justice Report 2026", format: "pdf",
    url: "", match: "none",
    note: "Find the report PDF href on https://indiajusticereport.org/consumer-justice-report (regex href=\"[^\"]+\\.pdf\"); the interactive dashboard itself is SPA — do not attempt it.",
    summary: "Consumer courts capacity assessment (aggregate context)." },
  { id: "cga-monthly", title: "CGA union monthly accounts (index)", format: "html-list",
    url: "https://cga.nic.in/MonthDashboardReport/Published/list.aspx", linkRe: "\\.(xlsm|xlsx)", match: "none",
    summary: "Index of monthly union receipts/expenditure/deficit Excel files." },

  // ---- Mega-datasets (implemented in server/mega-ingest.js) + 2 true no-ops ----
  { id: "ddl-judicial", title: "DDL Judicial Data (81M cases)", format: null, match: "none",
    mega: true /* implemented in server/mega-ingest.js */ },
  { id: "budgets-for-justice", title: "Budgets for Justice union datasets", format: null, match: "none",
    mega: true /* implemented in server/mega-ingest.js */ },
  { id: "assam-tenders-ocds", title: "CivicDataLab Assam Tenders (OCDS zips)", format: null, match: "none",
    mega: true /* implemented in server/mega-ingest.js */ },
  { id: "pocso-tracking-zip", title: "Data4Justice POCSO tracking dataset", format: null, match: "none",
    mega: true /* implemented in server/mega-ingest.js */ },
  { id: "justicehub-catalog", title: "Justice Hub catalog (meta-index)", format: null, match: "none",
    skipped: "meta-index landing page, no data of its own; its datasets are integrated individually (Batch C)" },
  { id: "civicdatalab-childprotection-hub", title: "CivicDataLab child-protection project hub", format: null, match: "none",
    skipped: "landing page only, no data of its own; CALPRA/PCMA data covered by calpra-cases" },

  // ---- L2 already-covered / rejected ledger (R8) — inert records for full catalogue coverage ----
  // Covered by existing integrations or PLAN-L1:
  { id: "kanoon-aicte", title: "Indian Kanoon AICTE regulations/case law", format: null, match: "none",
    skipped: "query variant of the already-integrated Indian Kanoon fetcher (covers doctypes:judgments after the PLAN-L1 Step 5 edit)" },
  { id: "ecourts-ddl-justicehub", title: "eCourts Judicial Dataset 2010-2018 (Justice Hub)", format: null, match: "none",
    skipped: "same underlying data as mega ddl-judicial in server/mega-ingest.js" },
  { id: "budgets-justice-explorer", title: "Budgets for Justice explorer app", format: null, match: "none",
    skipped: "data layer covered by mega budgets-for-justice + L1 assam-budget-justice" },
  { id: "pocso-repo-dup", title: "POCSO case-law repo + Data4Justice (duplicate entry)", format: null, match: "none",
    skipped: "covered by L1 pocso-judgements and mega pocso-tracking-zip" },
  { id: "khoj-dup", title: "KHOJ judges dataset (duplicate entry)", format: null, match: "none",
    skipped: "covered by L1 khoj-judges" },
  { id: "assam-procurement-dup", title: "Assam Public Procurement Explorer (duplicate entry)", format: null, match: "none",
    skipped: "covered by mega assam-tenders-ocds" },
  { id: "obi-explorer", title: "apoorv74/OBI-data-explorer", format: null, match: "none",
    skipped: "community demo repo — the useful part is the CKAN API pattern, no data of its own" },
  // Structurally out of scope for stateless fetchers:
  { id: "tdsat-status", title: "TDSAT case status", format: null, match: "none",
    skipped: "single-case lookup by case/diary number only, no bulk listing (pattern P22)" },
  { id: "sec-kerala", title: "SEC Kerala local-body election data", format: null, match: "none",
    skipped: "time-limited live Trend Portal per election window; needs scheduled election-time runs (pattern P6)" },
  { id: "gfw-india", title: "Global Forest Watch India API", format: null, match: "none",
    skipped: "non-government cross-check layer with no name-matchable rows; revisit if an environment-dossier layer is built" },
  { id: "foscos-recall", title: "FSSAI FoSCoS food recalls", format: null, match: "none",
    skipped: "POST-driven search on a 2026-launched portal, thin history; revisit in L3 (form-post pattern)" },
  { id: "nba-programs", title: "NBA accredited programs", format: null, match: "none",
    skipped: "fragmented per-discipline pages, no named individuals; low investigative value" },
  { id: "assam-ocmms", title: "Assam OCMMS consent search", format: null, match: "none",
    skipped: "POST search forms with per-query params (pattern P29) — belongs in the L3 form-post plan" },
  { id: "wbocmms", title: "WB OCMMS consent search (both catalogue entries)", format: null, match: "none",
    skipped: "same P29 form-post pattern; post-2023 data migrated to Silpa Sathi — belongs in L3 plan" },
  { id: "mstc-coal-auctions", title: "MSTC WBMDTCL coal e-auction catalogs", format: null, match: "none",
    skipped: "static pages with unpredictable numeric IDs; needs a link-crawler — deferred to L3" },

  // ==== Batch K — PDF / document-listing archives, R2/R5 (14) ====
  { id: "dsnd-haryana-blacklist", title: "D S&D Haryana — debarred/blacklisted firms", format: "html-table",
    url: "https://dsndharyana.gov.in/debarred-black-listed-firms/", match: "name", tier: 6,
    summary: "Blacklisted supplier firms with action dates; reasons in linked order PDFs." },
  { id: "cag-audit-index", title: "CAG audit reports (national index)", format: "html-list",
    url: "https://cag.gov.in/en/audit-report?page={page}", pages: [0, 271], linkRe: "\\.pdf", match: "name", tier: 5,
    timeoutMs: 60000,
    note: "Full national archive (271 pages as of 2026-07; re-check the 'page-item last' link periodically as it grows). ?title= does NOT filter server-side (verified: identical PDF set for any query string) — matching is done locally against the crawled report-title/link-text corpus instead. If root 500s/socket-hangs, drop the upper bound and raise timeoutMs further. State AG sub-portals (cag.gov.in/ag2/odisha, /ag/bihar) share this template — add cag-odisha / cag-bihar entries with the same shape if wanted.",
    summary: "CAG performance/compliance/PSU audit report — report title/link text mentions this politician by name." },
  // State AG sub-portals — same page template as cag-audit-index (verified 2026-07:
  // ?page=N pagination works; Bihar under /ag/, Odisha under /ag2/). Added per the
  // note above. The emptyStreak break stops each once its report pages run out.
  // readBodies:true — download each audit-report PDF and match names in the BODY,
  // not just the title (names of officials/entities live inside the report text).
  // Bounded by maxDocs; bodies are cached and reused across refreshes.
  { id: "cag-bihar", title: "CAG Bihar (AG) — audit reports", format: "html-list",
    url: "https://cag.gov.in/ag/bihar/en/audit-report?page={page}", pages: [0, 40], linkRe: "\\.pdf",
    match: "name", tier: 5, timeoutMs: 60000, readBodies: true, maxDocs: 25, docChars: 8000,
    summary: "Bihar state Accountant General audit report PDFs — matched on report title AND body text (names inside the report)." },
  { id: "cag-odisha", title: "CAG Odisha (AG) — audit reports", format: "html-list",
    url: "https://cag.gov.in/ag2/odisha/en/audit-report?page={page}", pages: [0, 40], linkRe: "\\.pdf",
    match: "name", tier: 5, timeoutMs: 60000, readBodies: true, maxDocs: 25, docChars: 8000,
    summary: "Odisha state Accountant General audit report PDFs — matched on report title AND body text (names inside the report)." },
  { id: "pfc-power-utilities", title: "PFC performance of power utilities (ratings)", format: "html-list",
    url: "https://www.pfcindia.co.in/ensite/Home/VS/29", insecure: true, linkRe: "\\.pdf", match: "none",
    summary: "Annual integrated rating reports of state power utilities (PDF)." },
  { id: "port-statistics", title: "Basic Port Statistics of India", format: "html-list",
    url: "https://shipmin.gov.in/transport-reseach/basic-port-statistics", linkRe: "\\.pdf", match: "none",
    summary: "Port-wise cargo/vessel annual statistics PDFs (30-yr series)." },
  { id: "aaib-reports", title: "AAIB India — accident investigation reports", format: "html-list",
    url: "https://aaib.gov.in/", linkRe: "\\.pdf", match: "none",
    summary: "Aircraft accident investigation report PDFs (operator names, causes)." },
  { id: "mospi-paimana", title: "MoSPI PAIMANA — project monitoring flash reports", format: "html-list",
    url: "https://paimana-proj.mospi.gov.in/", linkRe: "\\.pdf", match: "none",
    summary: "Monthly project cost-overrun flash reports (PDF)." },
  { id: "ncrb-prison-stats", title: "NCRB Prison Statistics India", format: "html-list",
    url: "https://ncrb.gov.in/prison-statistics-india", linkRe: "\\.pdf", match: "none",
    summary: "Annual prison statistics PDFs (overcrowding, undertrials)." },
  { id: "india-budget-eb", title: "India Budget — Expenditure Profile (allsbe.pdf)", format: "pdf",
    url: "https://www.indiabudget.gov.in/doc/eb/allsbe.pdf", match: "none",
    summary: "Ministry-wise budget estimates (revenue/capital/total)." },
  { id: "mp-lfa-audit", title: "MP Local Fund Audit — reports", format: "html-list",
    url: "https://lfa.mp.gov.in/", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "Local-body audit reports naming embezzlement cases (Hindi PDFs)." },
  { id: "kspcb-consent", title: "KSPCB — consent/closure orders", format: "html-list",
    url: "https://kspcb.karnataka.gov.in/consent-management", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "Closure/consent order PDFs naming violating companies." },
  { id: "ric-rajasthan-decisions", title: "Rajasthan RIC — RTI second-appeal decisions", format: "html-list",
    url: "https://ric.rajasthan.gov.in/", linkRe: "\\.pdf", match: "none", tier: 6,
    note: "If homepage has no decision links, they may be behind an ASPX postback — then skip and record as R9 (browser).",
    summary: "RTI appeal decision PDFs (department, PIO, ruling)." },
  { id: "wb-mines-rfp", title: "WB Industries — mining RFP/EOI documents", format: "html-list",
    url: "https://www.wbindustries.gov.in/whats_current.html", insecure: true, linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "Mine tender/EOI PDFs: bidder eligibility, MDO awardees, royalty terms." },
  { id: "atfp-orders", title: "Appellate Tribunal SAFEMA/PMLA/FEMA orders", format: "html-list",
    url: "https://atfp.gov.in/orders.asp", linkRe: "\\.pdf", match: "none", tier: 6,
    note: "If orders.asp needs a POST to list, skip → record as R7 mega (form-post) for the L4/manual pass.",
    summary: "Money-laundering/FEMA appellate order PDFs (party names, amounts)." },
  { id: "myneta-rs-interest", title: "MyNeta — Rajya Sabha members' declaration of interest", format: "html-list",
    url: "https://myneta.info/InterestbyRajyasabhaMember/", match: "name", tier: 5,
    summary: "RS members' directorship/shareholding register index (per-member profile links)." },

  // ==== Batch L — DSpace / OAI-PMH repositories, R2 (3) ====
  { id: "eparlib-committees", title: "eParlib — parliamentary committee reports", format: "html-list",
    url: "https://eparlib.sansad.in/oai/request?verb=ListRecords&metadataPrefix=oai_dc&set=com_123456789_13",
    insecure: true, linkRe: "eparlib", match: "name", tier: 5,
    note: "OAI XML lists <dc:title>/<dc:identifier>; the anchor regex still captures identifier URLs. If the set spec is wrong, fetch ?verb=ListSets once and pick the committee-reports setSpec.",
    summary: "Committee report metadata + PDF handles (named MPs/subjects)." },
  { id: "tn-assembly-repo", title: "TN Legislative Assembly digital repository", format: "html-list",
    url: "https://tnlasdigital.tn.gov.in/jspui/oai/request?verb=ListRecords&metadataPrefix=oai_dc",
    linkRe: "jspui", match: "name", tier: 5,
    summary: "Assembly debate/record metadata (named members)." },
  { id: "hc-judgments-note", title: "Indian High Court judgments (AWS Open Data)", format: null, match: "none",
    note: "→ implemented as mega s3-sync 'hc-judgments-s3' (Step 5). Recorded here so the catalogue stays complete.",
    skipped: "1TB S3 corpus — see MEGA_SOURCES hc-judgments-s3" },

  // ==== Batch M — hidden / undocumented JSON APIs, R4 (5) ====
  { id: "jaldi-constitution-bench", title: "JALDI (Vidhi) Constitution Bench data", format: "json-api",
    url: "https://api.jaldi-vidhilegalpolicy.in/api/v1/RESOLVE-ROUTE", rowsPath: "data", match: "name", tier: 5,
    note: "No auth. Route names are in the site's main.js bundle; resolve the case-list route and set rowsPath to the array key in the response.",
    summary: "Constitution Bench matters: parties, dates, status." },
  { id: "land-conflict-watch", title: "Land Conflict Watch — conflict map data", format: "json-api",
    url: "", rowsPath: "", match: "name", tier: 5,
    note: "Map markers come from a JSON endpoint (DevTools → Network → XHR on the map page). Set url + rowsPath from what you observe.",
    summary: "Land-conflict cases: location, parties, sector, status." },
  { id: "cfpp-foodgrains", title: "Central Foodgrains Procurement Portal (Swagger API)", format: "json-api",
    url: "", rowsPath: "", match: "none",
    note: "Check cfpp.nic.in/cfpp/swagger-ui/index.html for a public GET returning state/commodity procurement rows; if every endpoint needs auth, skip.",
    summary: "State/commodity foodgrain procurement figures." },
  { id: "ceo-haryana-affidavits", title: "CEO Haryana — candidate affidavit CMS", format: "json-api",
    url: "https://ceoharyana.gov.in/WebCMS/GetDynamicContentListData", rowsPath: "", match: "name", tier: 5,
    note: "POST-based CMS. If json-api (GET) returns nothing, this needs a POST body (_DynamicTypeId=54&_WebsiteId=24) — then move to a mega json-post kind or skip; do NOT hack POST into the GET engine.",
    summary: "Candidate affidavit entries (constituency-wise, PDF links)." },
  { id: "njdg-district-api", title: "NJDG district/taluka court stats (AJAX)", format: "json-api",
    url: "", rowsPath: "", match: "none",
    note: "njdg.ecourts.gov.in charts are fed by AJAX JSON; capture one endpoint. If it needs per-filter session tokens, skip → record as R9 browser.",
    summary: "Court-level pendency/backlog statistics (aggregate)." },

  // ==== Batch N — data.gov.in JSON APIs, R4 (2) — skip without DATA_GOV_API_KEY ====
  { id: "cpcb-aqi", title: "CPCB real-time air quality (data.gov.in)", format: "json-api",
    url: "https://api.data.gov.in/resource/RESOURCE-ID?api-key={key}&format=json&limit=5000",
    apiKeyEnv: "DATA_GOV_API_KEY", rowsPath: "records", match: "none",
    note: "Catalog: search data.gov.in for 'Real time Air Quality Index'.",
    summary: "Station-wise real-time AQI (aggregate environmental context)." },
  { id: "pfms-schemes", title: "PFMS scheme listing", format: "html-table",
    url: "https://pfms.nic.in/SitePages/SchemeListing.aspx", match: "none",
    note: "If ASPX renders a plain table on GET, this works; if postback-driven (empty), skip → R9 browser.",
    summary: "Central scheme budgeted outlays (context)." },

  // ==== L3 ledger (R8) — inert records; gated entries carry alt: open-twin routes ====
  // --- Already covered by L1/L2/existing integrations ---
  { id: "l3-ibbi-orders-dup", title: "IBBI disciplinary orders (dup)", format: null, match: "none",
    skipped: "implemented as mega ibbi-orders (PLAN-L2)" },
  { id: "l3-cag-odisha-dup", title: "CAG local-body audit Odisha (dup)", format: null, match: "none",
    skipped: "same cag.gov.in template as cag-audit-index (Batch K) — add cag-odisha entry if per-state split wanted" },
  { id: "l3-cag-bihar-dup", title: "CAG audit reports Bihar (dup)", format: null, match: "none",
    skipped: "same template as cag-audit-index (Batch K)" },
  { id: "l3-maharera-dup", title: "MahaRERA (mahaonline) (dup)", format: null, match: "none",
    skipped: "covered by mega maharera-projects (PLAN-L2)" },
  { id: "l3-assam-procurement-dup", title: "Assam Public Procurement Explorer (dup)", format: null, match: "none",
    skipped: "covered by mega assam-tenders-ocds (PLAN-L1/L2)" },
  { id: "l3-ddl-dup", title: "DDL judicial data portal (dup)", format: null, match: "none",
    skipped: "covered by mega ddl-judicial" },
  { id: "l3-daksh-dup", title: "DAKSH HC data / NJDG HC grid (dup)", format: null, match: "none",
    skipped: "covered by mega daksh-hc-bulk (PLAN-L2); NJDG HC grid is the browser twin of njdg-district-api" },
  { id: "l3-khoj-dup", title: "KHOJ judges (dup)", format: null, match: "none",
    skipped: "covered by L1 khoj-judges" },
  { id: "l3-pcma", title: "PCMA cases 2015-2023", format: null, match: "none",
    skipped: "derive child_marriage=1 rows from the CALPRA CSV already in L1 calpra-cases; no separate fetch" },
  { id: "l3-ijr-full", title: "India Justice Report full datasets", format: null, match: "none",
    skipped: "covered by L1 ijr-2020/ijr-2022 + L2 ijr-consumer-2026" },
  { id: "l3-ids-drr", title: "IDS-DRR risk model (OCP)", format: null, match: "none",
    skipped: "covered by L2 assam-risk-scores + flood-tender repos" },
  { id: "l3-kanoon-family", title: "Tribunal case law (SAT/NGT/NCLAT) via Kanoon", format: null, match: "none",
    skipped: "reachable through the integrated Indian Kanoon fetcher (query variants)" },

  // --- CAPTCHA-gated case SEARCH — Kanoon already indexes; pdf-archive supplements recent orders ---
  // BUILT (was ledger): order-date-wise page serves order PDFs to plain fetch;
  // Kanoon still the primary party-name search, this adds the recent-order index.
  { id: "nclt-orders-index", title: "NCLT order/judgement PDFs (index)", format: "html-list",
    url: "https://nclt.gov.in/order-date-wise-search", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "NCLT order/judgement PDF links (party names); complements the integrated Indian Kanoon NCLT search." },
  { id: "l3-ngt-case", title: "NGT case status", format: null, match: "none",
    skipped: "diary-number status lookup CAPTCHA-gated (P4)",
    alt: "SEARCH EXISTS: Kanoon NGT query variant (PLAN-L1 Step 5) does party-name search. Recent-order gap → mega ngt-recent-orders (pdf-archive, Step 5c) — already listed in 5c-3." },
  { id: "l3-sat-case", title: "SAT case status", format: null, match: "none",
    skipped: "search form CAPTCHA-gated (P4)",
    alt: "SEARCH EXISTS: integrated sebi-orders + Kanoon 'SAT \"<name>\"'. Recent-order gap → pdf-archive mega on satweb.sat.gov.in 'Orders/Judgments' listing (Step 5c)." },
  // BUILT (was ledger): nclat.gov.in serves 26 judgement/daily-order PDF links to plain fetch.
  { id: "nclat-orders-index", title: "NCLAT judgement/daily-order PDFs (index)", format: "html-list",
    url: "https://nclat.gov.in/", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "NCLAT judgement/daily-order PDF links (party names); complements integrated Indian Kanoon NCLAT search. e-FILING portal stays gated." },
  { id: "l3-inpass", title: "InPASS patent search", format: null, match: "none",
    skipped: "ASP.NET session + CAPTCHA for bulk (P3/P4)",
    alt: "OPEN BULK: WIPO PATENTSCOPE + Google Patents index Indian patents with free bulk/API access; and ipindia.gov.in publishes weekly Patent Office Journal PDFs (html-list linkRe '\\.pdf') listing applicant/inventor names. Use those instead of the gated live search." },
  { id: "l3-nclt-orderwise", title: "NCLT order date-wise search", format: null, match: "none",
    skipped: "per-bench session form (P3)",
    alt: "SAME as l3-nclt-case-details: use the open Judgement/Orders PDF listing per bench." },
  // BUILT (was ledger): page serves 14 report/press-note PDF links to plain fetch.
  { id: "karnataka-lokayukta-reports", title: "Karnataka Lokayukta — report/press-note PDFs", format: "html-list",
    url: "https://lokayukta.karnataka.gov.in/casestatus.php", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "Lokayukta report/press-note PDFs naming officials under action (title match; bodies via pdf-archive if deeper needed)." },

  // --- Login / DSC-gated live layer — but a PUBLIC layer or MIRROR exists ---
  { id: "l3-mpcb-cems", title: "MPCB online CEMS", format: null, match: "none",
    skipped: "live CEMS on login-gated onlinecems.ecmpcb.in (P15)",
    alt: "OPEN TWIN: CPCB OCEMS + real-time AQI is published on data.gov.in — see Batch N cpcb-aqi (json-api, DATA_GOV_API_KEY). That mirror carries the station data without the state login." },
  { id: "l3-dot-row", title: "DoT Gati Shakti RoW permissions", format: null, match: "none",
    skipped: "application-level data behind MeriPehchaan login (P15)",
    alt: "OPEN LAYER: the state/ministry PENDENCY + processing-time dashboards are public — mega browser-render (waitFor table) captures the aggregate stats. RTI: for applicant-level delay reasons." },
  { id: "l3-igr-maha", title: "IGR Maharashtra e-search", format: null, match: "none",
    skipped: "detailed document search requires login (P11)",
    alt: "OPEN LAYER: IGR Maharashtra publishes stamp-duty COLLECTION statistics dashboards/PDFs publicly — html-list linkRe '\\.pdf' or browser-render for the stats. Property-registration cross-checks come from MahaRERA promoter names (mega maharera-projects) instead of per-document search." },
  { id: "l3-mstc-coal", title: "MSTC coal block auction", format: null, match: "none",
    skipped: "live bids need DSC login (P15)",
    alt: "OPEN TWIN: MSTC posts NIT + post-auction RESULT PDFs pre-login (mstcecommerce.com coal container.jsp). Already scoped as PLAN-L2 mega mstc-coal-auctions (static catalog crawl) — that captures winning-lot data without the DSC layer." },
  { id: "l3-mstc-critical", title: "MSTC critical mineral auction", format: null, match: "none",
    skipped: "Class-3 DSC for live bids (P15)",
    alt: "OPEN TWIN: same as l3-mstc-coal — public NIT/result PDFs; add an mstc-critical mega crawl mirroring mstc-coal-auctions." },
  { id: "l3-odisha-fli-dss", title: "Odisha FLI-DSS forest portal", format: null, match: "none",
    skipped: "report generation login-gated",
    alt: "OPEN TWIN: forest-clearance overlaps come from PARIVESH (MoEFCC) which is public — reachable via data.gov.in / the L1 parivesh scoping. RTI: for FLI-DSS overlap reports on a specific AOI." },
  { id: "l3-odisha-ofms", title: "Odisha OFMS forest GIS", format: null, match: "none",
    skipped: "dashboards login-gated",
    alt: "RETRIEVAL: names are inside the /uploads/ report PDFs → pdf-archive mega odisha-ofms-uploads (Step 5c, already listed in 5c-3) harvests + body-filters. No login for the uploads dir." },

  // --- Land-record portals: per-village/survey-ID lookup, often CAPTCHA (P11/P27) ---
  { id: "l3-igrsup", title: "IGRS Uttar Pradesh", format: null, match: "none",
    skipped: "per-parcel JS drill-down, no state-wide search (P11/P27)",
    alt: "OPEN MIRROR: state-level land-record digitisation progress via data.gov.in DILRMP (Batch N-style json-api) — see L2 dilrmp-progress. Parcel leads near named corridors come from PARIVESH/tender geo-tags, not from scraping IGRSUP." },
  { id: "l3-anyror-guj", title: "AnyROR Gujarat", format: null, match: "none",
    skipped: "survey-number-per-query, JS postback (P11/P27)",
    alt: "OPEN MIRROR: DILRMP data.gov.in progress dataset for the aggregate; RTI for specific 7/12 extracts on a flagged lead." },
  { id: "l3-cg-bhuiyan", title: "Chhattisgarh Bhuiyan land records", format: null, match: "none",
    skipped: "per-village cascading dropdown (P27)",
    alt: "OPEN MIRROR: DILRMP data.gov.in; RTI for specific khasra." },
  { id: "l3-assam-ilrms", title: "Assam ILRMS/Dharitree", format: null, match: "none",
    skipped: "per-village drill-down (P27)",
    alt: "OPEN MIRROR: DILRMP data.gov.in; Assam parcel leads also cross-referable to mega assam-tenders-ocds award locations." },
  { id: "l3-bhoomi-ka", title: "Bhoomi Karnataka land records", format: null, match: "none",
    skipped: "per-survey POST, likely CAPTCHA, no bulk (P27)",
    alt: "OPEN MIRROR: DILRMP data.gov.in for progress; RTI for a specific RTC." },
  { id: "l3-cg-khanij", title: "Chhattisgarh Khanij Online", format: null, match: "none",
    skipped: "ASP.NET viewstate lease search (P19)",
    alt: "OPEN TWIN: try a mega browser-render on the public lease-list/e-auction-RESULT sub-pages (no login) before giving up; CG mineral dispatch also appears in state DMF/royalty PDFs (html-list)." },
  // BUILT (was ledger): homepage serves 16 lease-list PDF links to plain fetch.
  { id: "telangana-mines-leases", title: "Telangana Mines & Geology — lease-list PDFs", format: "html-list",
    url: "https://mines.telangana.gov.in/", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "District/year lease-list PDFs; lease-holder names in link text/body (open twin of the per-ID lookup)." },
  { id: "l3-gidc", title: "GIDC estate/allotment portal", format: null, match: "none",
    skipped: "ASP.NET per-estate viewstate pagination (P19)",
    alt: "OPEN TWIN: mega browser-render on egov.gidcgujarat.org LandEstateDetails per estate (public, no login) — allottee names are rendered in the table." },
  { id: "l3-dda-land", title: "DDA land acquisition awards (scanned ledgers)", format: null, match: "none",
    skipped: "181 pages of scanned pre-2009 PDFs (P12)",
    alt: "RETRIEVAL: pdf-archive mega dda-awards-index (Step 5c, titleOnly, already in 5c-3) — award/village TITLES are name-bearing so title-only match works without downloading scans. Full compensation figures inside scans need the L4 OCR pass." },
  { id: "l3-dilrmp-ror-dir", title: "DILRMP State-RoR-Web directory", format: null, match: "none",
    skipped: "meta-directory of 28+ portals, not a dataset",
    alt: "OPEN MIRROR: the DILRMP progress numbers themselves are on data.gov.in — L2 dilrmp-progress already covers the only machine-readable layer here." },

  // --- NIC-GePNIC / CHIPS e-procurement: AOC results pages are PUBLIC ---
  { id: "l3-nhai-eprocure", title: "NHAI tenders (CPPP eprocure)", format: null, match: "none",
    skipped: "sp= session tokens on per-tender links (P3)",
    alt: "OPEN TWIN: CPPP is ALREADY an integrated fetcher (cppp-procurement.js) — NHAI is a query variant (organisation filter). Public 'Tenders by Organisation' + AOC results pages carry winner/value without login." },
  { id: "l3-defproc", title: "Defence eProcurement (DEFPROC)", format: null, match: "none",
    skipped: "session-token drill-down (P3)",
    alt: "OPEN TWIN: defproc.gov.in public 'Awarded/Results' + 'Debarment' listing pages — mega browser-render or html-table on the results page; no login for winner+value." },
  { id: "l3-mahatenders", title: "Maharashtra eProcurement (MahaTenders)", format: null, match: "none",
    skipped: "GePNIC viewstate; bidder DOCS login-gated (P28)",
    alt: "OPEN TWIN: GePNIC 'Awarded Tenders / AOC' results list is public — mega paged-html-table (or browser-render if postback) on mahatenders.gov.in results captures L1 bidder name + award value." },
  { id: "l3-mp-tenders", title: "MP eProcurement (MPTenders)", format: null, match: "none",
    skipped: "GePNIC session/CSRF (P28)",
    alt: "OPEN TWIN: same as l3-mahatenders — public AOC results page; mega crawl the results listing." },
  { id: "l3-odisha-tenders", title: "Odisha eProcurement", format: null, match: "none",
    skipped: "GePNIC viewstate; bidder DOCS login-gated (P28)",
    alt: "OPEN TWIN: public AOC results list; mega crawl. (Odisha also partially in CivicDataLab repos.)" },
  { id: "l3-cg-eproc", title: "Chhattisgarh eProcurement (CHIPS/CHEPS)", format: null, match: "none",
    skipped: "WebSphere shell + rotating CSRF",
    alt: "OPEN TWIN: mega browser-render on the CHEPS tender-results page (renders past the meta-refresh); winner+value are public." },
  { id: "l3-wb-tenders", title: "WB eProcurement (GePNIC)", format: null, match: "none",
    skipped: "CAPTCHA on tender-ID deep path (P28)",
    alt: "OPEN TWIN: the AOC/results LISTING (WebTenderStatusLists) is browsable without the per-tender CAPTCHA — mega crawl the listing for winner+value; skip the CAPTCHA'd per-ID doc page." },
  { id: "l3-hptenders", title: "HP Tenders eProcurement", format: null, match: "none",
    skipped: "GePNIC dynamic listings + CAPTCHA",
    alt: "ALREADY DONE: CivicDataLab republished the full HP scrape openly → L2 hp-flood-tenders (GitHub CSV). Use that; no need to touch hptenders.gov.in." },
  { id: "l3-assam-ocp", title: "Assam Public Procurement Explorer site", format: null, match: "none",
    skipped: "unstable subpage URLs",
    alt: "ALREADY DONE: raw OCDS data republished on GitHub → mega assam-tenders-ocds." },

  // --- Consent/regulatory search portals (P29) — form-POST, granted results public ---
  { id: "l3-ocmms-national", title: "OCMMS national aggregator (JSP search)", format: null, match: "none",
    skipped: "JSP POST per state/district (P29) — no CAPTCHA/login",
    alt: "OPEN (form-POST): granted-consent results ARE public; needs the L4 json-post/form-post kind (POST body per state+date). No wall — just not GET-able. Meanwhile CPCB defaulter lists (html-list) cover the worst-polluter angle." },
  { id: "l3-asocmms", title: "Assam OCMMS granted-application search", format: null, match: "none",
    skipped: "Grails/GSP form-POST (P29) — no CAPTCHA/login",
    alt: "OPEN (form-POST): public granted-CTE/CTO search; L4 form-post kind. Assam industrial-consent names also partially cross-ref mega assam-tenders-ocds." },
  { id: "l3-mpcb-consent", title: "MPCB consent management", format: null, match: "none",
    skipped: "endpoints migrated to MAITRI (P29)",
    alt: "OPEN: locate the current MAITRI granted-consent listing (maitri.mahaonline.gov.in) — public results, L4 form-post; no login for granted list." },
  // BUILT (was ledger): homepage links downloadable datasets/notices.
  { id: "gpcb-datasets", title: "GPCB — AAQ/water-quality datasets & notices", format: "html-list",
    url: "https://gpcb.gujarat.gov.in/", linkRe: "\\.(xls|xlsx|csv|pdf)", match: "none", tier: 6,
    summary: "GPCB downloadable datasets/notices (OCEMS real-time is mirrored on CPCB data.gov.in cpcb-aqi)." },
  { id: "l3-mahafood-pds", title: "Maharashtra PDS (Tableau dashboards)", format: null, match: "none",
    skipped: "core data in Tableau vizql (P18)",
    alt: "OPEN: Tableau Public exposes a 'Download → Crosstab' CSV endpoint per view (…/views/<wb>/<view>.csv) — no login. Resolve the view path once and add a csv entry. Public-distribution aggregates also on data.gov.in (PDS)." },

  // --- NeVA assembly portals & Hindi-OCR PDF directories — public, just JS/OCR-heavy ---
  { id: "l3-neva-hub", title: "NeVA state-assembly portal network", format: null, match: "none",
    skipped: "multi-tenant per-state JS templates",
    alt: "OPEN: no wall — per-state NeVA Q&A pages are public. Add mega browser-render entries per priority state (mhla/wbla/jhla.neva.gov.in) with waitFor 'table'; questions carry MLA names." },
  { id: "l3-jhla-neva", title: "Jharkhand NeVA assembly Q&A", format: null, match: "none",
    skipped: "JS POST search, bilingual",
    alt: "OPEN: mega browser-render on jhla.neva.gov.in questions module (public); match:'name' on MLA names." },
  // BUILT (was ledger): PDF directory serves question-reply PDF links to plain fetch.
  { id: "bihar-vidhansabha-qs", title: "Bihar Vidhan Sabha — question-reply PDFs", format: "html-list",
    url: "https://vidhansabha.bihar.gov.in/house2.html", linkRe: "\\.pdf", match: "none", tier: 5,
    summary: "Assembly question-reply PDF index (member names in titles; Devanagari OCR of bodies is a later pass)." },

  // --- Other structural blockers — all have an open route ---
  { id: "l3-eci-contribution", title: "ECI party contribution reports", format: null, match: "none",
    skipped: "index JS-rendered, 403 on plain fetch (P6)",
    alt: "OPEN TWIN: the donor PDFs are static files behind the JS index — mega browser-render the index once to harvest the '\\.pdf' hrefs, then html-list them. Donor→party data also in L1 adr-electoral-bonds (MyNeta mirror)." },
  // BUILT (was ledger): mahasec homepage serves result/notice PDF links to plain fetch.
  { id: "secm-results", title: "SEC Maharashtra — result/notice PDFs", format: "html-list",
    url: "https://mahasec.maharashtra.gov.in/", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "Local-body election result/notice PDFs (winner names in titles; booth-level OCR is a later pass)." },
  { id: "l3-sec-punjab", title: "SEC Punjab local-body elections", format: null, match: "none",
    skipped: "TLS-broken + fragmented (P6)",
    alt: "OPEN: use insecure:true html-list on sec.punjab.gov.in once a stable result index is found (cert-bypass is already supported, not a wall)." },
  { id: "l3-form20", title: "ECI Form 20 booth-wise results", format: null, match: "none",
    skipped: "per-constituency non-uniform PDFs (P6)",
    alt: "OPEN: results.eci.gov.in structured HTML + per-constituency Form-20 PDFs are all public — html-list per state CEO site; heavy but unwalled. Booth-level OCR is the L4 pass." },
  { id: "l3-cvigil", title: "cVIGIL portal", format: null, match: "none",
    skipped: "aggregate-only; no granular public layer (P8)",
    alt: "RTI: constituency-level complaint counts require an RTI filing (manual). Aggregate stat bulletins (PIB/ECI) are html-list-scrapable for trend leads." },
  { id: "l3-aft", title: "Armed Forces Tribunal case status", format: null, match: "none",
    skipped: "JS search form, narrow scope (no CAPTCHA)",
    alt: "OPEN: aft.gov.in has NO CAPTCHA (catalogue-confirmed) — mega browser-render the results table with blank/date-range sweeps; fully public." },
  { id: "l3-wbmdtcl", title: "WBMDTCL portal", format: null, match: "none",
    skipped: "static/stale + app-gated e-challan",
    alt: "COVERED: tender/EOI PDFs already handled by Batch K wb-mines-rfp; e-challan transport-permit lookup needs RTI (manual)." },
  { id: "l3-tia-trade", title: "TIA export dashboard", format: null, match: "none",
    skipped: "JS dashboard, guest extraction (no login for guest)",
    alt: "OPEN: TIA + DGCIS FTDDP guest tier are public (no login) — already scoped as mega ftddp-trade (browser-render). Guest tier is aggregate-capped but unwalled." },
  { id: "l3-obi-explorer-dup", title: "OBI data explorer (dup)", format: null, match: "none",
    skipped: "CKAN API pattern, no data of its own",
    alt: "OPEN: query data.openbudgetsindia.org CKAN API directly (/api/3/action/package_search) — add json-api entries for any budget dataset of interest." },

  // ========================================================================
  // LEVEL 4 (PLAN-L4-FETCHERS.md). Hardest tier. NO access control is ever
  // automated (CAPTCHA/paid/OTP/login/DSC). Group 1 = already covered by an
  // integrated source/open twin. Group 2 = SPA json-api (url filled AFTER a
  // `node server/mega-ingest.js --refresh <capture-id>` reveals the endpoint).
  // Group 4 = honest floor, no legitimate path.
  // ========================================================================

  // --- Group 1: already covered — CAPTCHA/WAF sits only on the live lookup ---
  { id: "l4-ecourts-district", title: "eCourts District Court case status", format: null, match: "none",
    skipped: "CAPTCHA on every live status query (P4)",
    alt: "SEARCH EXISTS: integrated indian-kanoon.js indexes district-court judgments — query '\"<name>\"'. Bulk historical corpus = mega ddl-judicial + hc-judgments-s3." },
  { id: "l4-ecourts-hc", title: "eCourts High Court services", format: null, match: "none",
    skipped: "CAPTCHA per query, per-bench (P4)",
    alt: "SEARCH EXISTS: Indian Kanoon indexes all High Courts. Bulk = mega daksh-hc-bulk + hc-judgments-s3 (AWS Open Data)." },
  { id: "l4-sci", title: "Supreme Court case status & judgments", format: null, match: "none",
    skipped: "WAF 403 + CAPTCHA (P4)",
    alt: "SEARCH EXISTS: Indian Kanoon indexes SCI judgments — query '\"<name>\"'. No need to touch the WAF'd portal." },
  // BUILT (was ledger): itat.gov.in serves 58 order PDF links to plain fetch.
  { id: "itat-orders-index", title: "ITAT order PDFs (index)", format: "html-list",
    url: "https://itat.gov.in/", linkRe: "\\.pdf", match: "none", tier: 6,
    summary: "ITAT order PDF links (assessee/party names); complements integrated Indian Kanoon ITAT search." },
  { id: "l4-eci-affidavit", title: "ECI candidate affidavit portal", format: null, match: "none",
    skipped: "WAF 403; scanned-PDF affidavits (P4/P6)",
    alt: "ALREADY PRIMARY: MyNeta (myneta-full.js) is ADR's structured OCR of these exact affidavits — asset/criminal data already ingested per candidate." },
  { id: "l4-eci-trust", title: "ECI electoral trust contribution reports", format: null, match: "none",
    skipped: "WAF 403; per-trust PDF enumeration (P6)",
    alt: "COVERED: donor→party flows via L2 adr-electoral-bonds (MyNeta mirror). Trust PDFs harvestable via mega browser-render→pdf-archive if a deeper cut is needed." },
  { id: "l4-parivesh", title: "PARIVESH 2.0 environment clearances", format: null, match: "none",
    skipped: "client-rendered SPA, API needs key (P10/P13)",
    alt: "OPEN API: PARIVESH proposal data is on data.gov.in (json-api + DATA_GOV_API_KEY, like cpcb-aqi). Or run mega browser-capture on parivesh.nic.in 'Know Your Approval' to grab the parivesh_api endpoint, then promote to json-api." },
  { id: "l4-cpcb-ocems", title: "CPCB OCEMS emissions", format: null, match: "none",
    skipped: "Angular SPA, unknown if public (P10)",
    alt: "OPEN API: CPCB real-time data is mirrored on data.gov.in → L3 cpcb-aqi (json-api). Use that, not the SPA." },

  // --- Group 2: SPA json-api — fill `url` after the paired browser-capture run ---
  { id: "l4-kppp-api", title: "KPPP tenders (json-api)", format: "json-api",
    url: "", rowsPath: "", match: "name", tier: 5,
    note: "Run `node server/mega-ingest.js --refresh kppp-tenders`, read server/data/mega/kppp-tenders/endpoints.json, paste the tender-search endpoint into url and its array key into rowsPath. Until then it skips (empty url).",
    summary: "Karnataka public-procurement tenders/awards: winner name + value." },
  { id: "l4-ceo-punjab-api", title: "CEO Punjab candidate data (json-api)", format: "json-api",
    url: "", rowsPath: "", match: "name", tier: 5,
    note: "Fill from browser-capture ceo-punjab-dash endpoints.json.",
    summary: "Punjab candidate/vote-share records." },
  { id: "l4-rti-raj-api", title: "Rajasthan RTI second-appeal report (json-api)", format: "json-api",
    url: "", rowsPath: "", match: "name", tier: 5,
    note: "Fill from browser-capture rti-raj-api endpoints.json (GetAgingCumPendencySecondAppealsReport). May need a POST body — if so, keep as browser-render rti-raj-appeals instead.",
    summary: "RTI second-appeal aging/pendency by department." },
  { id: "l4-nhai-datalake-api", title: "NHAI Data Lake projects (json-api)", format: "json-api",
    url: "", rowsPath: "", match: "name", tier: 5,
    note: "Fill from browser-capture nhai-datalake endpoints.json.",
    summary: "NHAI highway projects: contractor/concessionaire, cost, status." },

  // --- Group 3: WAF/cert or per-ID land record — open twin only ---
  { id: "l4-igrs-telangana", title: "IGRS Telangana registration/EC search", format: null, match: "none",
    skipped: "Cloudflare 403 + needs survey/doc number per query (P11/P27)",
    alt: "OPEN MIRROR: DILRMP progress on data.gov.in (L2 dilrmp-progress). Per-parcel EC needs a known ID → RTI for a specific lead. Playwright presents a real fingerprint but there is no bulk/name search to drive." },
  { id: "l4-ocmms-national", title: "OCMMS national (Struts session)", format: null, match: "none",
    skipped: "jsessionid stateful Struts, invalid cert (P29)",
    alt: "COVERED family: consent data reached via L3 l3-ocmms-national alt (form-POST L4 pass) and CPCB defaulter lists. No CAPTCHA/login — just stateful; deferred to the form-post kind." },

  // --- Group 4: honest floor — NO legitimate automated path (never attempt) ---
  { id: "l4-cersai", title: "CERSAI public search", format: null, match: "none",
    skipped: "paid per-search + login (P7) — automating = fee evasion. No open twin. RTI/manual only." },
  { id: "l4-vahan", title: "VAHAN/Sarathi national register", format: null, match: "none",
    skipped: "CAPTCHA + owner names masked even to public tier (P22). Targeted manual verification only." },
  { id: "l4-vahan-ntr", title: "VAHAN NTR successor portal", format: null, match: "none",
    skipped: "SPA + CAPTCHA + masked owner; authorized-user creds not public (P22)." },
  { id: "l4-pmkisan", title: "PM-KISAN beneficiary status", format: null, match: "none",
    skipped: "OTP to individual's phone; per-record self-service (P22). No bulk path." },
  { id: "l4-ondls", title: "ONDLS drug licensing", format: null, match: "none",
    skipped: "record-by-record lookup, no bulk endpoint (P22). RTI for a specific licensee." },
  { id: "l4-egreenwatch", title: "e-Green Watch CAMPA plantation report", format: null, match: "none",
    skipped: "CAPTCHA on the ASP.NET search form (P11/P25)",
    alt: "MAYBE: if a CAPTCHA-free plantation-report PDF listing exists on egreenwatch.nic.in, a pdf-archive mega could harvest it; otherwise RTI. The search itself is not automated." },
  { id: "l4-ecourts-status-live", title: "eCourts live case-status (CAPTCHA)", format: null, match: "none",
    skipped: "CAPTCHA per query (P4)",
    alt: "COVERED: judgments/orders via Indian Kanoon (l4-ecourts-district/hc). Live pendency status has no lawful bulk path." },

  // Batch 3 (2026-07-13) — Parliamentary Standing Committee reports via the PRS India
  // mirror (eparlib.nic.in did not resolve; sansad.in committee routes are a JS SPA).
  // Static HTML listing of SCR*.pdf under /files/policy/policy_committee_reports/;
  // readBodies downloads each report PDF and matches names in the BODY (ministry-
  // spending scrutiny names specific irregularities/entities). Shape mirrors cag-*.
  { id: "standing-committee-reports", title: "Parliamentary Standing Committee reports (PRS India)", format: "html-list",
    url: "https://prsindia.org/policy/report-summaries", linkRe: "policy_committee_reports/.*\\.pdf",
    match: "name", tier: 5, timeoutMs: 60000, readBodies: true, maxDocs: 25, docChars: 8000,
    summary: "Parliamentary Standing Committee report PDFs (PRS mirror) scrutinising ministry spending — matched on report title AND body text (names inside the report)." },
];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const argv = process.argv.slice(2);
  const getFlag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const { startTimer } = await import("./util/timing.js");
  const stop = startTimer("Ingest");
  ingestAll({ office: getFlag("--office"), state: getFlag("--state"), mps: argv.includes("--mps") }).then((n) => { console.log(`\n[ingest] ${n} new evidence rows total.`); stop(); process.exit(0); });
}
