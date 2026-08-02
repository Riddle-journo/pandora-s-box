// SQLite-backed data store (better-sqlite3, synchronous — matches the old
// JSON store's sync API exactly, so nothing else in the app changes).
//
// Why the swap: the old JSON store loaded + rewrote the ENTIRE db.json on every
// read and write. With ~4,500 reps, two report tiers each, and Sansad verbatim
// text (~30 KB/MP), that file became a scaling wall. SQLite gives indexed,
// row-level reads/writes and only touches what a query needs.
//
// Each row keeps its full object as JSON in a `data` column (so arbitrary
// fields survive untouched, exactly like before); a few hot columns are
// promoted for fast filtering/sorting without parsing every blob.
//
// Migrating from db.json:  node server/migrate-to-sqlite.js
import fs from "node:fs";
import { db } from "./db.js";
import { id, J } from "./shared.js";
// Politicians/evidence/reports/cards domain lives in ./store/politicians.js.
// These internal helpers are imported back for migrateFromJson (which also
// touches non-domain tables and so stays here); the public functions are
// re-exported through the facade line further below.
import {
  insPolitician, polRow, insEvidence, evRow, insReport, repRow,
} from "./politicians.js";
// Content domain (scandals/stories/leads/tips) lives in ./store/content.js.
// insScandal is imported back for migrateFromJson (stays here); the public
// functions are re-exported through the facade line further below.
import { insScandal } from "./content.js";

// Shared connection for the entity layer (server/entities.js) — one DB handle,
// one schema init, honouring PANDOROS_DB_PATH exactly like every other table here.
export { db } from "./db.js";

// `id` is defined in ./store/shared.js so store/* modules can use it without
// importing store.js; re-exported here to keep store.js the single public site.
export { id } from "./shared.js";

// ---- Politicians / evidence / reports / cards (moved to ./store/politicians.js) ----
export {
  listPoliticians, getPolitician, listPoliticiansWithLatest, upsertPolitician,
  batchUpsertPoliticians, listEvidence, addEvidence, latestReport, reportHistory,
  addReport, addCard, latestCard, listPoliticiansWithCard, cardLeaderboardRows,
  deleteAllReports, deleteAllEvidence, findPolitician, removeDemoPoliticians,
  evidenceCoverage, evidenceCounts, politiciansMissing,
} from "./politicians.js";

// ---- Content domain (scandals / stories / leads / tips) moved to
// ./store/content.js — re-exported through the facade below. lead_feedback's
// CREATE TABLE (and recordLeadFeedback/detectorPrecision that use it) moved with
// it; the flags/engine_settings db.exec block below no longer references it. ----
export {
  addTip, listTips, reviewTip,
  listScandals, listProposals, deleteScandal, getScandal, upsertScandal,
  upsertLead, getLead, listLeads, listLeadProposals, deleteLead,
  recordLeadFeedback, detectorPrecision,
  upsertStory, getStory, listStories,
} from "./content.js";

// ---- Tofler company cache (director enrichment for FLAGGED companies only). ----
// One row per company we've looked up on Tofler, keyed by a stable company_key
// (CIN when known, else a name slug). This is BOTH the dedup guard (never re-hit
// Tofler for a company already fetched recently) and the persistence layer that
// Phase 2's director→politician matching will read. Decoupled from any single
// politician on purpose: a flag can be a collusion cluster or a tender award with
// no actor attached, yet its directors are still worth caching.
db.exec(`
  CREATE TABLE IF NOT EXISTS tofler_companies (
    company_key TEXT PRIMARY KEY, cin TEXT, name TEXT, fetched_at TEXT, data TEXT
  );
`);

export function getToflerCompany(companyKey) {
  return J(db.prepare("SELECT data FROM tofler_companies WHERE company_key = ? LIMIT 1").get(companyKey));
}

export function upsertToflerCompany(rec) {
  const now = new Date().toISOString();
  const row = { ...rec, fetched_at: rec.fetched_at ?? now };
  db.prepare(`INSERT OR REPLACE INTO tofler_companies (company_key, cin, name, fetched_at, data)
    VALUES (@company_key, @cin, @name, @fetched_at, @data)`).run({
    company_key: row.company_key, cin: row.cin ?? null, name: row.name ?? null,
    fetched_at: row.fetched_at, data: JSON.stringify(row),
  });
  return row;
}

