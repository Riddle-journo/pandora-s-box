// Investigator-privacy invariants, enforced at the HTTP level against a real
// running server: conflicts and stories must never be public, and the entire
// /api/admin surface must be token-gated (no x-admin-token -> 401).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";

let server;

test.before(async () => {
  server = await startTestServer();
});

test.after(async () => {
  await server.close();
});

test("no public conflicts or stories routes exist", async () => {
  const paths = [
    "/api/conflicts",
    "/api/politicians/x/conflicts",
    "/api/stories",
    "/api/stories/some-slug",
  ];
  for (const p of paths) {
    const res = await fetch(server.baseUrl + p);
    assert.equal(res.status, 404, `${p} is not public`);
  }
});

test("every /api/admin route is requireAdmin-gated", async () => {
  const adminRoutes = [
    "/api/admin/tips",
    "/api/admin/scandal-proposals",
    "/api/admin/investigation-leads",
    "/api/admin/conflicts",
    "/api/admin/stories",
    "/api/admin/ops/summary",
    "/api/admin/ops/roster",
    "/api/admin/ops/jobs",
    "/api/admin/ops/engine",
    "/api/admin/ops/flags",
    "/api/admin/ops/leads",
    "/api/admin/ops/queue",
    "/api/admin/ops/precision",
  ];
  for (const route of adminRoutes) {
    const res = await fetch(server.baseUrl + route);
    assert.equal(res.status, 401, `${route} requires admin token`);
  }
});

test("investigation leads are only reachable under /api/admin", async () => {
  const paths = [
    "/api/investigation-leads",
    "/api/conflicts",
    "/api/stories",
  ];
  for (const p of paths) {
    const res = await fetch(server.baseUrl + p);
    assert.equal(res.status, 404, `${p} is not reachable outside /api/admin`);
  }
});
