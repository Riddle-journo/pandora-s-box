// District-treasury PAYMENT extractor — bulk "L1" government disbursement corpora
// (CivicDataLab's Balasore district-treasury dump and the AP child-budget-tagged
// treasury spend). Each cached row is a raw government payment line: a payee /
// office name, a scheme / budget head, an amount, a date, and (sometimes) a DDO.
//
// These are RAW NAME MATCHES against the roster — a politician's name merely
// appears somewhere in the row's cells, so identity is UNVERIFIED (common names
// collide) exactly like financial-links.js. That means the honest home is the
// CLAIMS ledger at LOW confidence with the identity note, plus — where a clean
// amount parses — ONE numeric FACT per row so the existing generic_outlier
// detector can z-score treasury payments automatically. If the named party looks
// like a firm/company rather than the politician, we ALSO grow a RELATIONSHIP edge
// (politician → firm) instead of dropping the row. KEEP ALL DATA / universal
// subjects: every matched row yields a record; nothing is filtered for "not the
// politician".
//
// Unlike the once-per-evidence summary in financial-links.js, treasury evidence is
// a small set of near-independent payment rows, so we emit ONE record set PER ROW.
import { registerExtractor, runExtraction } from "./extract.js";
import { parseAnyDate } from "./financial-links.js";

export const TREASURY_VERSION = "treasury-payments-v1";

// financial-links.js keeps IDENTITY_NOTE private; redefine the same text here
// (we must not edit that file).
const IDENTITY_NOTE = "Raw name match — verify identity before treating as a finding (common names collide).";

// A cell that names a private firm/company (a payee we should edge to, not the
// politician). "corporation" is deliberately absent — it collides with government
// bodies (Municipal Corporation) and is handled by OFFICE_RE instead.
const FIRM_RE = /\b(?:pvt|private|ltd|limited|llp|company|companies|enterprises?|constructions?|traders?|agenc(?:y|ies)|industries|infra(?:structure)?|associates|contractors?|builders?|udyog|suppliers?|steels?|and\s+co|&\s*co)\b/i;
// A cell that names a government office / DDO (drawing-and-disbursing officer).
const OFFICE_RE = /\b(?:officer|office|ddo|treasury|department|dept|directorate|division|circle|zilla|panchayat|nagar|municipal|corporation|tahasildar|tahsildar|engineer)\b/i;

