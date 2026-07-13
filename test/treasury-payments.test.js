// Unit tests for the district-treasury payment extractor. The parser + record
// builder are PURE (no DB), so we test treasuryRecords() directly against inline
// fixture `content` for both corpus layouts (Balasore ISO dates + DDO column, AP
// child-budget dd-MON-yyyy + head descriptions), asserting the claim shape, the
// amount parsing (₹ / Indian commas stripped to a Number), and the numeric fact.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount, parseTreasuryRow, treasuryRecords, TREASURY_SOURCE_TYPES,
} from "../server/extractors/treasury-payments.js";

// Balasore layout: ddo_code|ddo_name|dept_code|dept_name|budget_code|heads…|
// allot_date(ISO)|allot_id|alloted|expenditure|… — amount here is a ₹/comma value.
const BALASORE = `Balasore district treasury transactions — Ramesh Kumar (2 matching rows, dataset of 50087):
• BLSAGR001 | District Agriculture Officer Jaleswar | AGR | Department of Agriculture And Farmers Empowerment | 23-2401-00-001 | 2401 | 0 | 1 | 1159 | 1003 | 136 | 1 | 2016-04-16 | 102 | ₹1,23,456 | 32000 | 0 | 0 | 0
• BLSREV002 | Tahasildar Balasore | REV | Revenue Department | 23-2029 | 2029 | 0 | 1 | 800 | 42 | 5 | 1 | 2017-03-10 | 55 | 40000 | 40000 | 0 | 0 | 0`;

// AP child-budget layout: district|year|month|timestamp(dd-MON-yyyy)|head_of_account|
// codes…|descriptions…|amount(last). Amount is the last, largest numeric cell.
const AP = `AP child-budget-tagged treasury spend — Ramesh Kumar (1 matching row, dataset of 24270):
• WESTGODAVARI | 2016 | JUNE | 01-JUNE-2016 | 2202011010004010011NVN | 2202 | 1 | 101 | 0 | 4 | 10 | 11 | N | V | P | General Education | Elementary Education | Government Primary Schools | Not Applicable | Government Primary Schools | Salaries | Pay | 7,25,504`;

// A row whose named party is a private firm, not the politician.
const FIRM = `Balasore district treasury transactions — Ramesh Kumar (1 matching row, dataset of 50087):
• BLSPWD003 | Executive Engineer PWD | PWD | Public Works | 23-3054 | 3054 | 0 | 1 | 337 | 4 | 12 | 1 | 2018-05-20 | 9 | Sri Ram Constructions Pvt Ltd | 250000 | 0 | 0 | 0`;

test("both treasury source_types are registered", () => {
  assert.deepEqual(TREASURY_SOURCE_TYPES, ["l1_balasore_treasury", "l1_ap_child_treasury"]);
});

test("parseAmount strips ₹, Rs and Indian comma grouping to a Number", () => {
  assert.equal(parseAmount("₹1,23,456"), 123456);
  assert.equal(parseAmount("Rs 45,000"), 45000);
  assert.equal(parseAmount("725504"), 725504);
  assert.equal(parseAmount("INR 1,000.50"), 1000.5);
  assert.equal(parseAmount("2016-04-16"), null); // a date is not an amount
  assert.equal(parseAmount("2202011010004010011NVN"), null); // head-of-account code
  assert.equal(parseAmount(""), null);
});

test("Balasore row: date (ISO), max amount, DDO office and scheme", () => {
  const r = parseTreasuryRow("• BLSAGR001 | District Agriculture Officer Jaleswar | AGR | Department of Agriculture And Farmers Empowerment | 23-2401-00-001 | 2401 | 0 | 1 | 1159 | 1003 | 136 | 1 | 2016-04-16 | 102 | ₹1,23,456 | 32000 | 0 | 0 | 0");
  assert.equal(r.date, "2016-04-16");
  assert.equal(r.amount, 123456); // ₹1,23,456 beats 32000 and all head codes
  assert.equal(r.ddo, "District Agriculture Officer Jaleswar");
  assert.equal(r.scheme, "Department of Agriculture And Farmers Empowerment");
  assert.equal(r.payee_is_firm, false);
});

test("Balasore evidence → per-row claims + numeric facts", () => {
  const { claims, facts, relationships } = treasuryRecords({ content: BALASORE }, "balasore_treasury");
  assert.equal(claims.length, 2);
  assert.equal(facts.length, 2);
  assert.equal(relationships.length, 0);

  const c0 = claims[0];
  assert.equal(c0.claim_type, "named_treasury_payee");
  assert.equal(c0.status, "unverified");
  assert.ok(c0.confidence >= 0.15 && c0.confidence <= 0.3);
  assert.equal(c0.as_of_date, "2016-04-16");
  assert.equal(c0.data.source, "balasore_treasury");
  assert.equal(c0.data.amount_inr, 123456);
  assert.match(c0.object_text, /Department of Agriculture/);
  assert.match(c0.object_text, /1,23,456/); // ₹ amount rendered en-IN
  assert.ok(c0.data.note.length > 0);

  const f0 = facts[0];
  assert.equal(f0.metric, "treasury_payment_inr");
  assert.equal(f0.value, 123456);
  assert.equal(f0.unit, "INR");
  assert.equal(f0.subject_kind, "politician");
  assert.equal(f0.as_of_date, "2016-04-16");
  assert.equal(facts[1].value, 40000);
});

test("AP child-budget layout: dd-MON-yyyy date, last-cell amount, head description scheme", () => {
  const { claims, facts } = treasuryRecords({ content: AP }, "ap_child_treasury");
  assert.equal(claims.length, 1);
  assert.equal(facts.length, 1);

  const c = claims[0];
  assert.equal(c.as_of_date, "2016-06-01"); // 01-JUNE-2016 parsed
  assert.equal(c.data.amount_inr, 725504); // 7,25,504 comma-stripped
  assert.equal(c.data.source, "ap_child_treasury");
  assert.match(c.object_text, /7,25,504/);
  assert.equal(facts[0].value, 725504);
  assert.equal(facts[0].as_of_date, "2016-06-01");
});

test("firm payee → relationship edge instead of dropping the row", () => {
  const { claims, facts, relationships } = treasuryRecords({ content: FIRM }, "balasore_treasury");
  assert.equal(claims.length, 1);
  assert.equal(facts.length, 1);
  assert.equal(relationships.length, 1);

  const rel = relationships[0];
  assert.equal(rel.rel_type, "treasury_payee_firm");
  assert.equal(rel.dst_name, "Sri Ram Constructions Pvt Ltd");
  assert.equal(rel.dst_kind, "company");
  assert.equal(rel.valid_from, "2018-05-20");
  assert.equal(rel.data.identity_unverified, true);
  assert.ok(rel.confidence <= 0.3);
  assert.equal(facts[0].value, 250000);
});

test("empty / headerless content yields no records", () => {
  assert.deepEqual(treasuryRecords({ content: "" }), { claims: [], facts: [], relationships: [] });
  assert.deepEqual(treasuryRecords({}), { claims: [], facts: [], relationships: [] });
});
