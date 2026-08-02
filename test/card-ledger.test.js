// Ledger-backed cards.
//
// The regression these exist for, measured on the live database: 2,993 of the
// 3,053 politicians whose report card read "INSUFFICIENT_DATA" already had
// declared assets, liabilities and criminal-case counts in the `facts` ledger.
// The card engine only ever read the `numbers` blob on evidence rows, so a
// figure extracted straight into the ledger was invisible to the public site.
//
// The end-to-end test at the bottom is the one that matters: a politician with
// ledger facts and NO evidence at all must still produce a graded card.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-cardledger-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const store = await import("../server/store/store.js");
const { db, id } = store;
const { upsertFact } = await import("../server/store/ledger.js");
const {
  ledgerViewForPolitician, ledgerFindings, mergeFindings, growthOf,
  peerContextFor, resetPeerIndex, cohortKeyFor, cohortLabel,
} = await import("../server/publishing/card-ledger.js");
const { buildPoliticianCard } = await import("../server/publishing/cards.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// Seed one politician + its person entity, bound the way the real pipeline
// binds them (a `politician_id` strong id on the entity), and return both ids.
function seedPerson({ name, office = "MLA", state = "Testland", party = "TP" }) {
  const p = store.upsertPolitician({ name, office, state, party, constituency: `${name}pur` });
  const eid = id();
  db.prepare(
    "INSERT INTO entities (id, kind, canonical_name, name_lc, strong_ids, created_at, data) VALUES (?,?,?,?,?,?,?)"
  ).run(eid, "person", name, name.toLowerCase(), JSON.stringify({ politician_id: p.id }), new Date().toISOString(), "{}");
  return { pid: p.id, eid };
}

function fact(eid, metric, value, as_of_date = null, extra = {}) {
  return upsertFact({
    entity_id: eid, subject_kind: "person", metric, value,
    unit: extra.unit ?? null, as_of_date, source_type: extra.source_type ?? "eci_affidavit",
    extractor_version: extra.extractor_version ?? `t-${metric}-${as_of_date ?? "u"}`,
  });
}

test("ledgerViewForPolitician: a dated figure always beats an undated one", () => {
  const { pid, eid } = seedPerson({ name: "Dated Wins" });
  fact(eid, "declared_assets", 111, null);       // undated
  fact(eid, "declared_assets", 999, "2023");     // dated — must win
  const view = ledgerViewForPolitician(pid);
  assert.equal(view.hasData, true);
  assert.equal(view.metrics.declared_assets.value, 999);
  assert.equal(view.metrics.declared_assets.year, 2023);
  assert.equal(view.metrics.declared_assets.observations, 2);
});

test("ledgerViewForPolitician: newest dated figure wins, and a series is built", () => {
  const { pid, eid } = seedPerson({ name: "Series Person" });
  for (const [y, v] of [["2018", 100], ["2019", 200], ["2022", 400]]) fact(eid, "declared_income", v, y);
  const view = ledgerViewForPolitician(pid);
  assert.equal(view.metrics.declared_income.value, 400);
  assert.equal(view.metrics.declared_income.year, 2022);
  assert.deepEqual(view.series.declared_income.map((p) => p.year), [2018, 2019, 2022]);
});

test("ledgerViewForPolitician: a politician with no entity is empty, not an error", () => {
  const p = store.upsertPolitician({ name: "Unbound", office: "MLA", state: "Testland" });
  const view = ledgerViewForPolitician(p.id);
  assert.equal(view.hasData, false);
  assert.deepEqual(view.metrics, {});
});

test("growthOf refuses to fabricate a multiple", () => {
  assert.equal(growthOf(null), null);
  assert.equal(growthOf([{ year: 2019, value: 100 }]), null, "one point is not growth");
  assert.equal(growthOf([{ year: 2019, value: 0 }, { year: 2024, value: 100 }]), null, "cannot divide by zero");
  assert.equal(growthOf([{ year: 2024, value: 100 }, { year: 2024, value: 500 }]), null, "same year is not a span");
  const g = growthOf([{ year: 2019, value: 100 }, { year: 2024, value: 800 }]);
  assert.equal(g.multiple, 8);
  assert.equal(g.years, 5);
});

test("ledgerFindings mirrors analyzer codes, weights and thresholds", () => {
  const { pid, eid } = seedPerson({ name: "Findings Person" });
  fact(eid, "declared_assets", 10_000_000, "2019");
  fact(eid, "declared_assets", 80_000_000, "2024");
  fact(eid, "declared_liabilities", 2_000_000, "2024");
  fact(eid, "criminal_cases", 4, "2024");
  const { flags, facts } = ledgerFindings(ledgerViewForPolitician(pid));
  const codes = flags.map((f) => f.code);
  assert.ok(codes.includes("ASSET_GROWTH_ANOMALY"), "8x growth must flag");
  assert.ok(codes.includes("MULTIPLE_PENDING_CASES"), "4 cases must flag");
  // Weight and param must match detectors/analyzer.js exactly, or the same
  // person scores differently depending on which pipeline reached them.
  const growth = flags.find((f) => f.code === "ASSET_GROWTH_ANOMALY");
  assert.equal(growth.weight, -22);
  assert.equal(growth.param, "corruption");
  const cases = flags.find((f) => f.code === "MULTIPLE_PENDING_CASES");
  assert.equal(cases.weight, -12);
  assert.equal(cases.param, "abuse_of_power");
  assert.equal(facts.net_worth, 78_000_000);
});

test("ledgerFindings: zero cases is a documented positive, not silence", () => {
  const { pid, eid } = seedPerson({ name: "Clean Person" });
  fact(eid, "criminal_cases", 0, "2024");
  const { flags } = ledgerFindings(ledgerViewForPolitician(pid));
  const clean = flags.find((f) => f.code === "CLEAN_CRIMINAL_RECORD");
  assert.ok(clean);
  assert.equal(clean.weight, +6);
});

test("ledgerFindings: MPLADS is not judged below the ₹1 cr allocation guard", () => {
  const { pid, eid } = seedPerson({ name: "New MP", office: "MP" });
  fact(eid, "mplads_utilization_pct", 0);
  fact(eid, "mplads_allocated", 500_000);   // below the guard — a barely-released allocation
  const { flags } = ledgerFindings(ledgerViewForPolitician(pid));
  assert.equal(flags.find((f) => f.code === "MPLADS_UNDERUTILISED"), undefined,
    "0% on a nominal allocation must not be treated as under-spending");
});

test("mergeFindings: evidence wins on conflict, ledger fills the gaps", () => {
  const ev = { flags: [{ code: "MULTIPLE_PENDING_CASES", weight: -20 }], facts: { criminal_cases: 9 } };
  const led = {
    flags: [{ code: "MULTIPLE_PENDING_CASES", weight: -12 }, { code: "ASSET_GROWTH_ANOMALY", weight: -22 }],
    facts: { criminal_cases: 4, net_worth: 100 },
  };
  const merged = mergeFindings(ev, led);
  assert.equal(merged.flags.length, 2, "the duplicated code is not emitted twice");
  assert.equal(merged.flags.find((f) => f.code === "MULTIPLE_PENDING_CASES").weight, -20, "evidence version kept");
  assert.equal(merged.facts.criminal_cases, 9, "evidence value kept");
  assert.equal(merged.facts.net_worth, 100, "ledger-only value filled in");
});

test("peerContextFor: ranks within the cohort, and stays silent when it is too small", () => {
  resetPeerIndex();
  // 20 MLAs in Peerland with assets 1..20 — a cohort big enough to rank.
  let target = null;
  for (let i = 1; i <= 20; i++) {
    const { pid, eid } = seedPerson({ name: `Peer ${i}`, state: "Peerland" });
    fact(eid, "declared_assets", i * 1_000_000, "2024");
    if (i === 20) target = pid;
  }
  // 3 MLAs in Tinyland — below the minimum cohort, must not be ranked.
  let tiny = null;
  for (let i = 1; i <= 3; i++) {
    const { pid, eid } = seedPerson({ name: `Tiny ${i}`, state: "Tinyland" });
    fact(eid, "declared_assets", i * 1_000_000, "2024");
    if (i === 3) tiny = pid;
  }
  resetPeerIndex();

  const top = peerContextFor({ id: target, office: "MLA", state: "Peerland" });
  assert.equal(top.ranks.declared_assets.percentile, 100, "the richest is above everyone");
  assert.equal(top.ranks.declared_assets.rank, 1, "rank 1 = highest value");
  assert.equal(top.ranks.declared_assets.of, 20);

  const small = peerContextFor({ id: tiny, office: "MLA", state: "Tinyland" });
  assert.deepEqual(small.ranks, {}, "a 3-person cohort yields no percentile");
  assert.equal(small.cohort_label, "MLAs in Tinyland");
});

test("peerContextFor: equal values share a rank rather than being split by order", () => {
  resetPeerIndex();
  const ids = [];
  for (let i = 1; i <= 15; i++) {
    const { pid, eid } = seedPerson({ name: `Tied ${i}`, state: "Tiedland" });
    fact(eid, "criminal_cases", 0, "2024");   // everyone identical
    ids.push(pid);
  }
  resetPeerIndex();
  const a = peerContextFor({ id: ids[0], office: "MLA", state: "Tiedland" });
  const b = peerContextFor({ id: ids[9], office: "MLA", state: "Tiedland" });
  assert.equal(a.ranks.criminal_cases.rank, b.ranks.criminal_cases.rank,
    "identical declarations must not be arbitrarily ordered against each other");
  assert.equal(a.ranks.criminal_cases.percentile, 100, "tied at the top of a flat distribution");
});

test("cohort helpers name the comparison group a reader would recognise", () => {
  assert.equal(cohortKeyFor("MLA", "Bihar"), "MLA::Bihar");
  assert.equal(cohortLabel("MP", "Lok Sabha (Parliament)"), "sitting Lok Sabha MPs");
  assert.equal(cohortLabel("RS", null), "sitting Rajya Sabha members");
  assert.equal(cohortLabel("MLA", "Kerala"), "MLAs in Kerala");
});

test("REGRESSION: a politician with ledger facts but NO evidence still gets a graded card", () => {
  resetPeerIndex();
  const { pid, eid } = seedPerson({ name: "Ledger Only", state: "Ledgerland" });
  fact(eid, "declared_assets", 70_116_804, "2023");
  fact(eid, "declared_liabilities", 13_606_516, "2023");
  fact(eid, "criminal_cases", 2, "2023");
  for (const [y, v] of [["2018", 431_172], ["2019", 490_820], ["2022", 1_306_010]]) fact(eid, "declared_income", v, y);
  resetPeerIndex();

  assert.equal(store.listEvidence(pid).length, 0, "precondition: this person has no evidence rows at all");

  const card = buildPoliticianCard(pid);
  assert.notEqual(card.grade, "INSUFFICIENT_DATA",
    "this is the bug: ledger data existed and the card said there was none");
  const keys = card.sections.map((s) => s.key);
  assert.ok(keys.includes("wealth"), "wealth section built from the ledger");
  assert.ok(keys.includes("criminal"), "criminal section built from the ledger");
  assert.ok(keys.includes("income"), "income series built from the ledger");
  assert.ok(card.ledger_metric_count >= 4);

  const wealth = card.sections.find((s) => s.key === "wealth");
  const netWorth = wealth.stats.find((s) => s.label === "Declared net worth");
  assert.ok(netWorth, "net worth is shown");
  // 70,116,804 − 13,606,516 = 56,510,288 → ₹5.65 Cr
  assert.match(netWorth.value, /5\.65 Cr/);

  const income = card.sections.find((s) => s.key === "income");
  assert.ok(income.series.length === 3, "all three declared years are carried");
});

test("REGRESSION: a card must never present a bare number without a source", () => {
  const { pid, eid } = seedPerson({ name: "Cited Person", state: "Citeland" });
  const evId = id();
  store.addEvidence([{
    id: evId, politician_id: pid, url: "https://ex.test/affidavit", title: "Affidavit",
    source_type: "other", admissible: true, date: "2024-01-01",
  }]);
  upsertFact({
    entity_id: eid, subject_kind: "person", metric: "declared_assets", value: 5_000_000,
    as_of_date: "2024", source_type: "eci_affidavit", evidence_id: evId, extractor_version: "t-cite",
  });
  const view = ledgerViewForPolitician(pid);
  assert.equal(view.metrics.declared_assets.url, "https://ex.test/affidavit",
    "every ledger metric carries the URL of the document it came from");

  const card = buildPoliticianCard(pid);
  const wealth = card.sections.find((s) => s.key === "wealth");
  assert.ok(wealth.facts.every((f) => f.sources.length > 0), "no uncited claim reaches a card");
});
