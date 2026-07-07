// Job-queue + worker tests. Temp SQLite DB via PANDOROS_DB_PATH — no network,
// no LLM. Handler dispatch is exercised with a FAKE handler map so the real
// ingest/generate/discover functions are never invoked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-jobs-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;

const store = await import("../server/store.js");
const worker = await import("../server/worker.js");
const scheduler = await import("../server/scheduler.js");
const {
  enqueueJob, claimNextJob, completeJob, failJob, getJob, deleteAllJobs,
} = store;

test.beforeEach(() => deleteAllJobs());

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("enqueue -> claim -> complete lifecycle", () => {
  const { id: jid, deduped } = enqueueJob({ type: "life", payload: { a: 1 } });
  assert.equal(deduped, false);
  assert.equal(getJob(jid).status, "queued");

  const job = claimNextJob();
  assert.equal(job.id, jid);
  assert.equal(job.status, "running");
  assert.equal(job.attempts, 1, "attempts incremented at claim");
  assert.deepEqual(job.payload, { a: 1 }, "payload is parsed back to an object");
  assert.ok(job.started_at, "started_at stamped");

  completeJob(jid);
  const done = getJob(jid);
  assert.equal(done.status, "done");
  assert.ok(done.finished_at);
});

test("failJob requeues with exponential backoff run_at = now + 60000 * 2**attempts", () => {
  const { id: jid } = enqueueJob({ type: "boff", payload: {}, maxAttempts: 5 });
  claimNextJob(); // attempts -> 1

  const before = Date.now();
  const r = failJob(jid, new Error("boom"));
  assert.equal(r.status, "queued");

  const j = getJob(jid);
  assert.equal(j.status, "queued");
  assert.equal(j.attempts, 1);
  const delay = j.run_at - before;
  // 60000 * 2**1 = 120000, allow a little slack for wall-clock drift.
  assert.ok(delay >= 120_000 - 100 && delay <= 120_000 + 2000, `backoff delay was ${delay}ms`);
  assert.match(j.last_error, /boom/);
  assert.equal(j.started_at, null, "started_at cleared on requeue");
});

test("failJob dead-letters once attempts reach max_attempts", () => {
  const { id: jid } = enqueueJob({ type: "dead", payload: {}, maxAttempts: 2 });

  claimNextJob();                 // attempts -> 1
  const r1 = failJob(jid, "e1");  // 1 < 2 -> requeue
  assert.equal(r1.status, "queued");

  // Claim again with a future clock so the backed-off job is due.
  const job2 = claimNextJob(Date.now() + 3600_000); // attempts -> 2
  assert.equal(job2.id, jid);
  const r2 = failJob(jid, "e2");  // 2 >= 2 -> dead
  assert.equal(r2.status, "dead");

  const j = getJob(jid);
  assert.equal(j.status, "dead");
  assert.ok(j.finished_at);
  assert.match(j.last_error, /e2/);
});

test("claim atomicity: two sequential claims never return the same job", () => {
  enqueueJob({ type: "atom", payload: { n: 1 } });
  const a = claimNextJob();
  const b = claimNextJob();
  assert.ok(a, "first claim gets the only job");
  assert.equal(b, null, "second claim gets nothing (job already running)");

  enqueueJob({ type: "atom", payload: { n: 2 } });
  enqueueJob({ type: "atom", payload: { n: 3 } });
  const c = claimNextJob();
  const d = claimNextJob();
  assert.ok(c && d);
  assert.notEqual(c.id, d.id, "each claim gets a distinct job");
});

test("enqueue dedups identical queued/running jobs", () => {
  const first = enqueueJob({ type: "dup", payload: { x: 1 } });
  const again = enqueueJob({ type: "dup", payload: { x: 1 } });
  assert.equal(first.deduped, false);
  assert.equal(again.deduped, true);
  assert.equal(again.id, first.id, "dedup returns the existing job id");

  // Different payload is a different job.
  const other = enqueueJob({ type: "dup", payload: { x: 2 } });
  assert.equal(other.deduped, false);

  // A RUNNING job of the same shape still dedups.
  claimNextJob(); // claims the x:1 job (oldest) -> running
  const whileRunning = enqueueJob({ type: "dup", payload: { x: 1 } });
  assert.equal(whileRunning.deduped, true);
});

test("worker dispatches by type to a handler and marks the job done", async () => {
  const calls = [];
  const handlers = {
    test_echo: async (payload, job) => { calls.push({ payload, id: job.id }); return { echoed: payload }; },
  };
  const { id: jid } = enqueueJob({ type: "test_echo", payload: { hi: 1 } });
  const job = claimNextJob();
  assert.equal(job.type, "test_echo");

  const res = await worker.runJob(job, handlers);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, "the fake handler ran exactly once");
  assert.deepEqual(calls[0].payload, { hi: 1 });
  assert.equal(getJob(jid).status, "done");
});

test("worker fails/dead-letters a job whose type has no handler", async () => {
  const { id: jid } = enqueueJob({ type: "no_such_type", payload: {}, maxAttempts: 1 });
  const job = claimNextJob(); // attempts -> 1
  const res = await worker.runJob(job, {}); // empty handler map
  assert.equal(res.ok, false);
  // attempts(1) >= max_attempts(1) -> dead
  assert.equal(getJob(jid).status, "dead");
});

test("scheduler enqueues on first tick and respects everyMs spacing", () => {
  const sched = [{ type: "sched_demo", payload: {}, everyMs: 1000 }];
  const now = 1_000_000_000;
  assert.deepEqual(scheduler.tickScheduler(now, sched), ["sched_demo"], "fires on first tick");
  assert.deepEqual(scheduler.tickScheduler(now + 500, sched), [], "within everyMs -> nothing");
  assert.deepEqual(scheduler.tickScheduler(now + 2000, sched), ["sched_demo"], "past everyMs -> fires again");
});
