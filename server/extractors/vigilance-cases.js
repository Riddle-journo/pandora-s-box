// Anti-corruption / vigilance / blacklist LINK extractors (Phase 2 "links" pass).
//
// These L1 sources — Lokayukta/Lokpal ombudsman cause-lists, state vigilance &
// anti-corruption bureau press/FIR listings, ACB FIR tables, procurement
// blacklists (banned/debarred firms), UGC fake-university lists, and NIA
// most-wanted rosters — are all RAW NAME MATCHES against the roster: a politician's
// name merely appears somewhere in a matched row. Common names collide, and the
// person/firm actually named is frequently NOT the politician at all. So, exactly
// like financial-links.js and indian-kanoon.js, the honest home is the CLAIMS
// ledger at LOW confidence with identity_unverified flagged — never a hard fact and
// never a public accusation.
//
// Their real value is the RELATIONSHIPS ledger. KEEP ALL DATA / universal subjects
// is a hard rule here: we NEVER drop a matched row for "that co-accused / that
// blacklisted firm isn't the politician". Every OTHER named party in the row (a
// co-accused person, a debarred company, a fake university) becomes an edge from the
// politician entity to that party's entity, so a later cross-entity detector can
// spot the SAME firm or person linked to several politicians — a pattern a
// journalist would chase.
//
// One claim per matched ROW (distinct object_text keeps them from colliding in the
// claims UNIQUE index); parsed specifics live in each record's `data`.
import { registerExtractor, runExtraction } from "../extract.js";
import { parseAnyDate, parseMatchCount } from "./financial-links.js";

export const VIGILANCE_CASES_VERSION = "vigilance-cases-v1";

const IDENTITY_NOTE =
  "Raw name match — verify identity before treating as a finding (common names collide; the party named may not be the politician).";

// ── date helper ──────────────────────────────────────────────────────────────
// parseAnyDate handles "2008-10-03", "28-Jul-2022", "21-07-2022". Vigilance rows
// also carry dotted/numeric-slash dates ("07.08.2019", "07/08/2024") — normalise
// those (day-first, Indian convention) after deferring to parseAnyDate.
export function parseLooseDate(s) {
  const t = String(s ?? "").trim();
  const iso = parseAnyDate(t);
  if (iso) return iso;
  const m = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/); // 07.08.2019 | 07/08/2024
  if (m) return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  return null;
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const firstDate = (cells) => { for (const c of cells) { const d = parseLooseDate(c); if (d) return d; } return null; };
const alphaLen = (s) => (String(s).match(/[A-Za-zऀ-ॿ]/g) || []).length;
const longestCell = (cells) => cells.slice().sort((a, b) => alphaLen(b) - alphaLen(a))[0] || "";
// A case / FIR / crime reference: "01/2026- PS ACB Srinagar", "162/2025", "RC 5/2020".
const pickCaseNo = (cells) => {
  for (const c of cells) {
    const t = String(c).trim();
    if (parseLooseDate(t) === t) continue;            // a bare date is not a case no
    if (/\b(?:FIR|Case|Crime|RC|VE|PS)\b/i.test(t) || /\b\d{1,4}\/\d{4}\b/.test(t)) return t.slice(0, 80);
  }
  return null;
};

