// End-to-end HTTP proof of the lead soft-delete, through the real Express app:
// an admin rejection must leave the row (and its learnable payload) in the DB
// while removing it from every administrative listing.

import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";

let srv, store;

before(async () => {
  srv = await startTestServer();
  // The harness has already pointed PANDOROS_DB_PATH at its temp DB, so this
  // import binds to the SAME database the server is serving.
  store = await import("../server/store/store.js");
});

after(async () => { await srv.close(); });

const admin = () => ({ "x-admin-token": srv.adminToken, "content-type": "application/json" });

function seedProposed(suffix) {
  return store.upsertLead({
    key: `E2E_VECTOR|actor-${suffix}|ben-${suffix}`,
    vector: "E2E_VECTOR", actor_id: `actor-${suffix}`, actor_name: `Actor ${suffix}`,
    beneficiary: `ben-${suffix}`, signal_score: 77, status: "proposed",
    headline: "e2e lead", evidence_urls: ["https://example.gov.in/e2e"],
    data: { engine_flag_key: "benford" },
    investigation: { verdict: "SUGGESTIVE", confidence: 55 },
  });
}

describe("POST /api/admin/investigation-leads/:id/reject", () => {
  it("soft-deletes: row survives with the investigation blob, gone from listings", async () => {
    const lead = seedProposed("a");

    const res = await fetch(`${srv.baseUrl}/api/admin/investigation-leads/${lead.id}/reject`,
      { method: "POST", headers: admin() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, rejected: lead.id },
      "response shape must be unchanged for existing clients");

    const after = store.getLead(lead.id);
    assert.ok(after, "row must survive");
    assert.equal(after.status, "rejected");
    assert.ok(after.rejected_at);
    assert.equal(after.investigation?.verdict, "SUGGESTIVE", "the scoreable verdict is retained");
    assert.equal(after.data?.engine_flag_key, "benford", "detector attribution is retained");

    // The human label and the lead row now COEXIST — that pairing is the whole
    // point: before, lead_feedback held a 'rejected' label whose lead was gone,
    // so the eval harness had nothing to score it against.
    const fb = store.db.prepare("SELECT decision FROM lead_feedback WHERE lead_id = ?").all(lead.id);
    assert.ok(fb.some((f) => f.decision === "rejected"),
      "a 'rejected' feedback label must exist alongside the surviving lead row");

    // Gone from the admin work-queue listing...
    const all = await (await fetch(`${srv.baseUrl}/api/admin/conflicts`, { headers: admin() })).json();
    assert.equal(all.some((l) => l.id === lead.id), false, "excluded from the unfiltered admin listing");

    // ...and from the proposals queue.
    const proposals = await (await fetch(`${srv.baseUrl}/api/admin/investigation-leads`, { headers: admin() })).json();
    assert.equal(proposals.some((l) => l.id === lead.id), false);

    // ...but explicitly readable, which is how the eval corpus is reached.
    const rejected = await (await fetch(`${srv.baseUrl}/api/admin/conflicts?status=rejected`, { headers: admin() })).json();
    assert.equal(rejected.some((l) => l.id === lead.id), true, "readable via ?status=rejected");
  });

  it("rejecting twice is a 404, not a second mutation (status guard still holds)", async () => {
    const lead = seedProposed("b");
    const first = await fetch(`${srv.baseUrl}/api/admin/investigation-leads/${lead.id}/reject`,
      { method: "POST", headers: admin() });
    assert.equal(first.status, 200);

    // The route requires status==='proposed'; a rejected lead is no longer one.
    const second = await fetch(`${srv.baseUrl}/api/admin/investigation-leads/${lead.id}/reject`,
      { method: "POST", headers: admin() });
    assert.equal(second.status, 404);
    assert.equal(store.getLead(lead.id).status, "rejected", "still exactly one rejection");
  });

  it("ops-console reject action behaves identically", async () => {
    const lead = seedProposed("c");
    const res = await fetch(`${srv.baseUrl}/api/admin/ops/leads/${lead.id}/action`, {
      method: "POST", headers: admin(), body: JSON.stringify({ action: "reject" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, rejected: true });
    assert.equal(store.getLead(lead.id).status, "rejected");
    assert.ok(store.getLead(lead.id).investigation, "investigation blob retained");
  });
});
