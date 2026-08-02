// W4 Task 2 — /api/v1 as the canonical prefix, /api as a permanent alias.
//
// The routers register absolute "/api/…" paths with no mount prefix, so v1 is a
// URL rewrite rather than a second mount. What has to hold: byte-identical
// bodies on both prefixes, the opt-in ?page envelope behaving the same on both
// (forcing it on v1 would break the SPA and the golden-master tests), an
// X-API-Version header on the /api surface, unknown versions 404-ing, and — the
// only real regression risk — the rate limiters still firing on the v1 prefix.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";

// Env BEFORE importing the helper/server: the limiters are registered at import
// time. The global budget is generous enough for the equivalence tests above the
// hammer block; the admin failure budget is tiny so it trips fast.
process.env.RATE_LIMIT = "1";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.RATE_LIMIT_MAX = "120";
process.env.RATE_LIMIT_ADMIN_WINDOW_MS = "60000";
process.env.RATE_LIMIT_ADMIN_MAX = "5";

const { startTestServer } = await import("./helpers/server.js");

let srv;

before(async () => {
  srv = await startTestServer();
});

after(async () => {
  await srv.close();
});

// A cross-section of the public surface: static payloads, list endpoints, a
// facets endpoint, and two :param routes (one 404, one 200 empty array).
const EQUIVALENT_PATHS = [
  "/api/parameters",
  "/api/tip-categories",
  "/api/politicians",
  "/api/scandals",
  "/api/scandals/facets",
  "/api/issues",
  "/api/leaderboard",
  "/api/politicians/nonexistent-id",
  "/api/politicians/nonexistent-id/evidence",
];

const v1 = (p) => "/api/v1" + p.slice("/api".length);

describe("/api and /api/v1 are the same surface", () => {
  for (const p of EQUIVALENT_PATHS) {
    it(`${p} and ${v1(p)} return identical status + body`, async () => {
      const a = await fetch(srv.baseUrl + p);
      const b = await fetch(srv.baseUrl + v1(p));
      assert.equal(b.status, a.status, `${v1(p)} status must match ${p}`);
      assert.equal(await b.text(), await a.text(), `${v1(p)} body must match ${p}`);
    });
  }

  it("the OpenAPI document is served on both prefixes", async () => {
    const a = await fetch(srv.baseUrl + "/api/openapi.json");
    const b = await fetch(srv.baseUrl + "/api/v1/openapi.json");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(await b.json(), await a.json());
  });
});

describe("X-API-Version header", () => {
  it("is present on the /api surface", async () => {
    const res = await fetch(srv.baseUrl + "/api/parameters");
    assert.equal(res.headers.get("x-api-version"), "v1");
  });

  it("is present on the /api/v1 surface", async () => {
    const res = await fetch(srv.baseUrl + "/api/v1/parameters");
    assert.equal(res.headers.get("x-api-version"), "v1");
  });

  it("is not set on non-API responses", async () => {
    const res = await fetch(srv.baseUrl + "/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-api-version"), null);
  });
});

describe("unknown versions are not routed", () => {
  for (const p of ["/api/v2/politicians", "/api/v2/parameters", "/api/v0/parameters"]) {
    it(`GET ${p} -> 404`, async () => {
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 404);
    });
  }

  it("a prefix that merely starts with /api/v1 is not rewritten", async () => {
    // "/api/v1x/…" must not be mistaken for the v1 prefix.
    const res = await fetch(srv.baseUrl + "/api/v1x/parameters");
    assert.equal(res.status, 404);
  });
});

describe("the canonical prefix is no stricter about case than its own alias", () => {
  // Express's default caseSensitive:false means /API/parameters already resolves.
  // A literal startsWith on the rewrite made the CANONICAL prefix the only
  // case-sensitive thing on the surface: /API/parameters worked, /API/v1/parameters
  // 404'd. Any client or proxy that normalizes path case saw an inconsistent API.
  const CASINGS = ["/API/v1/parameters", "/api/V1/parameters", "/API/V1/parameters", "/Api/V1/Parameters"];

  it("the bare alias tolerates case (the baseline this has to match)", async () => {
    const res = await fetch(srv.baseUrl + "/API/parameters");
    assert.equal(res.status, 200);
  });

  for (const p of CASINGS) {
    it(`GET ${p} -> 200, same body as /api/v1/parameters`, async () => {
      const canonical = await fetch(srv.baseUrl + "/api/v1/parameters");
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 200, `${p} must resolve like its lower-cased twin`);
      assert.equal(await res.text(), await canonical.text());
    });
  }

  it("case-folding does not widen the prefix match", async () => {
    // Still exactly "/api/v1" + ("/" | "?") — a near-miss must not be rewritten.
    for (const p of ["/API/V1X/parameters", "/API/V2/parameters"]) {
      assert.equal((await fetch(srv.baseUrl + p)).status, 404, p);
    }
  });
});

