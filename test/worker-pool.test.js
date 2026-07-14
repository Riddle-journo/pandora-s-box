// Concurrency-pool tests: fake handler types with manually-resolved deferreds
// prove REAL parallel execution, per-type caps, the global cap, gap spacing,
// mutex groups, exclusive types, and --once drain semantics. Temp SQLite DB via
// PANDOROS_DB_PATH — no network, no LLM, no real handlers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-pool-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch {}
}

const store = await import("../server/store.js");
const { runPool } = await import("../server/worker.js");
const { sleep } = await import("../server/util/timing.js");
const { enqueueJob, deleteAllJobs, setQueuePaused, listJobs, failJob, claimNextJob } = store;

test.beforeEach(() => { deleteAllJobs(); setQueuePaused(false); });
test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

// A handler whose completion the test controls, recording entry order + the
// number of instances inside the handler at once.
function gate() {
  const g = { entered: [], concurrent: 0, maxConcurrent: 0, release: null, releases: [] };
  g.handler = (name) => async () => {
    g.entered.push(name);
    g.concurrent++;
    g.maxConcurrent = Math.max(g.maxConcurrent, g.concurrent);
    await new Promise((res) => g.releases.push(res));
    g.concurrent--;
    return {};
  };
  g.releaseOne = () => g.releases.shift()?.();
  g.releaseAll = () => { while (g.releases.length) g.releases.shift()(); };
  return g;
}

const cfg = (maxParallel, perType = {}) => () => ({ maxParallel, perType });

test("jobs of one type run in parallel up to the per-type cap", async () => {
  const g = gate();
  const handlers = { fake_a: g.handler("a") };
  enqueueJob({ type: "fake_a", payload: { i: 1 } });
  enqueueJob({ type: "fake_a", payload: { i: 2 } });
  enqueueJob({ type: "fake_a", payload: { i: 3 } });

  const pool = runPool({ handlers, gapMap: {}, pollMs: 10, once: true, getConfig: cfg(4, { fake_a: 2 }) });
  await sleep(150);
  assert.equal(g.concurrent, 2, "exactly 2 of 3 in flight (cap)");
  g.releaseOne();
  await sleep(100);
  assert.equal(g.entered.length, 3, "third started once a lane freed");
  g.releaseAll();
  await sleep(50); g.releaseAll(); // release the late third if needed
  const n = await pool;
  assert.equal(n, 3);
  assert.equal(g.maxConcurrent, 2, "never above the per-type cap");
});

test("a capped type is skipped over — other types keep flowing", async () => {
  const g = gate();
  const handlers = { fake_a: g.handler("a"), fake_b: g.handler("b") };
  enqueueJob({ type: "fake_a", payload: { i: 1 }, priority: 5 }); // highest priority
  enqueueJob({ type: "fake_a", payload: { i: 2 }, priority: 5 }); // capped out
  enqueueJob({ type: "fake_b", payload: { i: 3 }, priority: 0 }); // lower priority, different type

  const pool = runPool({ handlers, gapMap: {}, pollMs: 10, once: true, getConfig: cfg(4, { fake_a: 1 }) });
  await sleep(150);
  assert.deepEqual(g.entered, ["a", "b"], "second fake_a skipped; fake_b claimed instead");
  g.releaseAll();
  await sleep(100); g.releaseAll();
  await pool;
});

test("global maxParallel cap holds across types", async () => {
  const g = gate();
  const handlers = { t1: g.handler("1"), t2: g.handler("2"), t3: g.handler("3") };
  enqueueJob({ type: "t1" }); enqueueJob({ type: "t2" }); enqueueJob({ type: "t3" });

  const pool = runPool({ handlers, gapMap: {}, pollMs: 10, once: true, getConfig: cfg(2, { t1: 2, t2: 2, t3: 2 }) });
  await sleep(150);
  assert.equal(g.concurrent, 2, "only 2 in flight despite 3 types eligible");
  g.releaseAll(); await sleep(100); g.releaseAll();
  await pool;
  assert.equal(g.maxConcurrent, 2);
});

