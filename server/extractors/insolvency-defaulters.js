// Corporate-insolvency + wilful-defaulter LINK extractor (companion to
// financial-links.js). Four bulk "mega" corpora are already fetched + name-matched
// per politician as raw `evidence` text, but had NO extractor, so detectors could
// not see them:
//
//   • IBBI CIRP public announcements  — corporate debtor / applicant / insolvency
//     professional / dates for every company in a Corporate Insolvency Resolution
//     Process.
//   • IBBI disciplinary orders        — orders against named insolvency professionals.
//   • RBI wilful-defaulter lists (Bank of Baroda, Punjab National Bank) — borrower
//     companies + co-directors/guarantors (name / DIN / PAN) suit-filed for ₹25L+.
//
// Exactly like financial-links.js these are RAW NAME MATCHES against the roster
// ("common Indian names collide"), so the honest home is the CLAIMS + EVENTS
// ledgers at LOW confidence with identity_unverified flagged — never a hard fact,
// never a public accusation. Their real value is the RELATIONSHIPS ledger: each row
// grows an edge from the politician entity to a debtor / borrower COMPANY (and to
// any co-directors), carrying DIN / CIN / PAN as strong ids so a later cross-entity
// detector can spot the SAME company (or the SAME director) linked to several
// politicians, or cross-link a defaulter directorship against mca-directors.js.
//
// KEEP ALL DATA / universal subjects (hard rule): every matched row emits at least
// a summary claim — a row is NEVER dropped for "not the politician". The parsed
// specifics (debtor, directors, identifiers) live in `data` and on relationship edges.
import { registerExtractor, runExtraction } from "./extract.js";

export const INSOLVENCY_DEFAULTERS_VERSION = "insolvency-defaulters-v1";

// ── shared helpers (modelled on financial-links.js) ──────────────────────────
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
// "08-07-2026" | "2026-07-08" | "28-Jul-2022" | "03 July, 2026" → ISO, else null.
export function parseAnyDate(s) {
  const t = String(s ?? "").trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);                       // 2026-07-08
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})[/-]([A-Za-z]{3,9})[/-](\d{4})/);          // 28-Jul-2022
  if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`; }
  m = t.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);       // 03 July, 2026
  if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`; }
  m = t.match(/(\d{1,2})-(\d{2})-(\d{4})/);                        // 08-07-2026
  if (m) return `${m[3]}-${m[2]}-${String(m[1]).padStart(2, "0")}`;
  return null;
}

// "(23 matching rows, dataset of 37311)" → { matched: 23, dataset: 37311 }
export function parseMatchCount(content) {
  const m = String(content ?? "").match(/\((\d+)\s+matching rows?(?:,\s*dataset of\s+(\d+))?\)/i);
  return { matched: m ? Number(m[1]) : null, dataset: m && m[2] ? Number(m[2]) : null };
}

export const IDENTITY_NOTE = "Raw name match — verify identity (address, company, DIN/PAN) before treating as a finding (common names collide).";

// Bullet rows written by ingest l1Match: "• cellA | cellB | ...". Returns each
// row as an array of trimmed cells.
export function contentRows(content) {
  return [...String(content ?? "").matchAll(/^•\s*(.*)$/gm)]
    .map((m) => m[1].split(" | ").map((c) => c.trim()));
}
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const isNoise = (s) => !s || /^\(\s*[\d.]+\s*[KMG]?B\s*\)$/i.test(s); // "(1.11 MB)" cell etc.

// Indian identifier shapes.
const PAN_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/g;                              // ABCDE1234F
const CIN_RE = /\b([LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6})\b/g;       // 21-char CIN
// 4th char of a PAN encodes holder type: P = individual; C/F/T/A/B/G/J/H/L = an entity.
const isEntityPan = (pan) => /^[A-Z]{3}[CFTABGJHL]/.test(pan);

function uniq(arr) { return [...new Set(arr)]; }

