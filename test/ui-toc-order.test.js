// ui-toc-order.test.js — the report TOC must follow document order.
//
// buildReportToc() used to splice the dynamic report-card sections in after the
// "#exec-card" entry. #exec-card only becomes visible when the report card has a
// `summary`, so for every rep without one findIndex() returned -1, `at + 1` was
// 0, and the card sections were inserted at the FRONT of the nav — above
// Verified / Network / Criminal / … / Evidence, which is not where they render.
// orderTocEntries() derives the order from the DOM instead, so there is no
// anchor entry left to go missing.
import test from "node:test";
import assert from "node:assert/strict";

const { orderTocEntries } = await import("../public/js/toc.js");

// Minimal stand-in for a DOM node: `pos` is its index in document order and
// compareDocumentPosition returns the two bits orderTocEntries reads.
const nodeAt = (pos) => ({
  pos,
  compareDocumentPosition(other) {
    if (other.pos > this.pos) return 4; // DOCUMENT_POSITION_FOLLOWING
    if (other.pos < this.pos) return 2; // DOCUMENT_POSITION_PRECEDING
    return 0;
  },
});
const entry = (id, pos) => ({ id, label: id, el: nodeAt(pos) });

test("dynamic card sections land in document order when #exec-card is absent", () => {
  // Document order: verified(1) criminal(2) card-a(3) card-b(4) evidence(5).
  // #exec-card is hidden (no card.summary), so it is not in the entry list.
  const fixed = [entry("verified-section", 1), entry("criminal-section", 2), entry("evidence-heading", 5)];
  const dyn = [entry("card-a", 3), entry("card-b", 4)];
  assert.deepEqual(
    orderTocEntries([...fixed, ...dyn]).map((e) => e.id),
    ["verified-section", "criminal-section", "card-a", "card-b", "evidence-heading"],
  );
});

test("dynamic card sections still follow the summary when #exec-card IS present", () => {
  const fixed = [entry("exec-card", 0), entry("verified-section", 5), entry("evidence-heading", 9)];
  const dyn = [entry("card-a", 1), entry("card-b", 2)];
  assert.deepEqual(
    orderTocEntries([...fixed, ...dyn]).map((e) => e.id),
    ["exec-card", "card-a", "card-b", "verified-section", "evidence-heading"],
  );
});

test("ordering does not depend on the order entries are collected in", () => {
  const shuffled = [entry("d", 4), entry("a", 1), entry("c", 3), entry("b", 2)];
  assert.deepEqual(orderTocEntries(shuffled).map((e) => e.id), ["a", "b", "c", "d"]);
  // and it does not mutate its input
  assert.deepEqual(shuffled.map((e) => e.id), ["d", "a", "c", "b"]);
});
