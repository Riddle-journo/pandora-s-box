// Parliamentary Standing Committee extractor — pure parser tested against an inline
// fixture (the `• <title> | <url> | <body excerpt>` row shape l1Match builds), plus
// one integration pass driving a fixture row through the framework into the
// claims / events / relationships ledgers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set the DB path BEFORE importing store/extract (importing the extractor pulls in
// extract.js → store.js, which opens the DB at load).
process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-committee-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { ensureEntity } = await import("../server/entities.js");
const { claimsFor } = await import("../server/ledger.js");
const { relationsOf } = await import("../server/relations.js");
const { extractFromEvidence } = await import("../server/extract.js");
const {
  parseCommitteeReports, findEntities, committeeRecords,
} = await import("../server/extractors/parliament-committee.js");

test.after(() => { for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} } });

const FIXTURE_CONTENT =
  "Parliamentary Standing Committee reports (2 matching rows, dataset of 380):\n" +
  "• Cyber Crimes and Cyber Security of Women | https://prsindia.org/files/policy/policy_committee_reports/SCR_on_Women_Empowerment_Cybercrime.pdf | The Committee examined the Ministry of Home Affairs and found that Bharat Sanchar Nigam Limited had not complied, and questioned Hon. member Test Rep about the delay.\n" +
  "• Availability of Oilseeds and Pulses | https://prsindia.org/files/policy/policy_committee_reports/SCR-Availability_of_Oilseeds_and_Pulses.pdf | The report notes that the Food Corporation of India and the Department of Agriculture, along with Test Rep, reviewed procurement.";

test("parseCommitteeReports splits each bullet row into title / url / body", () => {
  const rows = parseCommitteeReports(FIXTURE_CONTENT);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Cyber Crimes and Cyber Security of Women");
  assert.equal(rows[0].url, "https://prsindia.org/files/policy/policy_committee_reports/SCR_on_Women_Empowerment_Cybercrime.pdf");
  assert.match(rows[0].body, /Bharat Sanchar Nigam Limited/);
  assert.equal(rows[1].title, "Availability of Oilseeds and Pulses");
});

test("parseCommitteeReports derives a title from the filename when anchor text is empty", () => {
  const rows = parseCommitteeReports("•  | https://prsindia.org/files/policy/policy_committee_reports/SCR-Availability_of_Oilseeds_and_Pulses.pdf | body");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "SCR Availability of Oilseeds and Pulses");
});

test("findEntities pulls ministries, departments and PSUs out of a body excerpt", () => {
  const ents = findEntities("The Ministry of Home Affairs and Bharat Sanchar Nigam Limited, plus the Food Corporation of India and the Department of Agriculture.");
  assert.ok(ents.includes("Ministry of Home Affairs"), `got: ${JSON.stringify(ents)}`);
  assert.ok(ents.includes("Bharat Sanchar Nigam Limited"), `got: ${JSON.stringify(ents)}`);
  assert.ok(ents.includes("Food Corporation of India"), `got: ${JSON.stringify(ents)}`);
  assert.ok(ents.includes("Department of Agriculture"), `got: ${JSON.stringify(ents)}`);
});

test("committeeRecords emits a low-confidence unverified claim per report + org relationships", () => {
  const out = committeeRecords({ content: FIXTURE_CONTENT });
  assert.equal(out.claims.length, 2);
  for (const c of out.claims) {
    assert.equal(c.claim_type, "named_in_committee_report");
    assert.equal(c.status, "unverified");
    assert.ok(c.confidence <= 0.3);
  }
  assert.equal(out.claims[0].object_text, "Cyber Crimes and Cyber Security of Women");
  // Every relationship is a low-confidence, identity-unverified org edge.
  assert.ok(out.relationships.length >= 3);
  for (const r of out.relationships) {
    assert.equal(r.rel_type, "named_in_committee_report");
    assert.equal(r.dst_kind, "org");
    assert.equal(r.data.identity_unverified, true);
  }
  assert.ok(out.relationships.some((r) => r.dst_name === "Bharat Sanchar Nigam Limited"));
});

test("committeeRecords returns {} when the content has no bullet rows", () => {
  assert.deepEqual(committeeRecords({ content: "no rows here" }), {});
});

test("integration: a committee-report row → claims + org relationships in the ledgers", () => {
  const pid = "PC1";
  const eid = ensureEntity({ kind: "person", name: "Test Rep", strongIds: { politician_id: pid }, source: "seed" });

  const out = extractFromEvidence({
    id: "ev-committee-1", politician_id: pid, source_type: "l1_standing_committee_reports", tier: 5,
    data: {
      source_type: "l1_standing_committee_reports", tier: 5,
      title: "Parliamentary Standing Committee reports — Test Rep",
      content: FIXTURE_CONTENT,
    },
  });
  assert.equal(out.claims, 2);
  assert.ok(out.relationships >= 3);

  const claims = claimsFor(eid, "named_in_committee_report");
  assert.equal(claims.length, 2);
  assert.equal(claims[0].status, "unverified");
  assert.ok(claims[0].confidence <= 0.3);

  const rels = relationsOf(eid, { relType: "named_in_committee_report" });
  assert.ok(rels.length >= 3);
  assert.equal(rels[0].data.identity_unverified, true);
});