// Company-name heuristic. The borrower cell is a run-on with no delimiters, so we
// token-walk: a company is a maximal run of "name words" that contains at least one
// corporate-suffix word, trimmed to end at the LAST suffix word (so a trailing
// director name isn't swallowed) and capped at 5 words.
const COMPANY_SUFFIX = new Set([
  "PVT", "PRIVATE", "LIMITED", "LTD", "LLP", "INDUSTRIES", "ENTERPRISES", "EXPORTS",
  "IMPEX", "OVERSEAS", "TEXTILES", "POLYMERS", "PLYWOOD", "MOTORS", "STEEL", "STEELS",
  "FOOD", "FOODS", "MILL", "MILLS", "INFRA", "INFRASTRUCTURE", "CONSTRUCTION",
  "CONSTRUCTIONS", "TRADERS", "TRADER", "PROJECTS", "PROJECT", "FINISHING", "FASHION",
]);
// Words that never belong inside a company name (banks, branches, cities, roles).
const NAME_STOP = new Set([
  "SUIT", "SF", "BANK", "OF", "BARODA", "PUNJAB", "NATIONAL", "NEW", "DELHI",
  "CHANDIGARH", "MUMBAI", "PUNE", "NAGPUR", "GUJARAT", "MAHARASHTRA", "HARYANA",
  "ZOSARB", "ARMB", "RB", "DIRECTOR", "DIRECTORS", "GUARANTOR", "PROP", "SMT",
  "MR", "MRS", "MS", "SHRI", "PAN", "DIN", "CIN",
]);
const stripDot = (t) => t.replace(/[.,()]+$/g, "").replace(/^[.,()]+/g, "");
const isNameWord = (t) => {
  const w = stripDot(t);
  return /^[A-Za-z][A-Za-z&'\-]*$/.test(w) && !NAME_STOP.has(w.toUpperCase());
};
function extractCompanies(body) {
  const toks = body.split(/\s+/);
  const out = [];
  let i = 0;
  while (i < toks.length) {
    if (!isNameWord(toks[i])) { i++; continue; }
    let j = i, lastSuffix = -1;
    while (j < toks.length && isNameWord(toks[j]) && j - i < 8) {
      if (COMPANY_SUFFIX.has(stripDot(toks[j]).toUpperCase())) lastSuffix = j;
      j++;
    }
    if (lastSuffix >= 0) {
      const start = Math.max(i, lastSuffix - 4);
      out.push(clean(toks.slice(start, lastSuffix + 1).map(stripDot).join(" ")));
    }
    i = Math.max(j, i + 1);
  }
  return uniq(out.filter((c) => c.length >= 5 && c.length <= 70));
}

// ── IBBI CIRP public announcements ───────────────────────────────────────────
// Row cells (fixed layout): [type, announcement_date, claim_last_date,
//   CORPORATE_DEBTOR, APPLICANT, INSOLVENCY_PROFESSIONAL, address, (pdf size), ""].
export function parseIbbiCirp(data = {}) {
  const rows = contentRows(data.content).map((c) => ({
    ann_date: parseAnyDate(c[1]),
    debtor: isNoise(c[3]) ? null : clean(c[3]),
    applicant: isNoise(c[4]) ? null : clean(c[4]),
    ip: isNoise(c[5]) ? null : clean(c[5]),
  })).filter((r) => r.debtor);
  if (!rows.length) return null;
  const { matched, dataset } = parseMatchCount(data.content);
  return { rows, matched, dataset };
}

export function ibbiCirpRecords(data) {
  const p = parseIbbiCirp(data); if (!p) return {};
  const first = p.rows[0];
  const more = p.rows.length > 1 ? ` (+${p.rows.length - 1} more debtor${p.rows.length > 2 ? "s" : ""})` : "";
  const rels = [];
  const seen = new Set();
  for (const r of p.rows) {
    const key = r.debtor.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      rels.push({ rel_type: "linked_insolvent_company", dst_name: r.debtor, dst_kind: "company", valid_from: r.ann_date, confidence: 0.22, data: { source: "ibbi_cirp", applicant: r.applicant, insolvency_professional: r.ip, identity_unverified: true } });
    }
  }
  return {
    claims: [{ claim_type: "linked_insolvency_proceeding", object_text: `${first.debtor} — corporate insolvency (CIRP)${more}`.slice(0, 200), as_of_date: first.ann_date, status: "unverified", confidence: 0.22, data: { source: "ibbi_cirp", company: first.debtor, role: "corporate debtor (CIRP)", applicant: first.applicant, matched_rows: p.matched, note: IDENTITY_NOTE } }],
    events: [{ kind: "insolvency_cirp_mention", at: first.ann_date, data: { company: first.debtor, applicant: first.applicant, count: p.rows.length, identity_unverified: true, confidence: 0.22 } }],
    relationships: rels,
  };
}

