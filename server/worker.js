// Single-process job worker with a bounded CONCURRENCY POOL. Claims jobs and
// dispatches by type to a handler that CALLS AN EXISTING EXPORTED FUNCTION — it
// never reimplements ingest/report/discovery logic.
//
// Parallelism model (one Node process, several jobs in flight):
//   - a global cap (worker.pool.maxParallel, ops-tunable, default 4)
//   - a per-type cap (CONCURRENCY map + worker.concurrency.<type> overrides):
//     network-bound types (ingest_politician, generate_card) get >1 lane;
//     paid-LLM and file-cache-writing types stay at 1 so spend and cache files
//     are never multiplied
//   - MUTEX_GROUPS: full engine runs never overlap each other (they'd cross-mark
//     each other's flags stale) but run fine beside unrelated types
//   - EXCLUSIVE types (reset_data, db_maintenance_danger) run strictly alone
//   - MIN_GAP_MS still spaces per-type STARTS (the paid-budget throttle)
// A type at its cap / in a gap is SKIPPED OVER, so a saturated ingest lane never
// blocks a due card job. That is an intentional soft priority inversion: a
// high-priority job of a capped type yields to lower-priority jobs of others.
// External hosts are protected by server/util/host-limiter.js (cross-job gate).
//
// Usage:
//   node server/worker.js           # long-running: drain + poll forever, runs the scheduler
//   node server/worker.js --once    # drain the queue until empty, then exit (tests/verification)
//
// SIGINT: stop claiming, finish the in-flight jobs, then exit (a second SIGINT force-quits).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jobLogContext } from "./util/job-context.js";
import { logger } from "./util/log.js";
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
import { sleep } from "./util/timing.js";
import { getSetting, listOverrides } from "./engine-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const wlog = logger("worker");
// Handlers accept an injectable {log} line-writer; route it through the
// structured logger — which mirrors into the job's ring buffer, exactly
// like the console patch used to.
const jobLine = (...a) => wlog.info(a.map(String).join(" "));

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
  // DB maintenance — self-throttles internally (skips heavy tasks when busy).
  db_maintenance: 0,
  db_maintenance_danger: 0,
  // Spawn-based maintenance CLIs — serial by default; no extra gap needed.
  roster_update: 0,
  mega_refresh: 0,
  repair_myneta: 0,
  reset_data: 0,
};

// ── Per-type concurrency limits ─────────────────────────────────────────────
// How many jobs of one type may run AT THE SAME TIME. Types not listed default
// to 1. Only genuinely network-bound types get extra lanes — everything CPU-
// bound gains nothing from overlap (one JS thread), paid-LLM types must never
// multiply spend, and the file-cache writers (ingest_all L1 refresh,
// mega_refresh, roster/myneta CLIs) use non-atomic writeFileSync paths that
// would corrupt under overlap. Live overrides: worker.concurrency.<type>.
export const CONCURRENCY = {
  ingest_politician: 3, // multi-source fetch; external pressure capped by host-limiter
  generate_card: 2,     // free-chain only; >2 just burns free-tier 429s
};
export const DEFAULT_MAX_PARALLEL = 4; // global cap; override: worker.pool.maxParallel

// Types that run strictly ALONE — claimed only when the pool is empty, and
// nothing else is claimed while one runs. Both wipe/rewrite data.
export const EXCLUSIVE = new Set(["reset_data", "db_maintenance_danger"]);

// Types sharing a group never overlap EACH OTHER (they run fine beside
// unrelated types). Full engine runs mark every flag not written by their own
// runId stale (flags.js markStaleExcept), so two overlapping full runs would
// corrupt each other's flag set; a cppp rebuild must not overlap a cppp scan
// (non-atomic DROP→CREATE→insert). investigate_politician is politicianId-
// scoped (skips stale-marking) so it stays outside the group.
export const MUTEX_GROUPS = {
  engine_scan: "engine",
  investigate_all: "engine",
  engine_synthesis: "engine",
  cppp_scan: "engine",
};

