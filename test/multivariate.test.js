// Pure detector functions for the multivariate + change-point detectors. No DB —
// fixtures only, so the maths is pinned independently of the ledger wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { mahalanobisOutliers, changePoint, median, slog } from "../server/engine-multivariate.js";

test("median + slog: basics", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(slog(0), 0);
  assert.ok(slog(1e7) > slog(1e5)); // monotone
  assert.ok(slog(-100) < 0); // sign-preserving
});

test("mahalanobisOutliers: flags the rep whose COMBINATION is off, not the boring ones", () => {
  // 20 reps: 19 with a consistent profile (assets≈income≈spend all mid), one whose
  // individual metrics are each in-range but combined oddly (low income, high spend).
  const rows = [];
  for (let i = 0; i < 19; i++) {
    rows.push({ id: `n${i}`, name: `N${i}`, cohort: "MP", metrics: {
      declared_assets: 1e7 + i * 1e5, declared_income: 1e6 + i * 1e4,
      election_expenditure: 9e5 + i * 1e4, criminal_cases: i % 3,
    } });
  }
  // The odd one: normal assets, but income at the floor and spend at the ceiling.
  rows.push({ id: "odd", name: "Odd", cohort: "MP", metrics: {
    declared_assets: 1.1e7, declared_income: 1e3 /* far below */, election_expenditure: 5e7 /* far above */, criminal_cases: 1,
  } });
  const res = mahalanobisOutliers(rows, { minCohort: 12, minAxes: 3, zSqFlag: 3, zSqBig: 8 });
  assert.ok(res.length >= 1, "an outlier is found");
  assert.equal(res[0].id, "odd", "the odd-combination rep ranks first");
  const drivers = res[0].top.map((t) => t.metric);
  assert.ok(drivers.includes("declared_income") || drivers.includes("election_expenditure"), "the driving axes are the anomalous ones");
});

test("mahalanobisOutliers: a single degenerate axis cannot dominate (z clamp)", () => {
  // A cohort where everyone declares 0 criminal cases except one rep with 50.
  const rows = [];
  for (let i = 0; i < 15; i++) rows.push({ id: `c${i}`, name: `C${i}`, cohort: "MP", metrics: { declared_assets: 1e7 + i * 1e5, declared_income: 1e6 + i * 1e4, criminal_cases: 0, election_expenditure: 1e6 } });
  rows.push({ id: "crim", name: "Crim", cohort: "MP", metrics: { declared_assets: 1.05e7, declared_income: 1.05e6, criminal_cases: 50, election_expenditure: 1e6 } });
  const res = mahalanobisOutliers(rows, { minCohort: 12, minAxes: 3, zSqFlag: 3, zSqBig: 8, zClamp: 6 });
  const crim = res.find((r) => r.id === "crim");
  // It may flag, but the clamp keeps the score finite/bounded — never Infinity.
  if (crim) assert.ok(Number.isFinite(crim.score) && crim.score < 40, "clamped score stays bounded");
});

test("changePoint: finds a real step-change, ignores steady growth", () => {
  // A flat-then-jump series: 1,1,1,1 then 100,100,100 → break after index 3.
  const jump = [1, 1, 1, 1, 100, 100, 100].map((v, i) => ({ x: 2010 + i, value: v, evidence_id: `e${i}` }));
  const cp = changePoint(jump, { minPoints: 4, minShiftZ: 1 });
  assert.ok(cp, "a change-point is found");
  assert.equal(cp.direction, "jump");
  assert.equal(cp.at, 2013, "break is at the last low year");
  assert.ok(cp.shiftZ > 1);

  // Steady linear growth has no single dominant break large enough at a high bar.
  const smooth = Array.from({ length: 8 }, (_, i) => ({ x: 2010 + i, value: 100 + i * 5 }));
  assert.equal(changePoint(smooth, { minPoints: 4, minShiftZ: 3 }), null, "gentle slope doesn't trip a high bar");

  // Too few points → null.
  assert.equal(changePoint([{ x: 1, value: 1 }, { x: 2, value: 9 }], { minPoints: 4 }), null);
});