// ── IBBI disciplinary orders (against insolvency professionals) ───────────────
// Row cells: [serial, "03 July, 2026", "In the matter of Mr. NAME, Insolvency
//   Professional (size)", "Order of Disciplinary Committee"].
export function parseIbbiOrders(data = {}) {
  const rows = [];
  for (const c of contentRows(data.content)) {
    const cell = c.find((x) => /In the matter of/i.test(x)) || "";
    const nm = cell.match(/In the matter of\s+(?:Mr\.?|Ms\.?|Mrs\.?|Shri|Smt\.?|M\/s\.?)?\s*(.+?)\s*,?\s*(?:Insolvency Professional(?: Entity)?|IPE?\b)/i);
    const date = c.map((x) => parseAnyDate(x)).find(Boolean) || null;
    const name = nm ? clean(nm[1]) : null;
    if (name) rows.push({ name, date, order: clean(c[c.length - 1]) });
  }
  if (!rows.length) return null;
  const { matched } = parseMatchCount(data.content);
  return { rows, matched };
}

export function ibbiOrdersRecords(data) {
  const p = parseIbbiOrders(data); if (!p) return {};
  const first = p.rows[0];
  const rels = [];
  const seen = new Set();
  for (const r of p.rows) {
    const key = r.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rels.push({ rel_type: "linked_insolvency_professional", dst_name: r.name, dst_kind: "person", valid_from: r.date, confidence: 0.2, data: { source: "ibbi_orders", order: r.order, identity_unverified: true } });
  }
  const more = p.rows.length > 1 ? ` (+${p.rows.length - 1} more)` : "";
  return {
    claims: [{ claim_type: "linked_insolvency_proceeding", object_text: `${first.name} — IBBI disciplinary order (insolvency professional)${more}`.slice(0, 200), as_of_date: first.date, status: "unverified", confidence: 0.2, data: { source: "ibbi_orders", role: "insolvency professional (disciplinary order)", matched_rows: p.matched, note: IDENTITY_NOTE } }],
    events: [{ kind: "insolvency_order_mention", at: first.date, data: { name: first.name, count: p.rows.length, identity_unverified: true, confidence: 0.2 } }],
    relationships: rels,
  };
}

