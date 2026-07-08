// L2 bounded agentic tool-loop tests. Fully offline: INVESTIGATOR_MOCK=1 swaps the
// LLM call for a scripted response sequence and the tool registry for stubs, so we
// exercise the loop, persistence, resume, step-cap, and malformed-JSON paths with
// no network. Points the store at a throwaway DB before importing anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.INVESTIGATOR_MOCK = "1";
process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-investigator-${process.pid}.db`);

const { upsertLead, getLead } = await import("../server/store.js");
const { investigateLead, setMockResponses } = await import("../server/investigator.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// A minimal detected lead. actor_id points at a politician with no evidence rows,
// so the dossier is empty — fine, the loop only needs the lead facts + tools.
function seedLead(key) {
  return upsertLead({
    key, vector: "REGULATORY_SELF_DEALING", actor_id: `pol-${key}`, actor_name: "Test MP",
    instrument: "Standing Committee on Finance", beneficiary: "Acme Ltd",
    detail: "office/company sector overlap", headline: "Test MP and Acme Ltd", status: "detected",
  });
}

const ACTION = (tool, name) => ({ action: { tool, args: { name } }, reason: "verify" });
const VERDICT = (v) => ({ verdict: { verdict: v, mechanism: "m", evidence_for: ["e"], evidence_against: [], timeline: "not established", confidence: 42, confirming_record: "r", summary: "one sentence" } });

test("(a) scripted action→action→verdict persists 2 steps and the final verdict", async () => {
  const lead = seedLead("a");
  setMockResponses([
    ACTION("mca_directors", "Test MP"),
    ACTION("nse_deals", "Test MP"),
    VERDICT("COINCIDENCE"),
  ]);
  const out = await investigateLead(lead);
  assert.equal(out.status, "dismissed");                       // COINCIDENCE → dismissed
  const ran = out.investigation.steps.filter((s) => s.ran);
  assert.equal(ran.length, 2, "two tools actually ran");
  assert.deepEqual(ran.map((s) => s.tool), ["mca_directors", "nse_deals"]);
  assert.equal(out.investigation.status, "done");
  assert.equal(out.investigation.verdict, "COINCIDENCE");
  assert.equal(out.investigation.confidence, 42);
  // State was persisted to the store, not just returned.
  assert.equal(getLead("a").investigation.steps.filter((s) => s.ran).length, 2);
});

test("(b) resume continues from persisted steps and skips a duplicate tool+args", async () => {
  const lead = seedLead("b");
  // Pre-seed one already-taken step under lead.data.investigation (resume input).
  lead.data = { investigation: { status: "running", steps: [
    { tool: "mca_directors", args: { name: "Test MP" }, ran: true, summary: "prior", at: "2026-07-08T00:00:00.000Z" },
  ] } };
  setMockResponses([
    ACTION("mca_directors", "Test MP"),   // duplicate → must be skipped, not re-run
    ACTION("nse_deals", "Test MP"),        // fresh → runs (this is "step 2")
    VERDICT("COINCIDENCE"),
  ]);
  const out = await investigateLead(lead);
  const dup = out.investigation.steps.find((s) => s.tool === "mca_directors" && s.ran === false);
  assert.ok(dup && /skipped/i.test(dup.summary), "duplicate mca_directors was skipped");
  // mca_directors ran exactly once (the pre-seeded run), never a second time.
  assert.equal(out.investigation.steps.filter((s) => s.tool === "mca_directors" && s.ran).length, 1);
  assert.ok(out.investigation.steps.some((s) => s.tool === "nse_deals" && s.ran), "loop continued to nse_deals");
});

test("(c) step-cap forces a verdict when the model keeps requesting actions", async () => {
  const lead = seedLead("c");
  setMockResponses([
    ACTION("mca_directors", "Test MP"),
    ACTION("opencorporates", "Test MP"),
    ACTION("nse_deals", "Test MP"),
    ACTION("indian_kanoon", "Test MP"),   // 4th call — cap reached, still an action
    VERDICT("SUGGESTIVE"),                 // forced final verdict-only call
    { innocent_explanation: "x", fully_explainable: false, why: "y" }, // L3 (SUGGESTIVE ≠ COINCIDENCE)
  ]);
  const out = await investigateLead(lead);
  assert.equal(out.investigation.steps.filter((s) => s.ran).length, 4, "exactly MAX_STEPS tools ran");
  assert.equal(out.investigation.verdict, "SUGGESTIVE");
  assert.equal(out.status, "proposed");   // survived L3 (not fully explainable)
  assert.equal(out.investigation.status, "done");
});

test("(d) malformed JSON degrades to status:error and leaves the lead in detected", async () => {
  const lead = seedLead("d");
  setMockResponses(["not json at all {{{", "still not json"]);  // initial + one retry
  const out = await investigateLead(lead);
  assert.equal(out.status, "detected", "lead is not promoted or dismissed");
  assert.equal(out.investigation.status, "error");
  assert.equal(getLead("d").investigation.status, "error");
});
