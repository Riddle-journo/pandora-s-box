// Evidence uniqueness migration: pre-seed an OLD-schema DB containing duplicate
// (politician_id, url) rows, then import the store — its boot migration must
// dedupe (keeping the best row: has_content DESC, fetched_at DESC, rowid DESC),
// drop idx_ev_dupe, and enforce UNIQUE idx_ev_uniq. Also proves addEvidence
// still upgrades in place afterward.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-evuniq-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch {}
}

// ---- Seed an old-shape DB (pre-unique-index) with duplicates, then close it.
{
  const raw = new Database(DB_PATH);
  raw.exec(`
    CREATE TABLE evidence (
      id TEXT PRIMARY KEY, politician_id TEXT, url TEXT, date TEXT,
      has_content INTEGER DEFAULT 0, fetched_at TEXT, data TEXT
    );
    CREATE INDEX idx_ev_dupe ON evidence(politician_id, url);
  `);
  const ins = raw.prepare(
    "INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)");
  // Pair 1: content-less newer row vs content-bearing older row → content wins.
  ins.run("e1", "p1", "https://x.test/a", "", 0, "2026-07-10T00:00:00Z", JSON.stringify({ id: "e1" }));
  ins.run("e2", "p1", "https://x.test/a", "", 1, "2026-07-01T00:00:00Z", JSON.stringify({ id: "e2", content: "full text" }));
  // Pair 2: same has_content → newest fetched_at wins.
  ins.run("e3", "p1", "https://x.test/b", "", 1, "2026-07-01T00:00:00Z", JSON.stringify({ id: "e3", content: "old" }));
  ins.run("e4", "p1", "https://x.test/b", "", 1, "2026-07-09T00:00:00Z", JSON.stringify({ id: "e4", content: "new" }));
  // Same url for a DIFFERENT politician → not a duplicate, must survive.
  ins.run("e5", "p2", "https://x.test/a", "", 0, "2026-07-05T00:00:00Z", JSON.stringify({ id: "e5" }));
  // NULL urls are never deduped.
  ins.run("e6", "p1", null, "", 0, "2026-07-05T00:00:00Z", JSON.stringify({ id: "e6" }));
  ins.run("e7", "p1", null, "", 0, "2026-07-06T00:00:00Z", JSON.stringify({ id: "e7" }));
  raw.close();
}

const store = await import("../server/store.js");
const { db } = await import("../server/store/db.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("migration dedupes keeping has_content DESC, then newest fetched_at", () => {
  const ids = db.prepare("SELECT id FROM evidence ORDER BY id").all().map((r) => r.id);
  assert.ok(ids.includes("e2"), "content-bearing row survives pair 1");
  assert.ok(!ids.includes("e1"), "content-less duplicate dropped");
  assert.ok(ids.includes("e4"), "newest row survives pair 2");
  assert.ok(!ids.includes("e3"), "older duplicate dropped");
  assert.ok(ids.includes("e5"), "same url under another politician untouched");
  assert.ok(ids.includes("e6") && ids.includes("e7"), "NULL-url rows never deduped");
});

test("unique index exists and old non-unique index is gone", () => {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='evidence'").all()
    .map((r) => r.name);
  assert.ok(idx.includes("idx_ev_uniq"), "idx_ev_uniq created");
  assert.ok(!idx.includes("idx_ev_dupe"), "idx_ev_dupe dropped");
  const uniq = db.prepare("PRAGMA index_info(idx_ev_uniq)").all().map((c) => c.name);
  assert.deepEqual(uniq, ["politician_id", "url"]);
});

test("duplicate (politician_id, url) can no longer exist", () => {
  const dupes = db.prepare(`SELECT politician_id, url, COUNT(*) c FROM evidence
    WHERE url IS NOT NULL GROUP BY politician_id, url HAVING c > 1`).all();
  assert.deepEqual(dupes, []);
});

test("addEvidence still dedups and upgrades in place after the migration", () => {
  const added1 = store.addEvidence([{ politician_id: "p9", url: "https://x.test/c", title: "bare" }]);
  assert.equal(added1.length, 1);
  // Same url, no new content → merge path, nothing added.
  const added2 = store.addEvidence([{ politician_id: "p9", url: "https://x.test/c", title: "bare again" }]);
  assert.equal(added2.length, 0);
  // Same url WITH content → upgrade in place, still one row.
  const added3 = store.addEvidence([{ politician_id: "p9", url: "https://x.test/c", title: "rich", content: "body" }]);
  assert.equal(added3.length, 1);
  const rows = db.prepare("SELECT has_content FROM evidence WHERE politician_id='p9' AND url='https://x.test/c'").all();
  assert.equal(rows.length, 1, "still exactly one row");
  assert.equal(rows[0].has_content, 1, "upgraded to content-bearing");
});