// ── source_type → parser config ──────────────────────────────────────────────
// category: "vigilance" (named_in_vigilance_case) | "blacklist" (named_on_blacklist)
// layout: which per-row parser to run (columns differ per dataset — see notes).
const CONFIG = {
  // Ombudsman / vigilance document-listing pages: rows are [link-text, url]; the
  // link text is a report / press-release / cause-list title naming an official.
  l1_ap_lokayukta:               { category: "vigilance", layout: "linklist" },
  l1_ts_lokayukta:               { category: "vigilance", layout: "linklist" },
  l1_kerala_lokayukta:           { category: "vigilance", layout: "linklist" },
  l1_karnataka_lokayukta_reports:{ category: "vigilance", layout: "linklist" },
  l1_kerala_vacb:                { category: "vigilance", layout: "linklist" },
  l1_uk_vigilance:               { category: "vigilance", layout: "linklist" },
  l1_punjab_vb_press:            { category: "vigilance", layout: "linklist" },
  // ACB J&K FIR table: [S.No, FIR No, Date of Registration, Brief Allegations,
  // Individuals under Investigation, Remarks].
  l1_acb_jk_fir:                 { category: "vigilance", layout: "fir" },
  // HP SVACB district FIRs: table layout varies per district → heuristic FIR parse.
  l1_hp_svacb_firs:              { category: "vigilance", layout: "firGeneric" },
  // NIA Most Wanted: [name/title, url, ...] — the absconder IS the named party.
  l1_nia_most_wanted:            { category: "vigilance", layout: "mostWanted" },
  // Karnataka Lokayukta PDF bodies (mega cache): [title, url, body-snippet]; the
  // snippet holds enquiry numbers and many respondent-official names.
  l1_mega_ka_lokayukta_body:     { category: "vigilance", layout: "lokayuktaBody" },
  l1_ka_lokayukta_body:          { category: "vigilance", layout: "lokayuktaBody" }, // alias per spec
  // REC banned-firms (Hindi cols): [Sr, Company, Address, Ban date, Duration, Reason, Remark].
  l1_rec_banned:                 { category: "blacklist", layout: "recBanned" },
  // DSND Haryana blacklist: [Title (contains "M/s <firm>"), Date, Download].
  l1_dsnd_haryana_blacklist:     { category: "blacklist", layout: "dsndBlacklist" },
  // UGC fake universities: [Sr No, State, University Name (+ address)].
  l1_ugc_fake:                   { category: "blacklist", layout: "ugcFake" },
  // IREPS railways banned/suspended firms: layout unknown → heuristic firm parse.
  l1_ireps_banned:               { category: "blacklist", layout: "banGeneric" },
};

export const VIGILANCE_SOURCE_TYPES = Object.keys(CONFIG);

// ── row utilities ────────────────────────────────────────────────────────────
// Split the evidence `content` body into rows of cells. Content shape:
//   "<title> (<N> matching rows, dataset of <M>):\n• cellA | cellB | cellC\n• …"
export function parseRowLines(content) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("•"))                 // "• "
    .map((l) => l.replace(/^•\s*/, "").split(" | ").map((c) => c.trim()));
}

// A stray table header row that slipped through the name filter — skip it.
function looksLikeHeader(cells) {
  const first = norm(cells[0]);
  if (["s no", "sr no", "sl no", "sno", "srno"].includes(first)) return true;
  return cells.some((c) => /^(fir no|university name|company name|brief allegations|individuals under investigation|view \/ download)$/i.test(String(c).trim()));
}

// Is this candidate party actually the matched politician (so we don't self-link)?
function isMatched(name, matchedNorm) {
  if (!matchedNorm || matchedNorm.length < 4) return false;
  const n = norm(name);
  return n.length >= 4 && (n.includes(matchedNorm) || matchedNorm.includes(n));
}

// Clean a candidate party name → null if it isn't a usable proper noun.
function cleanName(raw) {
  let n = String(raw ?? "").replace(/^\d+\.?\s*/, "").split(",")[0].trim();
  n = n.replace(/\s+/g, " ").trim();
  if (alphaLen(n) < 4 || n.length > 60) return null;
  if (!/[A-Za-zऀ-ॿ]/.test(n)) return null;
  return n;
}

const personRel = (name, source, date) => ({
  rel_type: "co_accused_in_vigilance_case", dst_name: name, dst_kind: "person",
  valid_from: date, confidence: 0.2, data: { source, identity_unverified: true },
});
const firmRel = (name, kind, source, date) => ({
  rel_type: "named_with_blacklisted_firm", dst_name: name, dst_kind: kind,
  valid_from: date, confidence: 0.2, data: { source, identity_unverified: true },
});

