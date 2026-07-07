// Single-process, sequential job worker. Claims ONE job at a time and dispatches
// by type to a handler that CALLS AN EXISTING EXPORTED FUNCTION — it never
// reimplements ingest/report/discovery logic. Concurrency inside a job already
// exists (fetchers use mapLimit), so the worker itself stays deliberately serial:
// simple, predictable, and easy on external endpoints and the LLM budget.
//
// Usage:
//   node server/worker.js           # long-running: drain + poll forever, runs the scheduler
//   node server/worker.js --once    # drain the queue until empty, then exit (tests/verification)
//
// SIGINT: finish the current job, then exit (a second SIGINT force-quits).
import {
  claimNextJob, peekNextJob, completeJob, failJob, enqueueJob,
  listPoliticians, getPolitician,
} from "./store.js";
import { ingestFor } from "./ingest.js";
import { generateReport } from "./report-generator.js";
import { maybeDiscover } from "./scandal-discovery.js";
import { startScheduler } from "./scheduler.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimum gap (ms) between STARTS of the same job type — the in-memory rate
// budget. Checked against a per-type last-start map before a job is claimed;
// if it's too soon, the worker sleeps rather than starting the job.
export const MIN_GAP_MS = {
  generate_report: 30_000, // protect the LLM/OpenRouter budget
  discover_scandals: 0,    // self-rate-limits via its own 12h meta cursor
  ingest_politician: 0,
  ingest_all: 0,
  noop: 0,
};

// Job-type → handler. Handlers receive the parsed payload (and the job row) and
// must call the real exported functions. Returned value is logged, not stored.
export const HANDLERS = {
  // Ingest evidence for one politician. Fan-out target of ingest_all.
  async ingest_politician({ politicianId } = {}) {
    const p = getPolitician(politicianId);
    if (!p) throw new Error(`Unknown politician: ${politicianId}`);
    return await ingestFor(p);
  },
  // Fan out one ingest_politician job per (non-demo) politician so a failure on
  // one rep is isolated and retried on its own, not the whole batch.
  async ingest_all() {
    let enqueued = 0;
    for (const p of listPoliticians().filter((x) => !x.is_demo)) {
      enqueueJob({ type: "ingest_politician", payload: { politicianId: p.id } });
      enqueued++;
    }
    return { enqueued };
  },
  // Regenerate a report. mode is passed straight through to generateReport.
  async generate_report({ politicianId, mode = "incremental" } = {}) {
    return await generateReport(politicianId, { mode });
  },
  // Scandal auto-discovery. maybeDiscover already self-rate-limits (12h cursor).
  async discover_scandals() {
    return await maybeDiscover();
  },
  // Built-in health/verification job: does nothing but echo its payload. Safe to
  // enqueue anywhere (no network, no LLM) to confirm the worker is consuming.
  async noop(payload = {}) {
    return { ok: true, echo: payload };
  },
};

// Run a single claimed job through its handler, then complete or fail it.
// Console line per job: outcome, type, id, elapsed ms. `handlers` is injectable
// so tests can dispatch fake types without touching the real handlers.
export async function runJob(job, handlers = HANDLERS) {
  const t0 = Date.now();
  const handler = handlers[job.type];
  if (!handler) {
    const outcome = failJob(job.id, new Error(`No handler for job type: ${job.type}`));
    console.error(`[worker] failed ${job.type} ${job.id} (0ms) → ${outcome?.status}: no handler`);
    return { ok: false, error: "no handler", outcome };
  }
  try {
    const result = await handler(job.payload ?? {}, job);
    completeJob(job.id);
    const ms = Date.now() - t0;
    console.log(`[worker] done ${job.type} ${job.id} (${ms}ms)`);
    return { ok: true, result, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    const outcome = failJob(job.id, err);
    console.error(`[worker] failed ${job.type} ${job.id} (${ms}ms) → ${outcome?.status}: ${err.message}`);
    return { ok: false, error: err, outcome, ms };
  }
}

// Drain every currently-claimable job, honoring the per-type rate budget, until
// the queue has nothing due. Backed-off (future run_at) jobs are NOT claimable,
// so a repeatedly-failing job cannot spin this loop forever. Used by --once.
export async function drain(handlers = HANDLERS, { gapMap = MIN_GAP_MS, lastStart = {}, honorGaps = true } = {}) {
  let processed = 0;
  for (;;) {
    const peek = peekNextJob();
    if (!peek) break;
    if (honorGaps) {
      const gap = gapMap[peek.type] ?? 0;
      const since = Date.now() - (lastStart[peek.type] ?? 0);
      if (gap && since < gap) await sleep(gap - since);
    }
    const job = claimNextJob();
    if (!job) break;
    lastStart[job.type] = Date.now();
    await runJob(job, handlers);
    processed++;
  }
  return processed;
}

async function main() {
  const once = process.argv.includes("--once");

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) { console.log("\n[worker] second SIGINT — force exit."); process.exit(130); }
    stopping = true;
    console.log("\n[worker] SIGINT — finishing the current job, then exiting…");
  });

  if (once) {
    console.log("[worker] --once: draining queue…");
    const n = await drain();
    console.log(`[worker] drained ${n} job(s). Exiting.`);
    process.exit(0);
  }

  console.log("[worker] starting (long-running). Ctrl-C to stop after the current job.");
  startScheduler();
  const lastStart = {};
  const POLL_MS = 1000;
  while (!stopping) {
    const peek = peekNextJob();
    if (!peek) { await sleep(POLL_MS); continue; }
    const gap = MIN_GAP_MS[peek.type] ?? 0;
    const since = Date.now() - (lastStart[peek.type] ?? 0);
    if (gap && since < gap) { await sleep(Math.min(gap - since, POLL_MS)); continue; }
    if (stopping) break;
    const job = claimNextJob();
    if (!job) { await sleep(POLL_MS); continue; }
    lastStart[job.type] = Date.now();
    await runJob(job);
  }
  console.log("[worker] stopped.");
  process.exit(0);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("worker.js");
if (invokedDirectly) main();
