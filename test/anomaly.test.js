// Statistical detectors (anomaly-v1). The three detectors are pure functions over
// prepared arrays, so most of this runs with hand-built fixtures and no DB. One
// test uses a temp DB to prove upsertLead idempotency + status precedence.
//
// The asset fixture is hand-computed: a 12-event cohort with ratios {8×2.0, 3×1.0,
// 1×5.0} has mean 2.0 and population std 1.0, so the 5.0 outlier sits at exactly
// z=3.0 — the single event that should flag.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-anomaly-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const {
  detectAssetGrowthOutliers, detectUtilizationExtremes, detectTimingCorrelation,
  DETECTOR_VERSION,
} = await import("../server/detectors/anomaly.js");
const { upsertLead, getLead, listLeads } = await import("../server/store/store.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// Build a two-year asset record pair yielding a given growth ratio in a cohort.
function pair(id, cohort, ratio) {
  const from = 1e7; // ₹1 Cr base
  return [
    { politician_id: id, name: `P-${id}`, cohort, year: 2014, assets_total: from, evidence_id: `${id}-a` },
    { politician_id: id, name: `P-${id}`, cohort, year: 2019, assets_total: from * ratio, evidence_id: `${id}-b` },
  ];
}

// Cohort of 12 growth events: mean ratio 2.0, pop std 1.0, one outlier at 5.0 (z=3).
function assetCohort() {
  const ratios = [5.0, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1]; // p0 is the outlier
  const recs = [];
  ratios.forEach((r, i) => recs.push(...pair(`p${i}`, "TestState", r)));
  return recs;
}

test("detectAssetGrowthOutliers flags exactly the z=3 outlier with the right z", () => {
  const out = detectAssetGrowthOutliers(assetCohort());
  assert.equal(out.length, 1);
  const lead = out[0];
  assert.equal(lead.actor_id, "p0");
  assert.equal(lead.vector, "STAT_ASSET_OUTLIER");
  assert.equal(lead.detector_version, DETECTOR_VERSION);
  assert.ok(Math.abs(lead.data.z - 3.0) < 1e-6, `z was ${lead.data.z}`);
  assert.equal(lead.data.cohort_n, 12);
  assert.deepEqual(lead.data.evidence_ids, ["p0-a", "p0-b"]); // provenance carried
});

test("detectAssetGrowthOutliers suppresses small cohorts (n<8) even with an extreme outlier", () => {
  // 7 events only — one wild 20× outlier — must NOT flag (below MIN_COHORT_N).
  const ratios = [20, 1, 1, 1, 1, 1, 1];
  const recs = [];
  ratios.forEach((r, i) => recs.push(...pair(`s${i}`, "SmallState", r)));
  assert.equal(detectAssetGrowthOutliers(recs).length, 0);
});

test("detectAssetGrowthOutliers respects the ₹2 Cr absolute-growth floor", () => {
  // A statistically extreme ratio on tiny sums (₹1k → below ₹2 Cr) must not flag.
  const recs = [];
  const ratios = [5.0, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1];
  ratios.forEach((r, i) => {
    const from = 1000; // ₹1k base → outlier grows only ₹4k, far under ₹2 Cr
    recs.push(
      { politician_id: `t${i}`, name: `T-${i}`, cohort: "TinyState", year: 2014, assets_total: from },
      { politician_id: `t${i}`, name: `T-${i}`, cohort: "TinyState", year: 2019, assets_total: from * r },
    );
  });
  assert.equal(detectAssetGrowthOutliers(recs).length, 0);
});

test("detectUtilizationExtremes flags both tails and honours the edge thresholds", () => {
  const recs = [
    { politician_id: "u1", name: "U1", utilization_pct: 14.9, allocated: 5e7 },  // < 15 → flag (low)
    { politician_id: "u2", name: "U2", utilization_pct: 15.0, allocated: 5e7 },  // == 15 → no flag
    { politician_id: "u3", name: "U3", utilization_pct: 98.0, allocated: 5e7 },  // == 98 → no flag
    { politician_id: "u4", name: "U4", utilization_pct: 98.1, allocated: 5e7 },  // > 98 → flag (high)
    { politician_id: "u5", name: "U5", utilization_pct: 5.0, allocated: 5e6 },   // tiny fund (<₹1cr) → no flag
  ];
  const out = detectUtilizationExtremes(recs);
  const ids = out.map((c) => c.actor_id).sort();
  assert.deepEqual(ids, ["u1", "u4"]);
  assert.ok(out.every((c) => c.vector === "STAT_FUND_UTILIZATION"));
  assert.equal(out.find((c) => c.actor_id === "u1").data.extreme, "under-utilised");
  assert.equal(out.find((c) => c.actor_id === "u4").data.extreme, "fully-drawn");
});

test("detectTimingCorrelation: day 90 is inside the window, day 91 is outside", () => {
  const bp = { kind: "bond_purchase", at: "2022-01-01", donor_entity_id: "D1", donor_name: "Donor", party_entity_id: "P" };
  const within = detectTimingCorrelation([
    bp, { kind: "awarded_tender", at: "2022-04-01", awardee_entity_id: "D1" }, // exactly 90 days
  ]);
  assert.equal(within.length, 1);
  assert.equal(within[0].vector, "STAT_TIMING_CORRELATION");
  assert.equal(within[0].data.days_apart, 90);
  assert.equal(within[0].data.same_entity, true);

  const beyond = detectTimingCorrelation([
    bp, { kind: "awarded_tender", at: "2022-04-02", awardee_entity_id: "D1" }, // 91 days
  ]);
  assert.equal(beyond.length, 0);
});

test("detectTimingCorrelation pairs a sister company via the sharesDirector predicate", () => {
  const events = [
    { kind: "bond_purchase", at: "2022-01-01", donor_entity_id: "D1", donor_name: "Donor" },
    { kind: "awarded_tender", at: "2022-02-01", awardee_entity_id: "SISTER" },
  ];
  const none = detectTimingCorrelation(events); // default predicate → no link
  assert.equal(none.length, 0);
  const linked = detectTimingCorrelation(events, { sharesDirector: (a, b) => a === "D1" && b === "SISTER" });
  assert.equal(linked.length, 1);
  assert.equal(linked[0].data.same_entity, false);
});

test("upsertLead is idempotent and never resets a human-advanced status", () => {
  const [candidate] = detectUtilizationExtremes([
    { politician_id: "z1", name: "Z1", utilization_pct: 2.0, allocated: 5e7, evidence_id: "z1-ev" },
  ]);

  // 1. First detection → status 'detected'.
  upsertLead(candidate);
  const key = `${candidate.vector}|${candidate.actor_id}|${candidate.beneficiary}`;
  assert.equal(getLead(key).status, "detected");

  // 2. The funnel advances it (AI/human).
  upsertLead({ ...candidate, status: "investigated" });
  assert.equal(getLead(key).status, "investigated");

  // 3. A later detector re-run (candidate carries NO status) must NOT reset it,
  //    and must not create a duplicate row.
  const before = listLeads({ status: "investigated" }).filter((l) => l.actor_id === "z1").length;
  upsertLead(candidate);
  assert.equal(getLead(key).status, "investigated");
  const after = listLeads({ status: "investigated" }).filter((l) => l.actor_id === "z1").length;
  assert.equal(before, 1);
  assert.equal(after, 1);
});
