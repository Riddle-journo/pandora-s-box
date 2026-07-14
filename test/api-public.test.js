// Public API smoke tests against the real Express app via the integration
// harness. Starts the server once (before) and closes it once (after).
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

describe("public API", () => {
  it("GET /healthz -> 200 and ok", async () => {
    const res = await fetch(srv.baseUrl + "/healthz");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("GET /api/politicians -> 200 and array", async () => {
    const res = await fetch(srv.baseUrl + "/api/politicians");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/politicians/nonexistent-id -> pins observed status", async () => {
    const res = await fetch(srv.baseUrl + "/api/politicians/nonexistent-id");
    assert.equal(res.status, 404);
  });

  it("GET /api/methodology -> 200 with parameters and scoring", async () => {
    const res = await fetch(srv.baseUrl + "/api/methodology");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok("parameters" in body);
    assert.ok("scoring" in body);
  });

  it("GET /api/parameters -> 200", async () => {
    const res = await fetch(srv.baseUrl + "/api/parameters");
    assert.equal(res.status, 200);
  });

  it("GET /api/openapi.json -> parseable OpenAPI doc", async () => {
    const res = await fetch(srv.baseUrl + "/api/openapi.json");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.openapi, /^3\./);
    assert.ok(body.paths["/api/politicians"]);
  });
});