// ── RBI wilful-defaulter lists (Bank of Baroda / PNB) ─────────────────────────
// The borrower PDF body is one run-on cell; ingest shows a ~360-char window around
// the matched name. We token-extract identifiers (PAN / CIN / DIN) and corporate
// names rather than rely on fixed columns. PAN's 4th char classifies holder:
// entity PAN → borrower company; individual PAN → a co-director/guarantor.
export function parseWilfulDefaulter(data = {}) {
  const content = String(data.content ?? "");
  // Bank name = the title prefix before " — " (from the evidence title, else the
  // leading text of the content blob).
  const titleSrc = String(data.title ?? "") || content.split(/\(\d+\s+matching/)[0];
  const bank = clean(titleSrc.split(/\s+—\s+/)[0]) || "unknown bank";
  // Body = the matched rows only (drop the header line and the "• PDF | <url> |" prefix).
  const body = contentRows(content).map((c) => c.filter((x) => !/^https?:\/\//i.test(x) && x !== "PDF").join(" ")).join("  ");

  const pans = uniq([...body.matchAll(PAN_RE)].map((m) => m[1]));
  const cins = uniq([...body.matchAll(CIN_RE)].map((m) => m[1]));
  // Labelled DINs only (bare 8-digit numbers are too collision-prone to trust).
  const dins = uniq([...body.matchAll(/\bDIN[:\s]*(\d{6,8})\b/gi)].map((m) => m[1]));
  const entityPans = pans.filter(isEntityPan);
  const personPans = pans.filter((p) => !isEntityPan(p));
  const companies = extractCompanies(body);

  // Co-directors / guarantors: a capitalised name token sequence immediately
  // preceding a DIN or an individual PAN.
  const directors = new Map(); // name -> { name, din?, pan? }
  const addDir = (name, ids) => {
    const nm = clean(name).replace(/[.,(]+$/, "").replace(/^(?:Director|Guarantor|Prop\.?|Shri|Smt\.?|Mr\.?|Mrs\.?|Ms\.?)\s+/i, "").trim();
    if (!nm || nm.length < 4 || /\b(LIMITED|LTD|PVT|LLP|INDUSTRIES|ENTERPRISES|BANK)\b/i.test(nm)) return;
    // Drop candidates that are purely place/role tokens (a city grabbed off a
    // run-on line is not a co-director) — keep only names with a real word.
    if (nm.split(/\s+/).every((w) => NAME_STOP.has(w.toUpperCase()))) return;
    const cur = directors.get(nm) || { name: nm };
    directors.set(nm, { ...cur, ...ids });
  };
  for (const m of body.matchAll(/([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.']+){0,4})\s*[(,]?\s*DIN[:\s]*(\d{6,8})/gi)) addDir(m[1], { din: m[2] });
  for (const m of body.matchAll(/([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.']+){0,4})[\s,(]+([A-Z]{5}\d{4}[A-Z])\b/g)) {
    if (!isEntityPan(m[2])) addDir(m[1], { pan: m[2] });
  }

  const borrower = companies[0] || null;
  const date = parseAnyDate(content);
  const suit = /\bsuit\b|\bSF\b/i.test(body);
  return { bank, borrower, companies, pans, entityPans, personPans, cins, dins, directors: [...directors.values()], suit, date };
}

export function wilfulDefaulterRecords(data) {
  const p = parseWilfulDefaulter(data);
  // KEEP ALL DATA: a matched row always emits the summary claim, even when no
  // borrower/company/identifier could be parsed out of the run-on snippet.
  const obj = `suit-filed wilful defaulter — ${p.bank}${p.borrower ? ` (${p.borrower})` : ""}`;
  const out = {
    claims: [{ claim_type: "named_wilful_defaulter", object_text: obj.slice(0, 200), as_of_date: p.date, status: "unverified", confidence: 0.2, data: { source: "rbi_wilful_defaulter", bank: p.bank, company: p.borrower, suit_filed: p.suit, pans: p.pans, dins: p.dins, cins: p.cins, note: IDENTITY_NOTE } }],
    events: [{ kind: "wilful_defaulter_mention", at: p.date, data: { bank: p.bank, company: p.borrower, identity_unverified: true, confidence: 0.2 } }],
    relationships: [],
  };
  if (p.borrower) {
    const ids = {};
    if (p.cins[0]) ids.cin = p.cins[0];
    if (p.entityPans[0]) ids.pan = p.entityPans[0];
    out.relationships.push({ rel_type: "linked_defaulter_company", dst_name: p.borrower, dst_kind: "company", dst_strong_ids: ids, valid_from: p.date, confidence: 0.18, data: { source: "rbi_wilful_defaulter", bank: p.bank, suit_filed: p.suit, identity_unverified: true } });
  }
  for (const d of p.directors) {
    const ids = {};
    if (d.din) ids.din = d.din;
    else if (d.pan) ids.pan = d.pan;
    out.relationships.push({ rel_type: "linked_defaulter_codirector", dst_name: d.name, dst_kind: "person", dst_strong_ids: ids, valid_from: p.date, confidence: 0.15, data: { source: "rbi_wilful_defaulter", bank: p.bank, identity_unverified: true } });
  }
  return out;
}

// ── registration ─────────────────────────────────────────────────────────────
// source_type = `l1_${meta.id.replaceAll("-","_")}`. The mega caches on disk stamp
// meta.id = `mega-<id>` (writeMegaCache in mega-ingest.js), so the LIVE source_types
// are the `l1_mega_*` forms below. The bare `l1_ibbi_*`/`l1_rbi_*` forms are also
// registered defensively (harmless no-ops if no such evidence exists) so a differently
// stamped install is still covered.
const CIRP_SOURCE_TYPES = ["l1_mega_ibbi_cirp", "l1_ibbi_cirp"];
const ORDERS_SOURCE_TYPES = ["l1_mega_ibbi_orders", "l1_ibbi_orders"];
const WD_SOURCE_TYPES = ["l1_mega_rbi_wd_bob", "l1_mega_rbi_wd_pnb", "l1_rbi_wd_bob", "l1_rbi_wd_pnb"];

for (const st of CIRP_SOURCE_TYPES) registerExtractor(st, { version: INSOLVENCY_DEFAULTERS_VERSION, extract: (ev) => ibbiCirpRecords(ev.data ?? {}) });
for (const st of ORDERS_SOURCE_TYPES) registerExtractor(st, { version: INSOLVENCY_DEFAULTERS_VERSION, extract: (ev) => ibbiOrdersRecords(ev.data ?? {}) });
for (const st of WD_SOURCE_TYPES) registerExtractor(st, { version: INSOLVENCY_DEFAULTERS_VERSION, extract: (ev) => wilfulDefaulterRecords(ev.data ?? {}) });

export const INSOLVENCY_DEFAULTER_SOURCE_TYPES = [
  ...CIRP_SOURCE_TYPES, ...ORDERS_SOURCE_TYPES, ...WD_SOURCE_TYPES,
];

export function runInsolvencyDefaulterExtraction() {
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  for (const st of INSOLVENCY_DEFAULTER_SOURCE_TYPES) {
    const r = runExtraction({ sourceType: st });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/insolvency-defaulters.js");
if (invokedDirectly) {
  console.log("[insolvency-defaulters] extraction done:", JSON.stringify(runInsolvencyDefaulterExtraction()));
  process.exit(0);
}
