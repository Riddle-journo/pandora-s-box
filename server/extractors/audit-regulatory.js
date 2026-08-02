// Audit + regulatory-order L1 extractors (constitutional audit & statutory
// tribunal/regulator orders). These bulk "L1" corpora are already fetched and
// matched per-politician as RAW NAME MATCHES against the roster — a report title
// or a name buried in a PDF body mentions someone who shares a politician's name.
// Exactly like financial-links.js and indian-kanoon.js, a raw name match is NEVER
// a hard fact and never a public accusation: its honest home is the CLAIMS ledger
// at LOW confidence with identity_unverified flagged.
//
// Two families, one shape:
//   • AUDIT bodies (CAG national index, state Accountant-General reports, MP Local
//     Fund Audit, SFIO investigations, FIU publications) → claim_type
//     "named_in_audit_report".
//   • REGULATORY / tribunal orders (SAFEMA/PMLA/FEMA appellate = ATFP, NCLT,
//     NCLAT, ITAT, NGT, Rajasthan RIC, KSPCB consent/closure orders) → claim_type
//     "named_in_regulatory_order".
//
// KEEP ALL DATA / universal subjects (hard rule): every matched ROW yields a claim
// on the politician subject — a row is never dropped for "this isn't the
// politician". And every OTHER named party in the row/body excerpt (a company,
// PSU, official, or professional) grows a low-confidence RELATIONSHIP edge from the
// politician entity to that party — so a later cross-entity detector can spot the
// SAME company/order/report linked to several politicians, a pattern a journalist
// would chase.
//
// The evidence blob (built by l1Match in server/ingest.js, shared by mega caches)
// is: "<Title> (<N> matching rows, dataset of <M>):\n• cellA | cellB | …\n• …"
// where each "• " line is one matched row, cells joined by " | ". For the body-text
// sources (cag-bihar/odisha, the mega *-body / *-orders caches) a long cell is a
// ~360-char window around the matched name — report/order prose, not the preamble.
import { registerExtractor, runExtraction } from "./extract.js";
import { parseMatchCount, parseAnyDate } from "./financial-links.js";

export const AUDIT_REGULATORY_VERSION = "audit-regulatory-v1";

const IDENTITY_NOTE = "Raw name match — verify identity before treating as a finding (common names collide).";

// Generic link labels that carry no report/order title of their own — fall back to
// the corpus header title when the first cell is one of these.
const GENERIC_LABEL = /^(read more|download(\s*pdf)?|click here|view|see more|order|orders|pdf|calend[ae]r|link|here)$/i;

// A cell is a "body excerpt" (report/order prose) when it is a long window or the
// l1Match snippet wrapper "…text…". Everything else is a short structured cell.
function isBodyCell(cell) {
  const s = String(cell);
  return s.length > 200 || /^\s*…/.test(s) || /…\s*$/.test(s);
}

// Company / PSU / statutory-body suffixes seen across audit & order prose. Matched
// case-insensitively so both "HT Media Ltd." and "NATIONAL TEXTILE CORPN LIMITED"
// are caught.
// Suffix words are matched only as the FINAL token of a name (Sahkari/Samiti etc.
// deliberately omitted — as standalone suffixes they fragment "SAHKARI SAMITI LTD"
// into pieces; the trailing "Ltd" anchors the whole span instead).
const ORG_SUFFIX =
  "(?:Ltd|Limited|Pvt\\.?\\s*Ltd|LLP|Corpn|Corporation|Company|Companies|Industries|Textiles?|Infrastructures?|Enterprises?|Constructions?|Builders?|Developers?|Motors?|Mills?|Cements?|Steels?|Udyog|Nigam|Bank|Ceramics|Society|Trust|Foundation|Hospitals?|Hotels?|Resorts?|Minerals?|Housing|Realty|Estates?|Traders?|Agencies|Associates|Panchayat|Municipality)";
// A name word must START with a letter (so pure numbers / "(Ins)" / "No." bridges
// like "No. 992 of 2024 HT Media Ltd" can't be swept into one org). CORE is the
// capitalised first word; WORD is any following name word.
const CORE = "[A-Z][A-Za-z0-9&.'\\-]*";
const WORD = "[A-Za-z][A-Za-z0-9&.'\\-]*";
// Lazy middle so a name ends at its FIRST suffix word ("HT Media Ltd"), not the
// far one ("HT Media Ltd. Vs. GHCL Ltd"). A leading "Vs"/"With" connector that the
// scan swallows (e.g. "Vs GHCL Ltd") is stripped back off in cleanParty.
const ORG_RE = new RegExp(`\\b(${CORE}(?:\\s+${WORD}){0,6}?\\s+${ORG_SUFFIX})\\.?\\b`, "gi");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const normKey = (s) => norm(s).toLowerCase().replace(/[.,]+$/, "");
const looksOrg = (name) =>
  new RegExp(`\\b${ORG_SUFFIX}\\b`, "i").test(String(name));

