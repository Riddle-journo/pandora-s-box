# PLAN: Level-1 Complexity Source Fetchers (27 sources) — single-file, ingest-only

Execute this plan top-to-bottom. Every step is copy-paste-ready.

HARD CONSTRAINTS (from the project owner):
- **Create NO new fetcher files.** All regular-source code goes into `server/ingest.js`.
  EXCEPTION (owner-approved): exactly ONE new standalone script, `server/mega-ingest.js`
  (Step 6), holding ONLY the mega datasets, refreshed manually by the owner —
  same pattern as the existing `server/bulk-import.js` / `server/mca-index.js`.
  Plus a one-line edit to `server/fetchers/indian-kanoon.js` in Step 5.
- **Everything runs via `npm run ingest` only.** No new CLI, no new npm scripts.
- Only cached *data* files may be created, under `server/data/l1-cache/` (JSON).
- Do NOT read `sources_catalog.json` or `engineering_patterns.json` — everything
  needed is in this file.
- Do not install any package other than: `npm install xlsx fflate` (both are
  lazy-loaded; their absence must never crash ingest — same convention as
  `pdf-parse` in `server/fetchers/http.js`).

## Architecture (read once)

All 27 level-1 sources are **datasets** (tables/CSVs/XLSX/PDF), not per-politician
search portals. So: one generic engine + one config array (`L1_SOURCES`), both
appended to `server/ingest.js`. Flow inside the existing ingest command:

1. `ingestAll()` calls `refreshL1Caches()` ONCE per run (before the politician
   loop): downloads any dataset whose cache is missing or >7 days old into
   `server/data/l1-cache/<id>.json`. Failures log a warning and reuse stale
   cache — never abort ingest.
2. `ingestFor(p)` calls `fetchL1Datasets(p)` (also defined in ingest.js): pure
   local cache matching, ~zero network cost per politician. Its rows join the
   existing `addEvidence` call.

Match modes per source: `name` (row contains `p.name`), `party` (`p.party`),
`none` (cache-only — aggregate data with no names; emits no evidence but stays
available for the investigator layer).

Existing conventions you MUST follow:
- Evidence row shape (see `server/fetchers/sebi-orders.js`):
  `{ politician_id, source_type, tier, admissible, title, url, date, summary, content }`.
- Reuse helpers from `server/fetchers/http.js`: `fetchText`, `htmlToText`,
  `fetchPdfText`, `UA` (import them at the top of ingest.js).
- Fail soft everywhere: any error → `[]` / stale cache, never a throw out of ingest.

## Step 0 — prep

```
npm install xlsx fflate
```

## Step 1 — append the L1 engine to `server/ingest.js`

Add to the existing imports at the top of `server/ingest.js`:

```js
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fetchText, htmlToText, fetchPdfText, UA, fetchJson } from "./fetchers/http.js";
```

Then paste this entire block at the BOTTOM of `server/ingest.js`, but ABOVE the
`if (process.argv[1] …)` CLI block:

```js
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
  // Populated batch by batch — see PLAN-L1-FETCHERS.md Step 3.
];
```

NOTE: `L1_SOURCES` is referenced by functions above it — that is fine, `const`
at module top level is initialized before any of these functions are *called*
(they only run during ingest). Keep the array at the bottom so config edits
never touch engine code.

## Step 2 — wire into the existing ingest flow (3 small edits, same file)

1. In `ingestFor(p)`: add `l1` to the destructuring array (after `pibProjects`)
   and add as the LAST element of the `Promise.all([...])` array:
   ```js
   fetchL1Datasets(p),        // level-1 dataset sources (registry-driven, local cache)
   ```
   ⚠ Destructuring order must match Promise.all order. `fetchL1Datasets` is sync
   but returning it inside Promise.all is fine.
2. Still in `ingestFor`, after the `newsBodies` line add:
   ```js
   const caseLeads = await fetchL1CaseMonitors(p); // P21 single-case monitors
   ```
   and add both `l1` and `caseLeads` to the array passed to `addEvidence`.
