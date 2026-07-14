// Jobs domain extracted from store.js. Owns the SQLite-backed job queue table
// and its queue-control helpers. Re-exported through the store.js facade.
// Meta-dependent helpers (isQueuePaused/setQueuePaused) and jobCounts (needs
// the shared `tally` helper) stay in store.js.
import { db } from "./db.js";
import { id } from "./shared.js";

// ---- Jobs (minimal SQLite-backed job queue) ----
// Sequential, single-process worker consumes these. No new deps: claim/complete
// /fail are plain synchronous better-sqlite3 statements; timing lives in worker.js.
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// Enqueue a job. Dedup: skip if an IDENTICAL type+payload job is already queued
// or running (so a re-run of the scheduler/fan-out never piles up duplicates).
/** @param {{ type?: string, payload?: object, runAt?: number, priority?: number, maxAttempts?: number }} job — `type` is required at runtime; optional here only for the `= {}` default */
export function enqueueJob({ type, payload = {}, runAt = Date.now(), priority = 0, maxAttempts = 3 } = {}) {
  const payloadJson = JSON.stringify(payload ?? {});
  const dupe = db.prepare(
    "SELECT id FROM jobs WHERE type = ? AND payload = ? AND status IN ('queued','running') LIMIT 1"
  ).get(type, payloadJson);
  if (dupe) return { id: dupe.id, deduped: true };
  const row = {
    id: id(), type, payload: payloadJson, status: "queued",
    priority: Number(priority) || 0, run_at: Math.round(Number(runAt) || Date.now()),
    attempts: 0, max_attempts: Number(maxAttempts) || 3, last_error: null,
    created_at: new Date().toISOString(), started_at: null, finished_at: null,
  };
  db.prepare(`INSERT INTO jobs
    (id, type, payload, status, priority, run_at, attempts, max_attempts, last_error, created_at, started_at, finished_at)
    VALUES (@id,@type,@payload,@status,@priority,@run_at,@attempts,@max_attempts,@last_error,@created_at,@started_at,@finished_at)`).run(row);
  return { id: row.id, deduped: false };
}

// Atomically flip the single best-eligible queued job to 'running' and return it.
// One UPDATE ... WHERE id = (SELECT ...) RETURNING is atomic in SQLite, so two
// claims (even from concurrent pool lanes) can never hand back the same row.
// excludeTypes lets the worker pool skip job types that are currently at their
// per-type concurrency cap or inside a rate-budget gap, so a saturated type
// never blocks a due job of another type. (Arrays can't be bound directly in
// better-sqlite3 — json_each over a JSON-encoded list is the standard idiom.)
// Back-compat: callable as claimNextJob(), claimNextJob(now), or with options.
const claimStmt = db.prepare(`
  UPDATE jobs SET status = 'running', started_at = @ts, attempts = attempts + 1
  WHERE id = (
    SELECT id FROM jobs WHERE status = 'queued' AND run_at <= @now
      AND type NOT IN (SELECT value FROM json_each(@excluded))
    ORDER BY priority DESC, run_at ASC, created_at ASC LIMIT 1
  )
  RETURNING *`);
