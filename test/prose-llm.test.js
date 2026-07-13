// Prose LLM extractors — the model-facing mappers are pure functions, so we test
// them with hand-built "model JSON" fixtures (no network, no model). This locks the
// materiality/guardrail contract: claims stay unverified + low-confidence, garbage
// is dropped, and Wikipedia numbers are range-checked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-prose-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const {
  mapNewsClaims, mapFactcheckClaims, mapCbiClaims, mapWikiFacts, PROSE_LLM_VERSION, PROSE_SOURCE_TYPES,
} = await import("../server/extractors/prose-llm.js");

test.after(() => { for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} } });

test("mapNewsClaims: unverified + low confidence, drops empties, caps at 6", () => {
  const out = mapNewsClaims({ claims: [
    { type: "promise", text: "Pledged 2 crore jobs by 2024", date: "2024-01-01" },
    { type: "allegation", text: "Accused of favouring a firm in a tender", stance: "denied" },
    { type: "statement", text: "" }, // dropped
    ...Array.from({ length: 8 }, (_, i) => ({ type: "action", text: `did thing ${i} in office` })),
  ] });
  assert.ok(out.length <= 6);
  assert.equal(out[0].claim_type, "news_promise");
  assert.equal(out[0].status, "unverified");
  assert.equal(out[1].claim_type, "news_allegation");
  assert.ok(out[1].confidence <= 0.3);
  assert.ok(out.every((c) => c.object_text.length > 0));
});

test("mapNewsClaims: unknown type falls back to statement", () => {
  const out = mapNewsClaims({ claims: [{ type: "gossip", text: "some material action taken" }] });
  assert.equal(out[0].claim_type, "news_statement");
});

test("mapFactcheckClaims: verdict drives status, skips short claims", () => {
  const out = mapFactcheckClaims({ items: [
    { claim: "Viral image of the PM was staged", verdict: "false", publisher: "BOOM", date: "2026-02-27" },
    { claim: "x", verdict: "true" }, // too short → dropped
    { claim: "A quote attributed to them is real", verdict: "unclear" },
  ] });
  assert.equal(out.length, 2);
  assert.equal(out[0].status, "verified");     // false verdict = a resolved fact-check
  assert.equal(out[0].data.verdict, "false");
  assert.equal(out[1].status, "unverified");   // unclear verdict
});

test("mapCbiClaims: low confidence, identity caveat, caps at 5", () => {
  const out = mapCbiClaims({ actions: [
    { text: "CBI registered a case against the accused in a loan fraud", date: "2026-02-12" },
    { text: "tiny" }, // dropped
  ] });
  assert.equal(out.length, 1);
  assert.equal(out[0].claim_type, "named_in_cbi_action");
  assert.ok(out[0].confidence <= 0.25);
  assert.match(out[0].data.note, /identity unverified/i);
});

test("mapWikiFacts: range-checks birth year and terms", () => {
  assert.deepEqual(mapWikiFacts({ birth_year: 1964, terms: 3 }).map((f) => [f.metric, f.value]), [["birth_year", 1964], ["legislative_terms", 3]]);
  assert.equal(mapWikiFacts({ birth_year: 1850, terms: 99 }).length, 0); // out of range → dropped
  assert.equal(mapWikiFacts({ birth_year: null, terms: null }).length, 0);
});

test("registry lists the four prose sources", () => {
  assert.deepEqual(PROSE_SOURCE_TYPES.sort(), ["cbi_press", "fact_check", "news", "wikipedia"]);
  assert.equal(PROSE_LLM_VERSION, "prose-llm-v1");
});
