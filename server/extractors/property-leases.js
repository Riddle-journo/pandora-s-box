// Real-estate (RERA) + mineral/mining-lease LINK extractor (Phase 2 "links" pass).
//
// Modelled exactly on financial-links.js. These bulk "L1"/"mega" corpora —
// MahaRERA project registers and state mineral/sand lease + mining-RFP/DSR PDFs —
// are RAW NAME MATCHES against the roster: the politician's name merely appears in
// a project register, a lease list, or a bid/DSR document body. Common names
// collide, so the honest home is the CLAIMS + EVENTS ledgers at LOW confidence with
// identity_unverified flagged — never a hard fact, never a public accusation.
//
// Their real value is the RELATIONSHIPS ledger. Each row that names a promoter /
// lessee / bidder FIRM grows an edge from the politician entity to that company
// entity, so a later cross-entity detector can spot the SAME builder or lessee
// company linked to several politicians — or cross-reference a promoter/lessee
// against the politician's declared donors and assets. Per the KEEP-ALL-DATA /
// universal-subjects rule we NEVER drop a row for "that's a firm, not the
// politician": a promoter firm linked to a politician IS the lead.
//
// Evidence shape (built by server/ingest.js l1Match): ev.data.content =
//   "<Title> (<N> matching rows, dataset of <M>):\n• cellA | cellB | ...\n• ..."
// Cells vary by source: a tabular RERA/mineral register carries promoter/lessee +
// project/site + registration/status; the WB mining corpus is PDF rows
// [ "" | <pdf-url> | <body-excerpt-around-name> ], so the site is derived from the
// PDF filename and the firm from the body text. The parser handles both layouts.
import { registerExtractor, runExtraction } from "../extract.js";
import { parseAnyDate, parseMatchCount } from "./financial-links.js";

export const PROPERTY_LEASES_VERSION = "property-leases-v1";

const IDENTITY_NOTE = "Raw name match — verify identity before treating as a finding (common names collide).";

// ── Cell vocabularies ────────────────────────────────────────────────────────
const STATUS_RE = /\b(registered|active|operational|expired|lapsed|cancelled|canceled|revoked|suspended|valid|approved|pending|granted|renewed|completed|working|closed|surrendered|terminated|ongoing|awarded|in progress|under process)\b/i;
const MINERAL_RE = /\b(sand|gravel|morrum|murram|coal|iron ore|iron|manganese|bauxite|lime\s?stone|granite|marble|quartzite|quartz|laterite|dolomite|silica|boulder|ordinary earth|kaolin|feldspar|china clay|red oxide|minor mineral|building stone|black stone|stone)\b/i;
// A company/firm party: a capitalised token run (lowercase connectors "and/of/the/&"
// allowed inside) ending in a business suffix. STRONG terminals (Ltd/LLP/Company/
// Corporation…) usually END the name, so we prefer the longest run to them; WEAK
// industry words (Minerals/Mining/Traders…) are a fallback since they often sit
// mid-name and would truncate it otherwise.
const RUN = "[A-Z][\\w&.'\\-]*(?:\\s+(?:and\\s+|of\\s+|the\\s+|&\\s+)?[A-Z][\\w&.'\\-]*){0,6}";
const STRONG_SUFFIX = "Private Limited|Pvt\\.?\\s*Ltd\\.?|Limited|Ltd\\.?|LLP|LLC|Corporation|Nigam|Company|Ventures?|Enterprises?|& Co\\.?|and Sons?";
const WEAK_SUFFIX = "Minerals?|Mining|Industries|Developers?|Builders?|Constructions?|Infrastructure|Infra|Realty|Realtors?|Traders?|Trading|Associates|Cements?|Aggregates?|Projects?|Agencies|Suppliers?|Contractors?";
const STRONG_RE = new RegExp(`(${RUN})\\s+(${STRONG_SUFFIX})\\b`);
const WEAK_RE = new RegExp(`(${RUN})\\s+(${WEAK_SUFFIX})\\b`);
// A registration / lease / permit identifier (RERA "P51700012345", or a labelled no.).
const REG_RE = /\b(P\d{6,})\b/i;
const LABELLED_ID_RE = /\b(?:lease|permit|reg(?:istration)?|licen[cs]e|project)\.?\s*(?:no\.?|number|id|#)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]{3,})/i;

const isUrl = (c) => /^https?:\/\//i.test(String(c ?? "").trim());
const looksLikeDate = (c) => !!parseAnyDate(c) && String(c).replace(/[\d/A-Za-z. -]/g, "").trim() === "";

// A named FIRM (or govt org) mentioned in `text`, else null. Govt-shaped names →
// "org", commercial suffixes → "company", so the graph carries the right kind.
export function extractParty(text) {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const m = t.match(STRONG_RE) || t.match(WEAK_RE);
  if (!m) return null;
  const name = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim();
  if (name.length < 4 || name.length > 80) return null;
  const kind = /\b(Corporation|Nigam|Board|Authority|Department|Government|Council|Commission|Development)\b/i.test(name) ? "org" : "company";
  return { name, kind };
}

// Derive a human site/project label from a PDF url filename (WB mining rows carry
// no title cell): ".../Jhargram%20Modified%20DSR%20Octber%202025.pdf" → "Jhargram
// Modified DSR Octber 2025".
function siteFromUrl(url) {
  try {
    const base = decodeURIComponent(String(url).split("/").pop().split("?")[0] || "");
    const name = base.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_%+]+/g, " ").replace(/[-]+/g, " ").replace(/\s+/g, " ").trim();
    return name && name.length >= 3 ? name.slice(0, 80) : null;
  } catch { return null; }
}

