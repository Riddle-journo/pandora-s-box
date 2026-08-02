// Affidavit extractors — the first REAL extractors (Phase 2C). They turn ECI/ADR
// affidavit data into numeric facts, from BOTH places it lives:
//
//   affidavit_row  — the parsed summary on each politician row (~4,235 reps):
//                    declared_assets, declared_liabilities, criminal_cases.
//   eci_affidavit  — the scraped full-affidavit evidence content (~1,491 reps):
//                    criminal_cases (with FIR detail) + a declared_income TIME
//                    SERIES (year-by-year, self only — spouse income is excluded).
//
// Both attach to the same person entity; source_type + evidence_id keep them
// distinct and traceable, so a detector can prefer the court-admissible source or
// reconcile the two. Registering happens on import (side effect), so importing
// this module makes the extractors available to the framework.
//
// NOTE on money parsing: server/util/numbers.js parseRupees() now handles the MyNeta
// "Rs 3,09,16,833 ~ 3 Crore+" format correctly (it cuts the "~ N Crore+" approximation
// before parsing). We keep our own parseAffidavitRupees() here because it adds
// affidavit-specific semantics parseRupees() does not: "Nil"/"None"/"N/A" → 0.
import { registerExtractor, runExtraction, runPoliticianExtraction } from "./extract.js";

export const AFFIDAVIT_ROW_VERSION = "affidavit-row-v1";
export const ECI_AFFIDAVIT_VERSION = "eci-affidavit-v1";

// Exact rupee value from a MyNeta affidavit string. Takes the figure before the
// "~ N Crore+" approximation and reads its digits. "Nil"/"None" → 0; blank → null.
export function parseAffidavitRupees(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;
  const digits = str.split("~")[0].replace(/[^0-9]/g, "");
  if (digits) return Number(digits);
  if (/\b(nil|none|not\s*applicable|n\/?a)\b/i.test(str)) return 0;
  return null;
}

// Election year from a MyNeta URL (…/LokSabha2024/…, …/Karnataka2023/…) → "2024".
export function electionYearFromUrl(url) {
  const m = String(url ?? "").match(/myneta\.info\/[A-Za-z]*?(\d{4})/);
  return m ? m[1] : null;
}

// Pure: a politician's parsed affidavit object → fact records (semantic fields only).
export function affidavitRowFacts(aff, { as_of_date = null } = {}) {
  if (!aff || typeof aff !== "object") return [];
  const out = [];
  const assets = parseAffidavitRupees(aff.assets);
  if (assets != null) out.push({ metric: "declared_assets", value: assets, unit: "inr", as_of_date });
  const liab = parseAffidavitRupees(aff.liabilities);
  if (liab != null) out.push({ metric: "declared_liabilities", value: liab, unit: "inr", as_of_date });
  const cc = Number(aff.criminal_cases);
  if (Number.isFinite(cc)) out.push({ metric: "criminal_cases", value: cc, unit: "count", as_of_date });
  return out;
}

// Pure: scraped eci_affidavit content → fact records. Criminal-case count plus the
// SELF income-tax time series (spouse section deliberately dropped).
export function eciAffidavitFacts(content) {
  const text = String(content ?? "");
  const out = [];

  const cc = text.match(/CRIMINAL CASES DECLARED:\s*(\d+)/i);
  if (cc) out.push({ metric: "criminal_cases", value: Number(cc[1]), unit: "count" });

  const blk = text.match(/INCOME-TAX RETURN HISTORY:([\s\S]{0,800})/i);
  if (blk) {
    const selfPart = blk[1].split(/spouse/i)[0]; // never attribute spouse income to the rep
    const seen = new Set();
    for (const m of selfPart.matchAll(/(\d{4})\s*-\s*\d{4}\s*\*\*\s*Rs\s*([\d,]+)/g)) {
      const year = m[1];
      const val = Number(m[2].replace(/[^0-9]/g, ""));
      if (!Number.isFinite(val) || seen.has(year)) continue; // first (earliest) FY start per year wins
      seen.add(year);
      out.push({ metric: "declared_income", value: val, unit: "inr", as_of_date: year, period: `FY${year}` });
    }
  }
  return out;
}

