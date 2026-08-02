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
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const store = await import("../server/store/store.js");
const worker = await import("../server/orchestration/worker.js");
const scheduler = await import("../server/orchestration/scheduler.js");
const {
  enqueueJob, claimNextJob, completeJob, failJob, getJob, deleteAllJobs,
  cancelJob, updateJob, requeueJob, trimJobs, isQueuePaused, setQueuePaused,
  recordFetchRun, lastFetchByPolitician,
} = store;

test.beforeEach(() => { deleteAllJobs(); setQueuePaused(false); });

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

test("pause flag round-trips and defaults to false", () => {
  assert.equal(isQueuePaused(), false);
  setQueuePaused(true);
  assert.equal(isQueuePaused(), true);
  setQueuePaused(false);
  assert.equal(isQueuePaused(), false);
});

test("cancelJob deletes a queued job but refuses a running one", () => {
  const { id: jid } = enqueueJob({ type: "cancel_me", payload: {} });
  const r = cancelJob(jid);
  assert.equal(r.ok, true);
  assert.equal(getJob(jid), null, "queued job is gone");

  const { id: rid } = enqueueJob({ type: "cancel_running", payload: {} });
  claimNextJob(); // -> running
  const r2 = cancelJob(rid);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "running");
  assert.equal(getJob(rid).status, "running", "running job untouched");

  assert.equal(cancelJob("nope").ok, false, "missing job -> ok:false");
});

test("updateJob edits priority/run_at/payload of a queued job only", () => {
  const { id: jid } = enqueueJob({ type: "edit_me", payload: { a: 1 }, priority: 0 });
  const r = updateJob(jid, { priority: 5, payload: { a: 2, b: 3 } });
  assert.equal(r.ok, true);
  const j = getJob(jid);
  assert.equal(j.priority, 5);
  assert.deepEqual(j.payload, { a: 2, b: 3 }, "payload fully replaced");

  claimNextJob(); // -> running
  const r2 = updateJob(jid, { priority: 9 });
  assert.equal(r2.ok, false, "running job is not editable");
  assert.match(r2.reason, /running/);
});

test("requeueJob re-runs a done/dead job and refuses a queued one", () => {
  const { id: jid } = enqueueJob({ type: "rerun_me", payload: {}, maxAttempts: 1 });
  claimNextJob();
  completeJob(jid);
  assert.equal(getJob(jid).status, "done");

  const r = requeueJob(jid);
  assert.equal(r.ok, true);
  const j = getJob(jid);
  assert.equal(j.status, "queued");
  assert.equal(j.attempts, 0, "attempts reset");
  assert.equal(j.last_error, null);
  assert.equal(j.finished_at, null);

  assert.equal(requeueJob(jid).ok, false, "already-queued job can't be re-run");
});

test("trimJobs bulk-deletes by status but never touches running", () => {
  const a = enqueueJob({ type: "t", payload: { n: 1 } });
  const b = enqueueJob({ type: "t", payload: { n: 2 } });
  claimNextJob(); completeJob(a.id);   // a -> done
  const running = enqueueJob({ type: "t", payload: { n: 3 } });
  claimNextJob(); // b -> running (oldest queued); actually claims b

  const deletedDone = trimJobs({ status: "done" });
  assert.equal(deletedDone, 1, "only the done job removed");
  assert.equal(getJob(a.id), null);

  // A blanket trim still spares whatever is running.
  const before = store.listJobs({ status: "running" }).length;
  trimJobs({});
  assert.equal(store.listJobs({ status: "running" }).length, before, "running survived a blanket trim");
});

test("lastFetchByPolitician maps id -> most-recent fetch_run timestamp", () => {
  recordFetchRun({ source: "s1", politician_id: "p1", ok: 1, at: 1000 });
  recordFetchRun({ source: "s2", politician_id: "p1", ok: 1, at: 5000 });
  recordFetchRun({ source: "s1", politician_id: "p2", ok: 0, at: 2000 });
  const m = lastFetchByPolitician();
  assert.equal(m.get("p1"), 5000, "takes the MAX per rep");
  assert.equal(m.get("p2"), 2000);
  assert.equal(m.has("p3"), false, "never-fetched rep is absent (always-due for incremental)");
});

test("scheduler enqueues on first tick and respects everyMs spacing", () => {
  const sched = [{ type: "sched_demo", payload: {}, everyMs: 1000 }];
  const now = 1_000_000_000;
  assert.deepEqual(scheduler.tickScheduler(now, sched), ["sched_demo"], "fires on first tick");
  assert.deepEqual(scheduler.tickScheduler(now + 500, sched), [], "within everyMs -> nothing");
  assert.deepEqual(scheduler.tickScheduler(now + 2000, sched), ["sched_demo"], "past everyMs -> fires again");
});
