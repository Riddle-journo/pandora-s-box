// Golden-master smoke tests for content/list routes against the real Express
// app via the integration harness. Pins CURRENT status code + top-level JSON
// shape (object vs array) observed against the empty test DB — not exact data.
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

describe("content/list API golden master", () => {
  it("GET /api/scandals -> 200 and array", async () => {
    const res = await fetch(srv.baseUrl + "/api/scandals");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/scandals/facets -> 200 and object", async () => {
    const res = await fetch(srv.baseUrl + "/api/scandals/facets");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
    assert.ok("states" in body);
    assert.ok("parties" in body);
    assert.ok("sectors" in body);
  });

  it("GET /api/leaderboard -> 200 and object", async () => {
    const res = await fetch(srv.baseUrl + "/api/leaderboard");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
    assert.ok("metric" in body);
    assert.ok("metrics" in body);
  });

  it("GET /api/leaderboard?limit=5 -> 200 and object", async () => {
    const res = await fetch(srv.baseUrl + "/api/leaderboard?limit=5");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
    assert.ok("metric" in body);
  });

  it("GET /api/issues -> 200 and array", async () => {
    const res = await fetch(srv.baseUrl + "/api/issues");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/funding/overview -> 200 and object", async () => {
    const res = await fetch(srv.baseUrl + "/api/funding/overview");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
    assert.ok("note" in body);
  });

  it("GET /api/scorecards -> 200 and object", async () => {
    const res = await fetch(srv.baseUrl + "/api/scorecards");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
    assert.ok("generated_at" in body);
    assert.ok("totals" in body);
  });

  it("GET /api/ministries -> 200 and array", async () => {
    const res = await fetch(srv.baseUrl + "/api/ministries");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/parties -> 200 and array", async () => {
    const res = await fetch(srv.baseUrl + "/api/parties");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/compare?ids=a,b -> pinned: current behavior (404, error object)", async () => {
    // pinned: current behavior
    const res = await fetch(srv.baseUrl + "/api/compare?ids=a,b");
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
    assert.ok("error" in body);
  });
});

describe("pagination edge cases (pinned before clamp-helper refactor)", () => {
  const admin = { headers: { "x-admin-token": "test-admin-token" } };

  // /api/leaderboard does not read limit/offset params (hardcoded slice(0,50)),
  // so edge params are ignored: always 200 + object with a rows array.
  for (const qs of ["limit=0", "limit=99999", "limit=-5", "offset=-1"]) {
    it(`GET /api/leaderboard?${qs} -> 200 object with rows array`, async () => {
      const res = await fetch(srv.baseUrl + "/api/leaderboard?" + qs);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body, "object");
      assert.ok(!Array.isArray(body));
      assert.ok(Array.isArray(body.rows));
      assert.ok(body.rows.length <= 50);
    });
  }

  // /api/scandals filters but does not paginate: edge params ignored -> 200 array.
  for (const qs of ["limit=0", "limit=99999", "limit=-5", "offset=-1"]) {
    it(`GET /api/scandals?${qs} -> 200 array`, async () => {
      const res = await fetch(srv.baseUrl + "/api/scandals?" + qs);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    });
  }

  // /api/admin/ops/jobs ignores limit/offset (hardcoded slice(0,200)); requires
  // the admin token -> 200 object with counts + jobs array.
  for (const qs of ["limit=0", "limit=99999", "limit=-5", "offset=-1"]) {
    it(`GET /api/admin/ops/jobs?${qs} -> 200 object with jobs array`, async () => {
      const res = await fetch(srv.baseUrl + "/api/admin/ops/jobs?" + qs, admin);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body, "object");
      assert.ok(!Array.isArray(body));
      assert.ok("counts" in body);
      assert.ok(Array.isArray(body.jobs));
      assert.ok(body.jobs.length <= 200);
    });
  }
});
