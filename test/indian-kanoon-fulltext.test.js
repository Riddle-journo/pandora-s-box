// Unit tests for the Indian Kanoon full-text merge step. These pin the PURE
// `mergeFullText` helper — the network-free core that folds fetched judgment
// bodies into the search-result lines. No network, no DB: everything runs off
// inline fixture strings, so the suite is deterministic and offline.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeFullText } from "../server/fetchers/indian-kanoon.js";

test("mergeFullText: incorporates a judgment body into the matching line", () => {
  const lines = ["• Case A on 1 May, 2019", "• Case B on 2 June, 2020"];
  const bodies = ["FULL JUDGMENT of A naming Test Rep as accused", "body of B"];

  const merged = mergeFullText(lines, bodies, { limit: 4 });

  // Original snippet line is preserved and the body is appended, not replaced.
  assert.ok(merged[0].startsWith("• Case A on 1 May, 2019"));
  assert.match(merged[0], /\n {4}Full text: FULL JUDGMENT of A naming Test Rep as accused$/);
  assert.match(merged[1], /Full text: body of B$/);
});

test("mergeFullText: respects the fulltext limit (bodies past it are ignored)", () => {
  const lines = ["l0", "l1", "l2", "l3", "l4"];
  const bodies = ["b0", "b1", "b2", "b3", "b4"]; // more bodies than the limit

  const merged = mergeFullText(lines, bodies, { limit: 2 });

  // Only the first `limit` lines get a body…
  assert.match(merged[0], /Full text: b0$/);
  assert.match(merged[1], /Full text: b1$/);
  // …and every line beyond the limit is returned exactly as-is.
  assert.equal(merged[2], "l2");
  assert.equal(merged[3], "l3");
  assert.equal(merged[4], "l4");
});

test("mergeFullText: default limit is 4 when no options are given", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `l${i}`);
  const bodies = Array.from({ length: 6 }, (_, i) => `b${i}`);

  const merged = mergeFullText(lines, bodies); // no opts → default limit 4

  assert.match(merged[3], /Full text: b3$/); // last index within default cap
  assert.equal(merged[4], "l4"); // 5th line (index 4) is beyond the default cap
  assert.equal(merged[5], "l5");
});

test("mergeFullText: empty / missing bodies fall back to snippet-only lines", () => {
  const lines = ["l0", "l1", "l2"];
  const bodies = ["", null]; // one empty, one null, one absent

  const merged = mergeFullText(lines, bodies, { limit: 4 });

  assert.deepEqual(merged, ["l0", "l1", "l2"]);
});

test("mergeFullText: no bodies at all reproduces the original lines exactly", () => {
  const lines = ["• only snippet A", "• only snippet B"];

  // This is the total-failure / degrade-gracefully path.
  assert.deepEqual(mergeFullText(lines, []), lines);
  assert.deepEqual(mergeFullText(lines), lines);
});

test("mergeFullText: excerpt is whitespace-collapsed and trimmed to excerptLen", () => {
  const noisy = "line one\n\n   line two\t\ttabbed" + " x".repeat(4000);
  const merged = mergeFullText(["• Case"], [noisy], { limit: 4, excerptLen: 1500 });

  const excerpt = merged[0].split("Full text: ")[1];
  assert.equal(excerpt.length, 1500, "excerpt trimmed to excerptLen chars");
  assert.ok(excerpt.startsWith("line one line two tabbed"), "internal whitespace collapsed");
  assert.doesNotMatch(excerpt, /[\n\t]/, "no raw newlines or tabs survive");
});
