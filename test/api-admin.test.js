// Admin auth + privacy HTTP tests against the real Express app via the
// integration harness. Starts the server once (before) and closes it once
// (after).
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";

let srv;

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

describe("admin auth", () => {
  it("GET /api/admin/tips: no x-admin-token header -> 401", async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/tips");
    assert.equal(res.status, 401);
  });

  it('GET /api/admin/tips: header "wrong-token" -> 401', async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/tips", {
      headers: { "x-admin-token": "wrong-token" },
    });
    assert.equal(res.status, 401);
  });

  it("GET /api/admin/tips: correct header -> 200", async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/tips", {
      headers: { "x-admin-token": srv.adminToken },
    });
    assert.equal(res.status, 200);
  });

  const protectedPaths = [
    "/api/admin/ops/summary",
    "/api/admin/stories",
    "/api/admin/investigation-leads",
    "/api/admin/conflicts",
    "/api/admin/ops/leads",
    "/api/admin/ops/llm-usage",
  ];

  for (const p of protectedPaths) {
    it(`GET ${p}: no x-admin-token header -> 401`, async () => {
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 401);
    });
  }
});

describe("privacy pins", () => {
  it("GET /api/conflicts -> 404 (not a public route)", async () => {
    const res = await fetch(srv.baseUrl + "/api/conflicts");
    assert.equal(res.status, 404);
  });

  it("GET /api/stories -> 404 (not a public route)", async () => {
    const res = await fetch(srv.baseUrl + "/api/stories");
    assert.equal(res.status, 404);
  });

  it("GET /api/politicians/some-id/conflicts -> 404 (not a public route)", async () => {
    const res = await fetch(srv.baseUrl + "/api/politicians/some-id/conflicts");
    assert.equal(res.status, 404);
  });
});

describe("admin lead decisions (empty DB)", () => {
  it("POST /api/admin/investigation-leads/xyz/approve -> 404 no such proposal", async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/investigation-leads/xyz/approve", {
      method: "POST",
      headers: { "x-admin-token": srv.adminToken },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no such proposal" });
  });

  it('POST /api/admin/ops/leads/xyz/action {"action":"approve"} -> 404 no such lead', async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/ops/leads/xyz/action", {
      method: "POST",
      headers: {
        "x-admin-token": srv.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "no such lead" });
  });
});

describe("admin ops jobs", () => {
  it('POST /api/admin/ops/jobs with correct token and {"type":"nonsense_type"} -> observed non-2xx (400)', async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/ops/jobs", {
      method: "POST",
      headers: {
        "x-admin-token": srv.adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "nonsense_type" }),
    });
    assert.equal(res.status, 400);
  });
});

// llm-usage panel (Task 5.4): authorized shape check on an empty ledger.
describe("llm usage panel", () => {
  it("GET /api/admin/ops/llm-usage with token -> summary shape", async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/ops/llm-usage?days=7", {
      headers: { "x-admin-token": srv.adminToken },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sinceDays, 7);
    assert.ok(Array.isArray(body.byModule));
    assert.ok("totals" in body);
  });
});
