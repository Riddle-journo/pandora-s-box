// MCA (Ministry of Corporate Affairs) directorship lookup via local SQLite index.
//
// Requires a one-time download + index build. Run:
//   node server/mca-index.js --download      (downloads from data.gov.in, needs DATA_GOV_KEY)
//   node server/mca-index.js --file directors.csv --file company-directors.csv
//
// Once built (data/mca.db), set env:
//   MCA_DB_PATH=data/mca.db     (or leave unset if file is at that default path)
//
// Source: MCA21 bulk data via data.gov.in (Ministry of Corporate Affairs, Govt of India).
// Updated: monthly releases on data.gov.in.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordAssertion } from "../entities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.join(__dirname, "..", "..", "data", "mca.db");

const NORM = (s) => (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const TOKENS = (s) => NORM(s).split(/\s+/).filter((t) => t.length >= 3);
const nameScore = (a, b) => {
  const A = TOKENS(a); const B = new Set(TOKENS(b));
  const hit = A.filter((t) => B.has(t)).length;
  return A.length ? hit / A.length : 0;
};

// Returns null if DB not available — fetcher degrades to [].
let _dbPromise = null;
function getDb() {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const dbPath = process.env.MCA_DB_PATH || DEFAULT_DB;
      try {
        const { default: Database } = await import("better-sqlite3");
        return new Database(dbPath, { readonly: true, fileMustExist: true });
      } catch { return null; }
    })();
  }
  return _dbPromise;
}

export async function fetchMCADirectors(p) {
  const db = await getDb();
  if (!db) return [];

  // Find director rows matching politician's name (fuzzy token match)
  let candidates;
  try {
    // Search by first significant name token for speed, then re-score
    const tokens = TOKENS(p.name);
    if (!tokens.length) return [];
    const primary = tokens[0]; // e.g. "narendra" from "Narendra Modi"
    candidates = db.prepare(
      `SELECT d.din, d.name FROM directors d WHERE d.name_lower LIKE ?`
    ).all(`%${primary}%`);
  } catch { return []; }

  if (!candidates.length) return [];

  // Score name matches; require ≥0.6 coverage of politician's tokens
  const scored = candidates.map((c) => ({ c, score: nameScore(p.name, c.name) }));
  const matched = scored
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5); // cap at top 5 DINs to avoid false positives

  // Entity layer (additive — does NOT change what this fetcher returns): record
  // each identity decision so it can be audited/undone. DIN is a strong id, so a
  // confident match auto-accepts; the 0.45–0.6 gray zone (otherwise discarded) is
  // recorded as a proposed token_score assertion for a human to review.
  const DIR_URL = "https://www.mca.gov.in/mca/html/searchDir.html";
  try {
    for (const { c, score } of matched) {
      recordAssertion({
        subject_kind: "person", raw_name: c.name, source: "mca_directors",
        source_ref: c.din != null ? String(c.din) : null, politician_id: p.id,
        confidence: score, method: c.din ? "strong_id" : "token_score", evidence_url: DIR_URL,
      });
    }
    for (const { c, score } of scored.filter((x) => x.score >= 0.45 && x.score < 0.6)) {
      recordAssertion({
        subject_kind: "person", raw_name: c.name, source: "mca_directors",
        source_ref: c.din != null ? String(c.din) : null, politician_id: p.id,
        confidence: score, method: "token_score", evidence_url: DIR_URL,
      });
    }
  } catch { /* recording must never break ingestion */ }

  if (!matched.length) return [];

  const allCompanies = [];
  for (const { c } of matched) {
    let rows;
    try {
      rows = db.prepare(
        `SELECT cin, company_name, designation, date_appointed, date_ceased, is_active
         FROM company_directors WHERE din = ?`
      ).all(c.din);
    } catch { continue; }
    allCompanies.push(...rows.map((r) => ({ ...r, director_name: c.name, din: c.din })));
  }

  if (!allCompanies.length) return [];

  const active   = allCompanies.filter((r) => r.is_active);
  const resigned = allCompanies.filter((r) => !r.is_active);

  const fmt = (r) => [
    `• ${r.company_name} (CIN: ${r.cin})`,
    `  Role: ${r.designation}`,
    `  Appointed: ${r.date_appointed || "?"}${r.date_ceased ? `  Ceased: ${r.date_ceased}` : ""}`,
    `  Status: ${r.is_active ? "ACTIVE" : "RESIGNED/CEASED"}`,
  ].join("\n");

  const lines = [
    active.length ? `ACTIVE DIRECTORSHIPS (${active.length}):\n${active.map(fmt).join("\n")}` : null,
    resigned.length ? `PAST DIRECTORSHIPS (${resigned.length}):\n${resigned.map(fmt).join("\n")}` : null,
  ].filter(Boolean);

  return [{
    politician_id: p.id,
    source_type: "mca_directors",
    tier: 6,
    admissible: true,
    title: `MCA21 directorship record — ${p.name}`,
    url: `https://www.mca.gov.in/mca/html/searchDir.html`,
    date: null,
    summary: `MCA21 shows ${active.length} active and ${resigned.length} past company directorships linked to "${p.name}" (verify DIN matches this politician).`,
    content: `MCA21 Company Directorships for "${p.name}" (source: data.gov.in bulk Director Master Data):\n\n${lines.join("\n\n")}`,
  }];
}
