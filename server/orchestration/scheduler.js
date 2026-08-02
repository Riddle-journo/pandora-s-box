// Tiny recurring enqueuer. Runs INSIDE the worker process (not a separate
// process): every minute it checks a hardcoded SCHEDULES table and enqueues a
// job whenever enough wall-clock has passed since it last did so. Last-enqueue
// timestamps live in the existing `meta` table, so schedule state survives a
// worker restart. No cron dependency — a single setInterval drives it.
import { enqueueJob, getMeta, setMeta } from "../store/store.js";

// everyMs = minimum spacing between enqueues of this type. The handlers
// themselves self-rate-limit further (e.g. maybeDiscover's 12h meta cursor,
// generate_report's 30s gap in the worker), so this only has to be a coarse
// "kick it off roughly this often" cadence.
export const SCHEDULES = [
  { type: "discover_scandals", payload: {}, everyMs: 6 * 3600_000 },       // ~every 6h (proposals only — GLM runs on admin approve)
  { type: "ingest_all",        payload: {}, everyMs: 7 * 24 * 3600_000 },  // ~weekly
  { type: "cards_all",         payload: { ingest: false }, everyMs: 7 * 24 * 3600_000 }, // ~weekly, after ingest (free Summarizer refresh)
  { type: "source_health",     payload: {}, everyMs: 24 * 3600_000 },      // ~daily
  { type: "extract_all",       payload: {}, everyMs: 7 * 24 * 3600_000 },  // ~weekly (rebuild ledgers from fresh evidence)
  { type: "engine_scan",       payload: {}, everyMs: 7 * 24 * 3600_000 },  // ~weekly (full Anomaly Engine — free; GLM stays manual)
  // DB maintenance tiers — the automated hygiene sweeps (integrity/orphans/drift/
  // backup/vacuum). Each writes a maintenance_log row; the Health tab surfaces red.
  { type: "db_maintenance", key: "db_maintenance_nightly", payload: { tier: "nightly" }, everyMs: 24 * 3600_000 },       // ~daily
  { type: "db_maintenance", key: "db_maintenance_weekly",  payload: { tier: "weekly"  }, everyMs: 7 * 24 * 3600_000 },   // ~weekly
  { type: "db_maintenance", key: "db_maintenance_monthly", payload: { tier: "monthly" }, everyMs: 30 * 24 * 3600_000 },  // ~monthly
];

// Schedules are keyed by `key` (falling back to `type`) so several schedules can
// share ONE job type but different payloads/cadences (e.g. the maintenance tiers)
// without clobbering each other's last-enqueue cursor.
const metaKey = (keyOrType) => `sched_last_enqueue_${keyOrType}`;

// One scheduler pass. Pure w.r.t. time (now is injectable for tests). Enqueues
// due jobs and records the enqueue time. Returns the list of types enqueued.
export function tickScheduler(now = Date.now(), schedules = SCHEDULES) {
  const fired = [];
  for (const s of schedules) {
    const k = s.key ?? s.type;
    const last = Number(getMeta(metaKey(k), 0)) || 0;
    if (now - last > s.everyMs) {
      enqueueJob({ type: s.type, payload: s.payload ?? {}, priority: s.priority ?? 0 });
      setMeta(metaKey(k), now);
      fired.push(k);
    }
  }
  return fired;
}

// Start the recurring scheduler. Fires once immediately, then every intervalMs
// (default 60s). Returns the interval handle; unref'd so it never keeps the
// event loop alive on its own.
export function startScheduler({ intervalMs = 60_000 } = {}) {
  const run = () => {
    const fired = tickScheduler();
    if (fired.length) console.log(`[scheduler] enqueued: ${fired.join(", ")}`);
  };
  run();
  const handle = setInterval(run, intervalMs);
  if (handle.unref) handle.unref();
  return handle;
}
