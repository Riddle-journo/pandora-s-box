// ════════════════════════════════════════════════════════════════════════════
// Admin: Ops Console — DB monitoring + command control (all requireAdmin)
// Read endpoints expose store aggregates; the single write endpoint enqueues
// whitelisted jobs onto the existing queue (drained by the in-process worker).
// Split out of server/index.js (Task 5.3) — routes keep their FULL original
// "/api/admin/ops/..." paths and their original relative registration order.
// ════════════════════════════════════════════════════════════════════════════
import express from "express";
import { requireAdmin } from "../auth.js";
import {
  statsSummary, evidenceCoverage, politiciansMissing, jobCounts, evidenceCounts,
  listPoliticiansWithLatest, listPoliticiansWithCard,
  sourceHealth, listJobs, getJob, enqueueJob,
  cancelJob, updateJob, requeueJob, trimJobs, reclaimRunningJobs, isQueuePaused, setQueuePaused,
  listLeads, getLead, upsertLead, recordLeadFeedback, detectorPrecision,
} from "../store.js";
import { tail as opsLogTail } from "../ops-log.js";
import { engineStatus, detectorById, runEngine } from "../engine.js";
import { listFlags, flagCounts, getFlag } from "../flags.js";
import { setSetting, coerceValue } from "../engine-settings.js";
import { WORKER_TUNABLES, workerStatus } from "../worker.js";
import { decideLeadShared } from "./util.js";

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

// Job types the console may enqueue. Anything else is rejected.
const OPS_JOB_TYPES = new Set([
  // Summarizer (free)
  "generate_card", "cards_all",
  // Ingest / maintenance
  "ingest_all", "ingest_politician", "source_health", "roster_update",
  "mega_refresh", "repair_myneta", "cppp_ingest", "reset_data",
  // Analysis store (free extraction + detectors; prose uses the FREE chain only)
  "extract_all", "extract_prose",
  // Investigator (admin-only output; GLM budget)
  "investigate_politician", "investigate_all", "run_synthesis", "draft_stories", "anomaly_scan",
  // Anomaly Engine (free code + free enrichment) + precision GLM trigger
  "engine_scan", "engine_synthesis", "investigate_lead", "cppp_scan",
  // Editorial (GLM, human-gated)
  "discover_scandals",
  // DB maintenance (free; tiers + individual tasks). Destructive tasks go through
  // the _danger type below so they inherit the confirm-phrase gate.
  "db_maintenance", "db_maintenance_danger",
  // Legacy dossier (transition only)
  "generate_report",
]);
// Destructive types → the exact confirm phrase the UI must echo before enqueue.
const OPS_DANGER = { reset_data: "RESET", db_maintenance_danger: "MAINTAIN" };

// Overview tiles: counts, grade histogram, per-source coverage, missing-data gaps.
router.get("/api/admin/ops/summary", requireAdmin, (_req, res) => {
  res.json({ ...statsSummary(), coverage: evidenceCoverage(), missing: politiciansMissing() });
});

// Source health over N days (fetch_runs ledger) classified into rotted/stale.
router.get("/api/admin/ops/health", requireAdmin, asyncH(async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
  const rows = sourceHealth(days);
  try {
    const [{ classifyHealth }, { FETCHER_NAMES }] = await Promise.all([import("../health.js"), import("../ingest.js")]);
    res.json({ days, ...classifyHealth(rows, FETCHER_NAMES) });
  } catch (err) {
    res.json({ days, rows, rotted: [], stale: [], warn: err.message });
  }
}));

// DB maintenance history — the latest run's full findings report + a short run
// trend, for the Health tab. Quiet-by-default: the UI highlights warn/red, green
// runs are just history. Read-only; the actual runs are queued jobs.
router.get("/api/admin/ops/maintenance", requireAdmin, asyncH(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  try {
    const { maintenanceHistory } = await import("../db-maintenance.js");
    res.json(maintenanceHistory({ limit }));
  } catch (err) {
    res.json({ latest: null, runs: [], tiers: ["nightly", "weekly", "monthly"], warn: err.message });
  }
}));

