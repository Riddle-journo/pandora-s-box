// Snapshot test pinning the EXACT ORDERED list of detector ids in the engine
// registry (engine.js DETECTORS). Registry ORDER is load-bearing: the ops
// console, run scoping, and stale-marking all iterate DETECTORS in order.
// The 9 cppp_* ids are appended to the registry at import time from
// cppp-detectors.js — they are pinned here in their appended position too.
// If this list changes, that is a deliberate registry edit; update it here on
// purpose (do not reorder to make the test pass).
import test from "node:test";
import assert from "node:assert/strict";

const { DETECTORS } = await import("../server/detectors/engine.js");

const EXPECTED_IDS = [
  "conflict",
  "asset_outlier",
  "fund_utilization",
  "timing_correlation",
  "income_outlier",
  "spend_vs_income",
  "multi_source_adverse",
  "collusion",
  "da_ratio",
  "liability_spike",
  "criminal_escalation",
  "expenditure_limit",
  "asset_income_mismatch",
  "young_wealth",
  "benford",
  "parliament_inactivity",
  "mplads_completion_gap",
  "nominee_director",
  "award_concentration",
  "bond_contract_proximity",
  "family_adverse",
  "party_income_spike",
  "party_spend_vs_donations",
  "round_numbers",
  "generic_outlier",
  "multivariate_outlier",
  "metric_changepoint",
  "nexus_triangle",
  "ownership_chain",
  "tender_capacity_mismatch",
  "undeclared_criminal_case",
  "vanishing_asset_item",
  "copy_paste_affidavit",
  "liability_writeoff",
  "net_worth_reconciliation",
  "zero_liability_implausibility",
  "multirole_company",
  "politician_linked_award",
  "declared_company_absent_from_registry",
  "donor_ruling_party_contractor",
  // ── appended at import time from cppp-detectors.js (procurement) ──
  "cppp_supplier_capture",
  "cppp_single_bidder",
  "cppp_contract_splitting",
  "cppp_short_window",
  "cppp_benford_values",
  "cppp_fy_end_bunching",
  "cppp_repeat_winner",
  "cppp_date_integrity",
  "cppp_anonymous_winner",
];

test("detector registry: exact ordered id list is pinned", () => {
  assert.deepEqual(DETECTORS.map((d) => d.id), EXPECTED_IDS);
});

// Cohort descriptors are hand-written objects sitting between two other
// hand-written objects in a 2,000-line registry file, and a malformed one fails
// SILENTLY: `guardDetector` sees no usable statistic, keeps every candidate,
// and the detector goes back to emitting a lead per person with nobody the
// wiser. (Writing these, a misplaced `}),` produced exactly that shape.) So the
// shape is pinned rather than trusted.
test("detector registry: every cohort descriptor is well formed", () => {
  const withCohort = DETECTORS.filter((d) => d.cohort);
  assert.ok(withCohort.length >= 4, "the measured over-firing detectors still carry a cohort");

  for (const d of withCohort) {
    const c = d.cohort;
    assert.equal(typeof c.metric, "string", `${d.id}: needs a metric to count its eligible population from`);
    assert.ok(c.metric.length > 0, `${d.id}: metric must not be empty`);
    assert.equal(typeof c.stat, "function", `${d.id}: needs a statistic accessor, or the tail cannot be ranked`);
    assert.equal(typeof c.subjectName, "string", `${d.id}: the systemic finding must name what it is about`);
    assert.ok(c.subjectName.length > 3, `${d.id}: subjectName must be meaningful`);
    assert.equal(typeof c.subjectKind, "string", `${d.id}: subjectKind`);

    // Direction decides which end of the cohort is the adverse tail. Either a
    // fixed direction or a per-group resolver, never neither — defaulting it
    // would silently keep the wrong end.
    const hasDirection = c.direction === "low" || c.direction === "high";
    assert.ok(hasDirection || typeof c.directionFor === "function",
      `${d.id}: needs direction ("low"/"high") or directionFor(groupKey)`);
    if (typeof c.groupBy === "function") {
      assert.equal(typeof c.directionFor, "function",
        `${d.id}: a grouped cohort must resolve direction per group — the groups may have opposite tails`);
    }
  }
});

test("detector registry: a cohort's stat accessor tolerates a malformed candidate", () => {
  // The accessor runs over whatever the detector emitted. If a candidate is
  // missing its data blob the accessor must return null (which the guard treats
  // as unrankable and handles), not throw and take the whole engine run down.
  for (const d of DETECTORS.filter((x) => x.cohort)) {
    for (const bad of [{}, { data: null }, { data: {} }, { data: { series: [] } }]) {
      assert.doesNotThrow(() => d.cohort.stat(bad), `${d.id}: stat() threw on ${JSON.stringify(bad)}`);
      const v = d.cohort.stat(bad);
      assert.ok(v == null || Number.isFinite(v), `${d.id}: stat() must return a number or null`);
    }
  }
});