describe("the bare version prefix is not a discovery endpoint", () => {
  // No terminal "/api" route exists, so /api/v1 and /api/v1/ 404 exactly like
  // /api and /api/ do. Pinned so the parity is deliberate rather than accidental
  // — if a service document is ever added at /api, add it for v1 in the same PR.
  for (const p of ["/api", "/api/", "/api/v1", "/api/v1/", "/API/V1"]) {
    it(`GET ${p} -> 404`, async () => {
      assert.equal((await fetch(srv.baseUrl + p)).status, 404, p);
    });
  }
});

describe("pagination envelope semantics are identical on both prefixes", () => {
  const LISTS = ["/api/politicians", "/api/scandals", "/api/issues"];

  it("no page/pageSize → bare array on BOTH prefixes (opt-in stays opt-in)", async () => {
    for (const p of LISTS) {
      for (const path of [p, v1(p)]) {
        const body = await (await fetch(srv.baseUrl + path)).json();
        assert.ok(Array.isArray(body), `${path} default must stay a bare array`);
      }
    }
  });

  it("?page=1&pageSize=5 → the same envelope on both prefixes", async () => {
    for (const p of LISTS) {
      const q = "?page=1&pageSize=5";
      const a = await (await fetch(srv.baseUrl + p + q)).json();
      const b = await (await fetch(srv.baseUrl + v1(p) + q)).json();
      assert.equal(b.page, 1);
      assert.equal(b.pageSize, 5);
      assert.equal(typeof b.total, "number");
      assert.deepEqual(b, a, `${v1(p)}${q} envelope must match ${p}${q}`);
    }
  });
});

describe("the SPA fetch helpers target v1", () => {
  it("public/js/api.js rewrites /api paths to /api/v1 and leaves the rest alone", async () => {
    const { toApiV1 } = await import("../public/js/api.js");
    assert.equal(toApiV1("/api/politicians"), "/api/v1/politicians");
    assert.equal(toApiV1("/api/leaderboard?metric=worst"), "/api/v1/leaderboard?metric=worst");
    // Idempotent: an already-versioned path must not become /api/v1/v1/…
    assert.equal(toApiV1("/api/v1/politicians"), "/api/v1/politicians");
    assert.equal(toApiV1("/api/v2/politicians"), "/api/v2/politicians");
    // Not the API surface, and not a false "v<digits>" match.
    assert.equal(toApiV1("/healthz"), "/healthz");
    assert.equal(toApiV1("/api/verify"), "/api/v1/verify");
  });

  it("every rewritten SPA path the helper produces is actually served", async () => {
    const { toApiV1 } = await import("../public/js/api.js");
    for (const p of ["/api/politicians", "/api/methodology", "/api/tip-categories", "/api/orgs", "/api/scorecards"]) {
      const res = await fetch(srv.baseUrl + toApiV1(p));
      assert.equal(res.status, 200, `${toApiV1(p)} must be served`);
    }
  });
});

describe("rate limiting is active on the v1 prefix", () => {
  // The admin limiter is mounted at "/api/admin" and counts only failed auth,
  // so reaching it through /api/v1/admin/... proves a mount-prefixed limiter
  // sees the rewritten URL.
  it("the admin brute-force limiter trips through /api/v1/admin/*", async () => {
    let sawTooMany = false;
    for (let i = 0; i < 8; i++) {
      const res = await fetch(srv.baseUrl + "/api/v1/admin/tips", {
        headers: { "x-admin-token": "wrong-token-" + i },
      });
      if (res.status === 429) { sawTooMany = true; break; }
      assert.equal(res.status, 401);
    }
    assert.ok(sawTooMany, "expected a 429 within 8 failed v1 auth attempts (budget is 5)");
  });

  // Runs LAST: it deliberately exhausts the global /api budget for this IP.
  it("the global /api limiter trips through /api/v1/* and shares one budget", async () => {
    let sawTooMany = false;
    let body = null;
    for (let i = 0; i < 400; i++) {
      const res = await fetch(srv.baseUrl + "/api/v1/parameters");
      if (res.status === 429) { sawTooMany = true; body = await res.json(); break; }
      assert.equal(res.status, 200);
    }
    assert.ok(sawTooMany, "expected the global limiter to trip on the v1 prefix");
    assert.equal(body.error, "rate limited");

    // One shared counter: the unversioned alias is throttled too, so v1 is not
    // an escape hatch from the limit (and vice versa).
    const alias = await fetch(srv.baseUrl + "/api/parameters");
    assert.equal(alias.status, 429);
  });
});