// Business interests declared under oath in the affidavit (evidence.numbers.interests,
// parsed at ingest). Unlike the raw-name-match link extractors, these are HIGH
// confidence — a sworn declaration, not a namesake — so they are the best company
// edges in the graph: they let the collusion detector spot the SAME company across
// several reps, and company-registry.js verify them against the MCA struck-off list.
// A few non-company rows (land / deposits / cash) slip into MyNeta's "interests"
// column, so we drop obvious non-entities.
const NON_COMPANY = /\b(agricultur|land|plot|deposit|fd\b|fixed deposit|cash|jewel|gold|silver|insurance polic|nsc|ppf|bond|mutual fund|shares? in|vehicle|none|nil|not applicable|n\.?a\.?)\b/i;
export function affidavitInterestLinks(numbers = {}) {
  const interests = Array.isArray(numbers.interests) ? numbers.interests : [];
  const rels = [];
  const seen = new Set();
  for (const it of interests) {
    const name = String(it?.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length < 3 || NON_COMPANY.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rels.push({
      rel_type: "declared_business_interest", dst_name: name.slice(0, 120), dst_kind: "company",
      confidence: 0.7, // sworn affidavit declaration
      data: { sector: it?.sector ?? null, owner: it?.owner ?? "self", source: "eci_affidavit" },
    });
  }
  const facts = [];
  if (rels.length) facts.push({ metric: "declared_business_interests", value: rels.length, unit: "count", data: {} });
  const props = Array.isArray(numbers.properties) ? numbers.properties : [];
  if (props.length) facts.push({ metric: "declared_immovable_properties", value: props.length, unit: "count", data: {} });
  // Asset-CATEGORY value facts (populated once affidavits are re-ingested with the
  // extended MyNeta parser). cash_in_hand + loans_given are the benami/parking
  // markers; the general outlier detectors (generic_outlier, multivariate) cover
  // them with no bespoke rule the moment they land.
  const cats = numbers.asset_categories && typeof numbers.asset_categories === "object" ? numbers.asset_categories : null;
  if (cats) for (const [metric, value] of Object.entries(cats)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) facts.push({ metric, value: n, unit: "inr", data: {} });
  }
  return { facts, relationships: rels };
}

// ── register both extractors with the framework ─────────────────────────────
registerExtractor("affidavit_row", {
  version: AFFIDAVIT_ROW_VERSION,
  extract: (ev) => ({ facts: affidavitRowFacts(ev.data?.affidavit, { as_of_date: ev.data?.election_year ?? null }) }),
});
registerExtractor("eci_affidavit", {
  version: ECI_AFFIDAVIT_VERSION,
  extract: (ev) => {
    const links = affidavitInterestLinks(ev.data?.numbers ?? {});
    return { facts: [...eciAffidavitFacts(ev.data?.content), ...links.facts], relationships: links.relationships };
  },
});

// Synthesize an evidence-shaped row from a politician for the affidavit_row source.
// Stable id (polaff:<pid>) → idempotent re-runs.
function rowEvidence(p) {
  return {
    id: `polaff:${p.id}`, politician_id: p.id, source_type: "affidavit_row", tier: 1,
    data: { source_type: "affidavit_row", tier: 1, affidavit: p.affidavit, election_year: electionYearFromUrl(p.myneta_url) },
  };
}

// Run BOTH affidavit sources. Returns per-source counts.
export function runAffidavitExtraction() {
  const row = runPoliticianExtraction("affidavit_row", rowEvidence);
  const eci = runExtraction({ sourceType: "eci_affidavit" });
  return { row, eci };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/affidavit.js");
if (invokedDirectly) {
  const c = runAffidavitExtraction();
  console.log("[affidavit] extraction done:");
  console.log("  affidavit_row:", JSON.stringify(c.row));
  console.log("  eci_affidavit:", JSON.stringify(c.eci));
  process.exit(0);
}
