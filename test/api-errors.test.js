// Error-path tests: pin that error responses do not leak stack traces or
// internal exception messages (ENOENT paths, SQL, etc.) to API clients.
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

const GENERIC_ERRORS = ["internal error", "not found"];

describe("error paths do not leak internals", () => {
  it("GET /api/ministries/definitely%2Fnot%2Freal/card -> pins observed status, no stack trace", async () => {
    const res = await fetch(srv.baseUrl + "/api/ministries/definitely%2Fnot%2Freal/card");
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.ok(!text.includes("at "));
    assert.ok(!text.includes(".js:"));
    const body = JSON.parse(text);
    if ("error" in body) {
      assert.ok(GENERIC_ERRORS.includes(body.error));
    }
  });

  it("GET /api/parties/notreal/card -> pins observed status, no stack trace", async () => {
    const res = await fetch(srv.baseUrl + "/api/parties/notreal/card");
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.ok(!text.includes("at "));
    assert.ok(!text.includes(".js:"));
    const body = JSON.parse(text);
    if ("error" in body) {
      assert.ok(GENERIC_ERRORS.includes(body.error));
    }
  });
});
