// Tiny recurring enqueuer. Runs INSIDE the worker process (not a separate
// process): every minute it checks a hardcoded SCHEDULES table and enqueues a
// job whenever enough wall-clock has passed since it last did so. Last-enqueue
// timestamps live in the existing `meta` table, so schedule state survives a
// worker restart. No cron dependency — a single setInterval drives it.
import { enqueueJob, getMeta, setMeta } from "./store.js";

// everyMs = minimum spacing between enqueues of this type. The handlers
// themselves self-rate-limit further (e.g. maybeDiscover's 12h meta cursor,
// generate_report's 30s gap in the worker), so this only has to be a coarse
// "kick it off roughly this often" cadence.
export const SCHEDULES = [
  { type: "discover_scandals", payload: {}, everyMs: 6 * 3600_000 },       // ~every 6h
  { type: "ingest_all",        payload: {}, everyMs: 7 * 24 * 3600_000 },  // ~weekly
  { type: "source_health",     payload: {}, everyMs: 24 * 3600_000 },      // ~daily
  { type: "anomaly_scan",      payload: {}, everyMs: 7 * 24 * 3600_000 },  // ~weekly
];

const metaKey = (type) => `sched_last_enqueue_${type}`;

// One scheduler pass. Pure w.r.t. time (now is injectable for tests). Enqueues
// due jobs and records the enqueue time. Returns the list of types enqueued.
export function tickScheduler(now = Date.now(), schedules = SCHEDULES) {
  const fired = [];
  for (const s of schedules) {
    const last = Number(getMeta(metaKey(s.type), 0)) || 0;
    if (now - last > s.everyMs) {
      enqueueJob({ type: s.type, payload: s.payload ?? {}, priority: s.priority ?? 0 });
      setMeta(metaKey(s.type), now);
      fired.push(s.type);
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
