// Financial + procurement LINK extractors (Phase 2, the deferred "links" pass).
//
// These sources — SEC EDGAR filings, ICIJ offshore leaks, electoral-bond
// disclosures, and government tender/contract corpora — are all RAW NAME MATCHES
// against the roster ("verify identity: common names can collide"). Exactly like
// indian-kanoon.js, that means the honest home is the CLAIMS + EVENTS ledgers at
// LOW confidence with identity_unverified flagged — never a hard fact and never a
// public accusation. Their real value is the RELATIONSHIPS ledger: each filing /
// leak / contract grows an edge from the politician entity to a company/org entity,
// so a later cross-entity detector can spot the SAME company or org linked to
// several politicians — a previously-unconnected pattern a journalist would chase.
//
// One lead-grade SUMMARY record per evidence row (not per line item): these blobs
// hold up to dozens of near-identical rows, and the point is a candidate signal for
// L2/L3 review, not a precise per-row ledger. The parsed specifics live in `data`.
import { registerExtractor, runExtraction } from "./extract.js";

export const FINANCIAL_LINKS_VERSION = "financial-links-v1";

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
// "12/Jan/2022" | "21-07-2022" | "28-Jul-2022" | "2008-10-03" → ISO, else null.
export function parseAnyDate(s) {
  const t = String(s ?? "").trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);                       // 2008-10-03
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})[/-]([A-Za-z]{3,9})[/-](\d{4})/);          // 12/Jan/2022, 28-Jul-2022
  if (m) { const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`; }
  m = t.match(/(\d{1,2})-(\d{2})-(\d{4})/);                        // 21-07-2022
  if (m) return `${m[3]}-${m[2]}-${String(m[1]).padStart(2, "0")}`;
  return null;
}

// "(23 matching rows, dataset of 37311)" → { matched: 23, dataset: 37311 }
export function parseMatchCount(content) {
  const m = String(content ?? "").match(/\((\d+)\s+matching rows?(?:,\s*dataset of\s+(\d+))?\)/i);
  return { matched: m ? Number(m[1]) : null, dataset: m && m[2] ? Number(m[2]) : null };
}

const IDENTITY_NOTE = "Raw name match — verify identity before treating as a finding (common names collide).";

// ── SEC EDGAR ────────────────────────────────────────────────────────────────
// title: SEC EDGAR filing mentions {NAME} — {COMPANY} (CIK {cik}) ({form})
export function parseSecEdgar(data = {}) {
  const title = String(data.title ?? "");
  const m = title.match(/—\s*(.+?)\s*\(CIK\s*(\d+)\)\s*\(([^)]+)\)/i);
  if (!m) return null;
  const company = m[1].replace(/\s+/g, " ").trim();
  const cik = m[2];
  const form = m[3].trim();
  const filed = (String(data.content ?? "").match(/filed\s+(\d{4}-\d{2}-\d{2})/i)?.[1]) || parseAnyDate(data.date);
  if (!company) return null;
  return { company, cik, form, date: filed };
}

// ── ICIJ Offshore Leaks ──────────────────────────────────────────────────────
// title: ICIJ Offshore Leaks — {NODE} (Officer|Entity, matched "{q}")
// content: …extracted from the {DATASET} data… Connections: … {COMPANY} {Role} …
export function parseIcij(data = {}) {
  const title = String(data.title ?? "");
  const node = title.match(/—\s*(.+?)\s*\((Officer|Entity)[^)]*\)/i);
  const content = String(data.content ?? "");
  const dataset = content.match(/from the\s+(.+?)\s+data\b/i)?.[1]?.trim()
    || content.match(/\b(Pandora Papers|Panama Papers|Paradise Papers|Bahamas Leaks|Offshore Leaks)\b/i)?.[1];
  // The connected offshore ENTITY (an ALL-CAPS company name before a role word).
  const conn = content.match(/Connections:[\s\S]*?\b([A-Z][A-Z&.\- ]{4,}?(?:LIMITED|LTD|INC|CORP|LLC|LLP|HOLDINGS|SERVICES|INTERNATIONAL LIMITED|INTERNATIONAL))\b/);
  return {
    node: node ? node[1].replace(/\s+/g, " ").trim() : null,
    node_kind: node ? node[2].toLowerCase() : null,
    dataset: dataset || "ICIJ Offshore Leaks",
    connected_entity: conn ? conn[1].replace(/\s+/g, " ").trim() : null,
    date: parseAnyDate(data.date),
  };
}

// ── Electoral bonds (purchased by a person / encashed by a party) ────────────
// content rows: "• 12/Jan/2022 | NAME | 100000"
export function parseElectoralBonds(data = {}) {
  const content = String(data.content ?? "");
  const rows = [...content.matchAll(/•\s*([\d/A-Za-z-]+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)/g)].map((m) => ({
    date: parseAnyDate(m[1]), name: m[2].trim(), amount: Number(m[3]),
  }));
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + (r.amount || 0), 0);
  const encashed = /encash/i.test(String(data.title ?? "")) || /Encashment/i.test(content);
  const name = rows[0].name;
  const { matched, dataset } = parseMatchCount(content);
  return {
    kind: encashed ? "encashed" : "purchased",
    name, total, count: rows.length, matched_rows: matched, dataset_rows: dataset,
    first_date: rows.map((r) => r.date).filter(Boolean).sort()[0] || null,
  };
}

// ── Government tenders / contracts (gem, l1_*_tenders, assam OCDS, …) ─────────
// Wildly varied column layouts; we pull only lead-grade fields: an org name, a
// tender id, a status hint, a date, and the match volume from the header.
export function parseProcurement(data = {}) {
  const content = String(data.content ?? "");
  const { matched, dataset } = parseMatchCount(content);
  const corpus = String(data.title ?? "").split(/\s+—\s+/)[0].trim() || (data.source_type ?? "government contract");
  const tender_id = content.match(/tender_id:\s*([^\s|]+)/i)?.[1]
    || content.match(/\b(\d{4}_[A-Za-z]+_\d+_\d+)\b/)?.[1] || null;
  const org = content.match(/org_name:\s*([^|]+?)\s*\|/i)?.[1]?.trim()
    || content.match(/\|\s*(PWD|RDTN|CPWD|NHAI|[A-Z][A-Za-z ]+?)\s*\|\s*[A-Za-z]+\s*\|\s*[\d.,]+\s*\|/)?.[1]?.trim()
    || null;
  const role = /tenderer/i.test(content) ? "tenderer"
    : /Accepted-AOC|award|aoc_date/i.test(content) ? "awardee/party"
    : "named";
  // Prefer the labelled award/AOC date; else the earliest date on the row.
  const labelled = content.match(/aoc_date:\s*(\d{1,2}[-/][A-Za-z]{3}[-/]\d{4})/i)?.[1];
  const dates = [...content.matchAll(/(\d{1,2}[-/][A-Za-z]{3}[-/]\d{4}|\d{4}-\d{2}-\d{2})/g)].map((m) => parseAnyDate(m[1])).filter(Boolean).sort();
  return { corpus, tender_id, org: org && org.length <= 60 ? org : null, role, matched_rows: matched, dataset_rows: dataset, date: parseAnyDate(labelled) || dates[0] || null };
}

// ── Emit records (claims + events + relationships) ───────────────────────────
function secRecords(data) {
  const p = parseSecEdgar(data); if (!p) return {};
  return {
    claims: [{ claim_type: "named_in_sec_filing", object_text: `${p.company} (${p.form})`, as_of_date: p.date, status: "unverified", confidence: 0.25, data: { cik: p.cik, form: p.form, note: IDENTITY_NOTE } }],
    events: [{ kind: "sec_filing_mention", at: p.date, data: { company: p.company, cik: p.cik, form: p.form, identity_unverified: true, confidence: 0.25 } }],
    relationships: [{ rel_type: "named_in_filing", dst_name: p.company, dst_kind: "company", dst_strong_ids: { sec_cik: p.cik }, valid_from: p.date, confidence: 0.25, data: { form: p.form, source: "sec_edgar", identity_unverified: true } }],
  };
}
function icijRecords(data) {
  const p = parseIcij(data); if (!p || !p.node) return {};
  const target = p.connected_entity || p.node;
  return {
    claims: [{ claim_type: "named_in_offshore_leak", object_text: `${p.node} — ${p.dataset}`, as_of_date: p.date, status: "unverified", confidence: 0.2, data: { dataset: p.dataset, connected_entity: p.connected_entity, node_kind: p.node_kind, note: IDENTITY_NOTE } }],
    events: [{ kind: "offshore_leak_mention", at: p.date, data: { node: p.node, dataset: p.dataset, identity_unverified: true, confidence: 0.2 } }],
    relationships: p.connected_entity
      ? [{ rel_type: "linked_offshore_entity", dst_name: target, dst_kind: "company", confidence: 0.2, data: { dataset: p.dataset, source: "icij_leaks", identity_unverified: true } }]
      : [],
  };
}
function bondsRecords(data) {
  const p = parseElectoralBonds(data); if (!p) return {};
  const cr = (p.total / 1e7).toFixed(2);
  return {
    claims: [{ claim_type: p.kind === "encashed" ? "linked_electoral_bond_encashment" : "linked_electoral_bond_purchase", object_text: `${p.name} — ₹${cr} Cr across ${p.count} bond(s)`, as_of_date: p.first_date, status: "unverified", confidence: 0.18, data: { total_inr: p.total, count: p.count, matched_rows: p.matched_rows, party_or_purchaser: p.name, note: IDENTITY_NOTE + (p.kind === "encashed" ? " Encashments are PARTY-level." : "") } }],
    events: [{ kind: p.kind === "encashed" ? "electoral_bond_encashment" : "electoral_bond_purchase", at: p.first_date, data: { total_inr: p.total, count: p.count, name: p.name, identity_unverified: true, confidence: 0.18 } }],
  };
}
function procurementRecords(data) {
  const p = parseProcurement(data); if (!p.tender_id && !p.org && !p.matched_rows) return {};
  const obj = [p.org, p.tender_id].filter(Boolean).join(" · ") || `${p.matched_rows ?? "?"} contract row(s) in ${p.corpus}`;
  const out = {
    claims: [{ claim_type: "named_in_government_contract", object_text: obj.slice(0, 200), as_of_date: p.date, status: "unverified", confidence: p.role === "tenderer" ? 0.28 : 0.2, data: { corpus: p.corpus, tender_id: p.tender_id, org: p.org, role: p.role, matched_rows: p.matched_rows, note: IDENTITY_NOTE } }],
    events: [{ kind: "government_contract_mention", at: p.date, data: { corpus: p.corpus, tender_id: p.tender_id, org: p.org, role: p.role, identity_unverified: true, confidence: 0.2 } }],
  };
  if (p.org) out.relationships = [{ rel_type: "named_in_government_contract", dst_name: p.org, dst_kind: "org", valid_from: p.date, confidence: 0.2, data: { corpus: p.corpus, tender_id: p.tender_id, role: p.role, source: "procurement", identity_unverified: true } }];
  return out;
}

// Procurement corpora currently in the store. New tender/GeM source_types can be
// appended here (or discovered via listProcurementSourceTypes at run time).
// NOTE: "gem" was removed here — GeM (gem.gov.in) is a JS-rendered SPA behind
// auth with no scrapeable listing (recorded in sources_catalog.json →
// rejected_sources), so no fetcher ever produces `gem` evidence; the registration
// was a dead no-op. New live tender/GeM source_types are still auto-picked up by
// registerDynamicProcurement() below when they actually appear in the DB.
export const PROCUREMENT_SOURCE_TYPES = [
  "l1_up_flood_tenders", "l1_hp_flood_tenders", "l1_hp_health_procurement",
  "l1_mega_assam_tenders_ocds",
];

registerExtractor("sec_edgar", { version: FINANCIAL_LINKS_VERSION, extract: (ev) => secRecords(ev.data ?? {}) });
registerExtractor("icij_leaks", { version: FINANCIAL_LINKS_VERSION, extract: (ev) => icijRecords(ev.data ?? {}) });
registerExtractor("l1_electoral_bonds_purchased", { version: FINANCIAL_LINKS_VERSION, extract: (ev) => bondsRecords(ev.data ?? {}) });
registerExtractor("l1_electoral_bonds_encashed", { version: FINANCIAL_LINKS_VERSION, extract: (ev) => bondsRecords(ev.data ?? {}) });
for (const st of PROCUREMENT_SOURCE_TYPES) registerExtractor(st, { version: FINANCIAL_LINKS_VERSION, extract: (ev) => procurementRecords({ ...(ev.data ?? {}), source_type: st }) });

// Register any additional tender/procurement-shaped source_types found in the DB
// (mega corpora vary between installs) so a new corpus is picked up without edits.
export function registerDynamicProcurement(sourceTypes = []) {
  const extra = [];
  for (const st of sourceTypes) {
    if (PROCUREMENT_SOURCE_TYPES.includes(st)) continue;
    if (/tender|procure|_aoc|contract|gem\b/i.test(st)) {
      registerExtractor(st, { version: FINANCIAL_LINKS_VERSION, extract: (ev) => procurementRecords({ ...(ev.data ?? {}), source_type: st }) });
      extra.push(st);
    }
  }
  return extra;
}

export const FINANCIAL_LINK_SOURCE_TYPES = [
  "sec_edgar", "icij_leaks", "l1_electoral_bonds_purchased", "l1_electoral_bonds_encashed",
  ...PROCUREMENT_SOURCE_TYPES,
];

export function runFinancialLinkExtraction() {
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  for (const st of FINANCIAL_LINK_SOURCE_TYPES) {
    const r = runExtraction({ sourceType: st });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/financial-links.js");
if (invokedDirectly) {
  console.log("[financial-links] extraction done:", JSON.stringify(runFinancialLinkExtraction()));
  process.exit(0);
}