const limitFor = (type, perType) =>
  Math.max(1, perType?.[type] ?? CONCURRENCY[type] ?? 1);

// Ops-tunable worker settings (stored in engine_settings under 'worker.<param>',
// edited live from the Tuning tab exactly like detector thresholds). Only the
// knobs that are SAFE to raise are exposed: paid-LLM, engine-mutex and
// file-cache-writing types are pinned at 1 by design and deliberately absent.
export const WORKER_TUNABLES = {
  "pool.maxParallel": {
    label: "max jobs in flight", type: "number", min: 1, max: 16, step: 1, def: DEFAULT_MAX_PARALLEL,
    desc: "Global cap on concurrently running jobs. Per-type lanes below still apply.",
  },
  "concurrency.ingest_politician": {
    label: "ingest lanes", type: "number", min: 1, max: 8, step: 1, def: CONCURRENCY.ingest_politician,
    desc: "Parallel per-politician ingest jobs. External sites stay protected by the shared host rate limiter regardless of this number.",
  },
  "concurrency.generate_card": {
    label: "card lanes", type: "number", min: 1, max: 8, step: 1, def: CONCURRENCY.generate_card,
    desc: "Parallel report-card jobs (free LLM chain only). High values just trade speed for more free-tier rate-limit fallbacks.",
  },
};

// Tuning-tab surface for the pool — shaped like an engine group so the ops
// console's generic tunables renderer can display it.
export function workerStatus() {
  const settings = {};
  for (const [param, meta] of Object.entries(WORKER_TUNABLES)) {
    const v = getSetting(`worker.${param}`);
    settings[param] = v === undefined ? meta.def : v;
  }
  return {
    id: "worker", label: "Worker pool", category: "worker",
    desc: "Job-queue parallelism. Paid-LLM, engine and maintenance job types always run one at a time (safety-pinned); these knobs only tune the network-bound lanes.",
    tunables: WORKER_TUNABLES, settings,
  };
}

