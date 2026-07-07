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
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PANDOROS_DB_PATH || path.join(__dirname, "..", "data", "pandoros.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS politicians (
    id TEXT PRIMARY KEY, name TEXT, name_lc TEXT, constituency_lc TEXT,
    office TEXT, state_lc TEXT, is_demo INTEGER DEFAULT 0, created_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pol_office ON politicians(office);
  CREATE INDEX IF NOT EXISTS idx_pol_state  ON politicians(state_lc);
  CREATE INDEX IF NOT EXISTS idx_pol_dupe   ON politicians(name_lc, constituency_lc);

  CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY, politician_id TEXT, url TEXT, date TEXT,
    has_content INTEGER DEFAULT 0, fetched_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ev_pol  ON evidence(politician_id);
  CREATE INDEX IF NOT EXISTS idx_ev_dupe ON evidence(politician_id, url);

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, politician_id TEXT, generated_at TEXT, report_tier INTEGER,
    overall_grade TEXT, overall_score INTEGER, headline TEXT, update_mode TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rep_pol  ON reports(politician_id);
  CREATE INDEX IF NOT EXISTS idx_rep_pt   ON reports(politician_id, report_tier, generated_at);

  CREATE TABLE IF NOT EXISTS tips (
    id TEXT PRIMARY KEY, politician_id TEXT, status TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tip_pol ON tips(politician_id);

  CREATE TABLE IF NOT EXISTS scandals (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE, status TEXT, date TEXT, discovered_at TEXT, data TEXT
  );

  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE, title TEXT, generated_at TEXT, data TEXT
  );

  CREATE TABLE IF NOT EXISTS investigation_leads (
    id TEXT PRIMARY KEY, key TEXT UNIQUE, status TEXT, vector TEXT,
    actor_id TEXT, signal_score REAL, detected_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_lead_status ON investigation_leads(status);
  CREATE INDEX IF NOT EXISTS idx_lead_actor  ON investigation_leads(actor_id);

  CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT DEFAULT 'queued',
    priority INTEGER DEFAULT 0, run_at INTEGER, attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3, last_error TEXT,
    created_at TEXT, started_at TEXT, finished_at TEXT
  );
  -- Claim order: queued & due first, then highest priority, then oldest run_at.
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at);
`);

export const id = () => crypto.randomUUID();

const J = (row) => (row ? JSON.parse(row.data) : null);
const lc = (s) => String(s ?? "").toLowerCase();

// ---- Politicians ----
export function listPoliticians() {
  return db.prepare("SELECT data FROM politicians").all().map(J);
}

export function getPolitician(pid) {
  return J(db.prepare("SELECT data FROM politicians WHERE id = ?").get(pid));
}

// Politicians + their latest report (any tier), in a single pass. Uses the
// promoted report columns so we never parse a report blob just for the listing.
export function listPoliticiansWithLatest() {
  const pols = db.prepare("SELECT data FROM politicians").all().map(J);
  const latest = db.prepare(`
    SELECT r.politician_id, r.overall_grade, r.overall_score, r.headline, r.report_tier, r.generated_at, r.update_mode
    FROM reports r
    JOIN (SELECT politician_id, MAX(generated_at) mg FROM reports GROUP BY politician_id) m
      ON r.politician_id = m.politician_id AND r.generated_at = m.mg
  `).all();
  const byPol = {};
  for (const r of latest) byPol[r.politician_id] = r;
  return pols.map((p) => {
    const r = byPol[p.id];
    return {
      ...p,
      latest: r ? { grade: r.overall_grade, score: r.overall_score, headline: r.headline, report_tier: r.report_tier, generated_at: r.generated_at, update_mode: r.update_mode } : null,
    };
  });
}

const insPolitician = db.prepare(`INSERT OR REPLACE INTO politicians
  (id, name, name_lc, constituency_lc, office, state_lc, is_demo, created_at, data)
  VALUES (@id, @name, @name_lc, @constituency_lc, @office, @state_lc, @is_demo, @created_at, @data)`);

function polRow(p) {
  return {
    id: p.id, name: p.name ?? "", name_lc: lc(p.name), constituency_lc: lc(p.constituency),
    office: p.office ?? null, state_lc: lc(p.state), is_demo: p.is_demo ? 1 : 0,
    created_at: p.created_at ?? new Date().toISOString(), data: JSON.stringify(p),
  };
}

export function upsertPolitician(p) {
  const existing = p.id ? getPolitician(p.id) : null;
  const row = { ...(existing ?? {}), ...p };
  if (!row.id) row.id = id();
  if (!row.created_at) row.created_at = new Date().toISOString();
  insPolitician.run(polRow(row));
  return row;
}

// Bulk insert. Dedupes on (name, constituency) like the old store. One txn.
export function batchUpsertPoliticians(politicians) {
  const existing = new Set(
    db.prepare("SELECT name_lc, constituency_lc FROM politicians").all().map((r) => `${r.name_lc}|${r.constituency_lc}`)
  );
  const added = [];
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      const key = `${lc(p.name)}|${lc(p.constituency)}`;
      if (existing.has(key)) continue;
      const row = { id: id(), created_at: new Date().toISOString(), ...p };
      insPolitician.run(polRow(row));
      existing.add(key);
      added.push(row);
    }
  });
  tx(politicians);
  return added;
}

// ---- Evidence ----
export function listEvidence(pid) {
  return db.prepare("SELECT data FROM evidence WHERE politician_id = ? ORDER BY date DESC").all(pid).map(J);
}

const insEvidence = db.prepare(`INSERT OR REPLACE INTO evidence
  (id, politician_id, url, date, has_content, fetched_at, data)
  VALUES (@id, @politician_id, @url, @date, @has_content, @fetched_at, @data)`);

function evRow(e) {
  return {
    id: e.id, politician_id: e.politician_id ?? null, url: e.url ?? null, date: e.date ?? "",
    has_content: e.content ? 1 : 0, fetched_at: e.fetched_at ?? new Date().toISOString(), data: JSON.stringify(e),
  };
}

export function addEvidence(items) {
  const added = [];
  const findByUrl = db.prepare("SELECT id, has_content, data FROM evidence WHERE politician_id = ? AND url = ? LIMIT 1");
  const tx = db.transaction((rows) => {
    for (const item of rows) {
      if (item.url) {
        const ex = findByUrl.get(item.politician_id, item.url);
        if (ex) {
          // Upgrade in place when the fresh fetch brings something the stored
          // row lacks: real content over a bare pointer, or the structured
          // `numbers` object (added 2026-07 for the computed-flags layer —
          // without this, evidence ingested before that change would never
          // gain numbers and the deterministic analyzer would stay blind).
          const old = JSON.parse(ex.data);
          const contentUpgrade = item.content && !ex.has_content;
          // Fresh numbers win when: the old row has none, the fresh fetch
          // filled in MORE data (an extraction fix now parses what used to be
          // null), or the values CHANGED (time-series sources like MPLADS move
          // monthly — freezing the first snapshot would rot the computed
          // flags). But NEVER downgrade: a partially-failed fetch (e.g. a
          // relatives list that came back empty because a lookup errored) must
          // not replace richer stored data. Richness counts array lengths, not
          // just key presence.
          const richness = (o) => Object.values(o ?? {}).reduce((s, v) =>
            s + (Array.isArray(v) ? v.length : v != null ? 1 : 0), 0);
          const numbersUpgrade = item.numbers && (
            richness(item.numbers) > richness(old.numbers) ||
            (old.numbers && richness(item.numbers) >= richness(old.numbers)
              && JSON.stringify(item.numbers) !== JSON.stringify(old.numbers))
          );
          if (contentUpgrade || numbersUpgrade) {
            // Stamp a fresh fetched_at: the row genuinely changed, and the
            // incremental report mode selects on fetched_at > last report —
            // keeping the old timestamp would hide the upgrade from it.
            const merged = { ...old, ...item, id: ex.id, fetched_at: new Date().toISOString() };
            insEvidence.run(evRow(merged));
            added.push(merged);
          }
          continue;
        }
      }
      const row = { id: id(), fetched_at: new Date().toISOString(), ...item };
      insEvidence.run(evRow(row));
      added.push(row);
    }
  });
  tx(items);
  return added;
}

// ---- Reports ----
const insReport = db.prepare(`INSERT OR REPLACE INTO reports
  (id, politician_id, generated_at, report_tier, overall_grade, overall_score, headline, update_mode, data)
  VALUES (@id, @politician_id, @generated_at, @report_tier, @overall_grade, @overall_score, @headline, @update_mode, @data)`);

function repRow(r) {
  return {
    id: r.id, politician_id: r.politician_id, generated_at: r.generated_at,
    report_tier: r.report_tier ?? 2, overall_grade: r.overall_grade ?? null,
    overall_score: typeof r.overall_score === "number" ? r.overall_score : null,
    headline: r.headline ?? null, update_mode: r.update_mode ?? null, data: JSON.stringify(r),
  };
}

// One report per politician (the T1/T2 split was removed). Returns the latest.
export function latestReport(pid) {
  return J(db.prepare("SELECT data FROM reports WHERE politician_id = ? ORDER BY generated_at DESC LIMIT 1").get(pid));
}

export function reportHistory(pid) {
  return db.prepare("SELECT data FROM reports WHERE politician_id = ? ORDER BY generated_at DESC").all(pid).map(J);
}

export function addReport(report) {
  const row = { id: id(), generated_at: new Date().toISOString(), ...report };
  if (!report.generated_at) row.generated_at = new Date().toISOString();
  insReport.run(repRow(row));
  return row;
}

// ---- Anonymous tips ----
// Privacy invariant unchanged: tips store only the ISO week, never IP/UA/time.
export function addTip({ politician_id, category, text }) {
  const now = new Date();
  const week = `${now.getUTCFullYear()}-W${String(Math.ceil(((now - new Date(Date.UTC(now.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)).padStart(2, "0")}`;
  const row = { id: id(), politician_id, category, text, week, status: "pending", corroborated: false };
  db.prepare("INSERT INTO tips (id, politician_id, status, data) VALUES (?, ?, ?, ?)").run(row.id, politician_id, "pending", JSON.stringify(row));
  return row;
}

export function listTips({ politician_id, status } = {}) {
  let sql = "SELECT data FROM tips", where = [], args = [];
  if (politician_id) { where.push("politician_id = ?"); args.push(politician_id); }
  if (status)        { where.push("status = ?"); args.push(status); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  return db.prepare(sql).all(...args).map(J);
}

export function reviewTip(tipId, { status, corroborated }) {
  const tip = J(db.prepare("SELECT data FROM tips WHERE id = ?").get(tipId));
  if (!tip) return null;
  if (status) tip.status = status;
  if (typeof corroborated === "boolean") tip.corroborated = corroborated;
  db.prepare("UPDATE tips SET status = ?, data = ? WHERE id = ?").run(tip.status, JSON.stringify(tip), tipId);
  return tip;
}

// ---- Scandals / policy-failure accountability records ----
const insScandal = db.prepare(`INSERT OR REPLACE INTO scandals
  (id, slug, status, date, discovered_at, data) VALUES (@id, @slug, @status, @date, @discovered_at, @data)`);

// Published scandals only (excludes auto-discovered proposals awaiting review).
export function listScandals() {
  return db.prepare("SELECT data FROM scandals WHERE status IS NULL OR status != 'proposed'").all().map(J)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

export function listProposals() {
  return db.prepare("SELECT data FROM scandals WHERE status = 'proposed'").all().map(J)
    .sort((a, b) => String(b.discovered_at ?? "").localeCompare(String(a.discovered_at ?? "")));
}

export function deleteScandal(slug) {
  const r = db.prepare("DELETE FROM scandals WHERE slug = ?").run(slug);
  return r.changes;
}

export function getScandal(idOrSlug) {
  return J(db.prepare("SELECT data FROM scandals WHERE id = ? OR slug = ? LIMIT 1").get(idOrSlug, idOrSlug));
}

export function upsertScandal(s) {
  const existing = s.slug ? J(db.prepare("SELECT data FROM scandals WHERE slug = ?").get(s.slug)) : null;
  const row = existing
    ? { ...existing, ...s, updated_at: new Date().toISOString() }
    : { id: id(), created_at: new Date().toISOString(), ...s };
  if (!row.id) row.id = id();
  insScandal.run({ id: row.id, slug: row.slug ?? null, status: row.status ?? null, date: row.date ?? "", discovered_at: row.discovered_at ?? "", data: JSON.stringify(row) });
  return row;
}

// ---- Investigation leads (conflict-of-interest candidates; SEPARATE collection
// from scandals). A lead is a CANDIDATE, gated behind admin review — it is never
// public until status='published'. status flow: detected → investigated →
// proposed (survived the AI referee) → published | dismissed. ----
const insLead = db.prepare(`INSERT OR REPLACE INTO investigation_leads
  (id, key, status, vector, actor_id, signal_score, detected_at, data)
  VALUES (@id, @key, @status, @vector, @actor_id, @signal_score, @detected_at, @data)`);

// Dedupe on key = vector|actor_id|beneficiary. Re-detection refreshes the
// detector fields but a passed status (from the AI layers) always wins, so an
// already-investigated lead is never silently reset to 'detected'.
export function upsertLead(lead) {
  const key = lead.key ?? `${lead.vector}|${lead.actor_id}|${lead.beneficiary}`;
  const now = new Date().toISOString();
  const existing = J(db.prepare("SELECT data FROM investigation_leads WHERE key = ?").get(key));
  const row = existing
    ? { ...existing, ...lead, key, updated_at: now }
    : { ...lead, id: id(), key, status: lead.status ?? "detected", detected_at: now };
  if (!row.id) row.id = id();
  insLead.run({
    id: row.id, key: row.key, status: row.status ?? "detected", vector: row.vector ?? null,
    actor_id: row.actor_id ?? null, signal_score: Number(row.signal_score) || 0,
    detected_at: row.detected_at ?? now, data: JSON.stringify(row),
  });
  return row;
}

export function getLead(idOrKey) {
  return J(db.prepare("SELECT data FROM investigation_leads WHERE id = ? OR key = ? LIMIT 1").get(idOrKey, idOrKey));
}

export function listLeads({ status } = {}) {
  const rows = status
    ? db.prepare("SELECT data FROM investigation_leads WHERE status = ? ORDER BY signal_score DESC").all(status)
    : db.prepare("SELECT data FROM investigation_leads ORDER BY signal_score DESC").all();
  return rows.map(J);
}

// Leads that survived the AI Investigator + Referee and await human approval.
export function listLeadProposals() {
  return db.prepare("SELECT data FROM investigation_leads WHERE status = 'proposed' ORDER BY signal_score DESC").all().map(J);
}

export function deleteLead(idOrKey) {
  return db.prepare("DELETE FROM investigation_leads WHERE id = ? OR key = ?").run(idOrKey, idOrKey).changes;
}

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
// Sequential, single-process worker consumes these. No new deps: claim/complete
// /fail are plain synchronous better-sqlite3 statements; timing lives in worker.js.
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// Enqueue a job. Dedup: skip if an IDENTICAL type+payload job is already queued
// or running (so a re-run of the scheduler/fan-out never piles up duplicates).
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
// sequential claims can never hand back the same row.
const claimStmt = db.prepare(`
  UPDATE jobs SET status = 'running', started_at = @ts, attempts = attempts + 1
  WHERE id = (
    SELECT id FROM jobs WHERE status = 'queued' AND run_at <= @now
    ORDER BY priority DESC, run_at ASC, created_at ASC LIMIT 1
  )
  RETURNING *`);
export function claimNextJob(now = Date.now()) {
  const row = claimStmt.get({ ts: new Date().toISOString(), now });
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

// Non-mutating look at the next claimable job (worker uses it to gate on rate
// budget before claiming). Same ordering as claimNextJob.
const peekStmt = db.prepare(
  "SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY priority DESC, run_at ASC, created_at ASC LIMIT 1");
export function peekNextJob(now = Date.now()) {
  const row = peekStmt.get(now);
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

export function getJob(idOrNull) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(idOrNull);
  return row ? { ...row, payload: safeParse(row.payload) } : null;
}

export function listJobs({ status } = {}) {
  const rows = status
    ? db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY priority DESC, run_at ASC").all(status)
    : db.prepare("SELECT * FROM jobs ORDER BY priority DESC, run_at ASC").all();
  return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

// ---- Maintenance / reset helpers ----
export function deleteAllJobs() {
  return db.prepare("DELETE FROM jobs").run().changes;
}

export function deleteAllReports() {
  return db.prepare("DELETE FROM reports").run().changes;
}

// Wipe ALL ingested evidence (for a clean re-ingest). Politicians untouched.
export function deleteAllEvidence() {
  return db.prepare("DELETE FROM evidence").run().changes;
}

// Find a politician by exact id, else by case-insensitive name match (for
// friendly test runs like `report-generator.js "Narendra Modi"`).
export function findPolitician(idOrName) {
  const byId = getPolitician(idOrName);
  if (byId) return byId;
  const q = lc(idOrName);
  const row = db.prepare("SELECT data FROM politicians WHERE name_lc = ? AND is_demo = 0 LIMIT 1").get(q)
    || db.prepare("SELECT data FROM politicians WHERE name_lc LIKE ? AND is_demo = 0 LIMIT 1").get(`%${q}%`);
  return J(row);
}

// Delete content-less "pointer" evidence — generic portal/search URLs with no
// readable content. News leads (source_type 'news') and fact-checks are kept:
// their headline IS the content. Returns rows removed.
export function purgeUselessPointers() {
  return db.prepare(
    "DELETE FROM evidence WHERE has_content = 0 AND json_extract(data, '$.source_type') NOT IN ('news','fact_check')"
  ).run().changes;
}

export function removeDemoPoliticians() {
  const demo = db.prepare("SELECT id FROM politicians WHERE is_demo = 1").all().map((r) => r.id);
  if (!demo.length) return { politicians: 0, reports: 0, evidence: 0 };
  const tx = db.transaction(() => {
    let reports = 0, evidence = 0;
    for (const pid of demo) {
      reports += db.prepare("DELETE FROM reports WHERE politician_id = ?").run(pid).changes;
      evidence += db.prepare("DELETE FROM evidence WHERE politician_id = ?").run(pid).changes;
    }
    const pols = db.prepare("DELETE FROM politicians WHERE is_demo = 1").run().changes;
    return { politicians: pols, reports, evidence };
  });
  return tx();
}

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
