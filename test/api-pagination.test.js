// Task 7.2 — opt-in pagination. The default (no params) shape must stay a bare
// array (belt-and-braces on top of the api-content golden tests); page/pageSize
// switches to the { items, page, pageSize, total } envelope.
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

const PATHS = ["/api/politicians", "/api/scandals", "/api/issues"];

describe("opt-in pagination", () => {
  it("no params → legacy bare array on all three endpoints", async () => {
    for (const p of PATHS) {
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(await res.json()), `${p} default must stay a bare array`);
    }
  });

  it("page param → envelope with items/page/pageSize/total", async () => {
    for (const p of PATHS) {
      const res = await fetch(srv.baseUrl + p + "?page=1&pageSize=5");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.items), `${p} paginated items`);
      assert.equal(body.page, 1);
      assert.equal(body.pageSize, 5);
      assert.equal(typeof body.total, "number");
      assert.ok(body.items.length <= 5);
    }
  });

  it("pageSize alone also opts in, and is capped at 100", async () => {
    const res = await fetch(srv.baseUrl + "/api/issues?pageSize=9999");
    const body = await res.json();
    assert.equal(body.pageSize, 100);
    assert.equal(body.page, 1);
  });

  it("total is consistent with the unpaginated set", async () => {
    const all = await (await fetch(srv.baseUrl + "/api/issues")).json();
    const paged = await (await fetch(srv.baseUrl + "/api/issues?page=1&pageSize=3")).json();
    assert.equal(paged.total, all.length);
  });

  it("out-of-range page returns an empty items array, not an error", async () => {
    const res = await fetch(srv.baseUrl + "/api/issues?page=99999&pageSize=10");
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.items, []);
  });
});
