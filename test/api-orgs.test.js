// Phase C (org entities) — /api/orgs directory + /api/orgs/:key/card routes,
// and /api/ministries back-compat, via the integration harness.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";

let srv;

before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });

describe("orgs API", () => {
  it("GET /api/orgs -> 200, array, well-formed entries", async () => {
    const res = await fetch(srv.baseUrl + "/api/orgs");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body) && body.length >= 200);
    const o = body[0];
    for (const k of ["key", "kind", "scope", "name", "sectors", "failures", "evidence_mentions"]) assert.ok(k in o, k);
  });

  it("GET /api/orgs?kind=psu filters to PSUs only", async () => {
    const res = await fetch(srv.baseUrl + "/api/orgs?kind=psu");
    const body = await res.json();
    assert.ok(body.length > 10);
    assert.ok(body.every((o) => o.kind === "psu"));
  });

  it("GET /api/orgs?state=Karnataka filters by scope", async () => {
    const body = await (await fetch(srv.baseUrl + "/api/orgs?state=Karnataka")).json();
    assert.ok(body.length > 0);
    assert.ok(body.every((o) => o.scope === "Karnataka"));
  });

  it("GET /api/orgs?q=sebi finds SEBI", async () => {
    const body = await (await fetch(srv.baseUrl + "/api/orgs?q=sebi")).json();
    assert.ok(body.some((o) => o.key === "regulator/sebi"));
  });

  it("GET /api/orgs/union/finance/card -> 200 with overview + structure", async () => {
    const res = await fetch(srv.baseUrl + "/api/orgs/union/finance/card");
    assert.equal(res.status, 200);
    const card = await res.json();
    assert.equal(card.kind, "ministry");
    assert.equal(card.subject_key, "union/finance");
    assert.equal(card.name, "Ministry of Finance");
    assert.ok(Array.isArray(card.sections));
    assert.equal(card.sections[0].key, "overview");
    const children = card.sections.find((s) => s.key === "children");
    assert.ok(children && children.orgs.some((o) => o.key === "psu/sbi"));
  });

  it("GET /api/orgs/psu/nhai/card -> 200 with parent breadcrumb", async () => {
    const card = await (await fetch(srv.baseUrl + "/api/orgs/psu/nhai/card")).json();
    assert.equal(card.kind, "psu");
    assert.equal(card.parent.key, "union/road-transport");
  });

  it("GET /api/orgs/junk/card -> 404", async () => {
    const res = await fetch(srv.baseUrl + "/api/orgs/junk/nope/card");
    assert.equal(res.status, 404);
  });

  it("back-compat: GET /api/ministries and /api/ministries/union/finance/card unchanged shape", async () => {
    const list = await (await fetch(srv.baseUrl + "/api/ministries")).json();
    assert.ok(Array.isArray(list));
    assert.ok(list.some((m) => m.key === "union/finance"));
    const card = await (await fetch(srv.baseUrl + "/api/ministries/union/finance/card")).json();
    assert.equal(card.subject_key, "union/finance");
    assert.equal(card.sections[0].key, "overview");
  });
});
