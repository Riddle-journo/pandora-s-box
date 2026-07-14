// Response-header pins: gzip compression is active for compressible payloads,
// and the hand-rolled security headers survive middleware changes.
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

describe("compression + security headers", () => {
  it("large JSON response is gzipped when the client accepts it", async () => {
    // /api/methodology is a static, comfortably-compressible JSON payload.
    const res = await fetch(srv.baseUrl + "/api/methodology", {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), "gzip");
    // body still parses (undici transparently decompresses)
    await res.json();
  });

  it("client without Accept-Encoding gets an uncompressed body", async () => {
    const res = await fetch(srv.baseUrl + "/api/methodology", {
      headers: { "Accept-Encoding": "identity" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), null);
    await res.json();
  });

  it("security headers are present on API responses", async () => {
    const res = await fetch(srv.baseUrl + "/api/parameters");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });
});