// Filtered roster rows (pre-pagination). Shared by the roster grid AND the
// "run on a set" batch endpoint, so the set a filter enqueues is byte-identical
// to the set the grid shows.
function rosterRows({ office, state, hasReport, hasEvidence, q } = {}) {
  const evCounts = evidenceCounts();
  const repFallback = new Map(listPoliticiansWithLatest().map((p) => [p.id, p.latest]));
  let rows = listPoliticiansWithCard().filter((p) => !p.is_demo).map((p) => {
    const latest = p.card ?? repFallback.get(p.id) ?? null;
    return {
      id: p.id, name: p.name, office: p.office ?? "", state: p.state ?? "",
      constituency: p.constituency ?? "", party: p.party ?? "",
      grade: latest?.grade ?? null, score: latest?.score ?? null,
      generated_at: latest?.generated_at ?? null, evidence: evCounts[p.id] ?? 0,
    };
  });
  if (office) rows = rows.filter((p) => p.office.toLowerCase() === String(office).toLowerCase());
  if (state) rows = rows.filter((p) => p.state.toLowerCase() === String(state).toLowerCase());
  if (hasReport === "1") rows = rows.filter((p) => p.grade != null);
  if (hasReport === "0") rows = rows.filter((p) => p.grade == null);
  if (hasEvidence === "1") rows = rows.filter((p) => p.evidence > 0);
  if (hasEvidence === "0") rows = rows.filter((p) => p.evidence === 0);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(s) || p.constituency.toLowerCase().includes(s));
  }
  return rows;
}

// Clamp copy-pasted page/pageSize query params into a safe range and derive the
// row offset. Preserves the previous inline Math.max/Math.min behavior exactly.
function pageParams(query, { defLimit, maxLimit }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.max(1, Math.min(maxLimit, Number(query.pageSize) || defLimit));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Roster explorer: filter/paginate reps + per-rep evidence count and latest grade.
router.get("/api/admin/ops/roster", requireAdmin, (req, res) => {
  const { page, pageSize } = pageParams(req.query, { defLimit: 50, maxLimit: 500 });
  const rows = rosterRows(req.query);
  const total = rows.length;
  const start = (page - 1) * pageSize;
  res.json({ total, page, pageSize, rows: rows.slice(start, start + pageSize) });
});

// Job queue: counts by status + recent jobs (newest first).
router.get("/api/admin/ops/jobs", requireAdmin, (req, res) => {
  const jobs = listJobs({ status: req.query.status })
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, 200);
  res.json({ counts: jobCounts(), jobs });
});

// One job + its captured live log (poll with ?since=<lastSeq>).
router.get("/api/admin/ops/jobs/:id", requireAdmin, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ job, log: opsLogTail(req.params.id, Number(req.query.since) || 0) });
});

// Live log only (lighter poll for the log drawer).
router.get("/api/admin/ops/logs/:id", requireAdmin, (req, res) => {
  res.json(opsLogTail(req.params.id, Number(req.query.since) || 0));
});

// ── Anomaly Engine: status, tuning, dry runs, flags, leads ──────────────────

// Full engine surface: every detector + group, tunables meta, resolved values,
// live flag counts. The ops console renders its Engine + Tuning panels from this.
router.get("/api/admin/ops/engine", requireAdmin, (_req, res) => {
  res.json({ ...engineStatus(), worker: workerStatus() });
});

// Live threshold editing. Body: { settings: { "<key>": value | null } } where
// key is "engine.<id>.<param>" (detector tunables) or "worker.<param>" (worker
// pool tunables — the pool re-reads them each claim tick, no restart). null
// clears the override (back to the code default). Values are validated against
// the owning tunable metadata before persisting.
router.put("/api/admin/ops/engine/settings", requireAdmin, (req, res) => {
  const changes = req.body?.settings ?? {};
  const applied = [], errors = [];
  for (const [key, raw] of Object.entries(changes)) {
    let meta = null;
    const em = key.match(/^engine\.([\w-]+)\.([\w-]+)$/);
    if (em) meta = detectorById(em[1])?.tunables?.[em[2]] ?? null;
    else if (key.startsWith("worker.")) meta = WORKER_TUNABLES[key.slice("worker.".length)] ?? null;
    if (!meta) { errors.push({ key, error: "unknown setting" }); continue; }
    try {
      applied.push(setSetting(key, raw === null ? null : coerceValue(meta, raw)));
    } catch (err) { errors.push({ key, error: err.message }); }
  }
  res.status(errors.length && !applied.length ? 400 : 200).json({ applied, errors });
});

// Synchronous dry run for threshold tuning: computes candidate flags under the
// CURRENT settings and returns counts + sample headlines — writes nothing.
// Scope with ?detector=<id> (recommended: the full sweep takes ~20s inline).
router.post("/api/admin/ops/engine/dryrun", requireAdmin, asyncH(async (req, res) => {
  try {
    const { detector, politicianId } = req.body ?? {};
    const r = await runEngine({
      dryRun: true,
      detectors: detector ? [detector] : null,
      politicianId: politicianId || null,
      log: () => {},
    });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: "internal error" }); }
}));

