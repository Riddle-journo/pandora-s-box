// Populate the temporal relationship/event store from data already in the app:
//   a. family_of + owner_of from graph.buildRelations / affidavit interests
//   b. donor_to (+ dated bond_purchase events) from the electoral-bonds dataset
//   c. director_of from Plan 4's accepted mca_directors assertions
// Idempotent (INSERT OR IGNORE on natural keys) and prints counts by type.
//
//   node server/backfill-relations.js
import "dotenv/config";
import { db, listPoliticians, listEvidence } from "./store.js";
import { ensureEntity } from "./entities.js";
import { buildRelations } from "./graph.js";
import { upsertRelationship, upsertEvent, relationshipCountsByType, eventCountsByKind } from "./relations.js";
import { PARTY_TOTALS, TOP_DONORS } from "./data/electoral-bonds.js";

const abbrToParty = Object.fromEntries(PARTY_TOTALS.map((p) => [p.abbr, p.party]));

// ── a. family + business (ownership) relations, from evidence + buildRelations ──
function backfillFamilyAndBusiness() {
  let family = 0, owner = 0, party = 0;
  for (const p of listPoliticians()) {
    const strongIds = { politician_id: p.id };
    if (p.myneta_url) strongIds.myneta_url = p.myneta_url;
    const pEnt = ensureEntity({ kind: "person", name: p.name, strongIds, source: "backfill" });
    const evidence = listEvidence(p.id);

    // family_of — each named relative carries its own Wikidata evidence row.
    for (const e of evidence) {
      if (e.source_type === "wikidata" && Array.isArray(e.numbers?.relatives)) {
        for (const rel of e.numbers.relatives) {
          if (!rel.name) continue;
          const relEnt = ensureEntity({ kind: "person", name: rel.name, source: "wikidata" });
          const r = upsertRelationship({
            src_entity_id: pEnt, dst_entity_id: relEnt, rel_type: "family_of",
            confidence: 0.8, evidence_id: e.id, source: "wikidata", data: { relation: rel.relation ?? null },
          });
          if (r.inserted) family++;
        }
      }
      // owner_of — declared company interests from the sworn affidavit.
      if (e.source_type === "eci_affidavit" && Array.isArray(e.numbers?.interests)) {
        for (const it of e.numbers.interests) {
          if (!it.name) continue;
          const coEnt = ensureEntity({ kind: "company", name: it.name, source: "affidavit" });
          const r = upsertRelationship({
            src_entity_id: pEnt, dst_entity_id: coEnt, rel_type: "owner_of",
            confidence: it.owner === "self" ? 0.7 : 0.6, evidence_id: e.id, source: "affidavit",
            data: { owner: it.owner ?? null, sector: it.sector ?? null },
          });
          if (r.inserted) owner++;
        }
      }
    }

    // family_of (dynasty) — matched-politician edges from buildRelations. These are
    // computed, not tied to a single evidence row → evidence_id null, confidence 0.6.
    const { links } = buildRelations(p, evidence);
    for (const l of links) {
      if (l.type !== "DYNASTY" || !l.target_id) continue;
      const targetEnt = ensureEntity({ kind: "person", name: l.target_name, strongIds: { politician_id: l.target_id }, source: "graph" });
      const r = upsertRelationship({
        src_entity_id: pEnt, dst_entity_id: targetEnt, rel_type: "family_of",
        confidence: 0.6, evidence_id: null, source: "graph", data: { relation: l.relation ?? null, dynasty: true },
      });
      if (r.inserted) family++;
    }

    // member_of_party — the politician's party affiliation.
    if (p.party) {
      const partyEnt = ensureEntity({ kind: "party", name: p.party, source: "roster" });
      const r = upsertRelationship({
        src_entity_id: pEnt, dst_entity_id: partyEnt, rel_type: "member_of_party",
        confidence: 0.95, source: "roster", data: {},
      });
      if (r.inserted) party++;
    }
  }
  return { family, owner, member_of_party: party };
}