// "₹1,23,456" | "Rs 45,000" | "725504" → Number; anything non-numeric → null.
// Strips a leading ₹/Rs/INR marker, Indian comma grouping, and stray spaces.
export function parseAmount(cell) {
  let s = String(cell ?? "").trim();
  if (!s) return null;
  s = s.replace(/^(?:₹|rs\.?|inr)\s*/i, "").replace(/,/g, "").replace(/\s+/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const isTextCell = (c) => /[A-Za-z]{3}/.test(c) && c.includes(" ") && !parseAnyDate(c) && parseAmount(c) === null;

// parseAnyDate() is greedy — a budget/head code like "23-2401-00-001" yields a
// bogus "2401-00-00". Accept only calendar-sane values so codes don't win.
function pickDate(cells) {
  for (const c of cells) {
    const d = parseAnyDate(c);
    const m = d && /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    if (!m) continue;
    const [y, mo, da] = [+m[1], +m[2], +m[3]];
    if (y >= 1950 && y <= 2100 && mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return d;
  }
  return null;
}

// Parse ONE "• cellA | cellB | ..." row into lead-grade fields. Layouts vary
// wildly between corpora, so every field is heuristic (documented per source):
//   • date   — first cell parseAnyDate() accepts (ISO or dd-MON-yyyy)
//   • amount — the largest clean numeric cell (the payment; head codes are small
//              or non-numeric, so max reliably lands on the money column)
//   • ddo    — first office/DDO-looking cell
//   • payee  — a firm-looking cell (→ relationship) else the DDO/office
//   • scheme — the longest descriptive phrase (department / budget-head text),
//              excluding the ddo and firm cells so it stays a distinct field
export function parseTreasuryRow(line) {
  const cells = String(line ?? "")
    .replace(/^\s*•\s*/, "")
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);
  if (!cells.length) return null;

  const date = pickDate(cells);

  let amount = null;
  for (const c of cells) { const n = parseAmount(c); if (n != null && (amount == null || n > amount)) amount = n; }

  const firmCell = cells.find((c) => FIRM_RE.test(c) && !OFFICE_RE.test(c)) ?? null;
  const ddo = cells.find((c) => OFFICE_RE.test(c)) ?? null;
  const payee_is_firm = Boolean(firmCell);
  const payee = firmCell ?? ddo;

  let scheme = null;
  for (const c of cells) {
    if (c === ddo || c === firmCell || !isTextCell(c)) continue;
    if (!scheme || c.length > scheme.length) scheme = c;
  }

  return { cells, date, amount, scheme, ddo, payee, payee_is_firm };
}

// Split evidence content into its "• …" payment rows and parse each.
export function parseTreasuryContent(content) {
  return String(content ?? "")
    .split("\n")
    .filter((l) => /^\s*•/.test(l))
    .map(parseTreasuryRow)
    .filter(Boolean);
}

const inr = (n) => Number(n).toLocaleString("en-IN");

// Build the ledger records for one evidence blob. `source` is the friendly corpus
// label stamped into every record's data (e.g. "balasore_treasury").
export function treasuryRecords(data = {}, source = "district_treasury") {
  const rows = parseTreasuryContent(data.content);
  const claims = [];
  const facts = [];
  const relationships = [];

  for (const r of rows) {
    const head = r.scheme || r.ddo || r.payee || "treasury payment";
    const object_text = (r.amount != null ? `${head} — ₹${inr(r.amount)}` : head).slice(0, 200);

    claims.push({
      claim_type: "named_treasury_payee",
      object_text,
      as_of_date: r.date,
      status: "unverified",
      confidence: 0.2,
      data: { source, scheme: r.scheme, amount_inr: r.amount, ddo: r.ddo, note: IDENTITY_NOTE },
    });

    // One numeric fact per row (only when a clean amount parses) — low-noise, so
    // generic_outlier can z-score the politician's treasury payments.
    if (r.amount != null) {
      facts.push({
        metric: "treasury_payment_inr",
        value: r.amount,
        unit: "INR",
        as_of_date: r.date,
        subject_kind: "politician",
        data: { source, scheme: r.scheme, ddo: r.ddo },
      });
    }

    // Named party is a firm, not the politician → grow a graph edge instead of
    // dropping the row.
    if (r.payee_is_firm && r.payee) {
      relationships.push({
        rel_type: "treasury_payee_firm",
        dst_name: r.payee,
        dst_kind: "company",
        valid_from: r.date,
        confidence: 0.15,
        data: { source, scheme: r.scheme, amount_inr: r.amount, identity_unverified: true },
      });
    }
  }

  return { claims, facts, relationships };
}

// source_type → friendly corpus label. Register ONLY the treasury corpora whose
// L1 cache exists with named payee rows (server/data/l1-cache/*.json):
//   • l1_balasore_treasury — Balasore (Odisha) district treasury, FY2014-18.
//       cols: ddo_code|ddo_name|dept_code|dept_name|budget_code|major..detailed
//       heads|object_head|allot_serial|allot_date(ISO)|allot_id|alloted|
//       expenditure|surrender|deduct|balance. DDO=ddo_name, scheme=dept/head,
//       date=allot_date, amount=max(alloted,expenditure).
//   • l1_ap_child_treasury — AP child-budget-tagged treasury spend.
//       cols: district|year|month|timestamp(dd-MON-yyyy)|head_of_account|major..
//       sub-detailed head codes|plan|voted|head TYPE + DESCRIPTIONS…|amount(last).
//       No DDO column; scheme=longest head description, date=timestamp,
//       amount=Amount.
export const TREASURY_SOURCES = {
  l1_balasore_treasury: "balasore_treasury",
  l1_ap_child_treasury: "ap_child_treasury",
};

export const TREASURY_SOURCE_TYPES = Object.keys(TREASURY_SOURCES);

for (const [st, source] of Object.entries(TREASURY_SOURCES)) {
  registerExtractor(st, { version: TREASURY_VERSION, extract: (ev) => treasuryRecords(ev.data ?? {}, source) });
}

export function runTreasuryExtraction() {
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  for (const st of TREASURY_SOURCE_TYPES) {
    const r = runExtraction({ sourceType: st });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/treasury-payments.js");
if (invokedDirectly) {
  console.log("[treasury-payments] extraction done:", JSON.stringify(runTreasuryExtraction()));
  process.exit(0);
}