// Per-detector precision from the human-decision ledger — the feedback loop's
// report. Suggestion-only; the console shows it, nothing auto-tunes.
router.get("/api/admin/ops/precision", requireAdmin, (req, res) => {
  const minSample = Math.max(1, Number(req.query.minSample) || 5);
  res.json({ minSample, detectors: detectorPrecision({ minSample }) });
});

// Flags browser: filter by detector/severity/status/subject, paginated.
router.get("/api/admin/ops/flags", requireAdmin, (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, { defLimit: 50, maxLimit: 200 });
  const { total, rows } = listFlags({
    detector: req.query.detector || undefined,
    severity: req.query.severity || undefined,
    status: req.query.status || "active",
    politicianId: req.query.politicianId || undefined,
    q: req.query.q || undefined,
    limit: pageSize, offset,
  });
  res.json({ total, page, pageSize, counts: flagCounts(), rows });
});

router.get("/api/admin/ops/flags/:id", requireAdmin, (req, res) => {
  const flag = getFlag(req.params.id);
  if (!flag) return res.status(404).json({ error: "not found" });
  res.json(flag);
});

// Lead pipeline browser — every status (detected → proposed → published /
// dismissed), searchable, with the full evidence citations in each row.
router.get("/api/admin/ops/leads", requireAdmin, (req, res) => {
  const { page, pageSize } = pageParams(req.query, { defLimit: 50, maxLimit: 200 });
  let rows = listLeads({ status: req.query.status || undefined });
  if (req.query.vector) rows = rows.filter((l) => l.vector === req.query.vector);
  if (req.query.q) {
    const s = String(req.query.q).toLowerCase();
    rows = rows.filter((l) =>
      (l.actor_name ?? "").toLowerCase().includes(s) ||
      (l.headline ?? "").toLowerCase().includes(s) ||
      (l.vector ?? "").toLowerCase().includes(s));
  }
  const byStatus = {};
  for (const l of listLeads({})) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
  const vectors = [...new Set(listLeads({}).map((l) => l.vector))].sort();
  res.json({ total: rows.length, page, pageSize, byStatus, vectors, rows: rows.slice((page - 1) * pageSize, page * pageSize) });
});

// Lead actions from the console. approve/reject mirror the #/admin gate (and
// keep its status rules); investigate enqueues a single-lead GLM job; dismiss
// parks a detected lead without deleting its history.
router.post("/api/admin/ops/leads/:id/action", requireAdmin, (req, res) => {
  const { action } = req.body ?? {};
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "no such lead" });
  if (action === "approve") {
    if (lead.status !== "proposed") return res.status(409).json({ error: "only proposed leads can be approved" });
    const published = decideLeadShared(lead, "approve", "ops");
    return res.json({ ok: true, status: published.status });
  }
  if (action === "reject") {
    if (lead.status !== "proposed") return res.status(409).json({ error: "only proposed leads can be rejected" });
    decideLeadShared(lead, "reject", "ops");
    return res.json({ ok: true, rejected: true });
  }
  if (action === "dismiss") {
    const updated = upsertLead({ ...lead, status: "dismissed", dismissed_at: new Date().toISOString() });
    recordLeadFeedback(lead, "dismissed", { source: "ops" });
    return res.json({ ok: true, status: updated.status });
  }
  if (action === "investigate") {
    const job = enqueueJob({ type: "investigate_lead", payload: { leadId: lead.id } });
    return res.json({ ok: true, jobId: job.id });
  }
  res.status(400).json({ error: `unknown action: ${action}` });
});

// Enqueue a whitelisted job. Destructive types require the exact confirm phrase.
router.post("/api/admin/ops/jobs", requireAdmin, (req, res) => {
  const { type, payload = {} } = req.body ?? {};
  if (!OPS_JOB_TYPES.has(type)) return res.status(400).json({ error: `job type not allowed: ${type}` });
  const requiredPhrase = OPS_DANGER[type];
  if (requiredPhrase) {
    if (payload.confirmPhrase !== requiredPhrase)
      return res.status(400).json({ error: `danger job requires confirmPhrase "${requiredPhrase}"` });
    payload.confirm = true; // the handler's defensive second gate
  }
  const job = enqueueJob({ type, payload });
  res.json({ ok: true, id: job.id, type: job.type, status: job.status });
});

// ── Queue control: pause / cancel / edit / requeue / trim ───────────────────

// Worker state: paused flag, per-status counts, and the running job (if any).
router.get("/api/admin/ops/queue", requireAdmin, (_req, res) => {
  res.json({ paused: isQueuePaused(), counts: jobCounts(), running: listJobs({ status: "running" }) });
});

// Pause/resume the worker. Paused = it stops CLAIMING new jobs; the job already
// running finishes (a serial worker can't be interrupted mid-flight).
router.post("/api/admin/ops/queue/pause", requireAdmin, (req, res) => {
  const paused = !!(req.body?.paused);
  setQueuePaused(paused);
  res.json({ ok: true, paused });
});

