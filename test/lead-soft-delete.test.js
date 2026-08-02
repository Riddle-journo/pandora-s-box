// Rejecting a lead SOFT-deletes it: the row survives so the human "false
// positive" label still has something to score against.
//
// The load-bearing case here is resurrection. Three production paths re-upsert a
// lead with status:'detected' EXPLICITLY (enrichment/director-link.js,
// synthesis/investigate.js detectFor, and the investigator's malformed-response
// reset). Since upsertLead merges incoming over existing, a rejected lead would
// climb straight back into the investigation queue on the next scan without the
// terminal-status guard — and an approved one would silently un-publish.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// MUST precede the store import: the store binds its DB handle at import time.
process.env.PANDOROS_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "pandoros-softdelete-")), "t.db");

const { upsertLead, getLead, listLeads, deleteLead } = await import("../server/store/store.js");
const { decideLeadShared } = await import("../server/routes/util.js");

let seq = 0;
function seedProposed(extra = {}) {
  const key = `TEST_VECTOR|actor-${++seq}|beneficiary-${seq}`;
  return upsertLead({
    key, vector: "TEST_VECTOR", actor_id: `actor-${seq}`, actor_name: `Actor ${seq}`,
    beneficiary: `beneficiary-${seq}`, signal_score: 50, status: "proposed",
    headline: "test lead", evidence_urls: ["https://example.gov.in/doc"],
    data: { engine_flag_key: "da_ratio" },
    investigation: { verdict: "SUGGESTIVE", confidence: 62, steps: [{ tool: "read_evidence" }] },
    ...extra,
  });
}

test("reject keeps the row, its detector attribution, and the investigation blob", () => {
  const lead = seedProposed();
  const returned = decideLeadShared(lead, "reject", "test");

  const after = getLead(lead.id);
  assert.ok(after, "the row must survive a rejection — it is the eval corpus");
  assert.equal(after.status, "rejected");
  assert.ok(after.rejected_at, "rejected_at is stamped");
  // The learnable payload: detector attribution, citations, and the L2/L3 verdict.
  assert.equal(after.data?.engine_flag_key, "da_ratio");
  assert.deepEqual(after.evidence_urls, ["https://example.gov.in/doc"]);
  assert.equal(after.investigation?.verdict, "SUGGESTIVE");
  assert.equal(after.investigation?.confidence, 62);
  assert.equal(returned?.status, "rejected", "returns the updated lead (callers ignore it, but null was a trap)");
});

test("forceStatus is a control flag and never leaks into the stored blob", () => {
  const lead = seedProposed();
  decideLeadShared(lead, "reject", "test");
  const after = getLead(lead.id);
  assert.equal("forceStatus" in after, false, "forceStatus must not be persisted");
});

test("re-detection CANNOT resurrect a rejected lead", () => {
  const lead = seedProposed();
  decideLeadShared(lead, "reject", "test");

  // Exactly what enrichment/director-link.js and detectFor do on the next scan.
  upsertLead({ ...getLead(lead.id), status: "detected" });
  assert.equal(getLead(lead.id).status, "rejected", "a human rejection is terminal");

  // And the investigator's malformed-response reset path.
  upsertLead({ ...getLead(lead.id), status: "detected", investigation: { status: "error" } });
  assert.equal(getLead(lead.id).status, "rejected");

  // A rejected lead must never re-enter the paid investigation queue.
  const detected = listLeads({ status: "detected" });
  assert.equal(detected.some((l) => l.id === lead.id), false);
});

test("re-detection cannot silently un-publish an approved lead", () => {
  const lead = seedProposed();
  decideLeadShared(lead, "approve", "test");
  assert.equal(getLead(lead.id).status, "published");

  upsertLead({ ...getLead(lead.id), status: "detected" });
  assert.equal(getLead(lead.id).status, "published", "publishing is terminal too");
});

test("re-detection still refreshes detector fields on a terminal lead", () => {
  const lead = seedProposed();
  decideLeadShared(lead, "reject", "test");
  upsertLead({ ...getLead(lead.id), status: "detected", signal_score: 91, headline: "refreshed" });

  const after = getLead(lead.id);
  assert.equal(after.status, "rejected", "status pinned");
  assert.equal(after.signal_score, 91, "but the detector's fresh numbers still land");
  assert.equal(after.headline, "refreshed");
});

test("a non-terminal status is still freely advanced (the AI funnel is untouched)", () => {
  const lead = upsertLead({
    key: "TEST_FUNNEL|a|b", vector: "TEST_FUNNEL", actor_id: "a", beneficiary: "b",
    signal_score: 10, status: "detected",
  });
  upsertLead({ ...lead, status: "investigated" });
  assert.equal(getLead(lead.id).status, "investigated");
  upsertLead({ ...getLead(lead.id), status: "proposed" });
  assert.equal(getLead(lead.id).status, "proposed");
  upsertLead({ ...getLead(lead.id), status: "dismissed" });
  assert.equal(getLead(lead.id).status, "dismissed", "machine dismissal stays reversible");
  upsertLead({ ...getLead(lead.id), status: "detected" });
  assert.equal(getLead(lead.id).status, "detected");
});

test("a reviewer can overturn their own terminal decision", () => {
  const lead = seedProposed();
  decideLeadShared(lead, "reject", "test");
  // Same shared helper, opposite decision — forceStatus makes reversal possible.
  const published = decideLeadShared(getLead(lead.id), "approve", "test");
  assert.equal(published.status, "published");
  assert.equal(getLead(lead.id).status, "published");
});

test("rejected leads are hidden from the default listing but readable on request", () => {
  const keep = seedProposed();
  const kill = seedProposed();
  decideLeadShared(kill, "reject", "test");

  const visible = listLeads({});
  assert.equal(visible.some((l) => l.id === kill.id), false,
    "story-generator and synthesis build output from listLeads({}) — a rejected lead must never reach them");
  assert.equal(visible.some((l) => l.id === keep.id), true);

  assert.equal(listLeads({ includeRejected: true }).some((l) => l.id === kill.id), true);
  assert.equal(listLeads({ status: "rejected" }).some((l) => l.id === kill.id), true,
    "the eval harness reads the rejection corpus this way");
});

test("deleteLead still hard-purges, for a genuine purge path", () => {
  const lead = seedProposed();
  decideLeadShared(lead, "reject", "test");
  assert.equal(deleteLead(lead.id), 1);
  assert.equal(getLead(lead.id), null);
});
