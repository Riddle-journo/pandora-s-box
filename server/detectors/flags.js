// Flag store — the Anomaly Engine's internal suspicion ledger. One row per
// (detector, subject, fingerprint). Severity is two-tier by design:
//   'small' — worth counting, never a lead on its own; feeds clusters.
//   'big'   — strong enough to become an investigation lead directly.
// Flags are working state: a fresh full run of a detector re-emits the flags it
// still believes in; anything it no longer emits is marked 'stale' (kept for the
// audit trail, excluded from synthesis). Leads remain the durable, human-gated
// record — deleting every flag loses nothing that was already promoted.
import { db, id as newId } from "./store.js";

const J = (row) => (row ? JSON.parse(row.data) : null);

const insFlag = db.prepare(`INSERT OR REPLACE INTO flags
  (id, key, detector, severity, score, politician_id, entity_id, status, created_at, updated_at, run_id, data)
  VALUES (@id, @key, @detector, @severity, @score, @politician_id, @entity_id, @status, @created_at, @updated_at, @run_id, @data)`);

// Idempotent upsert keyed on flag.key. A re-emitted flag refreshes severity,
// score, rationale and evidence but keeps its first created_at.
export function upsertFlag(flag) {
  const now = new Date().toISOString();
  const existing = J(db.prepare("SELECT data FROM flags WHERE key = ?").get(flag.key));
  const row = existing
    ? { ...existing, ...flag, id: existing.id, created_at: existing.created_at, updated_at: now, status: "active" }
    : { ...flag, id: newId(), created_at: now, updated_at: now, status: "active" };
  insFlag.run({
    id: row.id, key: row.key, detector: row.detector, severity: row.severity,
    score: Number(row.score) || 0, politician_id: row.politician_id ?? null,
    entity_id: row.entity_id ?? null, status: row.status,
    created_at: row.created_at, updated_at: row.updated_at, run_id: row.run_id ?? null,
    data: JSON.stringify(row),
  });
  return row;
}

// After a FULL (population-wide) run of one detector, everything that run did
// not re-emit is stale — the data no longer supports it. Scoped runs (one
// politician) must NOT call this: silence about reps it never looked at is not
// evidence of anything.
export function markStaleExcept(detector, runId) {
  const rows = db.prepare(
    "SELECT id, data FROM flags WHERE detector = ? AND status = 'active' AND (run_id IS NOT ? )"
  ).all(detector, runId);
  const upd = db.prepare("UPDATE flags SET status = 'stale', data = ? WHERE id = ?");
  for (const r of rows) {
    const d = JSON.parse(r.data);
    d.status = "stale";
    d.stale_at = new Date().toISOString();
    upd.run(JSON.stringify(d), r.id);
  }
  return rows.length;
}

export function listFlags({ detector, severity, status = "active", politicianId, q, limit = 200, offset = 0 } = {}) {
  const where = [], args = [];
  if (status && status !== "all") { where.push("status = ?"); args.push(status); }
  if (detector) { where.push("detector = ?"); args.push(detector); }
  if (severity) { where.push("severity = ?"); args.push(severity); }
  if (politicianId) { where.push("politician_id = ?"); args.push(politicianId); }
  const sql = `SELECT data FROM flags ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY score DESC`;
  let rows = db.prepare(sql).all(...args).map(J);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((f) =>
      (f.subject_name ?? "").toLowerCase().includes(s) ||
      (f.headline ?? "").toLowerCase().includes(s) ||
      (f.detector ?? "").toLowerCase().includes(s));
  }
  return { total: rows.length, rows: rows.slice(offset, offset + limit) };
}

export function flagCounts() {
  const rows = db.prepare(
    "SELECT detector, severity, status, COUNT(*) n FROM flags GROUP BY detector, severity, status"
  ).all();
  const perDetector = {};
  let small = 0, big = 0, stale = 0;
  for (const r of rows) {
    const d = (perDetector[r.detector] ??= { small: 0, big: 0, stale: 0 });
    if (r.status !== "active") { d.stale += r.n; stale += r.n; continue; }
    if (r.severity === "big") { d.big += r.n; big += r.n; } else { d.small += r.n; small += r.n; }
  }
  return { small, big, stale, perDetector };
}

// All active flags for one subject — the input to cluster synthesis.
export function activeFlagsBySubject() {
  const rows = db.prepare("SELECT data FROM flags WHERE status = 'active'").all().map(J);
  const bySubject = new Map(); // subject key → flags[]
  for (const f of rows) {
    const key = f.politician_id ? `pol:${f.politician_id}` : f.entity_id ? `ent:${f.entity_id}` : null;
    if (!key) continue;
    (bySubject.get(key) ?? bySubject.set(key, []).get(key)).push(f);
  }
  return bySubject;
}

export function getFlag(idOrKey) {
  return J(db.prepare("SELECT data FROM flags WHERE id = ? OR key = ? LIMIT 1").get(idOrKey, idOrKey));
}

export function deleteFlags({ detector, status } = {}) {
  if (detector && status) return db.prepare("DELETE FROM flags WHERE detector = ? AND status = ?").run(detector, status).changes;
  if (detector) return db.prepare("DELETE FROM flags WHERE detector = ?").run(detector).changes;
  if (status) return db.prepare("DELETE FROM flags WHERE status = ?").run(status).changes;
  return db.prepare("DELETE FROM flags").run().changes;
}
