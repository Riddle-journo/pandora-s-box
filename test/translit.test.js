// Cross-script (Devanagari↔Latin) name-match skeleton tests. The matcher is
// approximate by design; these lock in the clean cases it must get right and the
// noise guards it must apply.
import test from "node:test";
import assert from "node:assert/strict";

const {
  devanagariToLatin, consonantSkeleton, buildTranslitNeedles, textMatchesTranslit,
} = await import("../server/fetchers/translit.js");

test("consonantSkeleton: same name in both scripts collapses to one skeleton", () => {
  const pairs = [["Fadnavis", "फडणवीस"], ["Pawar", "पवार"], ["Modi", "मोदी"],
    ["Chavan", "चव्हाण"], ["Shinde", "शिंदे"], ["Gandhi", "गांधी"], ["Deshmukh", "देशमुख"]];
  for (const [en, de] of pairs) {
    assert.equal(consonantSkeleton(en), consonantSkeleton(de), `${en} vs ${de}`);
  }
});

test("devanagariToLatin drops vowels/matras, keeps folded consonants", () => {
  assert.equal(devanagariToLatin("पवार"), "pvr");
  assert.equal(devanagariToLatin("मोदी"), "md");
});

test("distinct names do NOT collapse together", () => {
  assert.notEqual(consonantSkeleton("Pawar"), consonantSkeleton("Fadnavis"));
  assert.notEqual(consonantSkeleton("Modi"), consonantSkeleton("Gandhi"));
});

test("buildTranslitNeedles drops too-short skeletons (noise guard)", () => {
  const set = buildTranslitNeedles(["Modi", "Fadnavis", "Ram"]); // Modi→md(2), Ram→rm(2) both <5
  assert.ok(set.has(consonantSkeleton("Fadnavis")));
  assert.ok(!set.has(consonantSkeleton("Modi")), "short skeleton excluded");
});

test("textMatchesTranslit finds an English roster name inside Devanagari text", () => {
  const needles = buildTranslitNeedles(["Fadnavis", "Deshmukh"]);
  const marathiBody = "शासन निर्णय: श्री देवेंद्र फडणवीस यांच्या अध्यक्षतेखाली ...";
  assert.equal(textMatchesTranslit(marathiBody, needles), true, "Fadnavis skeleton hits the Marathi body");
  assert.equal(textMatchesTranslit("अन्य मजकूर येथे", needles), false, "unrelated text does not match");
});