// Parse ONE row (array of cells) into lead-grade fields, layout-agnostic.
export function parseLeaseRow(cells = []) {
  const cellArr = cells.map((c) => String(c ?? "").trim());
  const joined = cellArr.join(" | ");
  const url = cellArr.find(isUrl) || null;
  const party = extractParty(joined);
  const registration = joined.match(REG_RE)?.[1] || joined.match(LABELLED_ID_RE)?.[1] || null;
  const status = joined.match(STATUS_RE)?.[1] || null;
  const mineral = joined.match(MINERAL_RE)?.[1] || null;
  const district = cellArr.map((c) => c.match(/\b(?:dist(?:rict)?)\.?\s*[:\-]?\s*([A-Z][A-Za-z .]{2,30})/i)?.[1]).find(Boolean) || null;
  const date = parseAnyDate(joined);
  // Descriptive site/project label: first cell that is not the firm, a url, a bare
  // registration id, a status word, a mineral word, or a bare date. Fall back to
  // the pdf filename (body-text rows have no title cell).
  const partyName = party?.name?.toLowerCase();
  const site = cellArr.find((c) =>
    c && !isUrl(c) && !c.includes("…") && c.length <= 60 &&
    (!partyName || !c.toLowerCase().includes(partyName)) &&
    !REG_RE.test(c) && !STATUS_RE.test(c) && !MINERAL_RE.test(c) && !looksLikeDate(c),
  ) || (url ? siteFromUrl(url) : null);
  return { site: site || null, party, registration, status, mineral, district, date, url };
}

// ── Emit records (claims + events + relationships) — one set per matched row ───
// kind: "rera" (real-estate register) or "mineral" (lease / mining-RFP / DSR).
function leaseRecords(data, kind) {
  const content = String(data.content ?? "");
  const source = data.source_type || (kind === "rera" ? "rera" : "mineral_lease");
  const { matched, dataset } = parseMatchCount(content);
  // Strip exactly the "• " prefix (bullet + one space, as l1Match writes it) so an
  // empty leading cell survives the " | " split instead of being eaten as padding.
  const rows = content.split(/\r?\n/).filter((l) => /^•/.test(l)).map((l) => l.replace(/^•\s?/, "").split(" | "));
  if (!rows.length) return {};

  const claims = [], events = [], relationships = [];
  for (const cells of rows) {
    const p = parseLeaseRow(cells);
    const bits = kind === "rera"
      ? [p.site, p.registration, p.status]
      : [p.site, p.mineral, p.registration, p.status];
    const objectText = (bits.filter(Boolean).join(" · ") || `1 of ${matched ?? rows.length} matched row(s)`).slice(0, 200);
    const conf = kind === "rera" ? 0.25 : 0.22;

    claims.push({
      claim_type: kind === "rera" ? "linked_rera_project" : "linked_mineral_lease",
      object_text: objectText, as_of_date: p.date, status: "unverified", confidence: conf,
      data: {
        source, project: p.site, status: p.status, registration: p.registration,
        mineral: p.mineral, district: p.district, matched_rows: matched, dataset_rows: dataset,
        note: IDENTITY_NOTE,
      },
    });
    events.push({
      kind: kind === "rera" ? "rera_project_mention" : "mineral_lease_mention", at: p.date,
      data: { source, project: p.site, status: p.status, identity_unverified: true, confidence: conf },
    });
    // KEEP ALL DATA: a named promoter/lessee/bidder FIRM → an edge, even (especially)
    // when it is not the politician themselves. That cross-link is the lead.
    if (p.party) {
      relationships.push({
        rel_type: kind === "rera" ? "promoter_of_rera_project" : "holds_mineral_lease",
        dst_name: p.party.name, dst_kind: p.party.kind, valid_from: p.date, confidence: conf - 0.02,
        data: { source, project: p.site, identity_unverified: true },
      });
    }
  }
  return { claims, events, relationships };
}