3. In `ingestAll(...)`, immediately after the `console.log(\`[ingest] Running for …\`)`
   line, add:
   ```js
   await refreshL1Caches(); // download/refresh level-1 datasets once per run
   ```

Sanity check after editing: `node -e "import('./server/ingest.js')"` must load
with no errors (it may print nothing — that's success).

## Step 3 — populate `L1_SOURCES` batch by batch

After appending each batch, verify with the ingest command itself (Step 4).
If a source fails refresh: apply its `note` fallback; if still failing after ~3
attempts, set `format: null` and add `skipped: "<why>"`, then continue — never
block a batch on one source.

### Batch A — static HTML tables (6)

```js
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
```

### Batch B — GitHub raw CSVs/XLSX (5)

Rule: URL must be `https://raw.githubusercontent.com/<org>/<repo>/<branch>/<path>`
(never the github.com HTML page). Try branch `main`; on 404 try `master`; if
still 404, list the tree via `https://api.github.com/repos/<org>/<repo>/git/trees/main?recursive=1`
to find the exact path.

```js
  { id: "pocso-judgements", title: "CivicDataLab POCSO case-law analysis", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/POCSO_case_law_analysis/master/processed_judgements.csv",
    match: "name", tier: 5, maxRows: 60000,
    summary: "Processed POCSO judgments with extracted fields (research snapshot)." },
  { id: "up-flood-tenders", title: "UP e-tender corpus (flood-data-ecosystem)", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/flood-data-ecosystem-UP/main/Sources/TENDERS/data/all_UP_tenders.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Full UP e-tender corpus: department, bidder, awarded value — reveals contractor links." },
  { id: "balasore-treasury", title: "Balasore district treasury transactions", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/district_treasury_analysis/master/balasore_fy_2014_2018_cleaned.csv",
    match: "name", tier: 5, maxRows: 150000,
    summary: "Daily district treasury payment records, Balasore Odisha 2014-18 (payee names)." },
  { id: "assam-budget-justice", title: "Assam justice-sector budget line items", format: "csv",
    url: "https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/datasets/state-budgets/assam/budget_head_categories.csv",
    match: "none",
    summary: "Assam Police/Prisons/Justice budget heads (aggregate context)." },
  { id: "hp-health-procurement", title: "HP health procurement (OCDS)", format: "xlsx",
    url: "", match: "name", tier: 5,
    note: "Repo CivicDataLab/himachal-pradesh-health-procurement-OCDS hosts a raw .xlsx; find its path via the trees-API rule and set url to the raw.githubusercontent.com address.",
    summary: "HP health-sector tenders & awards 2017-2021, OCDS-structured (buyer/supplier names)." },
```

### Batch C — Justice Hub (CKAN) datasets (6)

Rule: dataset page URL ≠ file URL. Resolve the direct file URL ONCE (manually,
while executing this plan) via
`https://justicehub.in/api/3/action/package_show?id=<slug>` → `result.resources[].url`
(slug = last path segment of the dataset page). Hard-code the resolved file URL
into `url:`. If the API is blocked, fetch the dataset HTML page and regex
`href="[^"]+\.(csv|xlsx|zip)"`. You may use `fetchJson` from http.js in a
throwaway `node -e` command to do this resolution.

```js
  { id: "electoral-bonds-purchased", title: "Electoral Bonds — Purchasers (SBI disclosure)", format: "csv",
    url: "", match: "name", tier: 6,
    note: "slug: disclosure-of-electoral-bonds; pick the 'purchased' CSV resource.",
    summary: "SBI electoral bond purchases: date, purchaser name, denomination (2019–2024)." },
  { id: "electoral-bonds-encashed", title: "Electoral Bonds — Encashments by party", format: "csv",
    url: "", match: "party", tier: 6,
    note: "slug: disclosure-of-electoral-bonds; pick the 'encashed' CSV resource.",
    summary: "Electoral bond encashments: date, political party, denomination." },
  { id: "khoj-judges", title: "Know Your High Court Judges (KHOJ)", format: "csv",
    url: "", match: "name", tier: 5, csvInZip: "master",
    note: "GitHub repo justicehub-in/know-your-high-court-judges → khoj-data-package.zip raw URL (trees-API rule); csvInZip picks the master_file CSV inside.",
    summary: "~43 variables per High Court judge — career, appointments, kinship signals." },
  { id: "calpra-cases", title: "CALPRA child-labour cases 2015-2023", format: "csv",
    url: "", match: "name", tier: 5,
    note: "slug: analysis-calpra-2015-2023; pick the main case-details CSV resource.",
    summary: "~10,800 CALPRA court cases across 6 states from eCourts (party names present)." },
  { id: "ijr-2022", title: "India Justice Report 2022 state indicators", format: "xlsx",
    url: "", match: "none",
    note: "slug: india-justice-report-2022; resource: 'State Indicators Raw Data' XLSX.",
    summary: "State-level justice-system indicator data (aggregate context)." },
  { id: "ijr-2020", title: "India Justice Report 2020 ranks data", format: "csv",
    url: "", match: "none", csvInZip: "rank",
    note: "slug: india-justice-report-2020; resource: 'Ranks Data' ZIP.",
    summary: "IJR 2020 indicator-level data (aggregate context)." },
```

### Batch D — PDFs & remaining (3)

```js
  { id: "wb-dmm-brochure", title: "WB Directorate of Mines & Minerals — Mineral Prospects", format: "pdf",
    url: "https://www.wbindustries.gov.in/files/Mineral_Report/DMM_Brochure_rev%2005.pdf",
    insecure: true, match: "none",
    summary: "District-wise WB mineral reserves (context for mining-lease conflict checks)." },
  { id: "rajkaj-circulars", title: "RAJKAJ Circulars & Orders (GAD Rajasthan)", format: "html-table",
    url: "https://rajkaj.rajasthan.gov.in/knowledge-bank/circulars-and-orders.php", match: "none",
    note: "If no <table> found, mark skipped (admin HR circulars, low investigative value).",
    summary: "Rajasthan GAD circulars incl. IPR (immovable property return) filing orders." },
  { id: "pocso-datewise", title: "POCSO date-wise case counts", format: "csv",
    url: "https://raw.githubusercontent.com/CivicDataLab/POCSO_case_law_analysis/master/date_wise_cases.csv",
    match: "none", summary: "Daily POCSO case counts (aggregate context)." },
```

### Mega-datasets → handled by `server/mega-ingest.js` (Step 6), plus 2 true no-ops

Append these inert records to `L1_SOURCES` so the catalogue stays fully
represented (the `mega:` flag documents where each is actually implemented):

```js
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
```

(The two `skipped` entries are genuinely landing pages with nothing to download —
their underlying datasets are already ingested via Batch C.)

## Step 4 — verification (ingest command only)

After each batch:
1. `node -e "import('./server/ingest.js')"` → loads clean.
2. `npm run ingest -- --state Goa` (small state) → run completes; console shows
   `[l1] <id>: refreshed, <n> rows` for each new source with n > 0, and the
   normal `[ingest] summary:` line. Any `refresh FAILED` → apply the source's
   fallback note or mark it skipped.
3. Second `npm run ingest -- --state Goa` immediately after → NO `[l1] … refreshed`
   lines (proves the TTL cache works; per-politician cost is local-only).
4. After Batch C: confirm at least one politician gains an
   `l1_electoral_bonds_encashed` evidence row (party match is near-guaranteed
   for major parties).

## Step 5 — Indian Kanoon NGT query variant (pattern P9)

One-line edit in `server/fetchers/indian-kanoon.js` (the ONLY other file touched):
in both `fetchViaApi` and `fetchViaWeb`, change the query `"${p.name}"` to
`"${p.name}" doctypes:judgments`. This covers the catalogue's NGT-judgments
query-variant source while cutting non-judgment noise. Verify: kanoon evidence
still appears on the next ingest run.

## Step 6 — mega-dataset importer: create `server/mega-ingest.js` (the ONE allowed new file)

Standalone script, owner-run on demand (never called by `npm run ingest`):

```
node server/mega-ingest.js                  # status of all mega caches
node server/mega-ingest.js --refresh all    # re-download + re-match everything
node server/mega-ingest.js --refresh <id>   # one dataset
```

Why pre-filtering: these datasets are far too big to scan per politician at
ingest time. This script downloads each one, streams/parses it, and keeps ONLY
rows mentioning any politician name (≥4 chars) or party from the roster. The
small filtered result is written to `server/data/l1-cache/mega-<id>.json` with
embedded metadata — `fetchL1Datasets` in ingest.js (Step 1) picks it up
automatically on every subsequent `npm run ingest`. **Re-run this script after
importing new politicians**, since the pre-filter is roster-dependent.

Paste exactly:

```js
// Mega-dataset importer (PLAN-L1-FETCHERS.md Step 6). Owner-run, on demand:
//   node server/mega-ingest.js [--refresh all|<id>]
// Downloads oversized level-1 datasets, pre-filters rows to those mentioning
// any politician/party in the roster, and writes small caches that ingest.js
// matches per politician. Raw downloads kept under server/data/mega/ so a
// roster-only re-match (--rematch) needs no re-download.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import { listPoliticians } from "./store.js";
import { UA } from "./fetchers/http.js";

const MEGA_DIR = path.join(process.cwd(), "server", "data", "mega");
const CACHE_DIR = path.join(process.cwd(), "server", "data", "l1-cache");

const MEGA_SOURCES = [
  {
    id: "assam-tenders-ocds",
    title: "CivicDataLab Assam Tenders (OCDS)",
    tier: 5, match: "name",
    summary: "45,000+ Assam e-tenders (2016-2022) mapped to OCDS: buyer, supplier/bidder, award value.",
    kind: "zip-xlsx",
    url: "https://raw.githubusercontent.com/CivicDataLab/assam-tenders-data/main/data/ProcessedData/ocds-mapped-data/current/ocds_mapped_data.xlsx.zip",
    note: "On 404 try branch master, or list the tree: https://api.github.com/repos/CivicDataLab/assam-tenders-data/git/trees/main?recursive=1",
  },
  {
    id: "pocso-tracking-zip",
    title: "Data4Justice POCSO case tracking (Assam/Delhi/Haryana)",
    tier: 5, match: "name",
    summary: "19,783 POCSO cases (2012-2020) from eCourts with party/act/section fields.",
    kind: "zip-csv",
    url: "",
    note: "Resolve via CKAN: https://justicehub.in/api/3/action/package_show?id=data4justice-unpacking-judicial-data-to-track-implementation-of-the-pocso-act-in-assam-delhi-haryana → pick the ZIP resource url; hard-code it here.",
  },
  {
    id: "budgets-for-justice",
    title: "Budgets for Justice — union law-and-justice budget datasets",
    tier: 5, match: "name",
    summary: "Union budget line items (2015-16 to 2022-23) for law/justice/police/WCD schemes.",
    kind: "csv-multi",
    urls: [],
    note: "List CSVs via https://api.github.com/repos/justicehub-in/budgets-for-justice-datasets/git/trees/main?recursive=1 — take every path under datasets/union-budgets/ ending .csv, prefix each with https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/ and hard-code the resulting list into urls.",
  },
  {
    id: "ddl-judicial",
    title: "DDL Judicial Data (81M district-court cases, 2010-2018)",
    tier: 5, match: "name",
    summary: "Development Data Lab bulk court-case records: party names, judge, acts/sections, outcomes.",
    kind: "csv-stream",
    urls: [],
    note: "OWNER ACTION: get the Dropbox bulk-download link(s) from https://www.devdatalab.org/judicial-data (open licence), convert to direct links (dl=1), and hard-code into urls. Multi-GB: files stream to disk and are line-filtered, never loaded into memory. Leave urls empty until then — the script reports 'not configured' and skips.",
  },
];

// --- roster needles ---------------------------------------------------------
function buildNeedles() {
  const ps = listPoliticians().filter((p) => !p.is_demo);
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const set = new Set();
  for (const p of ps) { const n = norm(p.name); if (n.length >= 4) set.add(n); }
  return [...set];
}
const normLine = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");

// --- helpers ----------------------------------------------------------------
async function downloadToFile(url, dest, { timeoutMs = 1800000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, fs.createWriteStream(dest));
  return dest;
}
function writeMegaCache(cfg, rows, totalScanned) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = {
    fetched_at: new Date().toISOString(),
    count: rows.length, total: totalScanned,
    meta: { id: `mega-${cfg.id}`, title: cfg.title, summary: cfg.summary, match: cfg.match, tier: cfg.tier, url: cfg.url || cfg.urls?.[0] || null },
    rows,
  };
  fs.writeFileSync(path.join(CACHE_DIR, `mega-${cfg.id}.json`), JSON.stringify(out));
  console.log(`[mega] ${cfg.id}: ${rows.length} politician-matching rows kept (of ${totalScanned} scanned)`);
}
// Same minimal CSV parser as ingest.js (kept local: this file must stand alone).
function parseCsv(text, maxRows = 2000000) {
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
const matchRow = (needles, row) => { const t = normLine(row.join(" | ")); return needles.some((n) => t.includes(n)); };
const CAP = 5000; // max kept rows per dataset — evidence content is capped anyway

// --- per-kind refreshers ----------------------------------------------------
async function refreshOne(cfg, needles, { rematchOnly = false } = {}) {
  const rawDir = path.join(MEGA_DIR, cfg.id);
  try {
    if (cfg.kind === "zip-xlsx" || cfg.kind === "zip-csv") {
      if (!cfg.url) return console.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
      const zipPath = path.join(rawDir, "data.zip");
      if (!rematchOnly || !fs.existsSync(zipPath)) await downloadToFile(cfg.url, zipPath);
      const { unzipSync } = await import("fflate");
      const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      const rows = []; let total = 0;
      for (const [name, data] of Object.entries(files)) {
        if (cfg.kind === "zip-xlsx" && name.endsWith(".xlsx")) {
          const X = await import("xlsx");
          const wb = X.read(Buffer.from(data), { type: "buffer" });
          for (const sn of wb.SheetNames) {
            for (const r of X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: "" })) {
              total++;
              if (rows.length < CAP && r.some((c) => String(c).trim()) && matchRow(needles, r.map(String))) rows.push(r.map(String));
            }
          }
        } else if (cfg.kind === "zip-csv" && name.endsWith(".csv")) {
          for (const r of parseCsv(Buffer.from(data).toString("utf8"))) {
            total++;
            if (rows.length < CAP && matchRow(needles, r)) rows.push(r);
          }
        }
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "csv-multi") {
      if (!cfg.urls?.length) return console.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
      const rows = []; let total = 0;
      for (const u of cfg.urls) {
        const f = path.join(rawDir, u.split("/").pop());
        if (!rematchOnly || !fs.existsSync(f)) await downloadToFile(u, f);
        for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
          total++;
          if (rows.length < CAP && matchRow(needles, r)) rows.push(r);
        }
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "csv-stream") {
      if (!cfg.urls?.length) return console.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
      const rows = []; let total = 0;
      for (const u of cfg.urls) {
        const f = path.join(rawDir, u.split("/").pop().split("?")[0] || "part.csv");
        if (!rematchOnly || !fs.existsSync(f)) {
          console.log(`[mega] ${cfg.id}: downloading ${u} (large — be patient)…`);
          await downloadToFile(u, f);
        }
        // Line-streamed filter: never loads the file into memory. Naive comma
        // split is fine — kept lines only feed substring matching + display.
        const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
        for await (const line of rl) {
          total++;
          if (rows.length < CAP && needles.some((n) => normLine(line).includes(n))) rows.push(line.split(","));
        }
        console.log(`[mega] ${cfg.id}: scanned ${total} lines so far, kept ${rows.length}`);
      }
      return writeMegaCache(cfg, rows, total);
    }
    console.log(`[mega] ${cfg.id}: unknown kind ${cfg.kind}`);
  } catch (e) { console.error(`[mega] ${cfg.id}: FAILED — ${e.message}`); }
}

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "--refresh" || cmd === "--rematch") {
  const which = argv[1] ?? "all";
  const targets = which === "all" ? MEGA_SOURCES : MEGA_SOURCES.filter((s) => s.id === which);
  if (!targets.length) { console.error(`[mega] unknown id '${which}'. Known: ${MEGA_SOURCES.map((s) => s.id).join(", ")}`); process.exit(1); }
  const needles = buildNeedles();
  console.log(`[mega] roster: ${needles.length} politician-name needles`);
  for (const cfg of targets) await refreshOne(cfg, needles, { rematchOnly: cmd === "--rematch" });
  process.exit(0);
} else {
  for (const s of MEGA_SOURCES) {
    const f = path.join(CACHE_DIR, `mega-${s.id}.json`);
    let line = "no cache — run: node server/mega-ingest.js --refresh " + s.id;
    try { const c = JSON.parse(fs.readFileSync(f, "utf8")); line = `${c.count} matched rows (of ${c.total}), refreshed ${c.fetched_at}`; } catch {}
    console.log(`[mega] ${s.id}: ${line}`);
  }
  process.exit(0);
}
```

Verification for Step 6:
1. `node server/mega-ingest.js` → prints a status line per dataset ("no cache" initially).
2. Fill in the resolvable URLs per each entry's `note` (assam zip, POCSO CKAN zip,
   budgets CSV list). Leave `ddl-judicial` unconfigured — it needs the owner to
   supply the Dropbox link; the script must print "not configured" and exit clean.
