// Characterization tests for server/util/names.js (Task 4.1).
// Expected values were computed by running the ORIGINAL in-file definitions
// (import-rs.js) before the extraction — these pin behavior, not intent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NORM, nameScore } from "../server/util/names.js";

test("NORM: strips honorific punctuation, keeps words >= 3 chars, lowercases", () => {
  assert.deepEqual(NORM("Dr. Manmohan Singh"), ["manmohan", "singh"]);
  assert.deepEqual(NORM("Shri  A.B.  Vajpayee"), ["shri", "vajpayee"]);
  assert.deepEqual(NORM("SONIA GANDHI"), ["sonia", "gandhi"]);
  assert.deepEqual(NORM("Y.S. Jagan Mohan Reddy"), ["jagan", "mohan", "reddy"]);
});

test("NORM: empty and short-token inputs", () => {
  assert.deepEqual(NORM(""), []);
  assert.deepEqual(NORM(null), []);
  assert.deepEqual(NORM("Rahul"), ["rahul"]);
  assert.deepEqual(NORM("A B C"), []); // all tokens < 3 chars drop out
});

test("nameScore: fraction of a's tokens found in b", () => {
  assert.equal(nameScore("Dr. Manmohan Singh", "Manmohan Singh"), 1);
  assert.equal(nameScore("Sonia Gandhi", "Rahul Gandhi"), 0.5);
  assert.equal(nameScore("A B C", "anything"), 0); // empty A => 0
  assert.equal(nameScore("Narendra Damodardas Modi", "Narendra Modi"), 0.6666666666666666);
});
