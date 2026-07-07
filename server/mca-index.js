// One-time MCA bulk data indexer. Downloads (or reads local files) and builds
// a queryable SQLite DB at data/mca.db for the mca-directors fetcher.
//
// Data source: Ministry of Corporate Affairs via data.gov.in (free, open data).
// The two datasets needed:
//   1. Director Master Data    — DIN, director name, DOB
//   2. Company-Director Data   — DIN ↔ CIN mapping with designation + dates
//
// How to get the data files (two options):
//
// OPTION A: Auto-download (requires free data.gov.in API key):
//   1. Register at https://data.gov.in → My Account → API Keys
//   2. Set env DATA_GOV_KEY=<your-key>
//   3. node server/mca-index.js --download
//
// OPTION B: Manual download (no key needed):
//   1. Go to https://data.gov.in → search "MCA Director Master Data"
//   2. Download the latest CSV (typically 100–500 MB)
//   3. Go to https://data.gov.in → search "MCA Company Director Mapping"
//   4. Download the latest CSV
//   5. node server/mca-index.js --dir-file /path/to/directors.csv --map-file /path/to/mapping.csv
//
// What gets built: data/mca.db (SQLite, ~1–3 GB depending on vintage)
// Query by: politician name → matched DIN(s) → list of companies

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import https from "node:https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_OUT = path.join(__dirname, "..", "data", "mca.db");
const DATA_DIR = path.join(__dirname, "..", "data");

// data.gov.in resource IDs for MCA datasets (may change when new versions published;
// check data.gov.in/catalog/ministry-corporate-affairs for updated IDs).
const DGI_RESOURCES = {
  directors:       "0fcfe372-8a95-4b68-bba5-9e8df5c46e3e", // Director Master Data
  companyDirectors:"a6c81f35-9a95-4b68-bba5-9e8df5c46e3e", // Company-Director Mapping
};

const args = process.argv.slice(2);
const DOWNLOAD = args.includes("--download");
const DIR_FILE = args.includes("--dir-file") ? args[args.indexOf("--dir-file") + 1] : null;
const MAP_FILE = args.includes("--map-file") ? args[args.indexOf("--map-file") + 1] : null;

async function downloadFromDGI(resourceId, outPath) {
  const key = process.env.DATA_GOV_IN_KEY || process.env.DATA_GOV_KEY;
  if (!key) throw new Error("Set DATA_GOV_IN_KEY env var (free at data.gov.in)");
  const url = `https://api.data.gov.in/resource/${resourceId}?api-key=${key}&format=csv&offset=0&limit=99999999`;
  console.log(`  Downloading resource ${resourceId}…`);
  return new Promise((resolve, reject) => {
    const f = fs.createWriteStream(outPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.pipe(f);
      f.on("finish", () => { f.close(); console.log(`  Saved to ${outPath}`); resolve(); });
    }).on("error", reject);
  });
}

function normName(s) {
  return (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Stream-parse a CSV file line by line and call rowFn(cells[]) for each data row.
async function streamCsv(filePath, rowFn) {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, "utf8"), crlfDelay: Infinity });
  let header = null; let count = 0;
  for await (const line of rl) {
    const cells = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    if (!header) { header = cells.map((h) => h.toLowerCase().replace(/\s+/g, "_")); continue; }
    rowFn(cells, header); count++;
    if (count % 100000 === 0) process.stdout.write(`\r  ${(count / 1e6).toFixed(2)}M rows…`);
  }
  console.log(`\r  ${count.toLocaleString()} rows processed.`);
  return count;
}