// Trim trailing filler ("& Anr", "& Ors", "With", stray brackets) off a captured
// party name and reject junk (too short / no letters).
function cleanParty(raw) {
  let s = norm(raw)
    .replace(/^(?:v\/?s\.?|with|and|the|m\/s\.?)\s+/i, "")   // connector the scan swallowed
    .replace(/\s*&\s*(Anr|Ors|Others|another)\b.*$/i, "")
    .replace(/\s*\[[^\]]*$/, "")
    .replace(/[|•]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.,\-\s]+$/, "")
    .trim();
  if (s.length < 4 || s.length > 70) return null;
  if (!/[A-Za-z]/.test(s)) return null;
  if (/^(the|and|with|vs|dob|hon|shri|smt|ms|mr|dated)\b/i.test(s)) return null;
  return s;
}

// Pull every OTHER named party (companies/PSUs/officials) out of a row's text.
// `selfName` is the matched politician — excluded so we never point an edge back at
// the subject.
export function extractParties(text, selfName) {
  const self = normKey(selfName);
  const out = [];
  const seen = new Set();
  const push = (raw, kind) => {
    const name = cleanParty(raw);
    if (!name) return;
    const key = normKey(name);
    if (!key || seen.has(key)) return;
    if (self && (key === self || key.includes(self))) return;
    seen.add(key);
    out.push({ name, kind: kind ?? (looksOrg(name) ? "org" : "person") });
  };
  const t = String(text ?? "");
  for (const m of t.matchAll(ORG_RE)) push(m[1], "org");
  return out.slice(0, 8);
}

