// DB-maintenance toolkit tests. Temp SQLite DB via PANDOROS_DB_PATH — no network,
// no LLM. Proves the robustness tooling itself is robust: orphan detection finds
// dangling references, integrity passes on a clean file, and rotating backups
// write a valid copy and prune to the keep-count.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-dbmaint-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
// Clear any leftover from a prior PID-reused run before the store opens it (the
// Windows handle-release gotcha the other suites document).
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const store = await import("../server/store/store.js");
const maint = await import("../server/platform/db-maintenance.js");
const { db } = store;

test.after(() => {
  try { db.close(); } catch {}
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }
  try { fs.rmSync(path.join(path.dirname(DB_PATH), "backups"), { recursive: true, force: true }); } catch {}
});

test("check() is clean on an empty, well-formed DB", () => {
  const r = maint.check();
  assert.equal(r.integrityOk, true);
  assert.equal(r.totalOrphans, 0);
  assert.equal(r.ok, true);
});

test("check() detects an orphaned evidence row (dangling politician_id)", () => {
  // Insert evidence pointing at a politician id that does not exist.
  db.prepare(`INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data)
    VALUES ('ev-orphan', 'no-such-pol', 'http://x', '', 0, '', '{}')`).run();
  const r = maint.check();
  const ev = r.orphans.find((o) => o.name === "evidence→politician");
  assert.equal(ev.count, 1, "orphaned evidence row should be counted");
  assert.equal(r.ok, false);
  // Cleaning it up returns the report to green.
  db.prepare("DELETE FROM evidence WHERE id = 'ev-orphan'").run();
  assert.equal(maint.check().ok, true);
});

test("check() detects an orphaned fact (dangling entity_id)", () => {
  db.prepare(`INSERT INTO facts (id, entity_id, subject_kind, metric, value, created_at)
    VALUES ('f-orphan', 'no-such-entity', 'person', 'net_worth', 1, '')`).run();
  const r = maint.check();
  assert.equal(r.orphans.find((o) => o.name === "facts→entity").count, 1);
  db.prepare("DELETE FROM facts WHERE id = 'f-orphan'").run();
});

test("backup() writes a valid copy and prunes to keep-count", async () => {
  const { default: Database } = await import("better-sqlite3");
  // Three backups, keep=2 → newest 2 survive, oldest pruned.
  let last;
  for (let i = 0; i < 3; i++) {
    last = maint.backup({ keep: 2, quiet: true });
    // Distinct mtimes so prune ordering is deterministic on fast filesystems.
    const past = Date.now() / 1000 - (3 - i) * 100;
    fs.utimesSync(last.dest, past, past);
  }
  const dir = path.join(path.dirname(DB_PATH), "backups");
  const files = fs.readdirSync(dir).filter((n) => /^pandoros-.*\.db$/.test(n));
  assert.equal(files.length, 2, "should keep exactly 2 backups");

  // The copy is a readable SQLite DB with the same schema.
  const copy = new Database(last.dest, { readonly: true });
  const hasPoliticians = copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='politicians'").get();
  assert.ok(hasPoliticians, "backup should contain the politicians table");
  copy.close();
});

test("optionalDatasets() reports the free Tofler director system, never the dead MCA bulk path", async () => {
  const checks = await maint.optionalDatasets();
  // The director-name posture must be the free Tofler one, always ok, and must
  // NOT recommend an MCA bulk download (that dataset is not freely available).
  const dir = checks.find((c) => c.id === "director_names");
  assert.ok(dir, "should include a director_names check");
  assert.equal(dir.ok, true, "the free Tofler system is always available");
  assert.match(dir.detail, /Tofler/);
  // Regression guard: nothing here should ever point at mca-index / the bulk download.
  for (const c of checks) assert.ok(!/mca-index|--download/.test(c.fix ?? ""), `${c.id} must not recommend the dead MCA download`);
  assert.equal(checks.find((c) => c.id === "mca_directors"), undefined, "the old mca_directors dataset check is gone");
});
