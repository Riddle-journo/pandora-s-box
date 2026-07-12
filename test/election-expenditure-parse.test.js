// Unit test for the pure expenditure-table parser. No network, no DB — just the
// exported parseExpenditureTable against inline MyNeta-style markup. Pins that we
// pull per-head line items (skipping the leading serial column and header row),
// read the amount from the rightmost numeric cell, tolerate ₹ / Rs. / commas, and
// capture the Grand Total separately.
import test from "node:test";
import assert from "node:assert/strict";
import { parseExpenditureTable } from "../server/fetchers/election-expenditure.js";

// A small itemized expense table: header row + 3 heads (mixed ₹/Rs./plain money
// formatting, a leading Sr-No column) + a colspan Grand Total row.
const HTML = `
<html><body>
<h2>Election Expenses</h2>
<table id="expenditure">
  <tr><th>Sr No</th><th>Particulars</th><th>Amount (Rs.)</th></tr>
  <tr><td>1</td><td>Public Meetings, Processions etc.</td><td>&#8377; 1,25,000</td></tr>
  <tr><td>2</td><td>Campaign Materials &amp; Publicity</td><td>Rs. 75,500</td></tr>
  <tr><td>3</td><td>Travel &amp; Vehicles</td><td>2,00,000</td></tr>
  <tr><td colspan="2">Grand Total</td><td>4,00,500</td></tr>
</table>
</body></html>`;

test("parseExpenditureTable: extracts per-head line items and the grand total", () => {
  const parsed = parseExpenditureTable(HTML);
  assert.ok(parsed, "should return a numbers object for a parseable table");

  assert.equal(parsed.grand_total, 400500);
  assert.equal(parsed.items.length, 3, "3 heads, header row + grand-total row excluded");

  assert.deepEqual(parsed.items, [
    { head: "Public Meetings, Processions etc.", amount: 125000 },
    { head: "Campaign Materials & Publicity", amount: 75500 },
    { head: "Travel & Vehicles", amount: 200000 },
  ]);

  // The Grand Total row must not leak into items.
  assert.ok(!parsed.items.some((it) => /grand\s*total/i.test(it.head)));
  // Items sum to the declared grand total (sanity on the parsed figures).
  assert.equal(parsed.items.reduce((s, it) => s + it.amount, 0), parsed.grand_total);
});

test("parseExpenditureTable: degrades to null when there is no table to parse", () => {
  assert.equal(parseExpenditureTable("<p>No expenditure filed.</p>"), null);
  assert.equal(parseExpenditureTable(""), null);
  assert.equal(parseExpenditureTable(null), null);
  assert.equal(parseExpenditureTable(undefined), null);
});

test("parseExpenditureTable: captures items even when no grand total is present", () => {
  const html = `<table>
    <tr><td>1</td><td>Print Advertisements</td><td>₹50,000</td></tr>
    <tr><td>2</td><td>Electronic Media</td><td>1,10,000</td></tr>
  </table>`;
  const parsed = parseExpenditureTable(html);
  assert.ok(parsed);
  assert.equal(parsed.grand_total, null);
  assert.deepEqual(parsed.items, [
    { head: "Print Advertisements", amount: 50000 },
    { head: "Electronic Media", amount: 110000 },
  ]);
});
