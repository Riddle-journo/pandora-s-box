// CPPP flatten/index — turns the read-only 6.6 GB CPPP award DB (4.9M rows, the
// award fields buried in a per-row details_json blob) into a LEAN, INDEXED table
// the procurement detectors can scan in milliseconds instead of json_extracting
// 4.5M blobs on every run. One-time (refreshable) ETL; writes to its OWN sqlite
// file so it never touches the source DB or the main pandoros.db.
//
//   Source:  CPPP_DB_PATH        (read-only; aoc_tenders + aoc_details)
//   Output:  CPPP_FLAT_PATH      (default: <CPPP_DB dir>/cppp_flat.db)
//
//   node server/cppp-index.js            # full flatten (few minutes)
//   node server/cppp-index.js --limit 50000   # quick slice for validation
//
// Every award row → { internal_id, tender_id, year, state, buyer, buyer_norm,
// bidder, bidder_norm, bidder_addr, value, bids, ttype, contract_date,
// published_date, title }. bidder_norm/buyer_norm are the grouping keys.
import "dotenv/config";
import path from "node:path";

// Normalise a company/org name for grouping: uppercase, drop ONLY the true
// corporate-form suffixes + honorifics ("M/S", "PVT", "LTD", "LLP") — never the
// distinguishing words like ENTERPRISES / CONSTRUCTIONS / ENGINEERS, which are
// part of the actual name (else "Raj Constructions" and "Raj Enterprises" collide
// into "RAJ"). Two spellings of the SAME firm still collapse; different firms stay
// distinct. A key with fewer than 2 tokens or <5 chars is treated as unreliable by
// the detectors (too generic to group on).
const FORM_NOISE = /\b(M\/?S|MESSRS|PVT|PRIVATE|LTD|LIMITED|LLP|THE)\b/g;
export function normName(s) {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9&/ ]+/g, " ").replace(FORM_NOISE, " ").replace(/\s+/g, " ").trim();
}
// A grouping key is only reliable if it has ≥2 tokens and ≥6 chars (so bare
// initials like "S K" or a single common word don't merge unrelated firms).
export const reliableKey = (norm) => { const t = String(norm ?? "").trim(); return t.length >= 6 && t.split(" ").length >= 2; };

// Parse "16-Jun-2026 12:00 AM" → ISO "2026-06-16" (or null).
const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
export function parseCpppDate(s) {
  const m = String(s ?? "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  return mo ? `${m[3]}-${mo}-${m[1].padStart(2, "0")}` : null;
}

// Contract Value comes as a string; occasionally in lakhs ("9.5") vs rupees
// ("1874075"). We CANNOT reliably tell, so keep the raw number and let detectors
// use robust/relative comparisons rather than absolute thresholds.
const toNum = (v) => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
const toInt = (v) => { const n = parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; };

export function flatPath() {
  if (process.env.CPPP_FLAT_PATH) return process.env.CPPP_FLAT_PATH;
  const src = process.env.CPPP_DB_PATH;
  return src ? path.join(path.dirname(src), "cppp_flat.db") : null;
}

export async function buildCpppIndex({ limit = null, log = console.log } = {}) {
  const src = process.env.CPPP_DB_PATH;
  if (!src) { log("[cppp-index] CPPP_DB_PATH not set — nothing to index."); return { ok: false, reason: "no_source" }; }
  let Database;
  try { Database = (await import("better-sqlite3")).default; }
  catch { log("[cppp-index] better-sqlite3 not installed."); return { ok: false, reason: "no_driver" }; }

  const srcDb = new Database(src, { readonly: true, fileMustExist: true });
  const out = flatPath();
  const outDb = new Database(out);
  outDb.pragma("journal_mode = WAL");
  outDb.pragma("synchronous = OFF"); // ETL of a rebuildable table — speed over durability
  outDb.exec(`
    DROP TABLE IF EXISTS cppp_awards;
    CREATE TABLE cppp_awards (
      internal_id TEXT PRIMARY KEY, tender_id TEXT, year INTEGER, state TEXT,
      buyer TEXT, buyer_norm TEXT, bidder TEXT, bidder_norm TEXT, bidder_addr TEXT,
      value REAL, bids INTEGER, ttype TEXT, contract_date TEXT, published_date TEXT, title TEXT
    );
  `);
  const ins = outDb.prepare(`INSERT OR REPLACE INTO cppp_awards
    (internal_id, tender_id, year, state, buyer, buyer_norm, bidder, bidder_norm, bidder_addr, value, bids, ttype, contract_date, published_date, title)
    VALUES (@internal_id,@tender_id,@year,@state,@buyer,@buyer_norm,@bidder,@bidder_norm,@bidder_addr,@value,@bids,@ttype,@contract_date,@published_date,@title)`);

  const sql = `
    SELECT d.internal_id, d.tender_id, d.details_json, t.year, t.org_name state, t.title
    FROM aoc_details d LEFT JOIN aoc_tenders t ON t.internal_id = d.internal_id
    WHERE d.details_json IS NOT NULL AND length(d.details_json) > 40
    ${limit ? `LIMIT ${Number(limit)}` : ""}`;
  const iter = srcDb.prepare(sql).iterate();

  let n = 0, kept = 0, batch = [];
  const flush = outDb.transaction((rows) => { for (const r of rows) ins.run(r); });
  const t0 = Date.now();
  for (const row of iter) {
    n++;
    let d;
    try { d = JSON.parse(row.details_json); } catch { continue; }
    const bidder = d["Name of the selected bidder(s)"] ?? null;
    const rec = {
      internal_id: row.internal_id, tender_id: row.tender_id ?? null,
      year: row.year ?? null, state: row.state ?? null,
      buyer: d["Organisation Name"] ?? null, buyer_norm: normName(d["Organisation Name"]),
      bidder, bidder_norm: normName(bidder),
      bidder_addr: d["Address of the selected bidder(s)"] || null,
      value: toNum(d["Contract Value"]), bids: toInt(d["Number of bids received"]),
      ttype: d["Tender Type"] ?? null,
      contract_date: parseCpppDate(d["Contract Date"]),
      published_date: parseCpppDate(d["Published Date"] ?? d["Award Published Date"]),
      title: (d["Tender Description"] ?? row.title ?? "").slice(0, 200),
    };
    batch.push(rec); kept++;
    if (batch.length >= 50000) { flush(batch); batch = []; log(`[cppp-index] ${n.toLocaleString()} scanned, ${kept.toLocaleString()} kept…`); }
  }
  if (batch.length) flush(batch);

  log("[cppp-index] building indexes…");
  outDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_cppp_bidder ON cppp_awards(bidder_norm);
    CREATE INDEX IF NOT EXISTS idx_cppp_buyer  ON cppp_awards(buyer_norm);
    CREATE INDEX IF NOT EXISTS idx_cppp_bids   ON cppp_awards(bids);
    CREATE INDEX IF NOT EXISTS idx_cppp_value  ON cppp_awards(value);
    CREATE INDEX IF NOT EXISTS idx_cppp_year   ON cppp_awards(year);
  `);
  srcDb.close(); outDb.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[cppp-index] done: ${kept.toLocaleString()} awards flattened to ${out} in ${secs}s`);
  return { ok: true, scanned: n, kept, out, secs: Number(secs) };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("server/cppp-index.js");
if (invokedDirectly) {
  const li = process.argv.indexOf("--limit");
  const limit = li >= 0 ? Number(process.argv[li + 1]) : null;
  await buildCpppIndex({ limit });
  process.exit(0);
}
