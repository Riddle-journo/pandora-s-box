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
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimNextJob, peekNextJob, completeJob, failJob, enqueueJob,
  listPoliticians, getPolitician, sourceHealth, pruneFetchRuns,
  isQueuePaused, lastFetchByPolitician, reclaimRunningJobs,
} from "./store.js";
import { ingestFor, FETCHER_NAMES } from "./ingest.js";
import { generateReport } from "./report-generator.js";
import { maybeDiscover } from "./scandal-discovery.js";
import { classifyHealth } from "./health.js";
import { startScheduler } from "./scheduler.js";
import { runAnomalyScan } from "./anomaly.js";
import { push as pushLog } from "./ops-log.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

// Spawn `node server/<script> <args…>` as a child and stream its stdout/stderr,
// line by line, into the job's live-log ring buffer. Resolves on exit code 0,
// rejects otherwise — so a failed CLI marks the job dead with the exit code.
// This is how the spawn-only maintenance CLIs become queue-monitorable jobs.
function spawnCli(jobId, script, args = []) {
  return new Promise((resolve, reject) => {
    pushLog(jobId, `$ node server/${script} ${args.join(" ")}`.trim());
    const child = spawn(process.execPath, [path.join("server", script), ...args], {
      cwd: REPO_ROOT, env: process.env,
    });
    const onData = (buf) => { for (const line of String(buf).split(/\r?\n/)) if (line.trim()) pushLog(jobId, line); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ code });
      else reject(new Error(`server/${script} exited with code ${code}`));
    });
  });
}

