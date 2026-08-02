// Store roundtrip + evidence dedup/upgrade. Runs against a throwaway SQLite DB
// in the OS temp dir — never the real data/pandoros.db, never the network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// store.js reads PANDOROS_DB_PATH at import time, so set it BEFORE importing.
const DB_PATH = path.join(os.tmpdir(), `pandoros-test-store-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const store = await import("../server/store/store.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("upsertPolitician roundtrips via getPolitician and findPolitician", () => {
  const saved = store.upsertPolitician({
    name: "Test Rep", constituency: "Testville", state: "TestState", office: "MP",
  });
  assert.ok(saved.id, "upsert returns an id");

  const byId = store.getPolitician(saved.id);
  assert.equal(byId.name, "Test Rep");
  assert.equal(byId.constituency, "Testville");

  // findPolitician resolves by id and by case-insensitive name (is_demo = 0).
  assert.equal(store.findPolitician(saved.id).id, saved.id);
  assert.equal(store.findPolitician("test rep").id, saved.id);
});

test("addEvidence dedups on (politician_id,url) and upgrades pointer -> content in place", () => {
  const p = store.upsertPolitician({ name: "Evidence Rep", constituency: "Evtown" });
  const url = "https://example.gov/record/1";

  // 1. First insert: a bare pointer (no content).
  const first = store.addEvidence([{ politician_id: p.id, url, date: "2024-01-01" }]);
  assert.equal(first.length, 1);
  assert.equal(store.listEvidence(p.id).length, 1);

  // 2. Same (politician_id,url), still no content -> deduped, nothing added.
  const dup = store.addEvidence([{ politician_id: p.id, url, date: "2024-01-01" }]);
  assert.equal(dup.length, 0, "duplicate pointer is not re-added");
  assert.equal(store.listEvidence(p.id).length, 1, "still a single row");

  // 3. Same url but now carrying real content -> upgrade in place (content beats
  //    pointer). One row, now with content.
  const upgraded = store.addEvidence([{ politician_id: p.id, url, content: "real body text" }]);
  assert.equal(upgraded.length, 1, "content upgrade is applied");
  const rows = store.listEvidence(p.id);
  assert.equal(rows.length, 1, "upgrade merges in place, no new row");
  assert.equal(rows[0].content, "real body text");
});