async function buildIndex(dirFile, mapFile) {
  const Database = (await import("better-sqlite3")).default;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`Building MCA index at ${DB_OUT}…`);
  const db = new Database(DB_OUT);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = OFF");
  db.pragma("cache_size = 100000");

  db.exec(`
    DROP TABLE IF EXISTS directors;
    DROP TABLE IF EXISTS company_directors;
    CREATE TABLE directors (
      din TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_lower TEXT NOT NULL,
      dob TEXT
    );
    CREATE TABLE company_directors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      din TEXT NOT NULL,
      cin TEXT NOT NULL,
      company_name TEXT,
      designation TEXT,
      date_appointed TEXT,
      date_ceased TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_dir_name ON directors(name_lower);
    CREATE INDEX IF NOT EXISTS idx_cd_din   ON company_directors(din);
    CREATE INDEX IF NOT EXISTS idx_cd_cin   ON company_directors(cin);
  `);

  // Parse Director Master Data
  console.log(`\n[1/2] Indexing Director Master Data from ${dirFile}…`);
  const insertDir = db.prepare(
    `INSERT OR REPLACE INTO directors (din, name, name_lower, dob) VALUES (?, ?, ?, ?)`
  );
  const insertDirBatch = db.transaction((rows) => { for (const r of rows) insertDir.run(...r); });
  let batch = [];
  await streamCsv(dirFile, (cells, hdr) => {
    const din  = cells[hdr.indexOf("din")] || cells[0];
    const name = cells[hdr.indexOf("name")] ?? cells[hdr.indexOf("director_name")] ?? cells[1];
    const dob  = cells[hdr.indexOf("dob")] ?? cells[hdr.indexOf("date_of_birth")] ?? "";
    if (!din || !name || name.length < 2) return;
    batch.push([din, name, normName(name), dob]);
    if (batch.length >= 10000) { insertDirBatch(batch); batch = []; }
  });
  if (batch.length) insertDirBatch(batch);

  // Parse Company-Director Mapping
  console.log(`\n[2/2] Indexing Company-Director Mapping from ${mapFile}…`);
  const insertMap = db.prepare(
    `INSERT INTO company_directors (din, cin, company_name, designation, date_appointed, date_ceased, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMapBatch = db.transaction((rows) => { for (const r of rows) insertMap.run(...r); });
  batch = [];
  await streamCsv(mapFile, (cells, hdr) => {
    const din    = cells[hdr.indexOf("din")] ?? cells[0];
    const cin    = cells[hdr.indexOf("cin")] ?? cells[hdr.indexOf("company_cin")] ?? cells[1];
    const cname  = cells[hdr.indexOf("company_name")] ?? cells[2] ?? "";
    const desig  = cells[hdr.indexOf("designation")] ?? cells[3] ?? "";
    const appd   = cells[hdr.indexOf("date_of_appointment")] ?? cells[4] ?? "";
    const ceased = cells[hdr.indexOf("date_of_cessation")] ?? cells[5] ?? "";
    const active = !ceased || ceased.trim() === "" ? 1 : 0;
    if (!din || !cin) return;
    batch.push([din, cin, cname, desig, appd, ceased, active]);
    if (batch.length >= 10000) { insertMapBatch(batch); batch = []; }
  });
  if (batch.length) insertMapBatch(batch);

  db.close();

  const stat = fs.statSync(DB_OUT);
  console.log(`\nDone! MCA index built at ${DB_OUT} (${(stat.size / 1e9).toFixed(2)} GB)`);
  console.log("Set env MCA_DB_PATH=" + DB_OUT + " (or leave if using the default location)");
  console.log("Wire fetcher: add fetchMCADirectors to server/ingest.js imports + Promise.all");
}

// ── Runtime lookup (used ONLY inside investigator.js, on a handful of top-lead
// names — never in the population loop). Opens the prebuilt data/mca.db read-only
// and returns the companies a person (by name) is/was a director of. Returns []
// when the DB was never built, so callers degrade gracefully. ──────────────────
let _lookupDb = null; // null=untried, false=unavailable, else {db}
let _Database, _sqliteTried = false;
function sqlite() {
  if (_sqliteTried) return _Database;
  _sqliteTried = true;
  try { _Database = createRequire(import.meta.url)("better-sqlite3"); }
  catch { _Database = null; }
  return _Database;
}
function lookupDb() {
  if (_lookupDb !== null) return _lookupDb || null;
  const dbPath = process.env.MCA_DB_PATH || DB_OUT;
  const Database = sqlite();
  if (!Database || !fs.existsSync(dbPath)) { _lookupDb = false; return null; }
  try {
    _lookupDb = { db: new Database(dbPath, { readonly: true, fileMustExist: true }) };
    return _lookupDb;
  } catch { _lookupDb = false; return null; }
}

export function lookupDirectorCompanies(name, { limit = 25 } = {}) {
  const h = lookupDb();
  if (!h) return [];
  const nl = normName(name);
  if (nl.length < 4) return [];
  try {
    const dins = h.db.prepare("SELECT din, name FROM directors WHERE name_lower = ? OR name_lower LIKE ? LIMIT 10")
      .all(nl, `%${nl}%`);
    if (!dins.length) return [];
    const out = [];
    const q = h.db.prepare("SELECT cin, company_name, designation, date_appointed, date_ceased, is_active FROM company_directors WHERE din = ? LIMIT ?");
    for (const d of dins) {
      for (const r of q.all(d.din, limit)) {
        out.push({ matched_din: d.din, matched_name: d.name, cin: r.cin, company_name: r.company_name, designation: r.designation, active: !!r.is_active, appointed: r.date_appointed || null, ceased: r.date_ceased || null });
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  } catch { return []; }
}

async function main() {
  if (!DOWNLOAD && !DIR_FILE) {
    console.log(`MCA Bulk Data Indexer

Options:
  --download                    Auto-download from data.gov.in (needs DATA_GOV_KEY env)
  --dir-file  <path/to/dir.csv> Director Master Data CSV (from data.gov.in)
  --map-file  <path/to/map.csv> Company-Director Mapping CSV (from data.gov.in)

Where to get the files:
  1. https://data.gov.in → search "MCA Director Master Data" → Download CSV
  2. https://data.gov.in → search "Company Director Data MCA" → Download CSV
  Then: node server/mca-index.js --dir-file <f1> --map-file <f2>
`);
    process.exit(0);
  }

  let dirFile = DIR_FILE;
  let mapFile = MAP_FILE;

  if (DOWNLOAD) {
    dirFile = path.join(DATA_DIR, "mca_directors_raw.csv");
    mapFile = path.join(DATA_DIR, "mca_mapping_raw.csv");
    console.log("Downloading MCA bulk data from data.gov.in…");
    await downloadFromDGI(DGI_RESOURCES.directors, dirFile);
    await downloadFromDGI(DGI_RESOURCES.companyDirectors, mapFile);
  }

  if (!dirFile || !fs.existsSync(dirFile)) { console.error(`Director file not found: ${dirFile}`); process.exit(1); }
  if (!mapFile || !fs.existsSync(mapFile))  { console.error(`Mapping file not found: ${mapFile}`); process.exit(1); }

  await buildIndex(dirFile, mapFile);
}

// Only run the CLI when executed directly — NOT when imported for lookups.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("mca-index.js")) {
  main().catch((err) => { console.error("Fatal:", err); process.exit(1); }).finally(() => process.exit(0));
}
