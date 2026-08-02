// Cohort base-rate guard.
//
// The complaint this answers, in the owner's words: the engine produced a lead
// saying 128 MPs had not used their MPLADS funds and treated it as a
// conspiracy. It wasn't one. Measured on the live database, 128 of the 472
// members who have MPLADS figures at all — 27.1% — cross that threshold, and a
// second MPLADS detector fired on 303 of 472 (64.2%).
//
// A detector firing on a quarter to two-thirds of its cohort is measuring the
// cohort, not its members. These tests pin that rule: the middle is suppressed,
// the genuine tail survives with its score intact, and the pattern itself
// becomes one finding about the programme.
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCohortGuard, guardDetector, systemicFinding, populationForMetric, COHORT_DEFAULTS,
} from "../server/detectors/cohort-guard.js";

// n candidates whose statistic climbs 0, 1, 2 … so the tail is unambiguous.
function candidates(n, { extreme = "under-utilised", score = 30 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    subject: { politician_id: `p${i}`, name: `Member ${i}` },
    actor_name: `Member ${i}`,
    score, signal_score: score,
    headline: `utilisation ${i}%`, detail: "base detail.",
    data: { utilization_pct: i, extreme },
  }));
}
const COHORT = {
  metric: "mplads_utilization_pct", subjectKind: "programme",
  subjectName: "MPLADS", unit: "% utilised",
  stat: (c) => c.data?.utilization_pct ?? null,
  direction: "low",
};

test("a rare finding passes through completely untouched", () => {
  const cands = candidates(10);
  const r = applyCohortGuard(cands, { ...COHORT, population: 500 });
  assert.equal(r.candidates.length, 10, "2% of the cohort is a genuine anomaly");
  assert.equal(r.systemic, null);
  assert.equal(r.stats.systemic, false);
  assert.equal(r.candidates[0].cohort_context, undefined, "no annotation when nothing is systemic");
});

test("a widespread finding keeps only the tail and emits one systemic finding", () => {
  const r = applyCohortGuard(candidates(128), { ...COHORT, population: 472 });
  assert.equal(r.stats.systemic, true);
  assert.equal(r.stats.fire_rate, 27.1, "the measured live rate");
  assert.equal(r.candidates.length, 24, "ceil(472 * 0.05)");
  assert.equal(r.stats.suppressed, 104);
  assert.equal(r.stats.kept + r.stats.suppressed, 128, "every candidate is accounted for");
  assert.ok(r.systemic, "the pattern itself becomes a finding");
  assert.match(r.systemic.headline, /128 of 472 \(27\.1%\)/);
});

test("the tail is the most extreme end, chosen by direction", () => {
  const low = applyCohortGuard(candidates(128), { ...COHORT, population: 472, direction: "low" });
  assert.deepEqual(low.candidates.map((c) => c.data.utilization_pct).slice(0, 3), [0, 1, 2],
    "'low' keeps the least-spent");
  const high = applyCohortGuard(candidates(128), { ...COHORT, population: 472, direction: "high" });
  assert.deepEqual(high.candidates.map((c) => c.data.utilization_pct).slice(0, 3), [127, 126, 125],
    "'high' keeps the most-spent");
});

test("an unknown or tiny population never suppresses anything", () => {
  const cands = candidates(50);
  assert.equal(applyCohortGuard(cands, { ...COHORT, population: 0 }).candidates.length, 50,
    "no denominator means no base rate — never guess one");
  assert.equal(applyCohortGuard(cands, { ...COHORT, population: 20 }).candidates.length, 50,
    "20 subjects cannot establish a rate");
  assert.equal(applyCohortGuard(cands, { ...COHORT, population: 0 }).systemic, null);
});

test("the tail keeps its score; unrankable candidates are halved instead", () => {
  const tail = applyCohortGuard(candidates(128), { ...COHORT, population: 472 });
  assert.equal(tail.candidates[0].signal_score, 30, "the worst of 472 peers is the claim worth making");
  assert.equal(tail.candidates[0].cohort_context.is_cohort_tail, true);

  // Same rate, but no comparable statistic — we know the pattern is common and
  // cannot show any one case is exceptional.
  const blind = candidates(128).map((c) => ({ ...c, data: { extreme: "under-utilised" } }));
  const r = applyCohortGuard(blind, { ...COHORT, population: 472 });
  assert.equal(r.candidates.length, 128, "nothing is dropped that we cannot rank");
  assert.equal(r.candidates[0].signal_score, 15, "but an unverifiable claim is demoted");
  assert.equal(r.candidates[0].cohort_context.is_cohort_tail, false);
  assert.ok(r.systemic, "the base rate is still reported");
});