/** @param {number | {now?: number, excludeTypes?: string[]}} [arg] @returns {import("./types.js").Job | null} */
export function claimNextJob(arg) {
  const { now = Date.now(), excludeTypes = [] } =
    typeof arg === "number" ? { now: arg } : (arg ?? {});
  const row = claimStmt.get({ ts: new Date().toISOString(), now, excluded: JSON.stringify(excludeTypes) });
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

// Non-mutating look at the next claimable job (worker uses it to gate on rate
// budget before claiming). Same ordering + excludeTypes filter as claimNextJob.
const peekStmt = db.prepare(`
  SELECT * FROM jobs WHERE status = 'queued' AND run_at <= @now
    AND type NOT IN (SELECT value FROM json_each(@excluded))
  ORDER BY priority DESC, run_at ASC, created_at ASC LIMIT 1`);
export function peekNextJob(arg) {
  const { now = Date.now(), excludeTypes = [] } =
    typeof arg === "number" ? { now: arg } : (arg ?? {});
  const row = peekStmt.get({ now, excluded: JSON.stringify(excludeTypes) });
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

export function completeJob(id) {
  db.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return { id, status: "done" };
}

// Fail a job: requeue with exponential backoff, or dead-letter once its attempts
// have reached max_attempts. attempts is incremented at CLAIM time, so here it
// already reflects the number of tries made.
export function failJob(id, err) {
  const job = db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(id);
  if (!job) return null;
  const msg = String(err?.stack ?? err?.message ?? err ?? "").slice(0, 4000);
  if (job.attempts >= job.max_attempts) {
    db.prepare("UPDATE jobs SET status = 'dead', last_error = ?, finished_at = ? WHERE id = ?")
      .run(msg, new Date().toISOString(), id);
    return { id, status: "dead", attempts: job.attempts };
  }
  const runAt = Date.now() + 60_000 * 2 ** job.attempts;
  db.prepare("UPDATE jobs SET status = 'queued', last_error = ?, run_at = ?, started_at = NULL WHERE id = ?")
    .run(msg, runAt, id);
  return { id, status: "queued", attempts: job.attempts, run_at: runAt };
}

/** @param {string | null} idOrNull @returns {import("./types.js").Job | null} */
export function getJob(idOrNull) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(idOrNull);
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

/** @param {{ status?: string }} [filter] */
export function listJobs({ status } = {}) {
  const rows = status
    ? db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, run_at ASC").all(status)
    : db.prepare("SELECT * FROM jobs ORDER BY priority DESC, run_at ASC").all();
  return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

// Cancel a QUEUED job (delete it). A running job can't be yanked mid-flight from a
// serial worker, so the caller pauses the queue and lets it finish. Returns
// { ok, reason?, status? }.
export function cancelJob(id) {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  if (!job) return { ok: false, reason: "not found" };
  if (job.status === "running") return { ok: false, reason: "running", status: "running" };
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  return { ok: true };
}

// Patch a QUEUED job's priority / run_at / payload — nothing else is editable
// (a running/done/dead job is history). `payload`, when supplied, fully replaces
// the old one. Returns { ok, job? } / { ok:false, reason }.
/**
 * @param {string} id
 * @param {{ priority?: number, payload?: object, runAt?: number }} [patch]
 */
export function updateJob(id, { priority, payload, runAt } = {}) {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  if (!job) return { ok: false, reason: "not found" };
  if (job.status !== "queued") return { ok: false, reason: `not editable (${job.status})` };
  const sets = [], vals = { id };
  if (priority !== undefined) { sets.push("priority = @priority"); vals.priority = Number(priority) || 0; }
  if (runAt !== undefined)    { sets.push("run_at = @run_at");     vals.run_at = Math.round(Number(runAt) || Date.now()); }
  if (payload !== undefined)  { sets.push("payload = @payload");   vals.payload = JSON.stringify(payload ?? {}); }
  if (sets.length) db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  return { ok: true, job: getJob(id) };
}

// Re-run a finished/dead/failed job: reset it to queued, clear attempts + error,
// make it due now. Refuses jobs still queued/running (nothing to re-run yet).
export function requeueJob(id) {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  if (!job) return { ok: false, reason: "not found" };
  if (job.status === "queued" || job.status === "running") return { ok: false, reason: `already ${job.status}` };
  db.prepare(`UPDATE jobs SET status = 'queued', attempts = 0, last_error = NULL,
      run_at = @now, started_at = NULL, finished_at = NULL WHERE id = @id`).run({ id, now: Date.now() });
  return { ok: true, job: getJob(id) };
}

// Reset orphaned 'running' jobs back to 'queued'. A serial worker processes one
// job at a time, so a 'running' row with no live worker is a zombie left by a
// crash or restart mid-job. olderThanMs>0 reclaims only jobs whose started_at is
// older than the cutoff, so a MANUAL reclaim while a worker is live won't yank the
// job it's actively running; the worker itself calls this with 0 at boot, when it
// is the sole consumer and nothing of its own can be running yet. attempts is
// preserved (not reset), so a job that keeps zombie-ing still dead-letters. Returns
// the count reclaimed.
export function reclaimRunningJobs({ olderThanMs = 0 } = {}) {
  if (olderThanMs > 0) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return db.prepare(
      "UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)")
      .run(cutoff).changes;
  }
  return db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run().changes;
}

// Bulk-trim jobs. Filter by status and/or type; olderThanMs drops only jobs
// created before the cutoff. RUNNING jobs are NEVER trimmed. Returns count deleted.
/** @param {{ status?: string, type?: string, olderThanMs?: number }} [filter] */
export function trimJobs({ status, type, olderThanMs } = {}) {
  const where = ["status != 'running'"], vals = {};
  if (status) { where.push("status = @status"); vals.status = status; }
  if (type)   { where.push("type = @type");     vals.type = type; }
  if (olderThanMs != null) {
    where.push("created_at < @cutoff");
    vals.cutoff = new Date(Date.now() - Number(olderThanMs)).toISOString();
  }
  return db.prepare(`DELETE FROM jobs WHERE ${where.join(" AND ")}`).run(vals).changes;
}

export function deleteAllJobs() {
  return db.prepare("DELETE FROM jobs").run().changes;
}
