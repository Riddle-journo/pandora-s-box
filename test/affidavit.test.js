// Phase 2C — the affidavit extractors. Pure-function tests pin the parsing (the
// risky part: the MyNeta "~ N Crore+" trap and the self/spouse income split), then
// an integration test drives both sources through the framework into the ledger.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-affidavit-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db, upsertPolitician } = await import("../server/store/store.js");
const { ensureEntity } = await import("../server/entities/entities.js");
const { factsFor } = await import("../server/store/ledger.js");
const { runExtraction, runPoliticianExtraction } = await import("../server/extractors/extract.js");
const {
  parseAffidavitRupees, electionYearFromUrl, affidavitRowFacts, eciAffidavitFacts,
  affidavitInterestLinks, runAffidavitExtraction, AFFIDAVIT_ROW_VERSION, ECI_AFFIDAVIT_VERSION,
} = await import("../server/extractors/affidavit.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

test("parseAffidavitRupees: exact value, not the '~ N Crore+' approximation", () => {
  assert.equal(parseAffidavitRupees("Rs 3,09,16,833 ~ 3 Crore+"), 30916833);
  assert.equal(parseAffidavitRupees("Rs 29,01,575 ~ 29 Lacs+"), 2901575);
  assert.equal(parseAffidavitRupees("Nil"), 0);
  assert.equal(parseAffidavitRupees(""), null);
  assert.equal(parseAffidavitRupees(null), null);
});

test("electionYearFromUrl", () => {
  assert.equal(electionYearFromUrl("https://www.myneta.info/LokSabha2024/candidate.php?candidate_id=1"), "2024");
  assert.equal(electionYearFromUrl("https://www.myneta.info/Karnataka2023/candidate.php"), "2023");
  assert.equal(electionYearFromUrl(null), null);
});

test("affidavitRowFacts: three metrics, skips unparseable", () => {
  const facts = affidavitRowFacts({ criminal_cases: 1, assets: "Rs 3,09,16,833 ~ 3 Crore+", liabilities: "Nil" }, { as_of_date: "2024" });
  const byMetric = Object.fromEntries(facts.map((f) => [f.metric, f]));
  assert.equal(byMetric.declared_assets.value, 30916833);
  assert.equal(byMetric.declared_liabilities.value, 0);
  assert.equal(byMetric.criminal_cases.value, 1);
  assert.equal(byMetric.declared_assets.as_of_date, "2024");
  assert.equal(affidavitRowFacts(null).length, 0);
});

test("eciAffidavitFacts: criminal count + SELF income series, spouse excluded", () => {
  const content = [
    "CRIMINAL CASES DECLARED: 2 (charges, not convictions).",
    "INCOME-TAX RETURN HISTORY: self Y",
    "2022 - 2023 ** Rs 6,86,040 ~ 6 Lacs+ 2021 - 2022 ** Rs 6,98,530 ~ 6 Lacs+",
    "spouse Y 2022 - 2023 ** Rs 99,00,000 ~ 99 Lacs+",
  ].join(" ");
  const facts = eciAffidavitFacts(content);
  const income = facts.filter((f) => f.metric === "declared_income");
  const crim = facts.find((f) => f.metric === "criminal_cases");
  assert.equal(crim.value, 2);
  assert.deepEqual(income.map((f) => [f.as_of_date, f.value]).sort(), [["2021", 698530], ["2022", 686040]]);
  // The spouse's 99,00,000 must NOT appear.
  assert.ok(!income.some((f) => f.value === 9900000), "spouse income leaked in");
});

test("affidavitInterestLinks: sworn company edges, drops non-companies + dupes", () => {
  const { facts, relationships } = affidavitInterestLinks({
    interests: [
      { name: "Jindal Steel & Power Ltd", owner: "self", sector: "energy" },
      { name: "Jindal Steel & Power Ltd", owner: "self", sector: "energy" }, // dupe → dropped
      { name: "Agricultural land at Hisar", owner: "self" },                 // non-company → dropped
      { name: "JSW Steel Ltd", owner: "spouse", sector: "steel" },
    ],
    properties: [{ location: "Hisar" }, { location: "Delhi" }],
  });
  assert.equal(relationships.length, 2);
  assert.equal(relationships[0].rel_type, "declared_business_interest");
  assert.equal(relationships[0].confidence, 0.7);
  assert.equal(relationships[1].data.owner, "spouse");
  assert.deepEqual(facts.map((f) => [f.metric, f.value]), [["declared_business_interests", 2], ["declared_immovable_properties", 2]]);
});

test("affidavitInterestLinks: empty/absent interests yield nothing", () => {
  assert.deepEqual(affidavitInterestLinks({}), { facts: [], relationships: [] });
  assert.deepEqual(affidavitInterestLinks({ interests: [{ name: "Nil" }] }).relationships, []);
});

test("integration: both sources flow through the framework into the ledger", () => {
  // A politician with a row affidavit + a matching entity.
  const p = { id: "PZ", name: "Test Rep", myneta_url: "https://www.myneta.info/LokSabha2024/candidate.php?candidate_id=9",
    affidavit: { criminal_cases: 1, assets: "Rs 10,43,58,691 ~ 10 Crore+", liabilities: "Rs 51,70,325 ~ 51 Lacs+" } };
  upsertPolitician(p);
  const eid = ensureEntity({ kind: "person", name: p.name, strongIds: { politician_id: "PZ" }, source: "seed" });

  // An eci_affidavit evidence row for the same politician.
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run("EAFF1", "PZ", null, null, 1, "t", JSON.stringify({
      id: "EAFF1", source_type: "eci_affidavit", tier: 1,
      content: "CRIMINAL CASES DECLARED: 1. INCOME-TAX RETURN HISTORY: self Y 2023 - 2024 ** Rs 4,98,050 ~ 4 Lacs+ 2022 - 2023 ** Rs 6,86,040 ~ 6 Lacs+",
    }));

  const c = runAffidavitExtraction();
  assert.ok(c.row.facts >= 3, "row source should write assets+liabilities+criminal");
  assert.ok(c.eci.facts >= 3, "eci source should write criminal + 2 income years");

  // Row facts landed, dated by election year, tagged with the row version.
  const [assets] = factsFor(eid, "declared_assets");
  assert.equal(assets.value, 104358691);
  assert.equal(assets.as_of_date, "2024");
  assert.equal(assets.extractor_version, AFFIDAVIT_ROW_VERSION);
  assert.equal(assets.source_type, "affidavit_row");

  // Income time-series landed from the eci source (two distinct years).
  const income = factsFor(eid, "declared_income");
  assert.equal(income.length, 2);
  assert.equal(income.find((f) => f.as_of_date === "2022").value, 686040);
  assert.equal(income[0].extractor_version, ECI_AFFIDAVIT_VERSION);

  // Criminal_cases exists from BOTH sources (two rows, distinct source_type).
  const crim = factsFor(eid, "criminal_cases");
  assert.equal(crim.length, 2);
  assert.deepEqual([...new Set(crim.map((f) => f.source_type))].sort(), ["affidavit_row", "eci_affidavit"]);
});

test("integration: extraction is idempotent (re-run writes nothing new)", () => {
  const c = runAffidavitExtraction();
  assert.equal(c.row.facts, 0);
  assert.equal(c.eci.facts, 0);
});