export function listToflerCompanies() {
  return db.prepare("SELECT data FROM tofler_companies ORDER BY fetched_at DESC").all().map(J);
}

// (Lead feedback ledger — lead_feedback table, recordLeadFeedback,
// detectorPrecision — moved to ./store/content.js.)

// Reverse director lookup by PERSON name. This is the FREE replacement for the
// (unobtainable) MCA bulk Director dataset: there is no free comprehensive
// director index, so director names come from Tofler, fetched per FLAGGED
// company and kept in the tofler_companies cache. This scans that cache for a
// company whose board lists `name`. Targeted (only flagged companies are
// cached), not comprehensive — by design. Returns rows shaped for consumers
// that expect { company_name, cin, designation, active, matched_name, ... }.
const _dirNorm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
export function lookupDirectorCompaniesByName(name, { limit = 25 } = {}) {
  const q = _dirNorm(name);
  const qTokens = q.split(" ").filter((t) => t.length >= 3);
  if (!qTokens.length) return [];
  const out = [];
  for (const co of listToflerCompanies()) {
    for (const d of co.directors ?? []) {
      const dt = new Set(_dirNorm(d.name).split(" ").filter((t) => t.length >= 3));
      const hit = qTokens.filter((t) => dt.has(t)).length;
      if (hit / qTokens.length >= 0.6) {
        out.push({
          company_name: co.name ?? co.cin, cin: co.cin ?? null,
          designation: "Director", active: true,
          matched_name: d.name, matched_din: d.din ?? null,
          source_url: co.source_url ?? null, source: "tofler",
        });
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// ---- Anomaly Engine: flags + tunable settings ----
// A FLAG is the engine's internal unit of suspicion — smaller than a lead. Every
// detector emits flags (severity 'small' | 'big'); the lead-synthesis layer then
// promotes big flags and multi-flag clusters into investigation_leads, carrying
// the flags' evidence citations. Flags are rebuildable working state (re-running
// a detector refreshes them); leads carry the human-gated lifecycle.
// engine_settings holds the DB-backed tunables the ops console edits live —
// key 'engine.<detector>.<param>' → JSON value; absent key = code default.
db.exec(`
  CREATE TABLE IF NOT EXISTS flags (
    id TEXT PRIMARY KEY, key TEXT UNIQUE, detector TEXT, severity TEXT,
    score REAL, politician_id TEXT, entity_id TEXT, status TEXT DEFAULT 'active',
    created_at TEXT, updated_at TEXT, run_id TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_flags_detector ON flags(detector, status);
  CREATE INDEX IF NOT EXISTS idx_flags_severity ON flags(severity, status);
  CREATE INDEX IF NOT EXISTS idx_flags_pol      ON flags(politician_id, status);

  CREATE TABLE IF NOT EXISTS engine_settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at TEXT
  );
`);
// (lead_feedback table is created in ./store/content.js, right before its first
// db.prepare() — see the "Lead feedback ledger" section there.)

// ---- Issues (policy-area analyses: India context + party/govt stances) ----
const insIssue = db.prepare(`INSERT OR REPLACE INTO issues
  (id, slug, title, generated_at, data) VALUES (@id, @slug, @title, @generated_at, @data)`);

export function listIssues() {
  return db.prepare("SELECT data FROM issues").all().map(J);
}
export function getIssue(idOrSlug) {
  return J(db.prepare("SELECT data FROM issues WHERE id = ? OR slug = ? LIMIT 1").get(idOrSlug, idOrSlug));
}
export function upsertIssue(s) {
  const existing = s.slug ? J(db.prepare("SELECT data FROM issues WHERE slug = ?").get(s.slug)) : null;
  const row = existing ? { ...existing, ...s } : { id: id(), created_at: new Date().toISOString(), ...s };
  if (!row.id) row.id = id();
  insIssue.run({ id: row.id, slug: row.slug ?? null, title: row.title ?? "", generated_at: row.generated_at ?? "", data: JSON.stringify(row) });
  return row;
}

// (Stories domain moved to ./store/content.js and re-exported via the facade.)

// ---- Global meta (cursors like last_discovery_at) ----
export function getMeta(key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setMeta(key, value) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  return value;
}

// ---- Jobs (minimal SQLite-backed job queue) ----
// The jobs table domain lives in ./store/jobs.js; re-exported here so the
// store.js facade stays the single public import site.
export {
  enqueueJob, claimNextJob, peekNextJob, completeJob, failJob, getJob, listJobs,
  cancelJob, updateJob, requeueJob, reclaimRunningJobs, trimJobs, deleteAllJobs,
} from "./jobs.js";

// ---- Queue control: pause / cancel / edit / requeue / trim ----
// Pause is a persisted meta flag the worker consults before each claim, so it
// survives a restart and BOTH the in-process and standalone workers honour it.
// (Pausing doesn't kill the running job — a serial worker finishes it, mirroring
// the existing "SIGINT finishes the current job" semantics.)
const QUEUE_PAUSED_KEY = "worker_paused";
export function isQueuePaused() { return getMeta(QUEUE_PAUSED_KEY, false) === true; }
export function setQueuePaused(on) { return setMeta(QUEUE_PAUSED_KEY, !!on); }

// ---- Fetch-run health tracking ----
// One row per fetcher per ingestFor() call. This is how the platform notices a
// scraper has rotted: at 100+ sources, a source that silently returns [] forever
// is invisible without a per-source runs/success/items ledger.
/** @param {{ source?: string, politician_id?: string|null, ok?: boolean|number,
 *            items?: number, ms?: number, error?: unknown, at?: number }} [run] */
export function recordFetchRun({ source, politician_id = null, ok, items = 0, ms = 0, error = null, at = Date.now() } = {}) {
  const row = {
    id: id(), source, politician_id: politician_id ?? null, ok: ok ? 1 : 0,
    items: Number(items) || 0, ms: Number(ms) || 0,
    error: error != null ? String(error).slice(0, 500) : null,
    at: Math.round(Number(at) || Date.now()),
  };
  db.prepare(`INSERT INTO fetch_runs (id, source, politician_id, ok, items, ms, error, at)
    VALUES (@id, @source, @politician_id, @ok, @items, @ms, @error, @at)`).run(row);
  return row;
}

// Per-source aggregates over the last `days`. Returns one row per source that
// ran in the window: { source, runs, ok_rate, total_items, last_success_at, last_error }.
export function sourceHealth(days = 14) {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare(`
    SELECT source,
      COUNT(*)                                AS runs,
      SUM(ok)                                 AS oks,
      SUM(items)                              AS total_items,
      MAX(CASE WHEN ok = 1 THEN at END)       AS last_success_at
    FROM fetch_runs WHERE at >= ? GROUP BY source ORDER BY source`).all(since);
  const lastErrStmt = db.prepare(
    "SELECT error FROM fetch_runs WHERE source = ? AND ok = 0 AND error IS NOT NULL AND at >= ? ORDER BY at DESC LIMIT 1");
  return rows.map((r) => ({
    source: r.source,
    runs: r.runs,
    ok_rate: r.runs ? r.oks / r.runs : 0,
    total_items: r.total_items ?? 0,
    last_success_at: r.last_success_at ?? null,
    last_error: lastErrStmt.get(r.source, since)?.error ?? null,
  }));
}

// Per-source, per-DAY run series — the time dimension sourceHealth() aggregates
// away. Volume-drop detection needs it: a source that returns HTTP 200 and zero
// rows scores identically to a healthy fetcher for a quiet politician, and only
// a source's own trailing baseline can tell those apart.
//
// The bucket is a DAY, not a run, on purpose. fetch_runs rows are per
// (source, politician), so items-per-run varies enormously between politicians;
// comparing one latest run against a cross-politician median would be pure noise.
// A day's mean items-per-successful-run is the smallest unit that is comparable
// over time. `oks` is carried through so a consumer can require a day to hold
// enough successful runs to be worth trusting.
//
// Rows are oldest-first, so the LAST row for a source is its most recent day.
// Days are UTC (SQLite's unixepoch), which is fine: the comparison is
// day-over-day within one source, not against wall-clock expectations.
/** @param {{ days?: number, source?: string|null }} [opts]
 *  @returns {{ source: string, day: string, runs: number, oks: number,
 *              items: number, avg_items: number }[]} */
export function fetchRunDailySeries({ days = 45, source = null } = {}) {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare(`
    SELECT source,
      date(at / 1000, 'unixepoch') AS day,
      COUNT(*)                     AS runs,
      SUM(ok)                      AS oks,
      SUM(CASE WHEN ok = 1 THEN items ELSE 0 END) AS items
    FROM fetch_runs
    WHERE at >= ? ${source ? "AND source = ?" : ""}
    GROUP BY source, day
    ORDER BY source, day`).all(...(source ? [since, source] : [since]));
  return rows.map((r) => ({
    source: r.source,
    day: r.day,
    runs: r.runs,
    oks: r.oks ?? 0,
    items: r.items ?? 0,
    // Mean items per SUCCESSFUL run: a day where half the runs errored must not
    // look like a volume collapse (that is ROTTED's job, not VOLUME_DROP's).
    avg_items: r.oks ? (r.items ?? 0) / r.oks : 0,
  }));
}

export function pruneFetchRuns(olderThanDays = 90) {
  const cutoff = Date.now() - olderThanDays * 86400000;
  return db.prepare("DELETE FROM fetch_runs WHERE at < ?").run(cutoff).changes;
}

// Map of politician_id → last fetch_run timestamp (ms). A rep ABSENT from the map
// has never been ingested — incremental ingest treats those as always-due (they
// are exactly the "latest additions" a fresh roster_update leaves behind).
export function lastFetchByPolitician() {
  const rows = db.prepare(
    "SELECT politician_id AS id, MAX(at) AS at FROM fetch_runs WHERE politician_id IS NOT NULL GROUP BY politician_id").all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.at);
  return m;
}

// ---- Fetcher-failure telemetry (DELIBERATELY NOT fetch_runs) ----
// A degraded fetcher return ("the parse yielded nothing", "this PDF has no text
// layer", "we stopped at the row cap") is a real finding and has to survive a
// restart. It is NOT a fetch RUN, and it must never enter fetch_runs, because
// fetch_runs.source is a closed vocabulary: sourceHealth() GROUPs BY it, and
// every consumer of that (health.js, worker.js's health sweep, GET
// /api/ops/health, db-maintenance's freshness()) treats each distinct value as a
// configured source and each 0%-ok source as ROTTED — "provably broken". Writing
// phase rows there would make the rot detector manufacture rot: one transient
// 503, one scanned PDF or one page-cap hit would redden the automation gate.
// So the phase telemetry gets its own table with its own (source, phase) key,
// read explicitly by the health CLI and never mixed into source aggregates.
db.exec(`
  CREATE TABLE IF NOT EXISTS fetch_failures (
    id TEXT PRIMARY KEY, source TEXT, phase TEXT, message TEXT, url TEXT, at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fetch_failures_key ON fetch_failures(source, phase, at);
  CREATE INDEX IF NOT EXISTS idx_fetch_failures_at  ON fetch_failures(at);
`);

/** One degraded-return event. `source` must be a configured fetcher id — callers
 *  that cannot attribute the failure to one (an arbitrary news host, say) record
 *  in-process only and never reach here.
 *  @param {{ source?: string, phase?: string, message?: unknown, url?: string|null, at?: number }} [ev] */
export function recordFetchFailure({ source, phase, message = null, url = null, at = Date.now() } = {}) {
  const row = {
    id: id(), source: String(source ?? "?"), phase: String(phase ?? "?"),
    message: message != null ? String(message).slice(0, 500) : null,
    url: url != null ? String(url).slice(0, 500) : null,
    at: Math.round(Number(at) || Date.now()),
  };
  db.prepare(`INSERT INTO fetch_failures (id, source, phase, message, url, at)
    VALUES (@id, @source, @phase, @message, @url, @at)`).run(row);
  return row;
}

// Per-(source, phase) aggregates over the last `days`, most frequent first.
// Read-only; the health CLI's persistent counterpart to fetchFailureInventory().
/** @param {{ days?: number, limit?: number }} [opts] */
export function fetchFailureHealth({ days = 14, limit = 200 } = {}) {
  const since = Date.now() - days * 86400000;
  return db.prepare(`
    SELECT source, phase, COUNT(*) AS count, MAX(at) AS last_at, MIN(at) AS first_at
    FROM fetch_failures WHERE at >= ?
    GROUP BY source, phase ORDER BY count DESC, source, phase LIMIT ?`).all(since, limit)
    .map((r) => ({
      ...r,
      key: `${r.source}#${r.phase}`,
      last_message: db.prepare(
        "SELECT message FROM fetch_failures WHERE source = ? AND phase = ? AND at >= ? ORDER BY at DESC LIMIT 1")
        .get(r.source, r.phase, since)?.message ?? null,
    }));
}

// ALL-TIME distinct fetch_runs.source values with their row counts and span.
// Exists so the health CLI can report `source` values that are NOT a configured
// fetcher — junk keys written by a buggy caller — without any window clipping
// hiding them. Strictly read-only: it never deletes anything.
export function fetchRunSourceCounts() {
  return db.prepare(`
    SELECT source, COUNT(*) AS rows, SUM(ok) AS oks, MIN(at) AS first_at, MAX(at) AS last_at
    FROM fetch_runs GROUP BY source ORDER BY rows DESC`).all()
    .map((r) => ({ ...r, oks: r.oks ?? 0 }));
}

// ---- Maintenance / reset helpers ----
// (deleteAllReports, deleteAllEvidence, findPolitician, removeDemoPoliticians
// moved to ./store/politicians.js and are re-exported through the facade above.)

// ---- One-time migration from the old data/db.json ----
export function migrateFromJson(jsonPath, { force = false } = {}) {
  const existing = db.prepare("SELECT COUNT(*) c FROM politicians").get().c;
  if (existing > 0 && !force) throw new Error(`SQLite already has ${existing} politicians — re-run with force to overwrite.`);
  const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const counts = {};
  const tx = db.transaction(() => {
    if (force) for (const t of ["politicians", "evidence", "reports", "tips", "scandals", "meta"]) db.prepare(`DELETE FROM ${t}`).run();
    for (const p of json.politicians ?? []) insPolitician.run(polRow({ id: id(), created_at: new Date().toISOString(), ...p }));
    for (const e of json.evidence ?? [])   insEvidence.run(evRow(e));
    for (const r of json.reports ?? [])     insReport.run(repRow(r));
    for (const t of json.tips ?? [])        db.prepare("INSERT OR REPLACE INTO tips (id, politician_id, status, data) VALUES (?,?,?,?)").run(t.id ?? id(), t.politician_id ?? null, t.status ?? "pending", JSON.stringify(t));
    for (const s of json.scandals ?? [])    insScandal.run({ id: s.id ?? id(), slug: s.slug ?? null, status: s.status ?? null, date: s.date ?? "", discovered_at: s.discovered_at ?? "", data: JSON.stringify(s) });
    for (const [k, v] of Object.entries(json.meta ?? {})) db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(k, JSON.stringify(v));
    counts.politicians = (json.politicians ?? []).length;
    counts.evidence = (json.evidence ?? []).length;
    counts.reports = (json.reports ?? []).length;
    counts.tips = (json.tips ?? []).length;
    counts.scandals = (json.scandals ?? []).length;
  });
  tx();
  return counts;
}

export function counts() {
  const c = {};
  for (const t of ["politicians", "evidence", "reports", "tips", "scandals"]) c[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  return c;
}

// ---- Ops-console aggregates (read-only; power the monitoring dashboard) ----

// Turn [{k, n}] rows into a plain { k: n } map (stable shape for the UI).
function tally(rows, key = "k") {
  const out = {};
  for (const r of rows) out[r[key] ?? "(none)"] = r.n;
  return out;
}

// Grade distribution over the LATEST report per politician (history is ignored),
// plus jobs / leads / scandals / stories counted by status — the headline tiles.
export function statsSummary() {
  const grades = db.prepare(`
    SELECT overall_grade AS k, COUNT(*) AS n FROM reports r
    WHERE generated_at = (SELECT MAX(generated_at) FROM reports r2 WHERE r2.politician_id = r.politician_id)
    GROUP BY overall_grade`).all();
  const byStatus = (table) =>
    tally(db.prepare(`SELECT status AS k, COUNT(*) AS n FROM ${table} GROUP BY status`).all());
  return {
    counts: counts(),
    grades: tally(grades),
    jobs: byStatus("jobs"),
    leads: byStatus("investigation_leads"),
    scandals: byStatus("scandals"),
    stories: byStatus("stories"),
  };
}

// (evidenceCoverage, politiciansMissing, evidenceCounts moved to
// ./store/politicians.js and are re-exported through the facade above.)

// Jobs grouped by status ({ queued, running, done, dead }) for the queue header.
export function jobCounts() {
  return tally(db.prepare("SELECT status AS k, COUNT(*) AS n FROM jobs GROUP BY status").all());
}

export function pingDb() { return db.prepare("SELECT 1 AS ok").get().ok === 1; }
