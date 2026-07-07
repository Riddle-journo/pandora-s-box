// CPPP procurement — searches the Central Public Procurement Portal
// Award-of-Contract (AOC) dataset for the politician's name OR an associated
// company name, surfacing government contracts (the favoritism / kickback trail).
//
// The full CPPP AOC dataset (~4.9M awards) is published as a downloadable SQLite
// database (~6.6 GB) at https://tender.sarthaksidhant.com/ . It is FAR too large
// to fetch per-ingest, so this fetcher queries a LOCAL copy you download once:
//
//   1. Download aoc_tenders.db (or the .zip) from a mirror on that page.
//   2. npm install better-sqlite3
//   3. Set env CPPP_DB_PATH=/abs/path/to/aoc_tenders.db
//
// Without the DB + driver it returns [] silently. Schema-introspecting: it finds
// the largest table and searches all its text columns, so it works regardless of
// the exact column names in whatever DB build you downloaded.
//
// Two-hop favoritism trail: pass company names (from the MCA fetcher, once built)
// via p._associatedCompanies to catch contracts awarded to a politician's firms.
let dbPromise = null, warned = false;

async function getDb() {
  const path = process.env.CPPP_DB_PATH;
  if (!path) return null;
  if (!dbPromise) dbPromise = (async () => {
    let Database;
    try { Database = (await import("better-sqlite3")).default; }
    catch { if (!warned) { console.warn("[fetchers] better-sqlite3 not installed — CPPP procurement disabled. Run: npm install better-sqlite3"); warned = true; } return null; }
    try {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      // Pick the largest user table and cache its text columns.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      let best = null, bestRows = -1;
      for (const t of tables) {
        try {
          const n = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
          if (n > bestRows) { bestRows = n; best = t; }
        } catch {}
      }
      if (!best) return null;
      const cols = db.prepare(`PRAGMA table_info("${best}")`).all();
      const textCols = cols.filter((c) => /TEXT|CHAR|CLOB|VARCHAR|^$/i.test(c.type || "")).map((c) => c.name);
      return { db, table: best, textCols, allCols: cols.map((c) => c.name) };
    } catch (e) { if (!warned) { console.warn("[fetchers] CPPP DB open failed:", e.message); warned = true; } return null; }
  })();
  return dbPromise;
}

export async function fetchCPPPProcurement(p) {
  const h = await getDb();
  if (!h) return [];

  const terms = [p.name, ...(p._associatedCompanies ?? [])].filter(Boolean);
  if (!terms.length) return [];

  // Search the most contentful text columns (award/bidder/contractor/title-like).
  const searchCols = h.textCols
    .filter((c) => /name|bidder|contractor|award|supplier|firm|party|title|org/i.test(c))
    .slice(0, 6);
  const cols = searchCols.length ? searchCols : h.textCols.slice(0, 6);
  if (!cols.length) return [];

  const rows = [];
  for (const term of terms.slice(0, 6)) {
    const where = cols.map((c) => `"${c}" LIKE ?`).join(" OR ");
    const params = cols.map(() => `%${term}%`);
    try {
      const r = h.db.prepare(`SELECT * FROM "${h.table}" WHERE ${where} LIMIT 25`).all(...params);
      for (const row of r) rows.push({ term, row });
    } catch {}
    if (rows.length >= 50) break;
  }
  if (!rows.length) return [];

  // Render up to 40 matched awards as readable lines (all columns).
  const seen = new Set();
  const lines = [];
  for (const { term, row } of rows.slice(0, 40)) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue; seen.add(key);
    const pairs = Object.entries(row)
      .filter(([, v]) => v != null && String(v).trim() && String(v).length < 200)
      .map(([k, v]) => `${k}: ${String(v).replace(/\s+/g, " ").trim()}`)
      .join(" | ");
    lines.push(`• [matched "${term}"] ${pairs}`);
  }

  return [{
    politician_id: p.id,
    source_type: "gem",
    tier: 5,
    admissible: true,
    title: `Government contracts (CPPP award-of-contract) — ${p.name}`,
    url: "https://eprocure.gov.in/cppp/",
    date: null,
    summary: `${rows.length} CPPP award-of-contract record(s) matched the politician's name or an associated company — verify identity; a contract awarded to a politician's firm/associate is a favoritism red flag.`,
    content: `CPPP award-of-contract matches (verify the party is genuinely linked before concluding):\n${lines.join("\n")}`.slice(0, 9000),
  }];
}
