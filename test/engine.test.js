// The Anomaly Engine — flags, settings, detectors, and lead synthesis.
// Pure helpers (benfordStats, meanStd) are tested with fixtures; the DB-backed
// path seeds an isolated store and drives detect → flags → synthesis → leads,
// including the small/big severity split, evidence citations, dry-run purity,
// idempotent re-runs, and live-tunable thresholds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-engine-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const { upsertPolitician, listLeads, deleteLead } = await import("../server/store/store.js");
const { ensureEntity } = await import("../server/entities/entities.js");
const { upsertFact } = await import("../server/store/ledger.js");
const { benfordStats, meanStd, runEngine, DETECTORS, ENGINE_GROUPS, engineStatus } = await import("../server/detectors/engine.js");
const { wikidataBirthYear } = await import("../server/extractors/wikidata.js");
const { upsertFlag, listFlags, markStaleExcept, flagCounts, deleteFlags, activeFlagsBySubject } = await import("../server/detectors/flags.js");
const { setSetting, getSetting, resolveSettings, coerceValue } = await import("../server/detectors/engine-settings.js");
const { runLeadSynthesis, promoteBigFlags, clusterFlags } = await import("../server/synthesis/lead-synthesis.js");
const { recordLeadFeedback, detectorPrecision, upsertPolitician: _up } = await import("../server/store/store.js");
const { upsertClaim } = await import("../server/store/ledger.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("benfordStats: below minN returns null; benford-ish data passes; uniform digits trip", () => {
  assert.equal(benfordStats([123, 456], { minN: 40 }), null);

  // Benford-conforming sample: counts proportional to log10(1+1/d) over n=100.
  const conforming = [];
  const share = [30, 18, 12, 10, 8, 7, 6, 5, 4];
  share.forEach((n, i) => { for (let k = 0; k < n; k++) conforming.push((i + 1) * 1000 + k); });
  const ok = benfordStats(conforming, { minN: 40 });
  assert.ok(ok.chi2 < 15.51, `conforming chi2 should be low, got ${ok.chi2}`);
  assert.ok(ok.mad < 0.012, `conforming MAD should be low, got ${ok.mad}`);

  // Manipulated: every value starts with 5 (invented round figures).
  const cooked = Array.from({ length: 60 }, (_, i) => 500000 + i);
  const bad = benfordStats(cooked, { minN: 40 });
  assert.ok(bad.chi2 > 20.09, `cooked chi2 should be high, got ${bad.chi2}`);
  assert.ok(bad.mad > 0.015, `cooked MAD should be high, got ${bad.mad}`);
});

