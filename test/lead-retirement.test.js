// Lead staleness sweeps.
//
// Flags have had a staleness sweep since the engine was written; leads never
// did. The consequence was that no detector improvement could ever clean up
// after itself — after the base-rate guard retired 104 MPLADS flags and the
// plausibility bound retired the impossible-wage rows, 359 leads were still
// standing on flags that no longer existed, and the page still showed them.
//
// The rule both sweeps must obey: SOFT, and never over a human decision.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-leadretire-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const store = await import("../server/store/store.js");
const { db, upsertLead, getLead, retireLeadsWithoutActiveFlags, retireLeadsNotInRun } = store;
const { upsertFlag } = await import("../server/detectors/flags.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

let seq = 0;
function seedLead({ vector = "TEST_VECTOR", flagKey = null, status = "detected", actor = null } = {}) {
  const n = ++seq;
  const lead = upsertLead({
    key: `${vector}|k${n}`, vector, actor_id: actor ?? `a${n}`, beneficiary: `b${n}`,
    signal_score: 10, status,
    data: flagKey ? { engine_flag_key: flagKey } : {},
  });
  return lead;
}
function seedFlag(key, status = "active") {
  upsertFlag({
    key, detector: "test_detector", severity: "big", score: 10,
    politician_id: null, entity_id: null, subject_name: "S", subject_kind: "person",
    headline: "h", rationale: "r", evidence: [], data: {}, lead: null,
    detector_version: "test@v1", run_id: "run1",
  });
  if (status !== "active") {
    db.prepare("UPDATE flags SET status = ? WHERE key = ?").run(status, key);
  }
}

test("a lead whose flag is gone is retired; one whose flag is active survives", () => {
  seedFlag("live|1", "active");
  const alive = seedLead({ flagKey: "live|1" });
  const orphan = seedLead({ flagKey: "vanished|1" });     // no flag row at all
  seedFlag("stale|1", "stale");
  const staleBacked = seedLead({ flagKey: "stale|1" });

  const r = retireLeadsWithoutActiveFlags();
  assert.equal(r.retired, 2, "the orphan and the stale-backed lead");
  assert.equal(getLead(alive.key).status, "detected");
  assert.equal(getLead(orphan.key).status, "stale");
  assert.equal(getLead(staleBacked.key).status, "stale");
});

test("retirement is SOFT and explains itself", () => {
  const l = seedLead({ flagKey: "gone|2" });
  retireLeadsWithoutActiveFlags();
  const after = getLead(l.key);
  assert.ok(after, "the row is kept — a deleted lead cannot be audited or re-labelled");
  assert.equal(after.status, "stale");
  assert.ok(after.stale_at, "when");
  assert.match(after.stale_reason, /no longer active/, "why");
});

test("a human decision is never overwritten", () => {
  // `published` and `rejected` are terminal, and rejected rows ARE the eval
  // corpus — a sweep that silently retired them would destroy the only record
  // of what a human judged wrong.
  for (const status of ["published", "rejected", "dismissed"]) {
    const l = seedLead({ flagKey: `humanjudged|${status}`, status });
    retireLeadsWithoutActiveFlags();
    assert.equal(getLead(l.key).status, status, `${status} must survive the sweep`);
  }
});

test("a lead with no flag key is left alone", () => {
  // Not every lead comes from the flag store. Absence of a link is not
  // evidence the lead is stale, and guessing would retire the whole
  // denominator suite on the first sweep.
  const l = seedLead({ flagKey: null });
  const r = retireLeadsWithoutActiveFlags();
  assert.equal(getLead(l.key).status, "detected");
  assert.ok(r.retired >= 0);
});

test("retireLeadsNotInRun retires only the vectors the run owns", () => {
  const mine1 = seedLead({ vector: "OWNED_VECTOR" });
  const mine2 = seedLead({ vector: "OWNED_VECTOR" });
  const other = seedLead({ vector: "SOMEONE_ELSES_VECTOR" });

  // A full re-run that re-emitted only the first lead.
  const r = retireLeadsNotInRun(["OWNED_VECTOR"], [mine1.key]);
  assert.equal(r.retired, 1);
  assert.equal(getLead(mine1.key).status, "detected", "re-emitted, so still live");
  assert.equal(getLead(mine2.key).status, "stale", "not re-emitted by a full run");
  assert.equal(getLead(other.key).status, "detected", "a different detector's leads are untouched");
});

test("retireLeadsNotInRun is a no-op when given no vectors", () => {
  const l = seedLead({ vector: "UNTOUCHED" });
  assert.equal(retireLeadsNotInRun([], []).retired, 0);
  assert.equal(getLead(l.key).status, "detected");
});

test("REGRESSION: a re-run that produces nothing retires its whole vector", () => {
  // The MGNREGA case: the plausibility bound removed every lead the old method
  // produced for those rows. An empty result from a FULL run means the data
  // stopped supporting them — not that the sweep should be skipped.
  const a = seedLead({ vector: "EMPTIED_VECTOR" });
  const b = seedLead({ vector: "EMPTIED_VECTOR" });
  const r = retireLeadsNotInRun(["EMPTIED_VECTOR"], []);
  assert.equal(r.retired, 2);
  assert.equal(getLead(a.key).status, "stale");
  assert.equal(getLead(b.key).status, "stale");
  assert.match(getLead(b.key).stale_reason, /no longer produces this lead/);
});

test("a retired lead can come back when the data supports it again", () => {
  const l = seedLead({ vector: "REVIVABLE" });
  retireLeadsNotInRun(["REVIVABLE"], []);
  assert.equal(getLead(l.key).status, "stale");

  // Re-detection writes the lead again. `stale` is not terminal, so it revives
  // rather than being stuck out of sight forever.
  upsertLead({ key: l.key, vector: "REVIVABLE", actor_id: l.actor_id, beneficiary: l.beneficiary, signal_score: 12, data: {} });
  assert.equal(getLead(l.key).status, "detected");
});
