// Golden table for the Indian-figure number parsers. No network, no DB, no LLM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRupees, parsePercent, parseYear } from "../server/util/numbers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "numbers.json"), "utf8"));

test("parseRupees handles crore/lakh/thousand/comma-grouped formats", () => {
  for (const { in: input, out } of T.rupees) {
    assert.equal(parseRupees(input), out, `parseRupees(${JSON.stringify(input)})`);
  }
});

test("parsePercent normalizes strings, 0-1 fractions, and >1 numbers", () => {
  for (const { in: input, out } of T.percent) {
    assert.equal(parsePercent(input), out, `parsePercent(${JSON.stringify(input)})`);
  }
});

test("parseYear pulls the first 4-digit year", () => {
  for (const { in: input, out } of T.year) {
    assert.equal(parseYear(input), out, `parseYear(${JSON.stringify(input)})`);
  }
});