export const reraRecords = (data) => leaseRecords(data, "rera");
export const mineralRecords = (data) => leaseRecords(data, "mineral");

// ── Registration ─────────────────────────────────────────────────────────────
// Register ONLY source_types whose cache exists on disk AND actually produces
// named-row evidence. Verified against server/data/l1-cache/ + L1_SOURCES/
// MEGA_SOURCES on 2026-07-13:
//   • l1_mega_wb_mines_body — mega cache mega-wb-mines-body.json (meta.id
//     "mega-wb-mines-body"), match:"name", 59 body-text rows → LIVE. Registered.
// Deliberately NOT registered (dead no-ops, mirroring the removed "gem" entry in
// financial-links.js):
//   • l1_telangana_mines_leases, l1_wb_mines_rfp — caches exist but both cfgs are
//     match:"none" (PDF link-lists, never matched per-politician) → no evidence.
//   • l1_maharera_projects (RERA), l1_punjab_sand_mines — no cache on disk yet.
// The reraRecords / mineralRecords builders already handle those layouts, and
// registerDynamicPropertyLeases() below auto-wires any of them the moment they
// start producing evidence (e.g. after a MahaRERA refresh) — no edit needed here.
export const MINERAL_SOURCE_TYPES = ["l1_mega_wb_mines_body"];
export const RERA_SOURCE_TYPES = [];

for (const st of MINERAL_SOURCE_TYPES)
  registerExtractor(st, { version: PROPERTY_LEASES_VERSION, extract: (ev) => mineralRecords({ ...(ev.data ?? {}), source_type: st }) });
for (const st of RERA_SOURCE_TYPES)
  registerExtractor(st, { version: PROPERTY_LEASES_VERSION, extract: (ev) => reraRecords({ ...(ev.data ?? {}), source_type: st }) });

// Auto-wire any additional RERA / mineral-lease source_types found in the DB so a
// newly-refreshed corpus is picked up without editing this file. RERA-shaped ids
// use the RERA builder; mining/mineral/sand/lease/quarry-shaped ids the mineral one.
export function registerDynamicPropertyLeases(sourceTypes = []) {
  const extra = [];
  for (const st of sourceTypes) {
    if (MINERAL_SOURCE_TYPES.includes(st) || RERA_SOURCE_TYPES.includes(st)) continue;
    if (/rera|real_?estate|housing_?board/i.test(st)) {
      registerExtractor(st, { version: PROPERTY_LEASES_VERSION, extract: (ev) => reraRecords({ ...(ev.data ?? {}), source_type: st }) });
      extra.push(st);
    } else if (/mine|mineral|sand|lease|quarr|khanij|geolog/i.test(st)) {
      registerExtractor(st, { version: PROPERTY_LEASES_VERSION, extract: (ev) => mineralRecords({ ...(ev.data ?? {}), source_type: st }) });
      extra.push(st);
    }
  }
  return extra;
}

export const PROPERTY_LEASE_SOURCE_TYPES = [...MINERAL_SOURCE_TYPES, ...RERA_SOURCE_TYPES];

export function runPropertyLeaseExtraction() {
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  for (const st of PROPERTY_LEASE_SOURCE_TYPES) {
    const r = runExtraction({ sourceType: st });
    for (const k of Object.keys(total)) total[k] += r[k] ?? 0;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/property-leases.js");
if (invokedDirectly) {
  console.log("[property-leases] extraction done:", JSON.stringify(runPropertyLeaseExtraction()));
  process.exit(0);
}
