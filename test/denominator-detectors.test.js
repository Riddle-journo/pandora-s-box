// Denominator-detector tests. Pure detectors run over prepared arrays (DB-free).
// One integration test writes synthetic facts to a throwaway DB and runs the full
// loader → detector → upsertLead path, proving entity-keyed leads persist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-denom-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const {
  detectMgnregaWageOutliers, detectMgnregaPaymentDelay, detectSchemeOverspend,
  detectProcurementAboveMarket, runDenominatorDetectors, DENOM_DETECTOR_VERSION,
} = await import("../server/denominator-detectors.js");
const { ensureEntity } = await import("../server/entities.js");
const { upsertFact } = await import("../server/ledger.js");
const store = await import("../server/store.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// ── wage outlier ─────────────────────────────────────────────────────────────
test("wage outlier: flags a district far above the same-month cohort, not the pack", () => {
  // 12 districts ~₹250, one at ₹600 in the same period.
  const recs = [];
  for (let i = 0; i < 12; i++) recs.push({ entity_id: `n${i}`, name: `Normal ${i}`, period: "2024-2025-Dec", wage_rate: 250 + (i % 3), total_exp: 500 });
  recs.push({ entity_id: "hot", name: "Hot District", period: "2024-2025-Dec", wage_rate: 600, total_exp: 500 });
  const out = detectMgnregaWageOutliers(recs);
  assert.equal(out.length, 1, "only the outlier flags");
  assert.equal(out[0].actor_id, "hot");
  assert.equal(out[0].vector, "MGNREGA_WAGE_OUTLIER");
  assert.equal(out[0].beneficiary_kind, "district");
  assert.ok(out[0].data.z >= 3);
});

test("wage outlier: no flag below cohort size, or when wage under the noise floor", () => {
  const small = [{ entity_id: "a", name: "A", period: "p", wage_rate: 900, total_exp: 1 }];
  assert.equal(detectMgnregaWageOutliers(small).length, 0, "cohort too small");
  const lowWage = [];
  for (let i = 0; i < 12; i++) lowWage.push({ entity_id: `n${i}`, name: `N${i}`, period: "p", wage_rate: 10, total_exp: 1 });
  lowWage.push({ entity_id: "hot", name: "Hot", period: "p", wage_rate: 150, total_exp: 1 }); // z high but < WAGE_ABS_MIN
  assert.equal(detectMgnregaWageOutliers(lowWage).length, 0, "below ₹200 noise floor");
});

// ── payment delay ────────────────────────────────────────────────────────────
test("payment delay: flags low on-time % on material spend only", () => {
  const recs = [
    { entity_id: "d1", name: "Late Big", period: "p", pct_paid_15d: 20, total_exp: 800 },   // flag
    { entity_id: "d2", name: "Late Tiny", period: "p", pct_paid_15d: 20, total_exp: 10 },    // below exp floor
    { entity_id: "d3", name: "On Time", period: "p", pct_paid_15d: 95, total_exp: 800 },     // fine
    { entity_id: "d4", name: "No Data", period: "p", pct_paid_15d: null, total_exp: 800 },   // skip
  ];
  const out = detectMgnregaPaymentDelay(recs);
  assert.equal(out.length, 1);
  assert.equal(out[0].actor_id, "d1");
  assert.equal(out[0].vector, "MGNREGA_PAYMENT_DELAY");
});

// ── scheme overspend ─────────────────────────────────────────────────────────
test("scheme overspend: flags spend beyond allocation past both floors", () => {
  const recs = [
    { entity_id: "s1", name: "Overspent", period: "2020-21", allocated: 1000, expenditure: 1400 }, // 1.4×, +400
    { entity_id: "s2", name: "Underspent", period: "2020-21", allocated: 1000, expenditure: 800 },  // fine
    { entity_id: "s3", name: "Tiny Over", period: "2020-21", allocated: 1000, expenditure: 1160 },  // 1.16× but +160≥50 → flag
    { entity_id: "s4", name: "Barely", period: "2020-21", allocated: 1000, expenditure: 1100 },     // 1.1× < 1.15 ratio → no
  ];
  const out = detectSchemeOverspend(recs).map((c) => c.actor_id).sort();
  assert.deepEqual(out, ["s1", "s3"]);
});

// ── procurement above market ─────────────────────────────────────────────────
test("procurement above market: flags a purchase far above the mandi median", () => {
  const baseline = new Map([
    ["onion", { median: 2000, n: 5 }],
    ["potato", { median: 1500, n: 8 }],
    ["rare veg", { median: 900, n: 1 }], // too few quotes → baseline untrusted
  ]);
  const recs = [
    { entity_id: "p1", name: "Dept A", commodity: "Onion", unit_price: 3600, period: "2026-07" }, // 1.8× → flag
    { entity_id: "p2", name: "Dept B", commodity: "Potato", unit_price: 1600, period: "2026-07" }, // 1.07× → no
    { entity_id: "p3", name: "Dept C", commodity: "Rare Veg", unit_price: 5000, period: "2026-07" }, // baseline n<3 → no
    { entity_id: "p4", name: "Dept D", commodity: "Unlisted", unit_price: 9999, period: "2026-07" }, // no baseline → no
  ];
  const out = detectProcurementAboveMarket(recs, baseline);
  assert.equal(out.length, 1);
  assert.equal(out[0].actor_id, "p1");
  assert.equal(out[0].vector, "PROCUREMENT_ABOVE_MARKET");
  assert.ok(out[0].data.ratio >= 1.5);
});

// ── integration: facts → loaders → detectors → leads ─────────────────────────
test("integration: writes facts, runs orchestrator, persists entity-keyed leads", () => {
  // 12 baseline districts + 1 wage outlier + 1 payment-delay, all same period.
  const period = "2024-2025-Dec";
  for (let i = 0; i < 12; i++) {
    const eid = ensureEntity({ kind: "district", name: `State / District ${i}`, source: "test" });
    upsertFact({ entity_id: eid, subject_kind: "district", metric: "mgnrega_avg_wage_rate", value: 250, as_of_date: period, period, extractor_version: "test" });
    upsertFact({ entity_id: eid, subject_kind: "district", metric: "mgnrega_total_expenditure", value: 500, as_of_date: period, period, extractor_version: "test" });
    upsertFact({ entity_id: eid, subject_kind: "district", metric: "mgnrega_pct_paid_15d", value: 95, as_of_date: period, period, extractor_version: "test" });
  }
  const hot = ensureEntity({ kind: "district", name: "State / Hotspot", source: "test" });
  upsertFact({ entity_id: hot, subject_kind: "district", metric: "mgnrega_avg_wage_rate", value: 700, as_of_date: period, period, extractor_version: "test" });
  upsertFact({ entity_id: hot, subject_kind: "district", metric: "mgnrega_total_expenditure", value: 900, as_of_date: period, period, extractor_version: "test" });
  upsertFact({ entity_id: hot, subject_kind: "district", metric: "mgnrega_pct_paid_15d", value: 15, as_of_date: period, period, extractor_version: "test" });

  const sc = ensureEntity({ kind: "scheme", name: "Test Scheme", source: "test" });
  upsertFact({ entity_id: sc, subject_kind: "scheme", metric: "scheme_allocated_fund", value: 1000, period: "2020-21", as_of_date: "2020-21", extractor_version: "test" });
  upsertFact({ entity_id: sc, subject_kind: "scheme", metric: "scheme_expenditure", value: 1500, period: "2020-21", as_of_date: "2020-21", extractor_version: "test" });

  const res = runDenominatorDetectors({ log: () => {} });
  assert.ok(res.inputs.mgnrega_district_months >= 13, "pivoted district-months loaded");
  assert.equal(res.counts.MGNREGA_WAGE_OUTLIER, 1, "one wage outlier");
  assert.equal(res.counts.MGNREGA_PAYMENT_DELAY, 1, "one payment delay");
  assert.equal(res.counts.SCHEME_OVERSPEND, 1, "one overspend");

  const leads = store.listLeads({ status: "detected" });
  const vectors = new Set(leads.map((l) => l.vector));
  assert.ok(vectors.has("MGNREGA_WAGE_OUTLIER") && vectors.has("SCHEME_OVERSPEND"));
  const wageLead = leads.find((l) => l.vector === "MGNREGA_WAGE_OUTLIER");
  assert.equal(wageLead.actor_id, hot, "lead keyed on the district ENTITY id");
  assert.equal(wageLead.detector_version, DENOM_DETECTOR_VERSION);

  // Idempotent: a re-run upserts the same keys, no duplicates.
  runDenominatorDetectors({ log: () => {} });
  assert.equal(store.listLeads({ status: "detected" }).filter((l) => l.vector === "MGNREGA_WAGE_OUTLIER").length, 1);
});