// Minimum gap (ms) between STARTS of the same job type — the in-memory rate
// budget. Checked against a per-type last-start map before a job is claimed;
// if it's too soon, the worker sleeps rather than starting the job.
export const MIN_GAP_MS = {
  generate_card: 0,        // Summarizer: free-chain only, no paid budget to protect
  cards_all: 0,
  generate_report: 30_000, // protect the LLM/OpenRouter budget
  investigate_politician: 30_000, // Investigator: paid GLM layers
  investigate_all: 30_000,
  run_synthesis: 0,        // pure code
  draft_stories: 30_000,   // GLM per story
  discover_scandals: 0,    // self-rate-limits via its own 12h meta cursor
  ingest_politician: 0,
  ingest_all: 0,
  source_health: 0,
  anomaly_scan: 0,        // pure code, no network/LLM — self-limited by the weekly schedule
  engine_scan: 0,          // Anomaly Engine: pure code + free enrichment only
  cppp_scan: 0,            // CPPP procurement detectors (slow; own job, pure code)
  engine_synthesis: 0,     // flags → leads, pure code
  investigate_lead: 30_000, // single-lead GLM investigation (paid)
  noop: 0,
  // Spawn-based maintenance CLIs — serial by default; no extra gap needed.
  roster_update: 0,
  mega_refresh: 0,
  repair_myneta: 0,
  reset_data: 0,
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
  //   politicianIds — run ONLY this explicit set (the Roster tab's "run on
  //                   selected"); overrides incremental.
  //   incremental    — skip reps fetched within the last `staleDays` days; only
  //                   never-ingested + stale reps are enqueued ("just the latest,
  //                   not a full refresh").
  async ingest_all({ politicianIds = null, incremental = false, staleDays = 7 } = {}) {
    let list = listPoliticians().filter((x) => !x.is_demo);
    if (Array.isArray(politicianIds) && politicianIds.length) {
      const want = new Set(politicianIds);
      list = list.filter((p) => want.has(p.id));
    } else if (incremental) {
      const last = lastFetchByPolitician();
      const cutoff = Date.now() - Math.max(0, Number(staleDays) || 0) * 86400_000;
      list = list.filter((p) => { const t = last.get(p.id); return t == null || t < cutoff; });
    }
    let enqueued = 0;
    for (const p of list) {
      enqueueJob({ type: "ingest_politician", payload: { politicianId: p.id } });
      enqueued++;
    }
    const scope = (Array.isArray(politicianIds) && politicianIds.length) ? "set"
      : incremental ? `incremental(${staleDays}d)` : "all";
    console.log(`[ingest_all] scope=${scope} → enqueued ${enqueued} rep(s)`);
    return { enqueued, scope };
  },
  // Summarizer (Branch 1): build one public report card. Free — no paid LLM.
  // Payload accepts prose/ingest booleans, or noProse/reingest from the ops UI.
  async generate_card(payload = {}) {
    const { summarizeOne } = await import("./summarize.js");
    const prose = payload.prose ?? !payload.noProse;
    const ingest = payload.ingest ?? (payload.reingest !== undefined ? !!payload.reingest : true);
    const card = await summarizeOne(payload.politicianId, { prose, ingest });
    return { grade: card.grade, score: card.score, sections: card.sections.length };
  },
  // Fan out one generate_card job per (non-demo) politician. Defaults to NO
  // re-ingest (cards from existing evidence) — pair with ingest_all when fresh
  // evidence is wanted first.
  async cards_all(payload = {}) {
    const prose = payload.prose ?? !payload.noProse;
    const ingest = payload.ingest ?? !!payload.reingest;
    let list = listPoliticians().filter((x) => !x.is_demo);
    if (Array.isArray(payload.politicianIds) && payload.politicianIds.length) {
      const want = new Set(payload.politicianIds);
      list = list.filter((p) => want.has(p.id));
    }
    let enqueued = 0;
    for (const p of list) {
      enqueueJob({ type: "generate_card", payload: { politicianId: p.id, prose, ingest } });
      enqueued++;
    }
    return { enqueued };
  },
  // Regenerate a report. mode is passed straight through to generateReport.
  async generate_report({ politicianId, mode = "incremental" } = {}) {
    return await generateReport(politicianId, { mode });
  },
  // Investigator (Branch 2, admin-only output): Anomaly Engine for one rep, then
  // L2/L3 AI investigation of that rep's top detected leads. GLM budget lives here.
  async investigate_politician({ politicianId, top = 10 } = {}) {
    const { investigateTop } = await import("./investigate.js");
    const { runEngine } = await import("./engine.js");
    const p = getPolitician(politicianId);
    if (!p) throw new Error(`Unknown politician: ${politicianId}`);
    const engine = await runEngine({ politicianId: p.id });
    const r = await investigateTop({ targetIds: new Set([p.id]), topN: top });
    return { engine: engine.synthesis, ...r };
  },
  // Population-wide engine (free) + L2/L3 on the global top leads (paid, capped).
  async investigate_all({ top = 50 } = {}) {
    const { investigateTop } = await import("./investigate.js");
    const { runEngine } = await import("./engine.js");
    const engine = await runEngine({});
    const r = await investigateTop({ topN: top });
    return { engine: engine.synthesis, ...r };
  },
  // Anomaly Engine only (free): all detectors → flags, enrichment, lead
  // synthesis. Payload: { detectors: [ids], politicianId, dryRun, procurement } —
  // all optional. procurement:true also runs the slow CPPP detectors.
  async engine_scan(payload = {}) {
    const { runEngine } = await import("./engine.js");
    const r = await runEngine({
      detectors: Array.isArray(payload.detectors) && payload.detectors.length ? payload.detectors
        : typeof payload.detector === "string" && payload.detector ? [payload.detector] : null,
      politicianId: payload.politicianId || null,
      dryRun: !!payload.dryRun,
      procurement: !!payload.procurement,
    });
    return { runId: r.runId, dryRun: r.dryRun, tookMs: r.tookMs, synthesis: r.synthesis, enrichment: r.enrichment };
  },
  // Procurement (CPPP) scan: build/refresh the flattened award index if asked,
  // then run just the CPPP detectors → flags → leads. Slow (scans 4.9M awards);
  // its own job so it never slows a normal engine pass. Payload: { rebuild }.
  async cppp_scan(payload = {}) {
    if (payload.rebuild) {
      const { buildCpppIndex } = await import("./cppp-index.js");
      const idx = await buildCpppIndex({ log: console.log });
      if (!idx.ok) return { indexed: false, reason: idx.reason };
    }
    const { runEngine } = await import("./engine.js");
    const { CPPP_DETECTORS } = await import("./cppp-detectors.js");
    const r = await runEngine({ detectors: CPPP_DETECTORS.map((d) => d.id), procurement: true, log: console.log });
    return { runId: r.runId, tookMs: r.tookMs, synthesis: r.synthesis };
  },
  // Re-run flags → leads synthesis alone (after tuning thresholds, no re-detect).
  async engine_synthesis() {
    const { runLeadSynthesis } = await import("./lead-synthesis.js");
    return await runLeadSynthesis({ log: console.log });
  },
  // GLM investigation of ONE lead by id — the ops console's precision trigger.
  async investigate_lead({ leadId } = {}) {
    const { getLead } = await import("./store.js");
    const { investigateLead } = await import("./investigator.js");
    const lead = getLead(leadId);
    if (!lead) throw new Error(`Unknown lead: ${leadId}`);
    const r = await investigateLead(lead);
    return { leadId, status: r.status };
  },
  // L4 synthesis: cross-entity network hubs (pure code).
  async run_synthesis() {
    const { runSynthesis } = await import("./synthesis.js");
    return runSynthesis();
  },
  // L5: draft journalist-handoff stories from cleared/proposed leads (GLM).
  async draft_stories() {
    const { assembleIncidents, generateStory } = await import("./story-generator.js");
    const { listLeads, listScandals } = await import("./store.js");
    const incidents = assembleIncidents({ leads: listLeads({}), scandals: listScandals() });
    let ok = 0, fail = 0;
    for (const inc of incidents) {
      try { await generateStory(inc); ok++; } catch { fail++; }
    }
    return { incidents: incidents.length, drafted: ok, failed: fail };
  },
  // Scandal auto-discovery. maybeDiscover already self-rate-limits (12h cursor).
  async discover_scandals() {
    return await maybeDiscover();
  },
  // Fetcher-health sweep: aggregate fetch_runs, warn on ROTTED sources, and
  // prune ledger rows older than 90 days. Read-mostly; no network, no LLM.
  async source_health({ days = 14 } = {}) {
    const health = sourceHealth(days);
    const { rotted, quiet, stale } = classifyHealth(health, FETCHER_NAMES);
    for (const r of rotted) {
      console.warn(`[health] ROTTED ${r.source}: ${Math.round(r.ok_rate * 100)}% ok, ${r.total_items} items over ${days}d — ${r.last_error ?? "no error logged"}`);
    }
    const pruned = pruneFetchRuns(90);
    return { sources: health.length, rotted: rotted.length, quiet: quiet.length, stale: stale.length, pruned };
  },
  // Statistical outlier scan: manufactures anomaly leads (assets, MPLADS
  // utilisation, donation→award timing) for the L1 funnel. Pure code, no network.
  async anomaly_scan() {
    return await runAnomalyScan();
  },
  // Analysis store: run EVERY deterministic extractor over the evidence corpus
  // (facts/claims/events/relationships) then the ledger-native detectors, so new
  // evidence immediately becomes candidate leads. Pure code, no network, no LLM.
  async extract_all() {
    const { runExtractAndDetect } = await import("./extract-all.js");
    const r = runExtractAndDetect({ log: console.log });
    return { extraction: r.extraction.totals, detectors: r.detectors?.counts ?? null };
  },
  // Prose LLM extractors (news/fact-check/CBI/wikipedia) over the FREE chain only.
  // limit caps rows per source (a sample run); pass limit:null / all:true for the
  // full backfill (32k+ news rows — long, but free). Degrades to skips when the
  // free chain is exhausted.
  async extract_prose({ limit = 25, source = null, all = false } = {}) {
    const { runAllProseExtractors, runProseExtractor } = await import("./extractors/prose-llm.js");
    const lim = all ? null : Number(limit);
    if (source) return await runProseExtractor(source, { limit: lim, log: console.log });
    const results = await runAllProseExtractors({ limit: lim, log: console.log });
    return Object.fromEntries(results.map((r) => [r.source_type, { written: r.written, evidence: r.evidence, model_null: r.model_null }]));
  },
  // Built-in health/verification job: does nothing but echo its payload. Safe to
  // enqueue anywhere (no network, no LLM) to confirm the worker is consuming.
  async noop(payload = {}) {
    return { ok: true, echo: payload };
  },

  // ---- Spawn-based maintenance CLIs (no exported worker fn; run as subprocess) ----
  // Each streams the child's stdout/stderr into the job log. Dry-run unless the
  // payload explicitly opts into writes, mirroring each CLI's own default.

  // Refresh the roster from Digital Sansad (LS+RS), optionally MLAs. Dry-run
  // unless apply:true.
  async roster_update({ apply = false, mla = false } = {}, job) {
    const args = [];
    if (apply) args.push("--apply");
    if (mla) args.push("--mla");
    return await spawnCli(job.id, "update-roster.js", args);
  },
  // Re-download + re-match a mega dataset (or all). Owner-paced; heavy.
  async mega_refresh({ id = "all" } = {}, job) {
    return await spawnCli(job.id, "mega-ingest.js", ["--refresh", String(id)]);
  },
  // Validate/repair MyNeta affidavit URLs. Dry-run unless apply:true.
  async repair_myneta({ apply = false, onlySuspect = false, limit } = {}, job) {
    const args = [];
    if (apply) args.push("--apply");
    if (onlySuspect) args.push("--only-suspect");
    if (limit != null) args.push("--limit", String(limit));
    return await spawnCli(job.id, "repair-myneta.js", args);
  },
  // (No mca_index job — the MCA bulk Director dataset is not freely available;
  // director names come from the free Tofler path, not a downloadable index.)
  // CPPP procurement ingest — query the local 6.6GB contract-award DB per rep and
  // store `gem` evidence. Resumable (skips reps already done). Long-running over the
  // whole roster; scope with office/state/limit. In-process so it streams progress.
  async cppp_ingest({ office = null, state = null, limit = null, force = false } = {}) {
    const { runCpppIngest } = await import("./cppp-ingest.js");
    return await runCpppIngest({ office, state, limit, force, log: console.log });
  },
  // DANGER ZONE — wipe reports/evidence/demo. Guarded: requires confirm:true.
  // (The HTTP layer additionally checks a typed confirmPhrase before enqueue;
  // this is the defensive second gate.) Runs a dry-run preview unless apply:true.
  async reset_data({ scope = "reports", apply = false, confirm = false } = {}, job) {
    if (confirm !== true) throw new Error("reset_data refused: payload.confirm must be true.");
    const scopeFlag = { reports: "--reports", evidence: "--evidence", all: "--all", demo: "--demo" }[scope];
    if (!scopeFlag) throw new Error(`reset_data: unknown scope "${scope}".`);
    const args = [scopeFlag];
    if (apply) args.push("--apply");
    return await spawnCli(job.id, "reset-data.js", args);
  },
};