// Split the evidence content into a header + one parsed record per "• " row.
export function parseAuditRegulatory(data = {}) {
  const content = String(data.content ?? "");
  const { matched, dataset } = parseMatchCount(content);
  const headerTitle = norm(content.split("\n")[0].replace(/\s*\(\d+\s+matching row[\s\S]*$/i, "")) || null;
  // The matched politician lives at the tail of the evidence title: "<Title> — <NAME>".
  const selfName = norm(String(data.title ?? "").split(/\s+—\s+/).slice(1).join(" — "));

  const rows = [];
  for (const line of content.split("\n")) {
    if (!/^\s*•\s+/.test(line)) continue;
    const cells = line.replace(/^\s*•\s+/, "").split(" | ").map((c) => c.trim()).filter(Boolean);
    if (!cells.length) continue;
    const url = cells.find((c) => /^https?:\/\//i.test(c)) ?? null;
    const bodyCell = cells.find(isBodyCell) ?? null;
    const labelCell = cells.find((c) => c !== url && !isBodyCell(c)) ?? null;
    const docTitle = labelCell && !GENERIC_LABEL.test(labelCell) ? labelCell : (headerTitle ?? labelCell);
    // Date: only from the short structured cells (body prose dates — DOBs, hearing
    // logs — are noise), else null.
    const nonBody = cells.filter((c) => c !== bodyCell);
    const date = nonBody.map((c) => parseAnyDate(c)).find(Boolean) ?? null;
    const parties = extractParties([labelCell, bodyCell].filter(Boolean).join(" "), selfName);
    rows.push({ docTitle: docTitle ? norm(docTitle) : null, label: labelCell, url, body: bodyCell, date, parties });
  }
  return { headerTitle, matched, dataset, selfName: selfName || null, rows };
}

// ── Source-type → family classification ──────────────────────────────────────
// CAG / Accountant-General / Local Fund Audit / SFIO / FIU = audit reports.
// Everything else registered here (ATFP, NCLT, NCLAT, ITAT, NGT, RIC, KSPCB) is a
// regulatory / tribunal order.
export function isAuditSource(sourceType) {
  return /cag|(^|_)ag_|_lfa|lfa_|_lfa$|sfio|fiu|audit/i.test(String(sourceType));
}

// ── Emit (claims + relationships), one claim per matched row ──────────────────
export function auditRegulatoryRecords(data = {}, sourceType = "") {
  const parsed = parseAuditRegulatory(data);
  if (!parsed.rows.length) return {};
  const audit = isAuditSource(sourceType);
  const claimType = audit ? "named_in_audit_report" : "named_in_regulatory_order";
  const source = String(sourceType || data.source_type || "").replace(/^l1_/, "") || "audit_regulatory";
  const kindNote = audit ? " Named in audit-report text — not itself an adverse finding." : " Named in an order/appeal — not itself the party held liable.";

  const claims = [];
  const relationships = [];
  const seenObj = new Set();
  for (const r of parsed.rows) {
    // object_text: report title / order subject (+ opposing party when the body
    // gives a "A Vs B" pairing), capped for the ledger.
    const vsPair = r.parties.length >= 2 && r.body && /\bV\/?[Ss]\.?\b/.test(r.body)
      ? `${r.parties[0].name} vs ${r.parties[1].name}` : null;
    let object_text = r.docTitle || parsed.headerTitle || "(untitled)";
    if (vsPair && !object_text.toLowerCase().includes(vsPair.split(" vs ")[0].toLowerCase())) object_text = `${object_text} — ${vsPair}`;
    object_text = object_text.slice(0, 200);

    // Dedup identical object_text within one evidence blob (upsertClaim would drop
    // the duplicate anyway; skip early to keep counts honest).
    const dk = object_text.toLowerCase();
    if (!seenObj.has(dk)) {
      seenObj.add(dk);
      claims.push({
        claim_type: claimType,
        object_text,
        status: "unverified",
        confidence: audit ? 0.22 : 0.2,
        as_of_date: r.date,
        data: {
          source, doc_title: r.label ?? r.docTitle ?? null, url: r.url ?? null,
          report_title: parsed.headerTitle, matched_rows: parsed.matched, dataset_rows: parsed.dataset,
          note: IDENTITY_NOTE + kindNote,
        },
      });
    }

    for (const party of r.parties) {
      relationships.push({
        rel_type: audit ? "named_in_same_audit" : "named_in_same_order",
        dst_name: party.name,
        dst_kind: party.kind,
        valid_from: r.date,
        confidence: 0.15,
        data: {
          source, doc_title: r.label ?? r.docTitle ?? null, report_title: parsed.headerTitle,
          identity_unverified: true,
        },
      });
    }
  }
  const out = {};
  if (claims.length) out.claims = claims;
  if (relationships.length) out.relationships = relationships;
  return out;
}

// ── Registration ──────────────────────────────────────────────────────────────
// Every source_type below is a `l1_<id>` where <id> is an L1_SOURCES / mega cache
// id with dashes → underscores. Sources whose base config is match:"none" never
// emit evidence today (registration is a harmless no-op that future-proofs a later
// switch to match:"name"); the body/mega variants carry the real matched rows.
export const AUDIT_SOURCE_TYPES = [
  "l1_cag_audit_index",   // CAG national performance/compliance/PSU audit index
  "l1_cag_bihar",         // Bihar Accountant-General audit reports (title + body)
  "l1_cag_odisha",        // Odisha Accountant-General audit reports (title + body)
  "l1_sfio_investigations", // SFIO investigations completed / convicted directors
  "l1_fiu_publications",  // FIU-IND annual reports (named penalty actions in PDFs)
  "l1_mp_lfa_audit",      // MP Local Fund Audit report index
  "l1_mp_lfa_body",       // MP Local Fund Audit report BODIES (mega, body-text)
];

export const ORDER_SOURCE_TYPES = [
  "l1_atfp_orders",            // SAFEMA/PMLA/FEMA appellate order index
  "l1_atfp_orders_body",       // …order BODIES (mega, body-text)
  "l1_nclt_orders",            // NCLT order PDFs (mega, body-text)
  "l1_nclat_orders",           // NCLAT judgement/order PDFs (mega, body-text)
  "l1_itat_orders",            // ITAT order PDFs (mega, body-text)
  "l1_ngt_recent_orders",      // very-recent NGT orders (mega, body-text)
  "l1_ric_raj_decisions",      // Rajasthan RIC RTI second-appeal decisions (mega)
  "l1_ric_raj_body",           // …decision BODIES (mega, body-text)
  "l1_ric_rajasthan_decisions", // Rajasthan RIC base index
  "l1_kspcb_consent",          // KSPCB consent/closure orders
];

export const AUDIT_REGULATORY_SOURCE_TYPES = [...AUDIT_SOURCE_TYPES, ...ORDER_SOURCE_TYPES];

for (const st of AUDIT_REGULATORY_SOURCE_TYPES) {
  registerExtractor(st, {
    version: AUDIT_REGULATORY_VERSION,
    extract: (ev) => auditRegulatoryRecords(ev.data ?? {}, st),
  });
}

export function runAuditRegulatoryExtraction() {
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  for (const st of AUDIT_REGULATORY_SOURCE_TYPES) {
    const r = runExtraction({ sourceType: st });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/audit-regulatory.js");
if (invokedDirectly) {
  console.log("[audit-regulatory] extraction done:", JSON.stringify(runAuditRegulatoryExtraction()));
  process.exit(0);
}
