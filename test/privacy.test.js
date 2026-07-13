// Investigator-privacy invariants, enforced at the source level (no server
// boot needed): the public API surface in server/index.js must not expose
// conflicts or stories, and every /api/admin route must be requireAdmin-gated.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");

test("no public conflicts or stories routes exist", () => {
  assert.ok(!/app\.get\("\/api\/conflicts"/.test(src), "no GET /api/conflicts");
  assert.ok(!/app\.get\("\/api\/politicians\/:id\/conflicts"/.test(src), "no per-rep conflicts route");
  assert.ok(!/app\.get\("\/api\/stories"/.test(src), "no GET /api/stories");
  assert.ok(!/app\.get\("\/api\/stories\/:slug"/.test(src), "no GET /api/stories/:slug");
});

test("every /api/admin route is requireAdmin-gated", () => {
  const adminRoutes = [...src.matchAll(/app\.(get|post)\("(\/api\/admin[^"]*)",\s*([A-Za-z]+)/g)];
  assert.ok(adminRoutes.length >= 10, "admin routes found");
  for (const [, , route, middleware] of adminRoutes) {
    assert.equal(middleware, "requireAdmin", `${route} is gated`);
  }
});

test("investigation leads are only reachable under /api/admin", () => {
  const leadRoutes = [...src.matchAll(/app\.(get|post)\("([^"]*(?:conflicts|investigation-leads|stories)[^"]*)"/g)]
    .map((m) => m[2]);
  for (const r of leadRoutes) assert.ok(r.startsWith("/api/admin/"), `${r} is admin-only`);
});
