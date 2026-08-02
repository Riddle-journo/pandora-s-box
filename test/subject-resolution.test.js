// Phase 2A — politician_id → entity_id resolution, the bridge every ledger
// extractor crosses. Two coverage paths must both work: the fast strong-id path,
// and the assertion fallback (an entity linked by name-match that never got the
// reverse strong id folded in — the real DB's 96-row gap). Then reconcile must
// close that gap without minting duplicate entities, idempotently.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-resolve-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store/store.js");
const {
  ensureEntity, recordAssertion, getEntity,
  resolveEntityIdForPolitician, reconcilePoliticianStrongIds,
} = await import("../server/entities/entities.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

test("fast path: a politician_id strong id resolves directly", () => {
  const eid = ensureEntity({ kind: "person", name: "Direct MP", strongIds: { politician_id: "P1" }, source: "seed" });
  assert.equal(resolveEntityIdForPolitician("P1"), eid);
});

test("fallback: an assertion-only link still resolves (the 96-gap case)", () => {
  // Entity created WITHOUT a politician_id strong id...
  const eid = ensureEntity({ kind: "person", name: "Ghost MP", source: "seed" });
  // ...then bound to a politician by an accepted name-match assertion.
  const rec = recordAssertion({
    subject_kind: "person", raw_name: "Ghost MP", source: "news", source_ref: "n1",
    politician_id: "P2", method: "exact_alias", confidence: 0.9,
  });
  assert.equal(rec.entity_id, eid, "precondition: assertion should auto-accept to the sole alias match");

  // Strong-id lookup misses, but the fallback finds it.
  assert.equal(getEntity(eid).strong_ids.politician_id, undefined, "precondition: no strong id yet");
  assert.equal(resolveEntityIdForPolitician("P2"), eid);
});

test("resolve returns null for an unknown politician", () => {
  assert.equal(resolveEntityIdForPolitician("NOPE"), null);
  assert.equal(resolveEntityIdForPolitician(null), null);
});

test("reconcile folds the strong id in (closes the gap) without minting duplicates", () => {
  const before = db.prepare("SELECT COUNT(*) n FROM entities WHERE kind='person'").get().n;

  const c = reconcilePoliticianStrongIds([
    { id: "P1", name: "Direct MP" },   // already has the strong id
    { id: "P2", name: "Ghost MP" },    // assertion-only → should be folded
  ]);
  assert.equal(c.folded, 1, "P2 should be folded");
  assert.equal(c.already, 1, "P1 was already complete");
  assert.equal(c.created, 0, "no new entity should be minted");

  // Gap closed: P2 now resolves via the fast strong-id path.
  const eidP2 = resolveEntityIdForPolitician("P2");
  assert.equal(getEntity(eidP2).strong_ids.politician_id, "P2");

  // No duplicate entity created.
  const after = db.prepare("SELECT COUNT(*) n FROM entities WHERE kind='person'").get().n;
  assert.equal(after, before, "entity count must not change");
});

test("reconcile is idempotent (second run folds nothing)", () => {
  const c = reconcilePoliticianStrongIds([
    { id: "P1", name: "Direct MP" },
    { id: "P2", name: "Ghost MP" },
  ]);
  assert.equal(c.folded, 0);
  assert.equal(c.already, 2);
  assert.equal(c.created, 0);
});

test("reconcile refuses to steal a strong id from a name-collision duplicate", () => {
  // A distinct politician P3 shares P1's name and resolves (via assertion) to
  // P1's entity. It must be reported as a collision, never folded — otherwise the
  // entity would be silently reassigned away from its rightful owner.
  const rec = recordAssertion({
    subject_kind: "person", raw_name: "Direct MP", source: "news", source_ref: "n3",
    politician_id: "P3", method: "exact_alias", confidence: 0.8,
  });
  const eidP1 = resolveEntityIdForPolitician("P1");
  assert.equal(rec.entity_id, eidP1, "precondition: P3's assertion binds to P1's entity");
  assert.equal(resolveEntityIdForPolitician("P3"), eidP1);

  const c = reconcilePoliticianStrongIds([{ id: "P3", name: "Direct MP" }]);
  assert.equal(c.collision, 1);
  assert.equal(c.folded, 0);
  assert.equal(getEntity(eidP1).strong_ids.politician_id, "P1", "entity still belongs to P1");
});