// Tee console.log/warn/error into the job's live-log buffer for the duration of a
// job, returning a restore fn. The worker is serial, so patching the global
// console for the running job is safe (only one job runs at a time). This is what
// makes an in-process handler's existing `[ingest]`/`[generate]` lines streamable.
function teeConsole(jobId) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const wrap = (fn) => (...a) => { try { pushLog(jobId, a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")); } catch { /* logging must never break a job */ } return fn(...a); };
  console.log = wrap(orig.log); console.warn = wrap(orig.warn); console.error = wrap(orig.error);
  return () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; };
}

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
  const restore = teeConsole(job.id);
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
  } finally {
    restore();
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

// Start the scheduler + a polling drain loop IN-PROCESS (for the one-launch ops
// console: `node server/index.js` runs the web server AND the worker together).
// Non-blocking: returns a stop() fn. Long jobs are async I/O so they don't starve
// the HTTP event loop. Idempotent-ish — call once at server boot.
export function startInProcessWorker({ pollMs = 1000, scheduler = true } = {}) {
  // This worker is the sole serial consumer, so any 'running' job at boot is a
  // zombie orphaned by a prior crash/restart — requeue it before we start.
  const reclaimed = reclaimRunningJobs();
  if (reclaimed) console.log(`[worker] reclaimed ${reclaimed} orphaned running job(s) → queued`);
  if (scheduler) startScheduler();
  const lastStart = {};
  let stopped = false;
  (async () => {
    while (!stopped) {
      if (isQueuePaused()) { await sleep(pollMs); continue; } // ops-console pause: leave queued jobs untouched
      const peek = peekNextJob();
      if (!peek) { await sleep(pollMs); continue; }
      const gap = MIN_GAP_MS[peek.type] ?? 0;
      const since = Date.now() - (lastStart[peek.type] ?? 0);
      if (gap && since < gap) { await sleep(Math.min(gap - since, pollMs)); continue; }
      const job = claimNextJob();
      if (!job) { await sleep(pollMs); continue; }
      lastStart[job.type] = Date.now();
      await runJob(job);
    }
  })();
  return () => { stopped = true; };
}

async function main() {
  const once = process.argv.includes("--once");

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) { console.log("\n[worker] second SIGINT — force exit."); process.exit(130); }
    stopping = true;
    console.log("\n[worker] SIGINT — finishing the current job, then exiting…");
  });

  // Sole serial consumer: recover any job left 'running' by a previous crash.
  const reclaimed = reclaimRunningJobs();
  if (reclaimed) console.log(`[worker] reclaimed ${reclaimed} orphaned running job(s) → queued`);

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
    if (isQueuePaused()) { await sleep(POLL_MS); continue; } // ops-console pause: leave queued jobs untouched
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