test("minKeep floors the tail even when the cohort is small", () => {
  const r = applyCohortGuard(candidates(30), { ...COHORT, population: 40 });
  assert.equal(r.stats.systemic, true, "30 of 40 is overwhelmingly systemic");
  assert.equal(r.candidates.length, COHORT_DEFAULTS.minKeep,
    "the most extreme handful always survive, whatever the base rate");
});

test("every surviving candidate carries the base rate, so it cannot be read as a lone aberration", () => {
  const r = applyCohortGuard(candidates(128), { ...COHORT, population: 472 });
  for (const c of r.candidates) {
    assert.equal(c.cohort_context.cohort_fire_rate_pct, 27.1);
    assert.equal(c.data.cohort_context.cohort_population, 472);
    assert.match(c.detail, /128 of 472 comparable subjects/);
    assert.match(c.detail, /rather than about this individual/);
  }
});

test("opposite tails are judged separately, not pooled", () => {
  // 128 under-spenders (systemic at 27%) and 6 spend-to-the-rupee cases (1.3%,
  // a genuine anomaly). Pooling them would sweep the 6 into a systemic verdict
  // they are not part of.
  const mixed = [...candidates(128, { extreme: "under-utilised" }), ...candidates(6, { extreme: "fully-drawn" })];
  const r = guardDetector(mixed, {
    ...COHORT, population: 472,
    groupBy: (c) => c.data.extreme,
    directionFor: (k) => (k === "fully-drawn" ? "high" : "low"),
  });
  assert.equal(r.stats.groups["under-utilised"].systemic, true);
  assert.equal(r.stats.groups["fully-drawn"].systemic, false, "6 of 472 is still an anomaly");
  assert.equal(r.systemic.length, 1, "only the widespread tail produces a systemic finding");
  const fullyDrawn = r.candidates.filter((c) => c.data.extreme === "fully-drawn");
  assert.equal(fullyDrawn.length, 6, "the rare condition survives intact");
  assert.equal(fullyDrawn[0].cohort_context, undefined, "and is not annotated as commonplace");
});

test("guardDetector without a grouping still guards", () => {
  const r = guardDetector(candidates(303), { ...COHORT, population: 472, subjectName: "MPLADS works completion" });
  assert.equal(r.systemic.length, 1);
  assert.match(r.systemic[0].headline, /303 of 472 \(64\.2%\)/, "the second measured MPLADS rate");
  assert.equal(r.candidates.length, 24);
});

test("the systemic finding carries arithmetic a reader can check", () => {
  const s = systemicFinding(candidates(128), COHORT, {
    population: 472, fired: 128, fire_rate: 27.1, kept: 24, suppressed: 104, systemic: true,
  });
  assert.equal(s.vector, "SYSTEMIC_PATTERN");
  assert.equal(s.data.population, 472);
  assert.equal(s.data.fired, 128);
  assert.equal(s.data.individually_retained + s.data.suppressed_as_typical, 128);
  assert.equal(s.data.most_extreme.length, 5, "named worst cases, so it is checkable");
  assert.match(s.detail, /not an accusation against any individual/);
  // Score scales with how widespread it is — a scheme failing most of its
  // cohort is a bigger institutional story than one failing a fifth.
  const worse = systemicFinding([], COHORT, { population: 472, fired: 303, fire_rate: 64.2, kept: 24, suppressed: 279 });
  assert.ok(worse.signal_score > s.signal_score);
  assert.equal(worse.severity, "SIGNIFICANT");
});

test("populationForMetric is fail-soft and counts distinct subjects", () => {
  assert.equal(populationForMetric(null, "x"), 0, "a missing ctx is 0, not a crash");
  assert.equal(populationForMetric({}, "x"), 0);
  const ctx = { factsForPoliticians: () => [{ pid: "a" }, { pid: "a" }, { pid: "b" }] };
  assert.equal(populationForMetric(ctx, "m"), 2, "two rows for one person is one subject");
});

test("REGRESSION: the 128-MP MPLADS lead does not recur", () => {
  // The exact reported failure. Before the guard this produced 128 individual
  // leads, each implying an individual failure.
  const r = guardDetector(candidates(128), {
    ...COHORT, population: 472,
    groupBy: (c) => c.data.extreme, directionFor: () => "low",
  });
  assert.ok(r.candidates.length < 30, `128 individual leads became ${r.candidates.length}`);
  assert.equal(r.systemic.length, 1);
  // And what replaced them is a real story about the scheme, with its working shown.
  assert.match(r.systemic[0].headline, /27\.1%/);
  assert.equal(r.systemic[0].subject_kind, "programme");
  assert.equal(r.systemic[0].data.suppressed_as_typical, 104);
});
