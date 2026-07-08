// Temporal relationship/event store: upsert idempotency, relationsAt date-window
// logic (incl. null valid_from / null valid_to), and a mini backfill fixture
// (2 politicians, 1 shared company, 1 dated donation) checking edges + provenance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-relations-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;

const store = await import("../server/store.js");
const { ensureEntity } = await import("../server/entities.js");
const rel = await import("../server/relations.js");
const {
  upsertRelationship, upsertEvent, relationsOf, relationsAt, entitiesLinkedBy, eventsFor,
} = rel;

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("upsertRelationship + upsertEvent are idempotent on their natural keys", () => {
  const e = { src_entity_id: "A", dst_entity_id: "B", rel_type: "owner_of", source: "s", valid_from: "2020-01-01", confidence: 0.7 };
  const first = upsertRelationship(e);
  const second = upsertRelationship(e);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id, "returns the existing edge id");

  // A different valid_from is a different edge (coalesce-based unique key).
  const third = upsertRelationship({ ...e, valid_from: "2021-01-01" });
  assert.equal(third.inserted, true);

  const ev = { kind: "bond_purchase", at: "2020-05-01", entity_ids: ["A", "B"], source: "eb" };
  assert.equal(upsertEvent(ev).inserted, true);
  assert.equal(upsertEvent(ev).inserted, false);
});

test("relationsAt applies the validity window, incl. null valid_from / null valid_to", () => {
  const X = "win_src";
  // closed window
  upsertRelationship({ src_entity_id: X, dst_entity_id: "c1", rel_type: "owner_of", source: "t", valid_from: "2020-01-01", valid_to: "2020-12-31" });
  // open-ended (null valid_to)
  upsertRelationship({ src_entity_id: X, dst_entity_id: "c2", rel_type: "owner_of", source: "t", valid_from: "2019-01-01", valid_to: null });
  // unknown-start (null valid_from), ends 2020
  upsertRelationship({ src_entity_id: X, dst_entity_id: "c3", rel_type: "owner_of", source: "t", valid_from: null, valid_to: "2020-12-31" });

  const at2020 = relationsAt(X, "2020-06-01").map((r) => r.dst_entity_id).sort();
  assert.deepEqual(at2020, ["c1", "c2", "c3"], "all three active mid-2020");

  const at2023 = relationsAt(X, "2023-06-01").map((r) => r.dst_entity_id).sort();
  assert.deepEqual(at2023, ["c2"], "only the open-ended edge is still active in 2023");

  const at2018 = relationsAt(X, "2018-06-01").map((r) => r.dst_entity_id).sort();
  assert.deepEqual(at2018, ["c3"], "before any dated start, only the unknown-start edge qualifies");

  // null valid_from is flagged undated in the returned data payload.
  const c3 = relationsAt(X, "2020-06-01").find((r) => r.dst_entity_id === "c3");
  assert.equal(c3.data.undated, true);
  const c1 = relationsAt(X, "2020-06-01").find((r) => r.dst_entity_id === "c1");
  assert.ok(!c1.data.undated, "a dated edge is not flagged undated");
});

test("mini backfill: 2 politicians share a company; a dated donation lands with provenance", () => {
  const p1 = ensureEntity({ kind: "person", name: "Politician One", strongIds: { politician_id: "pol_A" }, source: "t" });
  const p2 = ensureEntity({ kind: "person", name: "Politician Two", strongIds: { politician_id: "pol_B" }, source: "t" });
  const shared = ensureEntity({ kind: "company", name: "Shared Holdings Pvt Ltd", source: "t" });
  const party = ensureEntity({ kind: "party", name: "Test Party", source: "t" });

  upsertRelationship({ src_entity_id: p1, dst_entity_id: shared, rel_type: "owner_of", source: "affidavit", evidence_id: "ev_1", confidence: 0.7, data: { owner: "self" } });
  upsertRelationship({ src_entity_id: p2, dst_entity_id: shared, rel_type: "owner_of", source: "affidavit", evidence_id: "ev_2", confidence: 0.7, data: { owner: "self" } });

  // The shared company is the dst of exactly two owner_of edges (the shared-hub shape).
  const incoming = relationsOf(shared, { relType: "owner_of" }).filter((r) => r.dst_entity_id === shared);
  assert.equal(incoming.length, 2);
  assert.deepEqual(incoming.map((r) => r.src_entity_id).sort(), [p1, p2].sort());
  assert.deepEqual(incoming.map((r) => r.evidence_id).sort(), ["ev_1", "ev_2"], "per-edge evidence provenance landed");

  // A dated donation: donor_to edge with valid_from + a bond_purchase event.
  const donor = ensureEntity({ kind: "company", name: "Donor Corp", source: "t" });
  upsertRelationship({ src_entity_id: donor, dst_entity_id: party, rel_type: "donor_to", source: "electoral_bonds", valid_from: "2022-07-01", confidence: 0.9, data: { total_cr: 50 } });
  upsertEvent({ kind: "bond_purchase", at: "2022-07-01", entity_ids: [donor, party], source: "electoral_bonds", evidence_id: "ev_bond", data: { total_cr: 50 } });

  const donations = entitiesLinkedBy("donor_to");
  assert.equal(donations.length, 1);
  assert.equal(donations[0].valid_from, "2022-07-01");
  assert.equal(donations[0].data.total_cr, 50);

  const bondEvents = eventsFor(donor, { kind: "bond_purchase" });
  assert.equal(bondEvents.length, 1);
  assert.equal(bondEvents[0].at, "2022-07-01");
  assert.equal(bondEvents[0].evidence_id, "ev_bond");
  assert.ok(bondEvents[0].entity_ids.includes(party));
});
