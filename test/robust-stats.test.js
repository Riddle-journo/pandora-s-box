// Robust statistics + plausibility bounds.
//
// Both defects these fix were live, in the MGNREGA wage data:
//
//   * 366 of 6,410 district-month rows carry impossible values — the worst is
//     ₹1,481,735 as an average DAILY wage against a notified rate in the low
//     hundreds. The engine reported it as a "26.9σ" finding.
//   * Because the cohort statistic was a MEAN, those same rows dragged one
//     month's baseline from about ₹368 to ₹2,403, hiding the real outliers
//     behind the fake ones.
import test from "node:test";
import assert from "node:assert/strict";

import { median, medianMad, robustZ, plausibilityFilter } from "../server/detectors/robust-stats.js";

test("median handles both parities and ignores non-numbers", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([1, null, 2, undefined, NaN, 3]), 2);
  assert.equal(median([]), null);
});

test("medianMad uses the MAD when the cohort has spread", () => {
  const s = medianMad([10, 12, 14, 16, 18]);
  assert.equal(s.method, "mad");
  assert.equal(s.median, 14);
  assert.ok(s.sigma > 0);
  assert.equal(s.n, 5);
});

test("the scale falls back when MAD collapses on ties", () => {
  // More than half the cohort shares one value — the normal case for a
  // centrally-notified wage. MAD is 0, so the ladder must keep going.
  const tied = medianMad([250, 250, 250, 250, 250, 250, 250, 700]);
  assert.equal(tied.mad, 0);
  assert.notEqual(tied.method, "none", "a detector must not go silent on a tight baseline");
  assert.ok(tied.sigma > 0);
  assert.equal(tied.median, 250, "the centre is still the median, unmoved by the outlier");

  // Every value identical: there is genuinely nothing to be an outlier of.
  const flat = medianMad([250, 250, 250, 250]);
  assert.equal(flat.method, "none");
  assert.equal(flat.sigma, 0);
});

test("robustZ refuses to score against zero dispersion", () => {
  assert.equal(robustZ(500, { median: 250, sigma: 0 }), null,
    "no spread is an honest 'cannot say', not infinite certainty");
  assert.equal(robustZ(500, { median: null, sigma: 5 }), null);
  assert.equal(robustZ(NaN, { median: 250, sigma: 5 }), null);
  assert.equal(robustZ(260, { median: 250, sigma: 5 }), 2);
});

test("REGRESSION: one corrupt row cannot move the centre", () => {
  // The live shape: a normal cohort plus a single impossible value.
  const normal = [220, 230, 240, 250, 260, 270, 280];
  const poisoned = [...normal, 1_481_735];

  const mean = poisoned.reduce((a, b) => a + b, 0) / poisoned.length;
  assert.ok(mean > 185_000, "this is what a mean does with a corrupt row");

  const s = medianMad(poisoned);
  assert.equal(s.median, 255, "the median barely notices");
  // And the fake value is still identified as the extreme one, rather than
  // becoming the new normal that hides everything else.
  assert.ok(robustZ(1_481_735, s) > 10);
  assert.ok(robustZ(280, s) < 3, "a genuinely ordinary district stays ordinary");
});

test("plausibilityFilter separates the impossible from the merely high", () => {
  const rows = [
    { name: "A", period: "p", wage: 250 },
    { name: "B", period: "p", wage: 526 },          // high but possible
    { name: "C", period: "p", wage: 1_481_735 },    // impossible
    { name: "D", period: "p", wage: null },
  ];
  const r = plausibilityFilter(rows, (x) => x.wage, { min: 1, max: 1000, label: "daily wage (₹)" });
  assert.equal(r.kept.length, 2);
  assert.deepEqual(r.kept.map((x) => x.name), ["A", "B"]);
  assert.equal(r.rejected.length, 2);
  assert.equal(r.summary.total, 4);
  assert.equal(r.summary.rejected, 2);
});

test("rejected rows are REPORTED, not silently dropped", () => {
  // A source that starts failing its plausibility band is an extractor
  // breaking. Swallowing that trades a visible bad lead for an invisible bad
  // pipeline, which is the worse bargain.
  const rows = [
    { name: "PUDUCHERRY / PONDICHERRY", period: "2024-2025-April", wage: 1_481_735 },
    { name: "MANIPUR / TAMENGLONG", period: "2024-2025-July", wage: 1_440_993 },
    { name: "OK / FINE", period: "p", wage: 300 },
  ];
  const r = plausibilityFilter(rows, (x) => x.wage, { min: 1, max: 1000, label: "daily wage (₹)" });
  assert.equal(r.summary.worst.length, 2);
  assert.equal(r.summary.worst[0].name, "PUDUCHERRY / PONDICHERRY", "worst offender first");
  assert.match(r.summary.worst[0].reason, /above plausible/);
  assert.equal(r.summary.worst[0].period, "2024-2025-April", "enough context to find the broken row");
});

test("an empty or all-invalid input is not an error", () => {
  assert.equal(medianMad([]).method, "none");
  assert.equal(plausibilityFilter([], (x) => x).kept.length, 0);
  const r = plausibilityFilter([{ v: null }, { v: NaN }], (x) => x.v, { min: 0, max: 10 });
  assert.equal(r.kept.length, 0);
  assert.equal(r.rejected.length, 2);
});
