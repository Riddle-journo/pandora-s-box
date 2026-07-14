// Rate limiting: forced ON for this file only (every other test file gets the
// helper's RATE_LIMIT=0 default). Tiny env-tuned windows so nothing sleeps.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE importing the helper/server (import-time middleware registration).
process.env.RATE_LIMIT = "1";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.RATE_LIMIT_MAX = "50";            // global: high enough to stay out of the way
process.env.RATE_LIMIT_ADMIN_WINDOW_MS = "60000";
process.env.RATE_LIMIT_ADMIN_MAX = "5";       // admin failures: trip fast

const { startTestServer } = await import("./helpers/server.js");

let srv;

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

describe("rate limiting", () => {
  // Runs FIRST: once the failure budget is spent (next test), the limiter
  // rejects before auth even sees the token — that's intentional lockout.
  it("valid-token admin requests pass and are not counted (skipSuccessfulRequests)", async () => {
    for (let i = 0; i < 7; i++) {
      const res = await fetch(srv.baseUrl + "/api/admin/tips", {
        headers: { "x-admin-token": srv.adminToken },
      });
      assert.equal(res.status, 200, `authorized request #${i + 1} should never be throttled`);
    }
  });

  it("admin token brute-force trips 429 after the failure budget", async () => {
    let sawTooMany = false;
    for (let i = 0; i < 8; i++) {
      const res = await fetch(srv.baseUrl + "/api/admin/tips", {
        headers: { "x-admin-token": "wrong-token-" + i },
      });
      if (res.status === 429) { sawTooMany = true; break; }
      assert.equal(res.status, 401);
    }
    assert.ok(sawTooMany, "expected a 429 within 8 failed auth attempts (budget is 5)");
  });

  it("429 body matches the house error shape", async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/tips", {
      headers: { "x-admin-token": "still-wrong" },
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error, "rate limited");
  });

  it("a valid token still passes on a non-admin-limited public route", async () => {
    // The admin limiter is tripped for this IP, but the GLOBAL limiter (max 50)
    // is not — public API calls keep working.
    const res = await fetch(srv.baseUrl + "/api/politicians");
    assert.equal(res.status, 200);
  });
});