test("MIN_GAP_MS spaces same-type starts; other types run inside the gap", async () => {
  const starts = { g: [], b: [] };
  const handlers = {
    fake_g: async () => { starts.g.push(Date.now()); },
    fake_b: async () => { starts.b.push(Date.now()); },
  };
  enqueueJob({ type: "fake_g", payload: { i: 1 }, priority: 5 });
  enqueueJob({ type: "fake_g", payload: { i: 2 }, priority: 5 });
  enqueueJob({ type: "fake_b", payload: { i: 3 }, priority: 0 });

  await runPool({ handlers, gapMap: { fake_g: 150 }, pollMs: 10, once: true, getConfig: cfg(4) });
  assert.equal(starts.g.length, 2);
  assert.ok(starts.g[1] - starts.g[0] >= 135, `gap respected (${starts.g[1] - starts.g[0]}ms)`);
  assert.ok(starts.b[0] < starts.g[1], "fake_b ran inside fake_g's gap window");
});

test("mutex group: engine-group types never overlap each other, others run beside them", async () => {
  const g = gate();
  const handlers = { engine_scan: g.handler("scan"), investigate_all: g.handler("inv"), ingest_politician: g.handler("ing") };
  enqueueJob({ type: "engine_scan", priority: 5 });
  enqueueJob({ type: "investigate_all", priority: 5 });
  enqueueJob({ type: "ingest_politician", priority: 0 });

  const pool = runPool({ handlers, gapMap: {}, pollMs: 10, once: true, getConfig: cfg(4) });
  await sleep(150);
  assert.ok(g.entered.includes("scan"), "engine_scan started");
  assert.ok(!g.entered.includes("inv"), "investigate_all held back by the mutex group");
  assert.ok(g.entered.includes("ing"), "unrelated ingest ran beside the engine job");
  g.releaseAll();
  await sleep(150);
  assert.ok(g.entered.includes("inv"), "investigate_all ran after the engine job finished");
  g.releaseAll(); await sleep(50); g.releaseAll();
  await pool;
});

test("EXCLUSIVE type runs strictly alone", async () => {
  const g = gate();
  const handlers = { reset_data: g.handler("reset"), fake_b: g.handler("b") };
  enqueueJob({ type: "fake_b", priority: 5 });
  enqueueJob({ type: "reset_data", priority: 5 });
  enqueueJob({ type: "fake_b", payload: { i: 2 }, priority: 5 });

  const pool = runPool({ handlers, gapMap: {}, pollMs: 10, once: true, getConfig: cfg(4, { fake_b: 4 }) });
  await sleep(120);
  // First fake_b in flight → reset_data must NOT be claimed; second fake_b may run.
  assert.ok(!g.entered.includes("reset"), "exclusive job waits for an empty pool");
  assert.equal(g.entered.filter((x) => x === "b").length, 2, "non-exclusive jobs keep flowing");
  g.releaseAll();
  await sleep(120);
  assert.ok(g.entered.includes("reset"), "exclusive job ran once the pool emptied");
  assert.equal(g.concurrent, 1, "runs alone");
  g.releaseAll(); await sleep(50); g.releaseAll();
  await pool;
});

test("--once drains and exits with a backed-off job still queued for the future", async () => {
  const handlers = { ok_job: async () => ({}) };
  enqueueJob({ type: "ok_job" });
  // Manufacture a backed-off job: claim + fail → requeued with future run_at.
  enqueueJob({ type: "will_fail" });
  const j = claimNextJob({ excludeTypes: ["ok_job"] });
  failJob(j.id, new Error("boom")); // attempts 1 < max 3 → queued, run_at ≈ +60s

  const n = await runPool({ handlers, gapMap: {}, pollMs: 10, once: true, getConfig: cfg(4) });
  assert.equal(n, 1, "processed only the due job");
  const queued = listJobs({ status: "queued" });
  assert.equal(queued.length, 1, "backed-off job still queued, not spun on");
});

test("pause: pool claims nothing while paused (non-once mode)", async () => {
  const g = gate();
  const handlers = { fake_a: g.handler("a") };
  setQueuePaused(true);
  enqueueJob({ type: "fake_a" });
  let stop = false;
  const pool = runPool({ handlers, gapMap: {}, pollMs: 10, isStopped: () => stop, getConfig: cfg(4) });
  await sleep(100);
  assert.equal(g.entered.length, 0, "nothing claimed while paused");
  setQueuePaused(false);
  await sleep(100);
  assert.equal(g.entered.length, 1, "claimed after resume");
  g.releaseAll();
  stop = true;
  await pool;
});
