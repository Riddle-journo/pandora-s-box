// L1 cache memoisation.
//
// l1Read is called once per L1 source PER POLITICIAN. The live cache is 106
// files totalling 124 MB (largest 37 MB), so a full-roster ingest re-read and
// re-parsed all of it for every one of 4,559 people. Measured on the real
// cache: 1,038 ms per pass cold, 10 ms memoised — about 50 minutes of pure
// JSON parsing saved across the 2,931 politicians who have never been ingested,
// every time a full run happens.
//
// The correctness property that matters is staleness: refreshL1Caches rewrites
// these files DURING a run, and serving a memoised copy of a cache that has
// since been refreshed would silently ingest against stale source data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_DIR = path.join(os.tmpdir(), `pandoros-l1memo-${process.pid}`);
fs.mkdirSync(CACHE_DIR, { recursive: true });
process.env.L1_CACHE_DIR = CACHE_DIR;
process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-l1memo-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const { l1Read, l1MemoClear, l1MemoStats } = await import("../server/orchestration/ingest.js");

test.after(() => {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const write = (id, obj) => fs.writeFileSync(path.join(CACHE_DIR, `${id}.json`), JSON.stringify(obj));

test("a second read returns the identical parsed object, not a re-parse", () => {
  l1MemoClear();
  write("memo-basic", { rows: [{ a: 1 }] });
  const first = l1Read("memo-basic");
  const second = l1Read("memo-basic");
  assert.deepEqual(first, { rows: [{ a: 1 }] });
  assert.equal(first, second, "same object identity — proof it was not parsed twice");
  assert.equal(l1MemoStats().entries, 1);
});

test("REGRESSION: a cache rewritten mid-run is re-read, never served stale", () => {
  // refreshL1Caches rewrites these files during a run. Serving the memoised
  // copy would ingest every politician after the refresh against stale data —
  // silently, which is the worst kind.
  l1MemoClear();
  write("memo-stale", { rows: [{ v: "old" }] });
  assert.deepEqual(l1Read("memo-stale"), { rows: [{ v: "old" }] });

  // Rewrite with different content AND a different size, and force a distinct
  // mtime (a same-millisecond rewrite is otherwise indistinguishable).
  write("memo-stale", { rows: [{ v: "new-and-longer" }] });
  const f = path.join(CACHE_DIR, "memo-stale.json");
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);

  assert.deepEqual(l1Read("memo-stale"), { rows: [{ v: "new-and-longer" }] },
    "the refreshed cache must win");
});

test("a missing cache is null and is not memoised as one", () => {
  l1MemoClear();
  assert.equal(l1Read("memo-does-not-exist"), null);
  assert.equal(l1MemoStats().entries, 0, "absence is not a cached value — the file may appear mid-run");
  write("memo-does-not-exist", { rows: [] });
  assert.deepEqual(l1Read("memo-does-not-exist"), { rows: [] });
});

test("a corrupt cache is a miss, and stays a miss without poisoning the memo", () => {
  l1MemoClear();
  fs.writeFileSync(path.join(CACHE_DIR, "memo-corrupt.json"), "{ not json");
  assert.equal(l1Read("memo-corrupt"), null);
  assert.equal(l1Read("memo-corrupt"), null, "still a miss on the second call");
  assert.equal(l1MemoStats().entries, 0);
});

test("the memo is bounded and evicts least-recently-used", () => {
  l1MemoClear();
  const budget = l1MemoStats().budget;
  assert.ok(budget > 0, "there is an explicit byte budget, not unbounded growth");

  // Enough distinct entries to prove accounting tracks, without allocating a
  // budget's worth of memory in a unit test.
  for (let i = 0; i < 20; i++) write(`memo-many-${i}`, { rows: [{ i, pad: "x".repeat(500) }] });
  for (let i = 0; i < 20; i++) l1Read(`memo-many-${i}`);
  const st = l1MemoStats();
  assert.equal(st.entries, 20);
  assert.ok(st.bytes > 0 && st.bytes <= st.budget, "cached bytes stay inside the budget");
});

test("l1MemoClear releases everything", () => {
  write("memo-clear", { rows: [1] });
  l1Read("memo-clear");
  assert.ok(l1MemoStats().entries >= 1);
  l1MemoClear();
  assert.equal(l1MemoStats().entries, 0);
  assert.equal(l1MemoStats().bytes, 0);
});
