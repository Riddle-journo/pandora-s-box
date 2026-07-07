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
import { listPoliticians, addEvidence } from "./store.js";
import { fetchText, htmlToText, fetchPdfText, UA, fetchJson } from "./fetchers/http.js";
import { fetchMyNetaProfile } from "./sources/myneta-full.js";
import { fetchWikipedia } from "./sources/wikipedia.js";
import { fetchNews } from "./sources/news.js";
import { enrichNewsBodies } from "./fetchers/article-body.js";
import { fetchPressReleases } from "./fetchers/press-releases.js";
import { fetchIndianKanoon } from "./fetchers/indian-kanoon.js";
import { fetchICIJ } from "./fetchers/icij.js";
import { fetchSEBIOrders } from "./fetchers/sebi-orders.js";
import { fetchCAGReports } from "./fetchers/cag-reports.js";
import { fetchSansadMP } from "./fetchers/sansad-mp.js";
import { fetchElectionExpenditure } from "./fetchers/election-expenditure.js";
import { fetchPartyFunding } from "./fetchers/party-funding.js";
import { fetchMPLADS } from "./fetchers/mplads.js";
import { fetchCPPPProcurement } from "./fetchers/cppp-procurement.js";
import { fetchMCADirectors } from "./fetchers/mca-directors.js";
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
export async function ingestFor(p) {
  const [mynetaFull, wiki, news, newsIntl, press, kanoon, icij, sebi, cag,
         sansad, expense, partyFin, mplads, cppp, mca, factcheck, wikidata, companyReg, secEdgar, pibProjects, l1] =
    await Promise.all([
      fetchMyNetaProfile(p),     // FULL affidavit (cases, IPC sections, asset growth)
      fetchWikipedia(p),         // biographical/career narrative
      fetchNews(p),              // GDELT headlines (English; 429-resilient)
      fetchMultilingualNews(p),  // English + Hindi + state-language news (Google News RSS)
      fetchPressReleases(p),     // ED/CBI listing + linked full releases (PDF-aware)
      fetchIndianKanoon(p),      // court judgment excerpts (API key OR free web scrape)
      fetchICIJ(p),              // ICIJ offshore leaks         (free, no key)
      fetchSEBIOrders(p),        // SEBI enforcement orders     (free, no key)
      fetchCAGReports(p),        // CAG audit + report PDF       (free, no key)
      fetchSansadMP(p),          // FULL parliamentary record, MP/RS (sansad.in JSON API)
      fetchElectionExpenditure(p), // sworn campaign-spend declaration (MyNeta, free)
      fetchPartyFunding(p),      // full party financials + donations (MyNeta, free)
      fetchMPLADS(p),            // MP fund sanctioned/released/utilised (MoSPI API, MP-only)
      fetchCPPPProcurement(p),   // govt contracts award trail (local SQLite, env CPPP_DB_PATH)
      fetchMCADirectors(p),      // MCA21 directorships (local SQLite, env MCA_DB_PATH or data/mca.db)
      fetchFactChecks(p),        // fact-checks from Alt News/BOOM/Factly etc. (free)
      fetchWikidata(p),          // structured named relatives + positions (free) → feeds the graph
      fetchCompanyRegistry(p),   // MCA registry check of declared companies (status/CIN) → struck-off flag
      fetchSECEdgar(p),          // US SEC EDGAR full-text filing search (free, no key) — rare but real hits
      fetchPIBProjects(p),       // PIB/ministry project announcements (free) → PROJECT_FRONT_RUNNING timing
      fetchL1Datasets(p),        // level-1 dataset sources (registry-driven, local cache)
    ]);

  // Upgrade headline news → full article body text (free, no key; PDF-aware).
  const newsBodies = await enrichNewsBodies([...news, ...newsIntl], { limit: 14 });
  const caseLeads = await fetchL1CaseMonitors(p); // P21 single-case monitors

  const added = addEvidence([
    mynetaFull, wiki, news, newsIntl, newsBodies,
    press, kanoon, icij, sebi, cag, sansad, expense, partyFin, mplads, cppp, mca, factcheck, wikidata, companyReg, secEdgar, pibProjects,
    l1, caseLeads,
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

// Download one source into cache. cfg: { id, url, format, insecure?, table?, sheet?, csvInZip?, maxRows? }
async function l1Refresh(cfg) {
  try {
    if (!cfg.format || !cfg.url) return { id: cfg.id, ok: false, why: "skipped/no url" };
    if (cfg.format === "html-table") {
      const html = cfg.insecure ? (await l1FetchInsecure(cfg.url))?.toString("utf8") ?? "" : await fetchText(cfg.url, { timeoutMs: 30000 });
      if (!html) return { id: cfg.id, ok: false, why: "fetch failed" };
      const tables = l1HtmlTables(html);
      if (!tables.length) return { id: cfg.id, ok: false, why: "no <table> found" };
      const rows = cfg.table != null ? tables[cfg.table] : tables.reduce((a, b) => (b.length > a.length ? b : a));
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
function l1Match(cfg, cache, p) {
  if (!cache?.rows?.length || cfg.match === "none") return null;
  const needle = cfg.match === "party" ? l1Norm(p.party) : l1Norm(p.name);
  if (!needle || needle.length < 4) return null;
  const hits = cache.rows.filter((row) => l1Norm(row.join(" | ")).includes(needle));
  if (!hits.length) return null;
  const lines = hits.slice(0, 12).map((r) => "• " + r.map((c) => String(c).slice(0, 160)).join(" | "));
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
  { id: "ijr-2020", title: "India Justice Report 2020 ranks data", format: "csv",
    url: "https://justicehub.in/dataset/3e5226d0-9bb8-4f5f-85ac-dbd59da05903/resource/627377dc-d208-44a3-a437-b2a461dc65d3/download/ranks-data-2020.zip",
    match: "none", csvInZip: "rank",
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
];

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop())) {
  const argv = process.argv.slice(2);
  const getFlag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const { startTimer } = await import("./util/timing.js");
  const stop = startTimer("Ingest");
  ingestAll({ office: getFlag("--office"), state: getFlag("--state"), mps: argv.includes("--mps") }).then((n) => { console.log(`\n[ingest] ${n} new evidence rows total.`); stop(); process.exit(0); });
}