// Split an "accused / individuals under investigation" cell into party fragments.
function splitParties(cell) {
  return String(cell ?? "")
    .split(/;|(?:^|\s)\d+\.\s+|\band\b(?=\s+[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── per-row parsers → { claim, relationships } ───────────────────────────────
function parseRow(cfg, cells, ctx) {
  switch (cfg.layout) {
    case "linklist":     return parseLinklist(cells, ctx, false);
    case "mostWanted":   return parseLinklist(cells, ctx, true);
    case "fir":          return parseFir(cells, ctx);
    case "firGeneric":   return parseFir(cells, ctx, true);
    case "lokayuktaBody":return parseLokayuktaBody(cells, ctx);
    case "recBanned":    return parseRecBanned(cells, ctx);
    case "dsndBlacklist":return parseDsnd(cells, ctx);
    case "ugcFake":      return parseUgcFake(cells, ctx);
    case "banGeneric":   return parseBanGeneric(cells, ctx);
    default:             return null;
  }
}

function vigClaim(object_text, date, { source, case_no = null, allegation = null }, confidence = 0.2) {
  return {
    claim_type: "named_in_vigilance_case", object_text: String(object_text).slice(0, 200),
    status: "unverified", confidence, as_of_date: date,
    data: { source, case_no, allegation, note: IDENTITY_NOTE },
  };
}
function blkClaim(object_text, date, { source, case_no = null, allegation = null }, confidence = 0.2) {
  return {
    claim_type: "named_on_blacklist", object_text: String(object_text).slice(0, 200),
    status: "unverified", confidence, as_of_date: date,
    data: { source, case_no, allegation, note: IDENTITY_NOTE },
  };
}

function parseLinklist(cells, { source }, mostWanted) {
  const title = cells[0];
  if (!title || !alphaLen(title)) return null;
  const date = firstDate(cells);
  // Case ref is inline in the prose title — pull just the token, not the whole cell.
  const cm = title.match(/((?:Case|FIR|Crime|RC|VE)\s*(?:No\.?)?\s*[:.\-]?\s*)?(\d{1,4}\/\d{4})/i);
  const caseNo = cm ? `${cm[1] ? cm[1].trim() + " " : ""}${cm[2]}` : null;
  const text = mostWanted ? `Most-wanted: ${title}` : title;
  return { claim: vigClaim(text, date, { source, case_no: caseNo, allegation: title }, 0.2), relationships: [] };
}

function parseFir(cells, { source, matchedNorm }, generic = false) {
  const caseNo = (!generic && cells[1]) || pickCaseNo(cells);
  const date = (!generic && parseLooseDate(cells[2])) || firstDate(cells);
  const allegation = (!generic && cells[3]) || longestCell(cells);
  const accusedCell = (!generic && cells[4]) || cells.find((c) =>
    c !== caseNo && c !== allegation && parseLooseDate(c) !== c && /[A-Za-z].*,/.test(c)) || "";
  const summary = [caseNo, allegation].filter(Boolean).join(": ") || allegation || caseNo || "vigilance FIR";
  const relationships = [];
  for (const frag of splitParties(accusedCell)) {
    const name = cleanName(frag);
    if (name && !isMatched(name, matchedNorm)) relationships.push(personRel(name, source, date));
  }
  return { claim: vigClaim(summary, date, { source, case_no: caseNo, allegation }, 0.3), relationships };
}

function parseLokayuktaBody(cells, { source, matchedNorm }) {
  const title = cells[0] || "Lokayukta cause-list";
  const body = cells[2] || cells[1] || "";
  const date = firstDate(cells);
  const enquiryNos = [...String(body).matchAll(/\b(\d{1,4}\/\d{4})\b/g)].map((m) => m[1]);
  const caseNo = enquiryNos[0] || null;
  const summary = enquiryNos.length ? `${title} — enquiry ${enquiryNos.slice(0, 3).join(", ")}` : title;
  const relationships = [];
  const seen = new Set();
  for (const m of String(body).matchAll(/\d+\.\s+([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,3})\s*,/g)) {
    const name = cleanName(m[1]);
    if (!name || isMatched(name, matchedNorm)) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push(personRel(name, source, date));
    if (relationships.length >= 8) break;
  }
  return { claim: vigClaim(summary, date, { source, case_no: caseNo, allegation: null }, 0.2), relationships };
}

function parseRecBanned(cells, { source }) {
  const firm = cells[1];
  const date = parseLooseDate(cells[3]) || firstDate(cells);
  const duration = cells[4] || null;
  const reason = cells[5] || longestCell(cells);
  if (!firm || !alphaLen(firm)) return null;
  const summary = `${firm} debarred${duration ? ` (${duration})` : ""}${reason ? ` — ${reason}` : ""}`;
  return {
    claim: blkClaim(summary, date, { source, case_no: duration, allegation: reason }, 0.2),
    relationships: [firmRel(firm.slice(0, 60), "company", source, date)],
  };
}

function parseDsnd(cells, { source }) {
  const title = cells[0];
  if (!title || !alphaLen(title)) return null;
  const date = parseLooseDate(cells[1]) || firstDate(cells);
  const m = title.match(/M\/s\.?\s+(.+)$/i) || title.match(/\b(?:of|against)\s+(.+)$/i);
  const firm = m ? m[1].replace(/\s+/g, " ").trim() : null;
  const rels = firm && alphaLen(firm) >= 4 ? [firmRel(firm.slice(0, 60), "company", source, date)] : [];
  return { claim: blkClaim(title, date, { source, case_no: null, allegation: title }, 0.2), relationships: rels };
}

function parseUgcFake(cells, { source }) {
  const state = cells.length >= 3 ? cells[1] : null;
  const org = cells[cells.length - 1];
  if (!org || !alphaLen(org)) return null;
  const orgName = org.split(",")[0].replace(/\s+/g, " ").trim();
  const summary = `Fake/unrecognised university: ${orgName}${state ? ` (${state})` : ""}`;
  const rels = alphaLen(orgName) >= 4 ? [firmRel(orgName.slice(0, 60), "org", source, null)] : [];
  return { claim: blkClaim(summary, null, { source, case_no: null, allegation: "fake/unrecognised university" }, 0.2), relationships: rels };
}

function parseBanGeneric(cells, { source }) {
  const date = firstDate(cells);
  // firm = the longest cell that isn't a date, a bare number, or the reason sentence.
  const candidates = cells.filter((c) => parseLooseDate(c) !== c && !/^\d+$/.test(String(c).trim()) && alphaLen(c) >= 4);
  if (!candidates.length) return null;
  const firm = candidates.slice().sort((a, b) => a.length - b.length)[0]; // shortest name-like cell
  const reason = longestCell(cells);
  const summary = `${firm} banned/suspended${reason && reason !== firm ? ` — ${reason}` : ""}`;
  return {
    claim: blkClaim(summary, date, { source, case_no: null, allegation: reason }, 0.2),
    relationships: [firmRel(firm.slice(0, 60), "company", source, date)],
  };
}

// ── public entry point (pure; unit-testable without a DB) ────────────────────
export function extractVigilanceCases({ content, title } = {}, sourceType) {
  const cfg = CONFIG[sourceType];
  if (!cfg) return {};
  const source = (String(title ?? "").split(" — ")[0] || sourceType).trim();
  const matchedNorm = norm(String(title ?? "").split(" — ").pop() || "");
  const ctx = { source, matchedNorm };
  const claims = [];
  const relationships = [];
  for (const cells of parseRowLines(content)) {
    if (looksLikeHeader(cells)) continue;
    const rec = parseRow(cfg, cells, ctx);
    if (!rec || !rec.claim) continue;
    claims.push(rec.claim);
    for (const r of rec.relationships ?? []) relationships.push(r);
  }
  return { claims, relationships };
}

// The registered extractor derives its own source_type from the evidence row, so a
// single extract fn serves every registration.
function extractFn(ev = {}) {
  const sourceType = ev.source_type ?? ev.data?.source_type ?? null;
  return extractVigilanceCases({ content: ev.data?.content, title: ev.data?.title }, sourceType);
}

for (const st of VIGILANCE_SOURCE_TYPES) {
  registerExtractor(st, { version: VIGILANCE_CASES_VERSION, extract: extractFn });
}

export function runVigilanceCasesExtraction() {
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  for (const st of VIGILANCE_SOURCE_TYPES) {
    const r = runExtraction({ sourceType: st });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/vigilance-cases.js");
if (invokedDirectly) {
  console.log("[vigilance-cases] extraction done:", JSON.stringify(runVigilanceCasesExtraction()));
  process.exit(0);
}
