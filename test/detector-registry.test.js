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