test("meanStd: population std over a known set", () => {
  const { mean, std } = meanStd([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.equal(std, 2);
});

// ── Settings ─────────────────────────────────────────────────────────────────

test("engine-settings: defaults resolve, overrides persist, null clears", () => {
  const tunables = { bigAt: { type: "number", def: 20 }, enabled: { type: "boolean", def: true } };
  assert.deepEqual(resolveSettings("t_demo", tunables), { bigAt: 20, enabled: true });
  setSetting("engine.t_demo.bigAt", 33);
  assert.equal(resolveSettings("t_demo", tunables).bigAt, 33);
  setSetting("engine.t_demo.bigAt", null);
  assert.equal(resolveSettings("t_demo", tunables).bigAt, 20);
  assert.equal(getSetting("engine.t_demo.bigAt"), undefined);
});

test("coerceValue: validates type and range", () => {
  assert.equal(coerceValue({ type: "number", min: 1, max: 10 }, "5"), 5);
  assert.throws(() => coerceValue({ type: "number", min: 1 }, "0"));
  assert.throws(() => coerceValue({ type: "number" }, "not-a-number"));
  assert.equal(coerceValue({ type: "boolean" }, "true"), true);
  assert.throws(() => coerceValue({ type: "boolean" }, "maybe"));
});

// ── Flag store ───────────────────────────────────────────────────────────────

test("flags: upsert is idempotent on key, refreshes fields, stale-marking works", () => {
  deleteFlags();
  const base = { key: "demo|p1|x", detector: "demo", severity: "small", score: 5, politician_id: "p1", subject_name: "P One", headline: "h1", rationale: "r1", evidence: [], run_id: "runA" };
  const first = upsertFlag(base);
  const second = upsertFlag({ ...base, score: 9, severity: "big", run_id: "runB" });
  assert.equal(second.id, first.id, "same key → same flag id");
  assert.equal(second.created_at, first.created_at);
  assert.equal(listFlags({ detector: "demo" }).total, 1);
  assert.equal(listFlags({ detector: "demo" }).rows[0].score, 9);

  // A full run (runC) that does NOT re-emit the flag marks it stale.
  const stale = markStaleExcept("demo", "runC");
  assert.equal(stale, 1);
  assert.equal(listFlags({ detector: "demo", status: "active" }).total, 0);
  assert.equal(listFlags({ detector: "demo", status: "stale" }).total, 1);
  const counts = flagCounts();
  assert.equal(counts.perDetector.demo.stale, 1);
  deleteFlags();
});

// ── Seeded end-to-end: da_ratio detector → flags → synthesis → leads ─────────

function seedRep(pid, name, { assets, incomes } = {}) {
  upsertPolitician({ id: pid, name, office: "MP", state: "Testland", party: "TST" });
  const entityId = ensureEntity({ kind: "person", name, strongIds: { politician_id: pid }, source: "test" });
  for (const [year, value] of assets ?? []) {
    upsertFact({ entity_id: entityId, subject_kind: "person", metric: "declared_assets", value, as_of_date: String(year), source_type: "eci_affidavit", evidence_id: `ev-${pid}-a${year}` });
  }
  for (const [year, value] of incomes ?? []) {
    upsertFact({ entity_id: entityId, subject_kind: "person", metric: "declared_income", value, as_of_date: String(year), source_type: "eci_affidavit", evidence_id: `ev-${pid}-i${year}` });
  }
  return entityId;
}

test("da_ratio end-to-end: big flag with evidence citations → promoted lead", async () => {
  deleteFlags();
  // Assets ₹1 Cr → ₹9 Cr over 2019→2024 with income ₹10 L/yr: growth ₹8 Cr vs
  // plausible savings ₹50 L → 16× — far past the 3× big threshold.
  seedRep("da1", "Da Outlier", {
    assets: [[2019, 1e7], [2024, 9e7]],
    incomes: [[2019, 1e6], [2024, 1e6]],
  });
  // A quiet rep: modest growth fully covered by income — must not flag.
  seedRep("da2", "Da Quiet", {
    assets: [[2019, 1e7], [2024, 1.3e7]],
    incomes: [[2019, 2e6], [2024, 2e6]],
  });

  const r = await runEngine({ detectors: ["da_ratio"], synthesize: false, log: () => {} });
  assert.equal(r.detectors.da_ratio.big, 1, "exactly the outlier flags big");
  assert.equal(r.detectors.da_ratio.small, 0);

  const { rows } = listFlags({ detector: "da_ratio", severity: "big" });
  assert.equal(rows.length, 1);
  const flag = rows[0];
  assert.equal(flag.politician_id, "da1");
  assert.ok(flag.rationale.includes("Check period 2019→2024"));
  assert.ok(flag.evidence.length >= 2, "cites both affidavit rows");
  assert.ok(flag.evidence.every((e) => e.note), "every citation explains what it shows");

  // Synthesis: the big flag becomes a lead carrying the citations.
  for (const l of listLeads({})) deleteLead(l.id); // clean slate
  const promoted = promoteBigFlags({ log: () => {} });
  assert.ok(promoted >= 1);
  const lead = listLeads({}).find((l) => l.vector === "DA_RATIO" && l.actor_id === "da1");
  assert.ok(lead, "DA_RATIO lead exists for the outlier");
  assert.equal(lead.status, "detected");
  assert.ok(lead.detail.includes("Why this is a lead"), "lead detail carries the evidence section");
  assert.ok(Array.isArray(lead.data.evidence) && lead.data.evidence.length >= 2, "lead data carries structured citations");
});

test("dry run writes neither flags nor leads", async () => {
  deleteFlags();
  for (const l of listLeads({})) deleteLead(l.id);
  const r = await runEngine({ detectors: ["da_ratio"], dryRun: true, log: () => {} });
  assert.equal(r.dryRun, true);
  assert.equal(r.detectors.da_ratio.big, 1, "dry run still reports what WOULD flag");
  assert.equal(listFlags({ detector: "da_ratio", status: "all" }).total, 0, "no flags written");
  assert.equal(listLeads({}).length, 0, "no leads written");
});

test("tunables change behavior live: raising minExcessMultiple silences the outlier", async () => {
  deleteFlags();
  setSetting("engine.da_ratio.minExcessMultiple", 50); // above the 16× seeded outlier
  const r = await runEngine({ detectors: ["da_ratio"], synthesize: false, log: () => {} });
  assert.equal((r.detectors.da_ratio.big ?? 0) + (r.detectors.da_ratio.small ?? 0), 0);
  setSetting("engine.da_ratio.minExcessMultiple", null);
  const r2 = await runEngine({ detectors: ["da_ratio"], synthesize: false, log: () => {} });
  assert.equal(r2.detectors.da_ratio.big, 1, "back to default → flags again");
});

test("disabled detector is skipped", async () => {
  setSetting("engine.da_ratio.enabled", false);
  const r = await runEngine({ detectors: ["da_ratio"], synthesize: false, log: () => {} });
  assert.equal(r.detectors.da_ratio.skipped, "disabled");
  setSetting("engine.da_ratio.enabled", null);
});

test("cluster synthesis: small flags only lead via multi-detector clusters, with citations", async () => {
  deleteFlags();
  for (const l of listLeads({})) deleteLead(l.id);
  upsertPolitician({ id: "cl1", name: "Cluster Rep", office: "MP", state: "Testland" });
  // Two small flags from DIFFERENT detectors on one subject; scores sum past the
  // cluster threshold when weighted (18+18 = 36 × small 0.4 = 14.4… too low), so
  // tune clusterMin down for the test, then restore.
  upsertFlag({ key: "d_a|cl1|x", detector: "d_a", severity: "small", score: 18, politician_id: "cl1", subject_name: "Cluster Rep", headline: "flag A", rationale: "why A", evidence: [{ url: "https://ex.org/a", note: "source A" }], run_id: "t" });
  upsertFlag({ key: "d_b|cl1|y", detector: "d_b", severity: "small", score: 18, politician_id: "cl1", subject_name: "Cluster Rep", headline: "flag B", rationale: "why B", evidence: [{ url: "https://ex.org/b", note: "source B" }], run_id: "t" });

  setSetting("engine.synthesis.clusterMin", 10);
  const clusters = clusterFlags({ log: () => {} });
  assert.equal(clusters, 1);
  const lead = listLeads({}).find((l) => l.vector === "FLAG_CLUSTER");
  assert.ok(lead);
  assert.equal(lead.actor_id, "cl1");
  assert.ok(lead.data.flags.length === 2);
  assert.ok(lead.detail.includes("flag A") && lead.detail.includes("flag B"));
  assert.ok(lead.detail.includes("https://ex.org/a"), "cluster lead cites each flag's evidence");
  assert.ok(lead.evidence_urls.includes("https://ex.org/b"));

  // A single detector repeating (minDetectors=2) must NOT cluster.
  deleteFlags();
  for (const l of listLeads({})) deleteLead(l.id);
  upsertFlag({ key: "d_a|cl1|x", detector: "d_a", severity: "small", score: 30, politician_id: "cl1", subject_name: "Cluster Rep", headline: "flag A", rationale: "why A", evidence: [], run_id: "t" });
  upsertFlag({ key: "d_a|cl1|y", detector: "d_a", severity: "small", score: 30, politician_id: "cl1", subject_name: "Cluster Rep", headline: "flag A2", rationale: "why A2", evidence: [], run_id: "t" });
  assert.equal(clusterFlags({ log: () => {} }), 0, "one detector repeating is not corroboration");
  setSetting("engine.synthesis.clusterMin", null);
});

test("re-running the engine is idempotent: no duplicate flags or leads", async () => {
  deleteFlags();
  for (const l of listLeads({})) deleteLead(l.id);
  await runEngine({ detectors: ["da_ratio"], synthesize: false, log: () => {} });
  const flags1 = listFlags({ detector: "da_ratio", status: "all" }).total;
  await runEngine({ detectors: ["da_ratio"], synthesize: false, log: () => {} });
  const flags2 = listFlags({ detector: "da_ratio", status: "all" }).total;
  assert.equal(flags1, flags2, "same data + same thresholds → same flag rows");

  const s1 = await runLeadSynthesis({ log: () => {} });
  const n1 = listLeads({}).length;
  await runLeadSynthesis({ log: () => {} });
  assert.equal(listLeads({}).length, n1, "synthesis re-run upserts, never duplicates");
  assert.ok(s1.promoted >= 1);
});

test("engineStatus: exposes every detector + group with tunables and counts", () => {
  const s = engineStatus();
  assert.equal(s.detectors.length, DETECTORS.length);
  assert.equal(s.groups.length, ENGINE_GROUPS.length);
  const da = s.detectors.find((d) => d.id === "da_ratio");
  assert.ok(da.tunables.bigAt && da.tunables.savingsRate);
  assert.ok(typeof da.settings.bigAt === "number");
  assert.ok(da.flags.big >= 1, "live counts included");
  const syn = s.groups.find((g) => g.id === "synthesis");
  assert.ok(syn.tunables.clusterMin);
});

test("activeFlagsBySubject groups politician and entity subjects separately", () => {
  deleteFlags();
  upsertFlag({ key: "d|p9|1", detector: "d", severity: "small", score: 1, politician_id: "p9", subject_name: "P", headline: "h", rationale: "r", evidence: [], run_id: "t" });
  upsertFlag({ key: "d|e9|1", detector: "d", severity: "small", score: 1, entity_id: "e9", subject_name: "E", headline: "h", rationale: "r", evidence: [], run_id: "t" });
  const by = activeFlagsBySubject();
  assert.ok(by.has("pol:p9") && by.has("ent:e9"));
  deleteFlags();
});

// ── Legacy thresholds are tunable (task: make legacy detectors tunable) ───────

test("legacy detector exposes its constants as tunables and honours overrides", async () => {
  const s = engineStatus();
  const fu = s.detectors.find((d) => d.id === "fund_utilization");
  assert.ok(fu.tunables.UTIL_LOW_PCT && fu.tunables.UTIL_HIGH_PCT, "MPLADS thresholds are tunable");
  assert.equal(fu.settings.UTIL_LOW_PCT, 15, "default matches the module constant");
  // Seed one under-utilised MPLADS record via evidence, then flip the threshold so
  // it no longer qualifies — proving the override reaches the pure detector.
  upsertPolitician({ id: "mp1", name: "MPLADS MP", office: "MP", state: "Testland" });
  const { addEvidence } = await import("../server/store/store.js");
  addEvidence([{ politician_id: "mp1", source_type: "mplads", url: "http://x/mplads", title: "MPLADS",
    numbers: { utilization_pct: 10, allocated: 5e7 }, admissible: true }]);
  deleteFlags();
  const hot = await runEngine({ detectors: ["fund_utilization"], synthesize: false, log: () => {} });
  assert.ok(hot.detectors.fund_utilization.big >= 1, "10% utilisation flags at the default 15% line");
  setSetting("engine.fund_utilization.UTIL_LOW_PCT", 5); // now 10% is no longer 'low'
  deleteFlags();
  const cold = await runEngine({ detectors: ["fund_utilization"], synthesize: false, log: () => {} });
  const total = (cold.detectors.fund_utilization.big ?? 0) + (cold.detectors.fund_utilization.small ?? 0);
  assert.equal(total, 0, "lowering the threshold silences the 10% record");
  setSetting("engine.fund_utilization.UTIL_LOW_PCT", null);
});

// ── Generic / unsupervised outlier detector ──────────────────────────────────

test("generic_outlier: flags a cohort outlier on ANY metric with no hand-coded rule", async () => {
  deleteFlags();
  // A 14-rep cohort with a tight cluster of a made-up metric plus one 100× outlier.
  for (let i = 0; i < 14; i++) {
    const pid = `go${i}`;
    upsertPolitician({ id: pid, name: `GO ${i}`, office: "MP", state: "Genland" });
    const ent = ensureEntity({ kind: "person", name: `GO ${i}`, strongIds: { politician_id: pid }, source: "test" });
    const value = i === 0 ? 1e9 : 1e7 + i * 1e5; // rep 0 is the extreme outlier
    upsertFact({ entity_id: ent, subject_kind: "person", metric: "made_up_metric", value, as_of_date: "2024", source_type: "test", evidence_id: `go-${i}` });
  }
  const r = await runEngine({ detectors: ["generic_outlier"], synthesize: false, log: () => {} });
  const flags = listFlags({ detector: "generic_outlier" }).rows.filter((f) => f.data?.metric === "made_up_metric");
  assert.ok(flags.length >= 1, "the outlier is flagged");
  const top = flags.find((f) => f.politician_id === "go0");
  assert.ok(top, "rep 0 (the 100× value) is flagged");
  assert.equal(top.data.tail, "high");
  assert.ok(Math.abs(top.data.modified_z) >= 3.5, "modified z clears the outlier line");
  assert.ok(top.evidence.length >= 1, "carries the source fact as evidence");
  deleteFlags();
});

// ── Data-gap fill: birth-year extraction from wikidata prose ──────────────────

test("wikidataBirthYear: pulls a plausible birth year from profile prose, else nothing", () => {
  assert.equal(wikidataBirthYear("Indian politician (1970–present)")[0].value, 1970);
  assert.equal(wikidataBirthYear("Businessman, born 1965 in Delhi")[0].value, 1965);
  assert.equal(wikidataBirthYear("(born 1982)")[0].value, 1982);
  assert.deepEqual(wikidataBirthYear("Member of the 18th Lok Sabha"), [], "no birth phrase → nothing (not a term year)");
  assert.deepEqual(wikidataBirthYear("born 1850"), [], "implausible year rejected");
});

// ── Cross-source contradiction + wealth-reconciliation detectors ──────────────

test("undeclared_criminal_case: declared zero but named in ≥2 court records → big", async () => {
  deleteFlags();
  const ent = seedRep("crimrep", "Crim Rep", { assets: [[2024, 5e7]] });
  // Declare ZERO criminal cases (a fact of 0), then two independent court claims.
  upsertFact({ entity_id: ent, subject_kind: "person", metric: "criminal_cases", value: 0, as_of_date: "2024", source_type: "eci_affidavit", evidence_id: "crim-decl" });
  for (const i of [1, 2]) upsertClaim({ subject_entity_id: ent, subject_kind: "person", claim_type: "named_in_court_judgment", object_text: `Case ${i}`, confidence: 0.2, as_of_date: "2022", source_type: "indian_kanoon", evidence_id: `court-${i}` });
  const r = await runEngine({ detectors: ["undeclared_criminal_case"], synthesize: false, log: () => {} });
  assert.equal(r.detectors.undeclared_criminal_case.big, 1, "zero-declaration + 2 court records is a big contradiction");
  const flag = listFlags({ detector: "undeclared_criminal_case", severity: "big" }).rows[0];
  assert.equal(flag.politician_id, "crimrep");
  assert.ok(flag.evidence.length >= 1, "cites the court records");
  deleteFlags();
});

test("net_worth_reconciliation: flags a net-worth jump income can't explain, nets out debt", async () => {
  deleteFlags();
  // Assets ₹1Cr→₹8Cr, liabilities flat at 0, income ₹10L/yr over 5y (₹50L) — a ₹7Cr
  // net-worth jump against ₹50L income → deeply unexplained. Big.
  const ent = seedRep("nwrep", "NW Rep", { assets: [[2019, 1e7], [2024, 8e7]], incomes: [[2019, 1e6], [2024, 1e6]] });
  upsertFact({ entity_id: ent, subject_kind: "person", metric: "declared_liabilities", value: 0, as_of_date: "2019", source_type: "eci_affidavit", evidence_id: "nw-l0" });
  upsertFact({ entity_id: ent, subject_kind: "person", metric: "declared_liabilities", value: 0, as_of_date: "2024", source_type: "eci_affidavit", evidence_id: "nw-l1" });
  // A borrow-funded rep: assets ₹1Cr→₹8Cr BUT liabilities also ₹0→₹7Cr — net worth flat, must NOT flag.
  const ent2 = seedRep("nwlev", "NW Levered", { assets: [[2019, 1e7], [2024, 8e7]], incomes: [[2019, 1e6], [2024, 1e6]] });
  upsertFact({ entity_id: ent2, subject_kind: "person", metric: "declared_liabilities", value: 0, as_of_date: "2019", source_type: "eci_affidavit", evidence_id: "lev-l0" });
  upsertFact({ entity_id: ent2, subject_kind: "person", metric: "declared_liabilities", value: 7e7, as_of_date: "2024", source_type: "eci_affidavit", evidence_id: "lev-l1" });
  const r = await runEngine({ detectors: ["net_worth_reconciliation"], synthesize: false, log: () => {} });
  const rows = listFlags({ detector: "net_worth_reconciliation" }).rows;
  assert.ok(rows.some((f) => f.politician_id === "nwrep"), "the cash-rich rep is flagged");
  assert.ok(!rows.some((f) => f.politician_id === "nwlev"), "the borrow-funded rep is NOT flagged (leverage nets out)");
  deleteFlags();
});

test("politician_linked_award: values a rep's firm's CPPP awards (skips cleanly with no CPPP index)", async () => {
  deleteFlags();
  // With no CPPP flat DB in the test env, cpppBidderStats returns null → the
  // detector must produce zero flags without throwing (graceful gating).
  const ent = seedRep("awrep", "Award Rep", { assets: [[2024, 5e7]] });
  const { upsertRelationship } = await import("../server/entities/relations.js");
  const co = ensureEntity({ kind: "company", name: "Award Rep Constructions Pvt Ltd", source: "test" });
  upsertRelationship({ src_entity_id: ent, dst_entity_id: co, rel_type: "declared_business_interest", confidence: 0.7, source: "test", data: { company_name: "Award Rep Constructions Pvt Ltd" } });
  const r = await runEngine({ detectors: ["politician_linked_award"], synthesize: false, log: () => {} });
  assert.ok(!r.detectors.politician_linked_award.error, "runs without error even with no CPPP index");
  deleteFlags();
});

test("copy_paste_affidavit: identical figures across years flag", async () => {
  deleteFlags();
  const ent = seedRep("cprep", "CP Rep");
  // Same assets AND income to the rupee across two distinct years.
  for (const [yr, eid] of [["2019", "cp-a0"], ["2024", "cp-a1"]]) upsertFact({ entity_id: ent, subject_kind: "person", metric: "declared_assets", value: 33_916_833, as_of_date: yr, source_type: "eci_affidavit", evidence_id: eid });
  const r = await runEngine({ detectors: ["copy_paste_affidavit"], synthesize: false, log: () => {} });
  assert.ok((r.detectors.copy_paste_affidavit.big + r.detectors.copy_paste_affidavit.small) >= 1, "identical cross-year figure flags");
  deleteFlags();
});

// ── Feedback loop: human/GLM decisions → per-detector precision + suggestions ──

test("feedback loop: logs decisions, attributes to detectors, suggests threshold moves", () => {
  // A cluster lead attributes to its contributing detectors; a promoted big flag to
  // its detector; a bare lead to its vector.
  const cluster = { key: "L1", vector: "FLAG_CLUSTER", signal_score: 40, headline: "h", data: { flags: [{ detector: "da_ratio" }, { detector: "benford" }] } };
  const promoted = { key: "L2", vector: "DA_RATIO", signal_score: 30, headline: "h", data: { engine_flag_key: "da_ratio|p1|x" } };

  // da_ratio: 6 decisions, 5 rejected → high reject rate → "raise thresholds".
  recordLeadFeedback(cluster, "rejected");
  recordLeadFeedback(promoted, "rejected");
  recordLeadFeedback(promoted, "rejected");
  recordLeadFeedback(promoted, "rejected");
  recordLeadFeedback(promoted, "dismissed");
  recordLeadFeedback(promoted, "approved");

  const prec = detectorPrecision({ minSample: 5 });
  const da = prec.find((p) => p.detector === "da_ratio");
  assert.ok(da, "da_ratio has feedback");
  assert.equal(da.judged, 6);
  assert.ok(da.reject_rate >= 0.8, "5/6 rejected");
  assert.match(da.suggestion, /RAIS/i, "suggests raising thresholds");
  // benford got only the one cluster rejection — below minSample, so no suggestion.
  const benford = prec.find((p) => p.detector === "benford");
  assert.equal(benford.suggestion, null, "small sample → no suggestion");
});
