// Database maintenance & robustness toolkit. One place for the operational
// hygiene the 346 MB pandoros.db needs: safe rotating backups, integrity +
// orphan checks, a WAL-shrinking vacuum, and a "doctor" preflight that tells
// unconfigured sources apart from genuinely-rare ones.
//
// Everything here is deliberately dependency-free (reuses better-sqlite3 via the
// shared store handle) and honours PANDOROS_DB_PATH exactly like store.js. It is
// read-only except `backup` (writes a copy) and `vacuum` (rewrites in place, and
// only after taking a backup first).
//
// Usage:
//   node server/db-maintenance.js backup   [--keep 5]     rotating VACUUM INTO backup
//   node server/db-maintenance.js check     [--json]      integrity + orphan report (exit 1 on problems)
//   node server/db-maintenance.js doctor    [--days 30]   config/health preflight (unconfigured vs rare sources)
//   node server/db-maintenance.js vacuum                  backup, then VACUUM + ANALYZE + WAL checkpoint
//   node server/db-maintenance.js all                     backup → check → doctor (the nightly routine)
//   node server/db-maintenance.js cron <nightly|weekly|monthly>   the automated tiered sweep (writes maintenance_log)
//   node server/db-maintenance.js task <name>             run ONE maintenance task by name
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { db, id } from "../store/store.js";
import {
  pruneFetchRuns, reclaimRunningJobs, sourceHealth,
  enqueueJob, listPoliticians, lastFetchByPolitician,
  listJobs, jobCounts, getMeta, setMeta, trimJobs,
} from "../store/store.js";
import { dataGovKey } from "./config.js";
import { consoleStyle } from "../util/log.js";
const clog = consoleStyle("db-maintenance");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PANDOROS_DB_PATH || path.join(__dirname, "..", "..", "data", "pandoros.db");
const DATA_DIR = path.dirname(DB_PATH);
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const fmtBytes = (n) => {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ── Backup ──────────────────────────────────────────────────────────────────
// VACUUM INTO writes a fully-consistent, de-fragmented copy with NO -wal/-shm
// sidecars — safer than a raw file copy (which can catch a mid-write WAL) and it
// compacts free pages on the way out. Backups land in data/backups/ with a
// timestamped name; the oldest are pruned so the folder can't grow unbounded.
export function backup({ keep = 5, quiet = false } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `pandoros-${nowStamp()}.db`);
  const t0 = Date.now();
  db.prepare("VACUUM INTO ?").run(dest);
  const size = fs.statSync(dest).size;

  // Prune: keep the newest `keep` timestamped backups, delete the rest.
  const existing = fs.readdirSync(BACKUP_DIR)
    .filter((n) => /^pandoros-.*\.db$/.test(n))
    .map((n) => ({ n, p: path.join(BACKUP_DIR, n), t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const pruned = existing.slice(keep);
  for (const f of pruned) fs.rmSync(f.p, { force: true });

  const out = { dest, size, ms: Date.now() - t0, kept: Math.min(existing.length, keep), pruned: pruned.length };
  if (!quiet) {
    clog.log(`[backup] wrote ${path.relative(DATA_DIR, dest)} (${fmtBytes(size)}) in ${out.ms}ms`);
    if (pruned.length) clog.log(`[backup] pruned ${pruned.length} old backup(s), keeping newest ${keep}`);
  }
  return out;
}

// Report on the legacy scattered .bak files in data/ (from ad-hoc manual copies)
// so the owner can see how much stale backup weight is sitting in the data dir.
export function legacyBackups() {
  const out = [];
  for (const n of fs.readdirSync(DATA_DIR)) {
    if (/\.(bak|bak-[^/]*)$/.test(n) || n.includes(".bak")) {
      const p = path.join(DATA_DIR, n);
      try { out.push({ name: n, size: fs.statSync(p).size }); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

// ── Integrity + referential checks ────────────────────────────────────────────
// SQLite has no enforced foreign keys here (rows carry ids as plain TEXT), so a
// deleted politician can leave orphaned evidence/reports/cards, and a rebuilt
// entity table can strand ledger rows. These queries surface every dangling
// reference so a cleanup pass has an exact target list.
const ORPHAN_CHECKS = [
  { name: "evidence→politician",     sql: "SELECT COUNT(*) c FROM evidence e   WHERE e.politician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = e.politician_id)" },
  { name: "reports→politician",      sql: "SELECT COUNT(*) c FROM reports r    WHERE r.politician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = r.politician_id)" },
  { name: "cards→politician",        sql: "SELECT COUNT(*) c FROM cards c2     WHERE c2.kind = 'politician' AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = c2.subject_key)" },
  { name: "facts→entity",            sql: "SELECT COUNT(*) c FROM facts f      WHERE f.entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = f.entity_id)" },
  { name: "claims→subject_entity",   sql: "SELECT COUNT(*) c FROM claims c     WHERE c.subject_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = c.subject_entity_id)" },
  { name: "relationships→src_entity",sql: "SELECT COUNT(*) c FROM relationships r WHERE r.src_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.src_entity_id)" },
  { name: "relationships→dst_entity",sql: "SELECT COUNT(*) c FROM relationships r WHERE r.dst_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.dst_entity_id)" },
  { name: "entity_aliases→entity",   sql: "SELECT COUNT(*) c FROM entity_aliases a WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = a.entity_id)" },
  { name: "flags→politician",        sql: "SELECT COUNT(*) c FROM flags f      WHERE f.politician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = f.politician_id)" },
  { name: "assertions→entity",       sql: "SELECT COUNT(*) c FROM entity_assertions a WHERE a.entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = a.entity_id)" },
];

export function check() {
  // PRAGMA integrity_check returns a single 'ok' row when the file is sound,
  // else one row per problem. quick_check is the fast structural pass.
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check);
  const integrityOk = integrity.length === 1 && integrity[0] === "ok";

  const orphans = ORPHAN_CHECKS.map((chk) => {
    try { return { name: chk.name, count: db.prepare(chk.sql).get().c }; }
    catch (e) { return { name: chk.name, count: -1, error: e.message }; }
  });
  const totalOrphans = orphans.reduce((s, o) => s + Math.max(0, o.count), 0);

  // PRAGMA foreign_key_check returns one row per violated FK reference.
  // The schema declares no REFERENCES today, so this must come back empty;
  // it's here so any future FK column gets checked by the nightly routine.
  const fkViolations = db.prepare("PRAGMA foreign_key_check").all();

  return {
    integrityOk, integrity, orphans, totalOrphans, fkViolations,
    ok: integrityOk && totalOrphans === 0 && fkViolations.length === 0,
  };
}

// ── Doctor: config/health preflight ───────────────────────────────────────────
// The health CLI already flags QUIET sources (0 items), but it can't tell an
// UNCONFIGURED source (needs a one-time dataset/key that was never set up) from
// a genuinely rare-hit one. This resolves that: it probes the optional local
// datasets and reports exactly which setup steps are still pending.
export async function optionalDatasets() {
  const checks = [];

  // Director names — the FREE system. There is NO freely-available MCA bulk
  // Director dataset (data.gov.in exposes Company Master Data, not directors),
  // so director names come from Tofler, fetched per FLAGGED company and cached
  // in tofler_companies. This reports the real posture and is ALWAYS ok — it
  // never recommends the (nonexistent) bulk download. Enable live fetching with
  // TOFLER_ENRICH=1; without it, the cache still serves whatever was gathered.
  let toflerRows = 0;
  try { toflerRows = db.prepare("SELECT COUNT(*) c FROM tofler_companies").get().c; } catch { /* table absent */ }
  const toflerOn = process.env.TOFLER_ENRICH === "1";
  checks.push({
    id: "director_names", ok: true,
    detail: `Tofler (free, per flagged company) — ${toflerRows} company(ies) cached; live fetch ${toflerOn ? "ON" : "OFF (set TOFLER_ENRICH=1)"}`,
    feeds: "director→politician leads, investigator directorships",
  });

  // PDF OCR — the fallback that reads SCANNED/image-only PDFs (no text layer).
  // Optional deps + off by default; report whether it's installed and enabled.
  let ocrDeps = true;
  try { await import("tesseract.js"); await import("pdf-to-img"); } catch { ocrDeps = false; }
  const ocrOn = process.env.PDF_OCR === "1";
  checks.push({
    id: "pdf_ocr", ok: true,
    detail: ocrDeps
      ? `deps installed; fallback ${ocrOn ? "ON" : "OFF (set PDF_OCR=1)"}${ocrOn ? ` — langs ${process.env.PDF_OCR_LANGS || "eng"}` : ""}`
      : "deps not installed (npm i tesseract.js pdf-to-img @napi-rs/canvas) — scanned PDFs skipped",
    feeds: "scanned-PDF text (press releases, audit reports, affidavits)",
  });

  // CPPP procurement index — backs the cppp fetcher (env CPPP_DB_PATH).
  const cpppPath = process.env.CPPP_DB_PATH || path.join(DATA_DIR, "cppp.db");
  checks.push({
    id: "cppp", ok: fs.existsSync(cpppPath),
    detail: fs.existsSync(cpppPath) ? `present (${fmtBytes(fs.statSync(cpppPath).size)})` : "cppp.db missing",
    fix: "node server/cppp-ingest.js   (builds the local CPPP procurement DB)",
    feeds: "cppp",
  });

  // data.gov.in key — unlocks the json-api L1 sources (FCI, PMFBY, DILRMP, AQI…).
  const dgiKey = dataGovKey();
  checks.push({
    id: "data_gov_key", ok: !!dgiKey,
    detail: dgiKey ? "set" : "no data.gov.in key",
    fix: "register free at data.gov.in → set DATA_GOV_IN_KEY",
    feeds: "company_registry (name→CIN/status) + l1 json-api sources (fci-stock, pmfby-claims, dilrmp-progress, cpcb-aqi)",
  });
  return checks;
}

// ── Integrity: the SQLite file itself ─────────────────────────────────────────
// quick_check is the fast structural pass (nightly); integrity_check scans every
// page (weekly). Both return a single 'ok' row when sound, else one row per fault.
export function integrityCheck({ full = false } = {}) {
  const pragma = full ? "integrity_check" : "quick_check";
  const rows = db.prepare(`PRAGMA ${pragma}`).all().map((r) => Object.values(r)[0]);
  const ok = rows.length === 1 && String(rows[0]).toLowerCase() === "ok";
  return { ok, full, rows: rows.slice(0, 20) };
}

// PRAGMA foreign_key_check. This schema declares no FKs (ids are plain TEXT, which
// is why ORPHAN_CHECKS exists), so this is normally empty — but it's a cheap extra
// net that catches any future declared-FK violation for free.
export function foreignKeyCheck() {
  const rows = db.prepare("PRAGMA foreign_key_check").all();
  return { ok: rows.length === 0, violations: rows.length, rows: rows.slice(0, 20) };
}

// FTS5 self-verify: ask the evidence_fts index to prove it still matches its shadow
// content. On failure, optionally 'rebuild' it from scratch. A desynced FTS index
// silently drops search hits, so this is how text co-occurrence mining stays honest.
export function ftsVerify({ rebuild = false } = {}) {
  try {
    db.prepare("INSERT INTO evidence_fts(evidence_fts) VALUES('integrity-check')").run();
    return { ok: true, rebuilt: false };
  } catch (e) {
    if (!rebuild) return { ok: false, rebuilt: false, error: e.message };
    try {
      db.prepare("INSERT INTO evidence_fts(evidence_fts) VALUES('rebuild')").run();
      return { ok: true, rebuilt: true };
    } catch (e2) { return { ok: false, rebuilt: false, error: e2.message }; }
  }
}

// Fold the write-ahead log back into the main DB and truncate the -wal sidecar, so
// it can't grow unbounded. Reports before/after -wal size; a -wal that won't shrink
// means a long-lived transaction is holding it open (worth a look).
export function walCheckpoint() {
  const walPath = DB_PATH + "-wal";
  const walSize = () => { try { return fs.statSync(walPath).size; } catch { return 0; } };
  const before = walSize();
  const result = db.pragma("wal_checkpoint(TRUNCATE)");
  return { before, after: walSize(), result };
}

// ── Referential hygiene beyond orphans ────────────────────────────────────────
// Duplicate-entity guard: two entities must never share the same STRONG id (the
// exact failure behind the 96-politicians-one-entity bug). Scans every entity's
// strong_ids and flags any id value claimed by more than one entity.
export function duplicateEntityScan() {
  const rows = db.prepare("SELECT id, canonical_name, strong_ids FROM entities WHERE strong_ids IS NOT NULL AND strong_ids != ''").all();
  const owners = new Map(); // "idkey=value" -> Set(entityId)
  for (const r of rows) {
    let ids; try { ids = JSON.parse(r.strong_ids); } catch { continue; }
    if (!ids || typeof ids !== "object") continue;
    for (const [k, v] of Object.entries(ids)) {
      if (v == null || v === "") continue;
      const key = `${k}=${String(v).toLowerCase()}`;
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(r.id);
    }
  }
  const collisions = [];
  for (const [key, set] of owners) if (set.size > 1) collisions.push({ key, entities: [...set] });
  return { scanned: rows.length, collisions: collisions.length, sample: collisions.slice(0, 10) };
}

// Snapshot of every ledger's row count — the size/growth trend recorded each run.
export function rowCounts() {
  const tables = ["politicians", "evidence", "reports", "cards", "entities",
    "facts", "claims", "events", "relationships", "flags", "investigation_leads", "jobs"];
  const out = {};
  for (const t of tables) { try { out[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { out[t] = -1; } }
  return out;
}

// ── Stale-JSON drift: typed rows older than the blob they came from ────────────
// A re-fetched evidence blob re-stamps evidence.fetched_at, but the idempotent
// upsert (keyed on evidence_id+extractor_version, NOT fetched_at) leaves the old
// typed rows in place — so the ledgers silently drift out of sync with the raw
// data. This finds exactly the affected evidence rows via the timestamp join.
export function driftScan({ sample = 12 } = {}) {
  const q = (table) => db.prepare(
    `SELECT x.evidence_id AS eid, COUNT(*) AS n FROM ${table} x JOIN evidence e ON e.id = x.evidence_id
     WHERE x.evidence_id IS NOT NULL AND e.fetched_at IS NOT NULL AND x.created_at IS NOT NULL
       AND e.fetched_at > x.created_at GROUP BY x.evidence_id`).all();
  const f = q("facts"), c = q("claims");
  const ids = new Set([...f.map((r) => r.eid), ...c.map((r) => r.eid)]);
  return {
    evidence: ids.size,
    facts: f.reduce((s, r) => s + r.n, 0),
    claims: c.reduce((s, r) => s + r.n, 0),
    evidenceIds: [...ids],
    sample: [...ids].slice(0, sample),
  };
}

// Heal drift: delete the stale typed rows for the drifted evidence, then re-extract
// them from the current blob. `limit` caps how many evidence rows to heal in one
// pass (0/null = all). Extractors self-register on importing extract-all.js.
export async function driftHeal({ limit = null } = {}) {
  const scan = driftScan();
  let ids = scan.evidenceIds;
  if (limit != null && Number(limit) > 0) ids = ids.slice(0, Number(limit));
  if (!ids.length) return { detected: 0, healed: 0, deleted: { facts: 0, claims: 0 }, reextracted: null };
  await import("../extractors/extract-all.js"); // side-effect: registers every extractor
  const { deleteFactsClaimsByEvidence } = await import("../store/ledger.js");
  const { reExtractEvidence } = await import("../extractors/extract.js");
  const deleted = deleteFactsClaimsByEvidence(ids);
  const reextracted = reExtractEvidence(ids);
  return { detected: scan.evidence, healed: ids.length, deleted, reextracted };
}

// ── Freshness: is the pipeline still alive? ───────────────────────────────────
// Classify per-source fetch health (rotted / quiet / stale) over a window. Thin
// wrapper over the same classifier the ops health endpoint uses.
export async function freshness(days = 14) {
  const rows = sourceHealth(days);
  try {
    const { classifyHealth } = await import("./health.js");
    const { FETCHER_NAMES } = await import("../orchestration/ingest.js");
    const c = classifyHealth(rows, FETCHER_NAMES);
    return { days, sources: rows.length, rotted: c.rotted ?? [], quiet: c.quiet ?? [], stale: c.stale ?? [] };
  } catch (e) {
    return { days, sources: rows.length, rotted: [], quiet: [], stale: [], warn: e.message };
  }
}

// Staleness queue: enqueue an INCREMENTAL ingest for reps never fetched or fetched
// longer than `staleDays` ago. The ingest_all handler already knows how to skip
// fresh reps; here we just kick it. Cheap — it only fetches new/stale items.
export function enqueueStaleIngest({ staleDays = 7 } = {}) {
  const last = lastFetchByPolitician();
  const cutoff = Date.now() - Math.max(0, Number(staleDays) || 0) * 86400_000;
  const stale = listPoliticians().filter((p) => !p.is_demo).filter((p) => {
    const t = last.get(p.id); return t == null || t < cutoff;
  });
  if (!stale.length) return { stale: 0, enqueued: false };
  const job = enqueueJob({ type: "ingest_all", payload: { incremental: true, staleDays } });
  return { stale: stale.length, enqueued: true, jobId: job.id };
}

// Self-healing zombie reclaim: requeue jobs stuck 'running' past `minutes` (a crash
// left them claimed). This is the automated form of the ops console's manual button.
export function reclaimZombies({ minutes = 30 } = {}) {
  return { reclaimed: reclaimRunningJobs({ olderThanMs: Math.max(0, Number(minutes) || 0) * 60_000 }) };
}

// Cache pruning — CACHES ONLY, never ledgers (keep-all-data rule). Trims the
// fetch_runs telemetry ledger and old finished jobs. Raw evidence + typed ledgers
// are never touched here.
export function cachePrune({ fetchRunDays = 90, jobDays = 14 } = {}) {
  const fetchRuns = pruneFetchRuns(fetchRunDays);
  const doneJobs = trimJobs({ status: "done", olderThanMs: jobDays * 86400_000 });
  const deadJobs = trimJobs({ status: "dead", olderThanMs: jobDays * 86400_000 });
  return { fetchRuns, doneJobs, deadJobs };
}

// ── Size & performance ────────────────────────────────────────────────────────
// Refresh the query planner's statistics. Cheap and safe — run it nightly.
export function optimize() {
  db.pragma("optimize");
  db.prepare("ANALYZE").run();
  return { ok: true };
}

// Freelist accounting — how much dead space a VACUUM would reclaim.
export function dbSpace() {
  const page_count = db.pragma("page_count", { simple: true });
  const freelist = db.pragma("freelist_count", { simple: true });
  const page_size = db.pragma("page_size", { simple: true });
  return { bytes: page_count * page_size, page_count, freelist, page_size, freeRatio: page_count ? freelist / page_count : 0 };
}

// Full VACUUM — rewrites the file, reclaiming freelist space. Takes a safety backup
// first (VACUUM rewrites in place), then ANALYZE + WAL checkpoint. Expensive.
export function vacuum({ keep = 5, backupFirst = true } = {}) {
  if (backupFirst) backup({ keep, quiet: true });
  db.prepare("VACUUM").run();
  db.prepare("ANALYZE").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return { size: fs.statSync(DB_PATH).size };
}

// Conditional VACUUM: only pay the cost when dead space exceeds `threshold` (freelist
// ratio). Monthly tier calls this so a healthy DB is left alone.
export function vacuumIfNeeded({ threshold = 0.15, force = false } = {}) {
  const before = dbSpace();
  if (!force && before.freeRatio < threshold) return { vacuumed: false, before, threshold };
  vacuum();
  return { vacuumed: true, threshold, before, after: dbSpace() };
}

// ── Backups: can we actually recover? ─────────────────────────────────────────
// A backup you haven't opened is a hope, not a backup. Open the newest backup file
// read-only and run quick_check on it. Returns red if there is no backup or it's
// unreadable/corrupt.
export function backupVerify() {
  let newest = null;
  try {
    newest = fs.readdirSync(BACKUP_DIR)
      .filter((n) => /^pandoros-.*\.db$/.test(n))
      .map((n) => ({ n, p: path.join(BACKUP_DIR, n), t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0] ?? null;
  } catch { /* no backup dir yet */ }
  if (!newest) return { ok: false, error: "no backup found" };
  let bkp;
  try {
    bkp = new Database(newest.p, { readonly: true, fileMustExist: true });
    const rows = bkp.prepare("PRAGMA quick_check").all().map((r) => Object.values(r)[0]);
    const ok = rows.length === 1 && String(rows[0]).toLowerCase() === "ok";
    const pols = bkp.prepare("SELECT COUNT(*) c FROM politicians").get().c;
    return { ok, file: newest.n, size: fs.statSync(newest.p).size, politicians: pols, rows: ok ? undefined : rows.slice(0, 5) };
  } catch (e) {
    return { ok: false, file: newest.n, error: e.message };
  } finally { try { bkp?.close(); } catch { /* ignore */ } }
}

// ── The maintenance runner: tasks, tiers, findings, and the log ───────────────
// Each task is a thunk returning { status: 'ok'|'warn'|'red', ...data }. runTask
// wraps one and normalises errors to a red finding; runMaintenance composes a tier.

// A tier is skipped-if-busy for its HEAVY tasks: when a concurrent ingest is queued
// or running (the schtasks CLI can overlap the live server worker), vacuum/full
// integrity are deferred rather than fighting for the write lock.
function busyWithIngest() {
  try {
    const running = listJobs({ status: "running" }).some((j) => String(j.type).startsWith("ingest"));
    const queued = listJobs({ status: "queued" }).some((j) => String(j.type).startsWith("ingest"));
    return running || queued;
  } catch { return false; }
}

// Task registry: name -> async () => finding. `heavy` tasks are skipped when busy.
const TASKS = {
  async integrity_quick() { const r = integrityCheck({ full: false }); return { status: r.ok ? "ok" : "red", ...r }; },
  async integrity_full()  { const r = integrityCheck({ full: true });  return { status: r.ok ? "ok" : "red", ...r }; },
  async foreign_keys()    { const r = foreignKeyCheck();                return { status: r.ok ? "ok" : "red", ...r }; },
  async fts_verify()      { const r = ftsVerify({ rebuild: true });     return { status: r.ok ? "ok" : "red", ...r }; },
  async wal_checkpoint()  { const r = walCheckpoint();                  return { status: "ok", ...r }; },
  async orphans()         { const r = check();                         return { status: r.ok ? "ok" : "red", integrityOk: r.integrityOk, totalOrphans: r.totalOrphans, orphans: r.orphans }; },
  async duplicate_entities() { const r = duplicateEntityScan();        return { status: r.collisions ? "red" : "ok", ...r }; },
  async drift_scan()      { const r = driftScan();                     return { status: (r.facts + r.claims) ? "warn" : "ok", ...r }; },
  async drift_heal()      { const r = await driftHeal({});             return { status: "ok", ...r }; },
  async freshness()       { const r = await freshness(14);             return { status: r.rotted.length ? "warn" : "ok", ...r }; },
  async staleness_ingest(){ const r = enqueueStaleIngest({});          return { status: "ok", ...r }; },
  async reclaim_zombies() { const r = reclaimZombies({});              return { status: "ok", ...r }; },
  async cache_prune()     { const r = cachePrune({});                  return { status: "ok", ...r }; },
  async optimize()        { const r = optimize();                      return { status: "ok", ...r }; },
  async backup()          { const r = backup({ quiet: true });         return { status: "ok", dest: path.basename(r.dest), size: r.size, ms: r.ms }; },
  async backup_verify()   { const r = backupVerify();                  return { status: r.ok ? "ok" : "red", ...r }; },
  async vacuum()          { if (busyWithIngest()) return { status: "warn", skipped: "ingest busy" }; const r = vacuum(); return { status: "ok", ...r }; },
  async vacuum_if_needed(){ if (busyWithIngest()) return { status: "warn", skipped: "ingest busy" }; const r = vacuumIfNeeded({}); return { status: "ok", ...r }; },
};
const HEAVY = new Set(["integrity_full", "vacuum", "vacuum_if_needed"]);

// Run one named task, catching failures into a red finding so a tier never aborts.
export async function runMaintenanceTask(name, opts = {}, { log = () => {} } = {}) {
  const fn = TASKS[name];
  if (!fn) throw new Error(`unknown maintenance task: ${name}`);
  const t0 = Date.now();
  try {
    // Task-specific overrides (e.g. drift_heal limit) flow through the opts payload.
    const finding = name === "drift_heal" ? { status: "ok", ...(await driftHeal({ limit: opts.limit ?? null })) }
      : name === "vacuum_if_needed" ? { status: "ok", ...(busyWithIngest() ? { status: "warn", skipped: "ingest busy" } : vacuumIfNeeded({ force: !!opts.force })) }
      : await fn();
    const out = { task: name, ...finding, ms: Date.now() - t0 };
    log(`[maint] ${name}: ${out.status}`);
    return out;
  } catch (e) {
    log(`[maint] ${name} FAILED: ${e.message}`);
    return { task: name, status: "red", error: e.message, ms: Date.now() - t0 };
  }
}

// The tiers. nightly = fast daily hygiene; weekly = deeper checks + drift heal;
// monthly = the expensive rewrite + backup audit. Order matters within a tier.
export const TIERS = {
  nightly: ["wal_checkpoint", "optimize", "integrity_quick", "orphans", "drift_scan", "freshness", "backup", "backup_verify"],
  weekly:  ["integrity_full", "foreign_keys", "fts_verify", "duplicate_entities", "reclaim_zombies", "staleness_ingest", "cache_prune", "drift_heal"],
  monthly: ["vacuum_if_needed", "backup", "backup_verify", "duplicate_entities"],
};

const SEV_RANK = { green: 0, ok: 0, warn: 1, red: 2 };
const worst = (findings) => {
  let s = "green";
  for (const f of findings) if ((SEV_RANK[f.status] ?? 0) > (SEV_RANK[s] ?? 0)) s = f.status === "ok" ? "green" : f.status;
  return s;
};

// Persist one run into maintenance_log. Quiet-by-default lives in the reader/UI:
// green rows are just history; warn/red rows are what the Health tab surfaces.
function writeMaintenanceLog({ tier, status, durationMs, findings }) {
  const rc = rowCounts();
  const rowTotal = Object.values(rc).reduce((s, n) => s + Math.max(0, n), 0);
  const dbSize = (() => { try { return fs.statSync(DB_PATH).size; } catch { return null; } })();
  const redOrWarn = findings.filter((f) => f.status === "red" || f.status === "warn").length;
  db.prepare(`INSERT INTO maintenance_log (id, at, tier, status, duration_ms, db_size, row_count, findings, report)
    VALUES (@id, @at, @tier, @status, @duration_ms, @db_size, @row_count, @findings, @report)`).run({
    id: id(), at: new Date().toISOString(), tier, status,
    duration_ms: durationMs, db_size: dbSize, row_count: rowTotal, findings: redOrWarn,
    report: JSON.stringify({ tier, status, durationMs, dbSize, rowCounts: rc, findings }),
  });
}

// Run a whole tier: singleton-guarded (never overlap with itself), heavy tasks
// deferred when busy, every finding logged. Returns the full report object.
export async function runMaintenance(tier, { log = clog.log, enqueue = true } = {}) {
  const tasks = TIERS[tier];
  if (!tasks) throw new Error(`unknown maintenance tier: ${tier} (use ${Object.keys(TIERS).join("|")})`);

  // Singleton lock: a maintenance run set within the last hour means another run is
  // in flight (or crashed mid-run) — skip rather than double-run heavy work.
  const LOCK = "maintenance_running";
  const lock = getMeta(LOCK, null);
  if (lock && Date.now() - Number(lock) < 3600_000) {
    log(`[maint] ${tier}: another run started ${Math.round((Date.now() - Number(lock)) / 1000)}s ago — skipping.`);
    return { tier, status: "warn", skipped: "locked", findings: [] };
  }
  setMeta(LOCK, Date.now());
  const t0 = Date.now();
  const findings = [];
  try {
    log(`\n[maint] ── tier ${tier} ──`);
    for (const name of tasks) {
      if (!enqueue && (name === "staleness_ingest")) { log(`[maint] ${name}: skipped (enqueue off)`); continue; }
      if (HEAVY.has(name) && busyWithIngest()) { findings.push({ task: name, status: "warn", skipped: "ingest busy" }); log(`[maint] ${name}: skipped (ingest busy)`); continue; }
      findings.push(await runMaintenanceTask(name, {}, { log }));
    }
  } finally { setMeta(LOCK, 0); }

  const durationMs = Date.now() - t0;
  const status = worst(findings);
  writeMaintenanceLog({ tier, status, durationMs, findings });
  log(`[maint] ${tier} done in ${durationMs}ms → ${status.toUpperCase()} (${findings.filter((f) => f.status === "red").length} red, ${findings.filter((f) => f.status === "warn").length} warn)`);
  return { tier, status, durationMs, findings };
}

// Reader for the Ops Console Health tab: the latest N runs (newest first), with the
// most-recent run's full report parsed out for rendering.
export function maintenanceHistory({ limit = 20 } = {}) {
  const rows = db.prepare("SELECT id, at, tier, status, duration_ms, db_size, row_count, findings, report FROM maintenance_log ORDER BY at DESC LIMIT ?").all(limit);
  const latest = rows[0] ? (() => { try { return JSON.parse(rows[0].report); } catch { return null; } })() : null;
  return {
    latest,
    runs: rows.map((r) => ({ id: r.id, at: r.at, tier: r.tier, status: r.status, duration_ms: r.duration_ms, db_size: r.db_size, row_count: r.row_count, findings: r.findings })),
    tiers: Object.keys(TIERS),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };

async function doctor(days) {
  const { sourceHealth } = await import("../store/store.js");
  const health = sourceHealth(days);
  const quiet = health.filter((h) => h.runs > 0 && h.ok_rate >= 0.5 && h.total_items === 0).map((h) => h.source);
  const datasets = await optionalDatasets();

  clog.log(`\n── Doctor (last ${days}d) ────────────────────────────────────────────\n`);
  clog.log("Optional datasets / keys:");
  for (const d of datasets) {
    clog.log(`  ${d.ok ? "✓" : "✗"} ${pad(d.id, 16)} ${d.detail}`);
    if (!d.ok) clog.log(`      feeds: ${d.feeds}\n      fix:   ${d.fix}`);
  }

  // Cross-reference: which QUIET sources are QUIET *because* they're unconfigured.
  const unconfiguredFeeds = new Set(datasets.filter((d) => !d.ok).flatMap((d) => d.feeds.split(",").map((s) => s.trim())));
  const explained = quiet.filter((s) => unconfiguredFeeds.has(s));
  const genuinelyRare = quiet.filter((s) => !unconfiguredFeeds.has(s));
  clog.log(`\nZero-item sources this window: ${quiet.length}`);
  if (explained.length) clog.log(`  unconfigured (fixable): ${explained.join(", ")}`);
  if (genuinelyRare.length) clog.log(`  rare-hit or worth a look: ${genuinelyRare.join(", ")}`);

  const legacy = legacyBackups();
  if (legacy.length) {
    const total = legacy.reduce((s, f) => s + f.size, 0);
    clog.log(`\nLegacy .bak files in data/: ${legacy.length} using ${fmtBytes(total)} — consider moving to data/backups/ and pruning:`);
    for (const f of legacy.slice(0, 6)) clog.log(`  ${pad(fmtBytes(f.size), 9)} ${f.name}`);
  }
  clog.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "all";
  const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const keep = Number(flag("--keep", 5)) || 5;
  const days = Number(flag("--days", 30)) || 30;

  if (cmd === "backup") { backup({ keep }); return process.exit(0); }

  if (cmd === "check") {
    const r = check();
    if (argv.includes("--json")) { clog.log(JSON.stringify(r, null, 2)); return process.exit(r.ok ? 0 : 1); }
    clog.log(`\n── Integrity check ──────────────────────────────────────────────\n`);
    clog.log(`  integrity_check: ${r.integrityOk ? "ok" : "FAILED — " + r.integrity.slice(0, 5).join("; ")}`);
    clog.log(`\n  Orphaned references:`);
    for (const o of r.orphans) {
      const mark = o.count > 0 ? "✗" : o.count < 0 ? "?" : "✓";
      clog.log(`  ${mark} ${pad(o.name, 28)} ${o.error ? "ERR " + o.error : o.count}`);
    }
    clog.log(`\n  ${r.ok ? "✓ clean" : `✗ ${r.totalOrphans} orphaned row(s)` + (r.integrityOk ? "" : " + integrity failure")}\n`);
    return process.exit(r.ok ? 0 : 1);
  }

  if (cmd === "doctor") { await doctor(days); return process.exit(0); }

  if (cmd === "vacuum") {
    clog.log("[vacuum] taking a safety backup first…");
    backup({ keep });
    clog.log("[vacuum] VACUUM…"); db.prepare("VACUUM").run();
    clog.log("[vacuum] ANALYZE…"); db.prepare("ANALYZE").run();
    clog.log("[vacuum] WAL checkpoint (TRUNCATE)…"); db.pragma("wal_checkpoint(TRUNCATE)");
    clog.log(`[vacuum] done. DB now ${fmtBytes(fs.statSync(DB_PATH).size)}`);
    return process.exit(0);
  }

  if (cmd === "all") {
    backup({ keep });
    const r = check();
    clog.log(`[check] integrity ${r.integrityOk ? "ok" : "FAILED"}, ${r.totalOrphans} orphan(s)`);
    await doctor(days);
    return process.exit(r.ok ? 0 : 1);
  }

  // The automated tiered sweep — the entry point Task Scheduler / the queue call.
  if (cmd === "cron") {
    const tier = argv[1] || "nightly";
    if (!TIERS[tier]) { clog.log(`Unknown tier "${tier}". Use: ${Object.keys(TIERS).join(" | ")}`); return process.exit(1); }
    const rep = await runMaintenance(tier, { log: clog.log });
    if (argv.includes("--json")) clog.log(JSON.stringify(rep, null, 2));
    return process.exit(rep.status === "red" ? 1 : 0);
  }

  // Run a single task by name (for scripting / debugging individual checks).
  if (cmd === "task") {
    const name = argv[1];
    if (!name) { clog.log(`Usage: task <name>. Known: ${Object.keys(TASKS).join(", ")}`); return process.exit(1); }
    const limit = flag("--limit"); const out = await runMaintenanceTask(name, { limit: limit != null ? Number(limit) : null, force: argv.includes("--force") }, { log: clog.log });
    clog.log(JSON.stringify(out, null, 2));
    return process.exit(out.status === "red" ? 1 : 0);
  }

  clog.log(`Unknown command "${cmd}". Use: backup | check | doctor | vacuum | all | cron <tier> | task <name>`);
  process.exit(1);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("db-maintenance.js");
if (invokedDirectly) main();