// Live pool config, re-read every claim tick (better-sqlite3 point reads are
// microseconds) so ops-console changes apply on the next tick — no restart.
export function readWorkerConfig() {
  const raw = Number(getSetting("worker.pool.maxParallel", DEFAULT_MAX_PARALLEL));
  const maxParallel = Math.max(1, Math.min(16, Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_MAX_PARALLEL));
  const perType = {};
  for (const { key, value } of listOverrides("worker.concurrency.")) {
    const type = key.slice("worker.concurrency.".length);
    const n = Number(value);
    if (type && Number.isFinite(n) && n >= 1) perType[type] = Math.min(8, Math.floor(n));
  }
  return { maxParallel, perType };
}

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
    wlog.info(`[ingest_all] scope=${scope} → enqueued ${enqueued} rep(s)`);
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
      const idx = await buildCpppIndex({ log: jobLine });
      if (!idx.ok) return { indexed: false, reason: idx.reason };
    }
    const { runEngine } = await import("./engine.js");
    const { CPPP_DETECTORS } = await import("./cppp-detectors.js");
    const r = await runEngine({ detectors: CPPP_DETECTORS.map((d) => d.id), procurement: true, log: jobLine });
    return { runId: r.runId, tookMs: r.tookMs, synthesis: r.synthesis };
  },
  // Re-run flags → leads synthesis alone (after tuning thresholds, no re-detect).
  async engine_synthesis() {
    const { runLeadSynthesis } = await import("./lead-synthesis.js");
    return await runLeadSynthesis({ log: jobLine });
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
      wlog.warn(`[health] ROTTED ${r.source}: ${Math.round(r.ok_rate * 100)}% ok, ${r.total_items} items over ${days}d — ${r.last_error ?? "no error logged"}`);
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
    const r = runExtractAndDetect({ log: jobLine });
    return { extraction: r.extraction.totals, detectors: r.detectors?.counts ?? null };
  },
  // Prose LLM extractors (news/fact-check/CBI/wikipedia) over the FREE chain only.
  // limit caps rows per source (a sample run); pass limit:null / all:true for the
  // full backfill (32k+ news rows — long, but free). Degrades to skips when the
  // free chain is exhausted.
  async extract_prose({ limit = 25, source = null, all = false } = {}) {
    const { runAllProseExtractors, runProseExtractor } = await import("./extractors/prose-llm.js");
    const lim = all ? null : Number(limit);
    if (source) return await runProseExtractor(source, { limit: lim, log: jobLine });
    const results = await runAllProseExtractors({ limit: lim, log: jobLine });
    return Object.fromEntries(results.map((r) => [r.source_type, { written: r.written, evidence: r.evidence, model_null: r.model_null }]));
  },
  // Built-in health/verification job: does nothing but echo its payload. Safe to
  // enqueue anywhere (no network, no LLM) to confirm the worker is consuming.
  async noop(payload = {}) {
    return { ok: true, echo: payload };
  },

  // DB maintenance (SAFE): run a whole tier (nightly/weekly/monthly) or one named
  // task. Composes db-maintenance.js — integrity/orphans/drift/backup/… — and writes
  // a maintenance_log row. Free: SQLite PRAGMAs + better-sqlite3 backup, no network.
  async db_maintenance(payload = {}, job) {
    const { runMaintenance, runMaintenanceTask } = await import("./db-maintenance.js");
    if (payload.tier) return await runMaintenance(payload.tier, { log: jobLine });
    if (payload.task) return await runMaintenanceTask(payload.task, payload, { log: jobLine });
    throw new Error("db_maintenance: need a tier or task in the payload");
  },
  // DB maintenance (DESTRUCTIVE): the tasks that rewrite/rebuild — full VACUUM and
  // drift-heal (delete+re-extract). Gated by the HTTP confirm phrase; this is the
  // defensive second gate. Everything it touches is rebuildable (a backup is taken
  // before VACUUM; heal only rewrites derived ledger rows), but it's kept behind the
  // danger door so it's a deliberate click.
  async db_maintenance_danger(payload = {}, job) {
    if (payload.confirm !== true) throw new Error("db_maintenance_danger refused: confirm must be true.");
    const allowed = new Set(["vacuum", "drift_heal"]);
    if (!allowed.has(payload.task)) throw new Error(`db_maintenance_danger: task "${payload.task}" is not a danger task`);
    const { runMaintenanceTask } = await import("./db-maintenance.js");
    return await runMaintenanceTask(payload.task, payload, { log: jobLine });
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
    return await runCpppIngest({ office, state, limit, force, log: jobLine });
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

// Per-job log routing under CONCURRENT jobs. The old approach swapped the
// global console per job — safe only while exactly one job ran at a time. Now
// the console is patched ONCE, and each call looks up "which job am I inside?"
// via AsyncLocalStorage, which follows the async call chain across await/
// timers/mapLimit automatically. Output from code running inside job A lands in
// A's live-log buffer; output outside any job (boot, HTTP, scheduler) passes
// straight through to the real console.
// jobLogContext itself lives in util/job-context.js (dependency-free) so the
// structured logger can import it without pulling in the whole worker;
// re-exported here so existing importers keep working.
export { jobLogContext } from "./util/job-context.js";

let consolePatched = false;
export function patchConsoleForJobs() {
  if (consolePatched) return;
  consolePatched = true;
  for (const m of ["log", "warn", "error"]) {
    const orig = console[m].bind(console);
    console[m] = (...a) => {
      const jobId = jobLogContext.getStore();
      if (jobId) {
        try { pushLog(jobId, a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")); }
        catch { /* logging must never break a job */ }
      }
      return orig(...a);
    };
  }
}

// Run a single claimed job through its handler, then complete or fail it.
// Console line per job: outcome, type, id, elapsed ms. `handlers` is injectable
// so tests can dispatch fake types without touching the real handlers.
export async function runJob(job, handlers = HANDLERS) {
  const t0 = Date.now();
  const handler = handlers[job.type];
  if (!handler) {
    const outcome = failJob(job.id, new Error(`No handler for job type: ${job.type}`));
    wlog.error(`[worker] failed ${job.type} ${job.id} (0ms) → ${outcome?.status}: no handler`);
    return { ok: false, error: "no handler", outcome };
  }
  patchConsoleForJobs(); // idempotent — ensures routing even when runJob is called directly (tests)
  return jobLogContext.run(job.id, async () => {
    try {
      const result = await handler(job.payload ?? {}, job);
      completeJob(job.id);
      const ms = Date.now() - t0;
      wlog.info(`[worker] done ${job.type} ${job.id} (${ms}ms)`);
      return { ok: true, result, ms };
    } catch (err) {
      const ms = Date.now() - t0;
      const outcome = failJob(job.id, err);
      wlog.error(`[worker] failed ${job.type} ${job.id} (${ms}ms) → ${outcome?.status}: ${err.message}`);
      return { ok: false, error: err, outcome, ms };
    }
  });
}

// ── The pool loop — the ONE consumer behind every entry point ────────────────
// Replaces the old serial drain/poll loops. Each tick: honor pause, read the
// live config, exclude types that are capped / mutex-blocked / gap-blocked /
// exclusive, claim ONE job (atomic UPDATE…RETURNING) and launch it WITHOUT
// awaiting. When the pool is full, wait for any in-flight job to finish.
//
//   once:true   → drain semantics: exit when nothing due remains (backed-off
//                 future-run_at jobs don't spin it; gap-blocked due jobs are
//                 waited out, matching the old drain()). Ignores pause, like
//                 the old --once drain did.
//   isStopped() → cooperative stop: stop claiming, finish in-flight, return.
export async function runPool({
  handlers = HANDLERS, gapMap = MIN_GAP_MS, pollMs = 1000,
  once = false, isStopped = () => false, getConfig = readWorkerConfig,
  lastStart = {},
} = {}) {
  patchConsoleForJobs();
  const runningByType = new Map(); // type  → in-flight count
  const runningGroups = new Map(); // group → in-flight count
  const inflight = new Set();
  let exclusiveRunning = false;
  let processed = 0;

  // Sleep, but wake early if any in-flight job finishes (frees a lane/type).
  const waitTick = (ms) => inflight.size
    ? Promise.race([Promise.race(inflight), sleep(ms)])
    : sleep(ms);

  while (!isStopped()) {
    if (!once && isQueuePaused()) { await waitTick(pollMs); continue; } // pause: claim nothing; in-flight finish
    const cfg = getConfig();
    if (exclusiveRunning || inflight.size >= cfg.maxParallel) {
      // Bounded wait (not a bare race): re-reads the live config every pollMs,
      // so RAISING worker.pool.maxParallel mid-flight takes effect within a
      // tick instead of only after the next job completes.
      await waitTick(pollMs);
      continue;
    }
    // Types we must not claim right now.
    const excluded = new Set();
    for (const [t, n] of runningByType) if (n >= limitFor(t, cfg.perType)) excluded.add(t);
    for (const [t, g] of Object.entries(MUTEX_GROUPS)) if ((runningGroups.get(g) ?? 0) > 0) excluded.add(t);
    if (inflight.size > 0) for (const t of EXCLUSIVE) excluded.add(t);
    let minGapWait = pollMs;
    for (const [t, gap] of Object.entries(gapMap)) {
      if (!gap) continue;
      const left = gap - (Date.now() - (lastStart[t] ?? 0));
      if (left > 0) { excluded.add(t); minGapWait = Math.min(minGapWait, left); }
    }

    const job = claimNextJob({ excludeTypes: [...excluded] });
    if (!job) {
      // Nothing claimable outside the exclusions. In --once mode we're done
      // only when the queue is truly empty of DUE jobs (an exclusion-blocked
      // due job still needs waiting out; a backed-off future run_at does not).
      if (once && inflight.size === 0 && !peekNextJob()) break;
      await waitTick(Math.max(10, minGapWait));
      continue;
    }

    if (EXCLUSIVE.has(job.type)) exclusiveRunning = true;
    lastStart[job.type] = Date.now();
    runningByType.set(job.type, (runningByType.get(job.type) ?? 0) + 1);
    const group = MUTEX_GROUPS[job.type];
    if (group) runningGroups.set(group, (runningGroups.get(group) ?? 0) + 1);
    processed++;
    const p = runJob(job, handlers).finally(() => {
      const n = (runningByType.get(job.type) ?? 1) - 1;
      if (n > 0) runningByType.set(job.type, n); else runningByType.delete(job.type);
      if (group) {
        const m = (runningGroups.get(group) ?? 1) - 1;
        if (m > 0) runningGroups.set(group, m); else runningGroups.delete(group);
      }
      if (EXCLUSIVE.has(job.type)) exclusiveRunning = false;
      inflight.delete(p);
    });
    inflight.add(p);
  }
  await Promise.allSettled([...inflight]); // graceful drain: claim nothing new, finish in-flight
  return processed;
}

// Drain every currently-claimable job until the queue has nothing due, then
// return the processed count. Kept as a thin wrapper over runPool for tests and
// the --once CLI. Backed-off (future run_at) jobs are NOT claimable, so a
// repeatedly-failing job cannot spin it forever.
export async function drain(handlers = HANDLERS, { gapMap = MIN_GAP_MS, lastStart = {}, honorGaps = true, pollMs = 25 } = {}) {
  return runPool({ handlers, gapMap: honorGaps ? gapMap : {}, lastStart, pollMs, once: true });
}

// Start the scheduler + the pool IN-PROCESS (for the one-launch ops console:
// `node server/index.js` runs the web server AND the worker together).
// Non-blocking: returns a stop() fn. Jobs are async I/O so they don't starve
// the HTTP event loop. Idempotent-ish — call once at server boot.
export function startInProcessWorker({ pollMs = 1000, scheduler = true } = {}) {
  // This process hosts the ONLY consumer pool, so any 'running' job at boot is
  // a zombie orphaned by a prior crash/restart — requeue it before we start.
  const reclaimed = reclaimRunningJobs();
  if (reclaimed) wlog.info(`[worker] reclaimed ${reclaimed} orphaned running job(s) → queued`);
  if (scheduler) startScheduler();
  let stopped = false;
  runPool({ pollMs, isStopped: () => stopped })
    .catch((err) => wlog.error(`[worker] pool crashed: ${err.stack ?? err}`));
  return () => { stopped = true; };
}

async function main() {
  const once = process.argv.includes("--once");

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) { wlog.info("[worker] second SIGINT — force exit."); process.exit(130); }
    stopping = true;
    wlog.info("[worker] SIGINT — finishing the in-flight job(s), then exiting…");
  });

  // Sole consumer pool: recover any job left 'running' by a previous crash.
  const reclaimed = reclaimRunningJobs();
  if (reclaimed) wlog.info(`[worker] reclaimed ${reclaimed} orphaned running job(s) → queued`);

  if (once) {
    wlog.info("[worker] --once: draining queue…");
    const n = await drain();
    wlog.info(`[worker] drained ${n} job(s). Exiting.`);
    process.exit(0);
  }

  wlog.info("[worker] starting (long-running, pooled). Ctrl-C to stop after in-flight jobs.");
  startScheduler();
  await runPool({ isStopped: () => stopping });
  wlog.info("[worker] stopped.");
  process.exit(0);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("worker.js");
if (invokedDirectly) main();
