// Phase 4 — ledger-native detectors. Pure detectors are tested with hand-built
// fixtures (no DB); an integration test seeds the facts ledger and drives the full
// path (ledger → loader → detector → investigation_leads), including idempotency.
//
// Income cohort: 12 growth events with ratios {1×5.0, 8×2.0, 3×1.0} → mean 2.0,
// pop std 1.0, so the 5.0 event sits at exactly z=3.0 — the one that should flag.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-ledgerdet-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { upsertPolitician, listLeads } = await import("../server/store/store.js");
const { ensureEntity } = await import("../server/entities/entities.js");
const { upsertFact } = await import("../server/store/ledger.js");
const {
  detectIncomeGrowthOutliers, detectSpendVsIncome, detectMultiSourceAdverse,
  runLedgerDetectors, LEDGER_DETECTOR_VERSION,
} = await import("../server/detectors/ledger-detectors.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

function incomeCohort() {
  const ratios = [5, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1]; // p0 is the outlier
  const recs = [];
  ratios.forEach((r, i) => {
    recs.push({ politician_id: `p${i}`, name: `P${i}`, cohort: "X", year: 2020, income: 1e6, evidence_id: `${i}a` });
    recs.push({ politician_id: `p${i}`, name: `P${i}`, cohort: "X", year: 2021, income: 1e6 * r, evidence_id: `${i}b` });
  });
  return recs;
}

test("detectIncomeGrowthOutliers: flags the single z=3 outlier", () => {
  const c = detectIncomeGrowthOutliers(incomeCohort());
  assert.equal(c.length, 1);
  assert.equal(c[0].actor_id, "p0");
  assert.equal(c[0].vector, "STAT_INCOME_OUTLIER");
  assert.equal(c[0].data.z.toFixed(1), "3.0");
  assert.ok(c[0].signal_score > 0);
});

test("detectIncomeGrowthOutliers: suppresses small cohorts", () => {
  const small = incomeCohort().filter((r) => ["p0", "p1", "p2"].includes(r.politician_id));
  assert.equal(detectIncomeGrowthOutliers(small).length, 0);
});

test("detectSpendVsIncome: cohort-relative — flags the outlier, not the systemic 3-4×", () => {
  // A cohort where a 3-4× spend/income ratio is the NORM (systemic), plus one rep
  // whose ratio is a genuine outlier. The old absolute-multiple detector would have
  // flagged all of them; the cohort-relative one flags only the outlier.
  const cohort = [];
  for (let i = 0; i < 9; i++) cohort.push({ politician_id: `n${i}`, name: `N${i}`, cohort: "X", spend: 3.5e6, income: 1e6 }); // 3.5× is the norm
  cohort.push({ politician_id: "out", name: "Out", cohort: "X", spend: 1.5e7, income: 1e6, spend_year: "2024", income_year: "2024" }); // 15× outlier
  const c = detectSpendVsIncome(cohort);
  assert.equal(c.length, 1);
  assert.equal(c[0].actor_id, "out");
  assert.equal(c[0].vector, "STAT_SPEND_VS_INCOME");
  assert.equal(c[0].data.ratio, 15);
  assert.ok(c[0].data.z > 2);
});

test("detectSpendVsIncome: sub-floor and sub-min spends never flag", () => {
  const c = detectSpendVsIncome([
    { politician_id: "b", name: "B", spend: 1e6, income: 2e6 }, // 0.5× → below floor
    { politician_id: "c", name: "C", spend: 5e5, income: 1e4 }, // spend below ₹10L → no
  ]);
  assert.equal(c.length, 0);
});

test("detectSpendVsIncome: small cohort flags only a very high hard ratio", () => {
  const c = detectSpendVsIncome([
    { politician_id: "hard", name: "Hard", spend: 1.5e7, income: 1e6 }, // 15× ≥ hard 12× → flag
    { politician_id: "soft", name: "Soft", spend: 4e6, income: 1e6 },   // 4× but tiny cohort → no
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0].actor_id, "hard");
});

test("detectMultiSourceAdverse: flags reps named across ≥3 distinct sources", () => {
  const c = detectMultiSourceAdverse([
    { politician_id: "x", name: "X", sources: new Set(["indian_kanoon", "cbi_press", "sec_edgar"]), claim_types: new Set(["named_in_court_judgment"]), evidence_ids: ["e1"] },
    { politician_id: "y", name: "Y", sources: new Set(["indian_kanoon", "cbi_press"]), claim_types: new Set(), evidence_ids: [] }, // only 2 → no
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0].actor_id, "x");
  assert.equal(c[0].vector, "MULTI_SOURCE_ADVERSE");
  assert.equal(c[0].data.n_sources, 3);
});

test("integration: ledger → detectors → investigation_leads, idempotent", () => {
  const seedFact = (eid, metric, value, year, ev) =>
    upsertFact({ entity_id: eid, subject_kind: "person", metric, value, unit: "inr", as_of_date: String(year), evidence_id: ev, extractor_version: "test", source_type: "test" });

  // A 12-strong income cohort so the outlier (p0, 5×) clears the z-score + cohort gate.
  const ratios = [5, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1];
  ratios.forEach((r, i) => {
    upsertPolitician({ id: `LP${i}`, name: `LP${i}`, state: "CohortState" });
    const eid = ensureEntity({ kind: "person", name: `LP${i}`, strongIds: { politician_id: `LP${i}` }, source: "seed" });
    seedFact(eid, "declared_income", 1e6, 2020, `${i}a`);
    seedFact(eid, "declared_income", 1e6 * r, 2021, `${i}b`);
  });

  // A separate politician whose campaign spend dwarfs their declared income by a
  // hard-outlier ratio (15×), so the small-cohort fallback flags it.
  upsertPolitician({ id: "PS", name: "Spender MP", state: "SpenderState" });
  const es = ensureEntity({ kind: "person", name: "Spender MP", strongIds: { politician_id: "PS" }, source: "seed" });
  seedFact(es, "declared_income", 2e6, 2024, "si");
  seedFact(es, "election_expenditure", 3e7, 2024, "ss");

  const res = runLedgerDetectors({ log: () => {} });
  assert.equal(res.counts.STAT_INCOME_OUTLIER, 1);
  assert.equal(res.counts.STAT_SPEND_VS_INCOME, 1);

  const leads = listLeads();
  const income = leads.find((l) => l.vector === "STAT_INCOME_OUTLIER");
  const spend = leads.find((l) => l.vector === "STAT_SPEND_VS_INCOME");
  assert.equal(income.actor_id, "LP0");
  assert.equal(income.detector_version, LEDGER_DETECTOR_VERSION);
  assert.equal(spend.actor_id, "PS");
  assert.equal(spend.data.ratio, 15);

  // Idempotent: a second run upserts the same keys, not new leads.
  const before = listLeads().length;
  runLedgerDetectors({ log: () => {} });
  assert.equal(listLeads().length, before);
});
