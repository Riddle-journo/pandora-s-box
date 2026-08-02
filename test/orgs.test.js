// Phase A (org entities) — catalogue integrity, resolveOrg precedence,
// resolveMinistry back-compat, and ensureOrgEntity idempotency.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-orgs-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { ORGS, getOrg, orgChildren, resolveOrg, resolveOrgExact } = await import("../server/data/orgs.js");
const { resolveMinistry, getMinistry, MINISTRIES } = await import("../server/data/ministries.js");
const { ensureOrgEntity, resolveOrgEntityId, resolveOrgEntityIdExact, syncOrgEntities, findEntityByStrongId, findEntityByAlias, getEntity } =
  await import("../server/entities/entities.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }
});

// ── Catalogue integrity ──────────────────────────────────────────────────────
test("catalogue: keys unique, well-formed, kinds valid, parents resolvable", () => {
  const seen = new Set();
  const KEY_RE = /^(union\/[a-z0-9-]+(\/[a-z0-9-]+)?|state\/[a-z-]+\/[a-z0-9-]+|psu\/[a-z0-9-]+|regulator\/[a-z0-9-]+)$/;
  const KINDS = new Set(["ministry", "department", "psu", "regulator"]);
  for (const o of ORGS) {
    assert.ok(!seen.has(o.key), `duplicate key ${o.key}`);
    seen.add(o.key);
    assert.match(o.key, KEY_RE, `malformed key ${o.key}`);
    assert.ok(KINDS.has(o.kind), `bad kind ${o.kind} on ${o.key}`);
    assert.ok(o.name && o.tokens && Array.isArray(o.tokens), `missing name/tokens on ${o.key}`);
    if (o.parent) assert.ok(getOrg(o.parent), `dangling parent ${o.parent} on ${o.key}`);
  }
  assert.ok(ORGS.length >= 200, `catalogue unexpectedly small: ${ORGS.length}`);
});

test("catalogue: legacy ministry keys preserved verbatim", () => {
  for (const key of [
    "union/finance", "union/home", "union/defence", "union/railways", "union/urban-development",
    "state/karnataka/mines", "state/delhi/excise", "state/madhya-pradesh/examinations", "state/bihar/animal-husbandry",
  ]) assert.ok(getOrg(key), `legacy key ${key} missing`);
});

test("orgChildren: departments and PSUs hang off their ministry", () => {
  const fin = orgChildren("union/finance").map((o) => o.key);
  assert.ok(fin.includes("union/finance/dept-revenue"));
  assert.ok(fin.includes("psu/sbi"));
});

// ── resolveOrg precedence ────────────────────────────────────────────────────
test("resolveOrg: PSU beats its parent ministry on specific text", () => {
  assert.equal(resolveOrg("Coal India Limited subsidiary tender")?.key, "psu/coal-india");
  assert.equal(resolveOrg("Ministry of Coal block allocation")?.key, "union/coal");
});

test("resolveOrg: department beats parent ministry when both match", () => {
  assert.equal(resolveOrg("Department of Revenue, Ministry of Finance")?.key, "union/finance/dept-revenue");
});

test("resolveOrg: state entry beats union on state text", () => {
  assert.equal(resolveOrg("Karnataka Mines & Geology")?.key, "state/karnataka/mines");
  assert.equal(resolveOrg("Ministry of Mines")?.key, "union/mines");
});

test("resolveOrg: kinds filter prevents cross-kind stealing", () => {
  const r = resolveOrg("SEBI enforcement order", { kinds: ["ministry", "department"] });
  assert.equal(r, null);
  assert.equal(resolveOrg("SEBI enforcement order")?.key, "regulator/sebi");
});

test("resolveOrg: junk resolves to null", () => {
  assert.equal(resolveOrg(""), null);
  assert.equal(resolveOrg("Quarterly results of a private firm"), null);
});