3. `node server/mega-ingest.js --refresh assam-tenders-ocds` → ends with
   `[mega] assam-tenders-ocds: N politician-matching rows kept (of M scanned)`.
4. `npm run ingest -- --state Assam` → politicians with tender hits gain
   `l1_mega_assam_tenders_ocds` evidence rows, with no change needed in ingest.js
   beyond Step 1 (the mega-cache loop is already there).
5. `--rematch all` reuses downloads in `server/data/mega/` (no network) — use it
   after adding new politicians.

## Guardrails

- NEVER let L1 code throw out of `ingestFor`/`ingestAll` — every helper above
  already fails soft; keep it that way.
- Add `server/data/l1-cache/` AND `server/data/mega/` to `.gitignore` if a
  `.gitignore` exists; never commit cache JSONs or raw mega downloads.
- Do not raise `maxRows` or the 12-hit/160-char content caps — evidence
  `content` is read by the LLM layer; the caps are deliberate token budgets.
- The ONLY new .js file allowed is `server/mega-ingest.js`. Do not add npm
  scripts. Do not modify `store.js`, `report-generator.js`, or any fetcher
  except the Kanoon one-liner. `npm run ingest` must NEVER trigger a mega
  download — mega refresh is owner-run only.
- Max ~3 attempts per dead URL, then `format: null` + `skipped:` and move on.

## Done criteria

- All 27 catalogue sources represented: implemented in `L1_SOURCES` /
  `L1_CASE_MONITORS`, implemented in `MEGA_SOURCES` (4 datasets, `ddl-judicial`
  allowed to stay "not configured" pending the owner's Dropbox link), or
  `skipped:` with a reason (the 2 landing pages).
- `npm run ingest -- --state <small state>` runs clean end-to-end; second run
  uses cache (no refresh lines); mega evidence rows appear once mega caches exist.
- `node server/mega-ingest.js` (status), `--refresh <id>`, and `--rematch all`
  all work; `--rematch` performs no network calls.
- Diff touches exactly three files: `server/ingest.js`, new
  `server/mega-ingest.js`, and the one-line `indian-kanoon.js` change.