// Recover zombie 'running' jobs (orphaned by a crash/restart) back to queued.
// Defaults to only touching jobs stuck >10 min, so a genuinely-active job on a
// live worker is left alone; pass olderThanMinutes:0 to force-reclaim all.
router.post("/api/admin/ops/queue/reclaim", requireAdmin, (req, res) => {
  const mins = req.body?.olderThanMinutes;
  const olderThanMs = mins === 0 ? 0 : Number(mins ?? 10) * 60_000;
  res.json({ ok: true, reclaimed: reclaimRunningJobs({ olderThanMs }) });
});

// Bulk-trim jobs (clear done/dead, drop all queued, etc). Never touches running.
// Registered BEFORE the :id routes so "trim" isn't captured as a job id.
router.post("/api/admin/ops/jobs/trim", requireAdmin, (req, res) => {
  const { status, type, olderThanDays } = req.body ?? {};
  const olderThanMs = olderThanDays != null ? Number(olderThanDays) * 86400_000 : undefined;
  res.json({ ok: true, deleted: trimJobs({ status, type, olderThanMs }) });
});

// Run a whitelisted fan-out over a SPECIFIC SET of reps — explicit ids, or
// everyone matching the current roster filter (resolved server-side so the client
// never has to enumerate the whole roster). Caps the set so a mis-set filter can't
// flood the queue (or the GLM budget).
const BATCH_ACTIONS = {
  ingest:      (ids)          => [enqueueJob({ type: "ingest_all", payload: { politicianIds: ids } })],
  cards:       (ids, payload) => [enqueueJob({ type: "cards_all", payload: { politicianIds: ids, prose: payload?.prose, ingest: payload?.ingest } })],
  engine:      (ids)          => ids.map((pid) => enqueueJob({ type: "engine_scan", payload: { politicianId: pid } })),
  investigate: (ids, payload) => ids.map((pid) => enqueueJob({ type: "investigate_politician", payload: { politicianId: pid, top: payload?.top ?? 10 } })),
};
router.post("/api/admin/ops/jobs/batch", requireAdmin, (req, res) => {
  const { action, politicianIds, filter, payload = {} } = req.body ?? {};
  const fn = BATCH_ACTIONS[action];
  if (!fn) return res.status(400).json({ error: `unknown batch action: ${action}` });
  let ids = Array.isArray(politicianIds) ? politicianIds.filter(Boolean) : null;
  if (!ids || !ids.length) ids = rosterRows(filter ?? {}).map((p) => p.id); // whole current filter
  if (!ids.length) return res.status(400).json({ error: "no reps matched" });
  if (ids.length > 2000) return res.status(400).json({ error: `set too large (${ids.length} > 2000)` });
  // engine/investigate fan out one job PER rep — cap those tighter (queue + $ budget).
  if ((action === "engine" || action === "investigate") && ids.length > 200)
    return res.status(400).json({ error: `${action} on a set is capped at 200 reps (${ids.length} requested) — narrow the filter` });
  const jobs = fn(ids, payload).filter(Boolean);
  res.json({ ok: true, action, reps: ids.length, jobs: jobs.length, ids: jobs.map((j) => j.id) });
});

// Cancel a single QUEUED job (running jobs can't be yanked from a serial worker).
router.post("/api/admin/ops/jobs/:id/cancel", requireAdmin, (req, res) => {
  const r = cancelJob(req.params.id);
  res.status(r.ok ? 200 : 409).json(r);
});

// Re-run a done/dead/failed job (fresh attempt, due now). Danger types must be
// re-enqueued from their own card so the confirm phrase is re-typed.
router.post("/api/admin/ops/jobs/:id/requeue", requireAdmin, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "not found" });
  if (OPS_DANGER[job.type]) return res.status(400).json({ ok: false, error: `re-run ${job.type} from its danger card (needs confirm)` });
  const r = requeueJob(req.params.id);
  res.status(r.ok ? 200 : 409).json(r);
});

// Edit a QUEUED job — priority / run_at / payload. Editing a danger job's payload
// could smuggle past the confirm gate, so that's refused.
router.patch("/api/admin/ops/jobs/:id", requireAdmin, (req, res) => {
  const { priority, payload, runAt } = req.body ?? {};
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "not found" });
  if (payload !== undefined && OPS_DANGER[job.type])
    return res.status(400).json({ ok: false, error: `cannot edit payload of danger job ${job.type}` });
  const r = updateJob(req.params.id, { priority, payload, runAt });
  res.status(r.ok ? 200 : 409).json(r);
});

export default router;