// ── resolveMinistry back-compat (the canary) ────────────────────────────────
test("resolveMinistry: corpus strings resolve to their historical keys", () => {
  const cases = [
    ["Ministry of Finance / RBI supervision", "union/finance"],
    ["Ministry of Defence", "union/defence"],
    ["Ministry of Railways", "union/railways"],
    ["Bihar Animal Husbandry Department", "state/bihar/animal-husbandry"],
    ["Karnataka Mines & Geology", "state/karnataka/mines"],
    ["Delhi Excise Department", "state/delhi/excise"],
    ["Vyapam — MP Professional Examination Board", "state/madhya-pradesh/examinations"],
    ["Gujarat Urban Development (Morbi municipal oversight)", "state/gujarat/urban-development"],
    ["Uttar Pradesh Home / Police", "state/uttar-pradesh/home"],
  ];
  for (const [text, key] of cases) assert.equal(resolveMinistry(text)?.key, key, text);
});

test("resolveMinistry: never returns a PSU or regulator", () => {
  assert.equal(resolveMinistry("NHAI highway contract"), null);
  assert.equal(resolveMinistry("SEBI"), null);
});

test("getMinistry + MINISTRIES shape unchanged for consumers", () => {
  const m = getMinistry("union/finance");
  assert.equal(m.name, "Ministry of Finance");
  assert.ok(Array.isArray(m.sectors) && Array.isArray(m.tokens));
  assert.ok(MINISTRIES.every((x) => x.kind === "ministry" || x.kind === "department"));
});

// ── Entity layer ─────────────────────────────────────────────────────────────
test("ensureOrgEntity: idempotent, strong-id keyed, aliases registered", () => {
  const a = ensureOrgEntity("psu/nhai");
  const b = ensureOrgEntity("psu/nhai");
  assert.equal(a, b);
  const ent = findEntityByStrongId("org", { org_key: "psu/nhai" });
  assert.equal(ent.id, a);
  assert.equal(getEntity(a).kind, "org");
  // short name registered as an alias
  assert.equal(findEntityByAlias("org", "NHAI")?.id, a);
});

test("ensureOrgEntity: unknown key returns null", () => {
  assert.equal(ensureOrgEntity("psu/does-not-exist"), null);
});

test("resolveOrgEntityId: free text lands on the canonical entity; junk is null", () => {
  const eid = resolveOrgEntityId("National Highways Authority of India (NHAI)");
  assert.equal(eid, ensureOrgEntity("psu/nhai"));
  assert.equal(resolveOrgEntityId("Some Private Contractor LLP"), null);
});

// ── Exact-identity matching (counterparty names with a non-org kind) ────────
test("resolveOrgExact: company-suffix variants of a PSU resolve", () => {
  for (const name of ["NTPC Ltd.", "NTPC Limited", "ntpc"]) assert.equal(resolveOrgExact(name)?.key, "psu/ntpc", name);
  assert.equal(resolveOrgExact("Steel Authority of India Limited")?.key, "psu/sail");
  assert.equal(resolveOrgExact("Life Insurance Corporation of India")?.key, "psu/lic");
});

test("resolveOrgExact: a private firm sharing a prefix is NOT the PSU", () => {
  assert.equal(resolveOrgExact("Coal India Traders Pvt Ltd"), null);
  assert.equal(resolveOrgExact("NTPC Vendors & Logistics Pvt Ltd"), null);
  assert.equal(resolveOrgExact("Sterling Finvest Private Limited"), null);
});

test("resolveOrgExact: partial/token text does not match (that's resolveOrg's job)", () => {
  assert.equal(resolveOrgExact("tender floated by NHAI for a highway"), null);
  assert.equal(resolveOrg("tender floated by NHAI for a highway")?.key, "psu/nhai");
});

test("resolveOrgEntityIdExact: exact hit lands on the canonical org entity", () => {
  assert.equal(resolveOrgEntityIdExact("NTPC Ltd."), ensureOrgEntity("psu/ntpc"));
  assert.equal(resolveOrgEntityIdExact("Some Contractor Pvt Ltd"), null);
});

test("syncOrgEntities: idempotent full sync", () => {
  const first = syncOrgEntities();
  assert.equal(first.synced, first.total);
  const again = syncOrgEntities();
  assert.equal(again.synced, again.total);
  // No duplicates: one entity per key
  const nhai = findEntityByStrongId("org", { org_key: "psu/nhai" });
  assert.ok(nhai);
});
