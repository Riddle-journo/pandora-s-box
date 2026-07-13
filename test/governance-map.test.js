// Governance map — the reference table that closes the donor→party→award triangle.
// Pure lookups; pin the shape and a few well-known facts so an accidental edit to
// the curated data is caught.
import test from "node:test";
import assert from "node:assert/strict";
import { rulingPartyOf, rulingPartiesInYear, jurisdictionsGovernedBy, canonParty } from "../server/data/governance-map.js";

test("rulingPartyOf: resolves the party in power for a year", () => {
  assert.equal(rulingPartyOf("Union", 2020), "BJP");
  assert.equal(rulingPartyOf("Union", 2010), "INC");
  assert.equal(rulingPartyOf("West Bengal", 2020), "AITC");
  assert.equal(rulingPartyOf("Tamil Nadu", 2015), "AIADMK");
  assert.equal(rulingPartyOf("Tamil Nadu", 2023), "DMK");
  assert.equal(rulingPartyOf("Nowhere", 2020), null);
});

test("canonParty: aliases collapse (TMC→AITC, CPM→CPI(M))", () => {
  assert.equal(canonParty("TMC"), "AITC");
  assert.equal(canonParty("tmc"), "AITC");
  assert.equal(canonParty("CPM"), "CPI(M)");
  assert.equal(canonParty("BJP"), "BJP");
});

test("jurisdictionsGovernedBy: lists what a party controls in a year", () => {
  const bjp2020 = jurisdictionsGovernedBy("BJP", 2020);
  assert.ok(bjp2020.includes("Union"));
  assert.ok(bjp2020.includes("Gujarat"));
  assert.ok(!bjp2020.includes("West Bengal"));
});

test("rulingPartiesInYear: returns a set of all parties in power somewhere", () => {
  const s = rulingPartiesInYear(2020);
  assert.ok(s.has("BJP") && s.has("AITC") && s.has("INC"));
  assert.ok(s.size >= 5);
});
