// Pure helpers of the CPPP flatten/index (name normalisation, date parsing,
// grouping-key reliability). No DB — these gate correctness of every procurement
// detector's grouping, so they're pinned independently.
import test from "node:test";
import assert from "node:assert/strict";
import { normName, parseCpppDate, reliableKey } from "../server/cppp-index.js";

test("normName: strips only corporate-form suffixes, keeps distinguishing words", () => {
  // Same firm, different spellings → one key.
  assert.equal(normName("M/s Raj Constructions Pvt. Ltd."), normName("RAJ CONSTRUCTIONS PRIVATE LIMITED"));
  // Different firms that share a first word must NOT collapse.
  assert.notEqual(normName("Raj Constructions"), normName("Raj Enterprises"));
  assert.equal(normName("Raj Constructions"), "RAJ CONSTRUCTIONS");
  // The corporate-form words themselves are dropped.
  assert.equal(normName("Gangaraju Enterprises Pvt Ltd"), "GANGARAJU ENTERPRISES");
});

test("reliableKey: rejects bare initials / single words, accepts real names", () => {
  assert.equal(reliableKey("S K"), false);       // too short + 2 tiny tokens
  assert.equal(reliableKey("RAJ"), false);       // single token
  assert.equal(reliableKey("RAJ CONSTRUCTIONS"), true);
  assert.equal(reliableKey("GANGARAJU ENTERPRISES"), true);
});

test("parseCpppDate: parses the CPPP date format, else null", () => {
  assert.equal(parseCpppDate("16-Jun-2026 12:00 AM"), "2026-06-16");
  assert.equal(parseCpppDate("05-Jan-2020"), "2020-01-05");
  assert.equal(parseCpppDate(""), null);
  assert.equal(parseCpppDate("garbage"), null);
});