// ── b. donations, from the electoral-bonds dataset (aggregate; no per-bond dates,
//    so valid_from stays null and there are no dated bond_purchase events here) ──
function backfillDonations() {
  let donor = 0, events = 0;
  for (const d of TOP_DONORS) {
    const donorEnt = ensureEntity({ kind: "company", name: d.donor, source: "electoral_bonds" });
    for (const abbr of d.parties) {
      const partyName = abbrToParty[abbr] ?? abbr;
      const partyEnt = ensureEntity({ kind: "party", name: partyName, source: "electoral_bonds" });
      const r = upsertRelationship({
        src_entity_id: donorEnt, dst_entity_id: partyEnt, rel_type: "donor_to",
        valid_from: d.date ?? null, confidence: 0.9, source: "electoral_bonds",
        data: { total_cr: d.total_cr, sector: d.sector },
      });
      if (r.inserted) donor++;
      // A dated purchase would become a bond_purchase event; the dataset is
      // aggregate (undated), so none are emitted here.
      if (d.date) {
        const ev = upsertEvent({
          kind: "bond_purchase", at: d.date, entity_ids: [donorEnt, partyEnt],
          source: "electoral_bonds", data: { total_cr: d.total_cr, sector: d.sector },
        });
        if (ev.inserted) events++;
      }
    }
  }
  return { donor_to: donor, bond_purchase_events: events };
}

// ── c. director_of, from Plan 4's accepted mca_directors assertions ──
// The assertion links the politician (politician_id) to a DIN-identified director
// entity. Persist that as a director_of edge; company-level edges await MCA company
// data. valid_from from the assertion's appointment date when present.
function backfillDirectorships() {
  let director = 0;
  const rows = db.prepare(
    "SELECT * FROM entity_assertions WHERE source = 'mca_directors' AND status = 'accepted' AND entity_id IS NOT NULL"
  ).all();
  for (const a of rows) {
    if (!a.politician_id) continue;
    const pEnt = ensureEntity({ kind: "person", name: a.raw_name, strongIds: { politician_id: a.politician_id }, source: "backfill" });
    let data = {};
    try { data = JSON.parse(a.data) || {}; } catch { /* ignore */ }
    const r = upsertRelationship({
      src_entity_id: pEnt, dst_entity_id: a.entity_id, rel_type: "director_of",
      valid_from: data.date_appointed ?? null, confidence: Number(a.confidence) || 0.6,
      evidence_id: null, source: "mca_directors", detector_version: a.detector_version ?? null,
      data: { din: a.source_ref, ...(data.company_name ? { company_name: data.company_name } : {}) },
    });
    if (r.inserted) director++;
  }
  return { director_of: director };
}

export function backfill() {
  const a = backfillFamilyAndBusiness();
  const b = backfillDonations();
  const c = backfillDirectorships();
  return { ...a, ...b, ...c, byRelType: relationshipCountsByType(), byEventKind: eventCountsByKind() };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("backfill-relations.js");
if (invokedDirectly) {
  const c = backfill();
  console.log("[backfill-relations] inserted this run:");
  console.log(`  family_of        : ${c.family}`);
  console.log(`  owner_of         : ${c.owner}`);
  console.log(`  member_of_party  : ${c.member_of_party}`);
  console.log(`  donor_to         : ${c.donor_to}`);
  console.log(`  director_of      : ${c.director_of}`);
  console.log(`  bond_purchase ev : ${c.bond_purchase_events}`);
  console.log("\n[backfill-relations] relationships table — counts by rel_type:");
  for (const [k, v] of Object.entries(c.byRelType)) console.log(`  ${k.padEnd(16)}: ${v}`);
  console.log("[backfill-relations] events table — counts by kind:");
  const ek = Object.entries(c.byEventKind);
  if (ek.length) for (const [k, v] of ek) console.log(`  ${k.padEnd(16)}: ${v}`);
  else console.log("  (none)");
  process.exit(0);
}
