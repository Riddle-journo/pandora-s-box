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
// WAL allows one writer at a time; without a busy timeout a second writer (e.g. a
// background ingest running alongside the Ops worker) throws SQLITE_BUSY instantly.
// Wait-and-retry for up to 15s so concurrent writers serialise instead of failing.
db.pragma("busy_timeout = 15000");

// ── Ledger-shape migration ───────────────────────────────────────────────
// The facts/claims analysis ledgers moved to universal entity subjects
// (entity_id NOT NULL + subject_kind). They are rebuildable by design (delete
// by extractor_version, re-extract), so an old-shape table is dropped and
// recreated rather than ALTERed — the raw evidence blobs are the source of truth.
for (const t of ["facts", "claims"]) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (exists) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes("subject_kind")) db.exec(`DROP TABLE ${t}`);
  }
}

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

  -- Summarizer report cards (Branch 1). One row per generation; latest wins.
  -- kind: politician | ministry | party. subject_key: politician id or org slug.
  -- scope: 'union' or a state name (for state-level ministries/parties).
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_key TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'union', card_version INTEGER, generated_at TEXT,
    score INTEGER, grade TEXT, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_subject ON cards(kind, subject_key, generated_at);

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

  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY, slug TEXT UNIQUE, status TEXT, headline TEXT,
    generated_at INTEGER, lead_ids TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);

  CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT DEFAULT 'queued',
    priority INTEGER DEFAULT 0, run_at INTEGER, attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3, last_error TEXT,
    created_at TEXT, started_at TEXT, finished_at TEXT
  );
  -- Claim order: queued & due first, then highest priority, then oldest run_at.
  CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at);

  CREATE TABLE IF NOT EXISTS fetch_runs (
    id TEXT PRIMARY KEY, source TEXT, politician_id TEXT, ok INTEGER,
    items INTEGER, ms INTEGER, error TEXT, at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_fetch_runs_src ON fetch_runs(source, at);

  -- Canonical entity layer. Fetchers keep fuzzy-matching names independently, but
  -- now they also RECORD each identity decision as an assertion, so it can be
  -- audited, improved, or undone. entities are the resolved canonical records.
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY, kind TEXT, canonical_name TEXT, name_lc TEXT,
    strong_ids TEXT, created_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind, name_lc);

  CREATE TABLE IF NOT EXISTS entity_aliases (
    entity_id TEXT, alias TEXT, alias_lc TEXT, source TEXT,
    UNIQUE (entity_id, alias_lc)
  );
  CREATE INDEX IF NOT EXISTS idx_entity_aliases_lc ON entity_aliases(alias_lc);

  CREATE TABLE IF NOT EXISTS entity_assertions (
    id TEXT PRIMARY KEY, subject_kind TEXT, raw_name TEXT, source TEXT,
    source_ref TEXT, politician_id TEXT, entity_id TEXT, confidence REAL,
    method TEXT, status TEXT, evidence_url TEXT, detector_version TEXT,
    created_at TEXT, decided_at TEXT, data TEXT,
    UNIQUE (source, source_ref, raw_name, politician_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assertions_status ON entity_assertions(status);
  CREATE INDEX IF NOT EXISTS idx_assertions_src    ON entity_assertions(source, raw_name);

  -- Temporal relationship/event store. Relationships/events between entities carry
  -- validity dates + per-edge evidence provenance, so temporal questions ("who
  -- owned this company WHEN the tender was awarded") become answerable instead of
  -- being recomputed statelessly in memory on every request.
  CREATE TABLE IF NOT EXISTS relationships (
    id TEXT PRIMARY KEY, src_entity_id TEXT, dst_entity_id TEXT, rel_type TEXT,
    valid_from TEXT, valid_to TEXT, confidence REAL, evidence_id TEXT, source TEXT,
    detector_version TEXT, created_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rel_src ON relationships(src_entity_id, rel_type);
  CREATE INDEX IF NOT EXISTS idx_rel_dst ON relationships(dst_entity_id, rel_type);
  -- Null valid_from folds to '' so re-runs are idempotent under INSERT OR IGNORE.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_uniq
    ON relationships(src_entity_id, dst_entity_id, rel_type, source, coalesce(valid_from, ''));

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, kind TEXT, at TEXT, entity_ids TEXT, evidence_id TEXT,
    source TEXT, created_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uniq
    ON events(kind, source, coalesce(at, ''), entity_ids);

  -- ── Analysis ledger layer (Phase 1) ─────────────────────────────────────────
  -- Everything above is the DISPLAY store: whole objects in the data blob column,
  -- feeding pages. The ledgers below are the ANALYSIS store: the comparable bits
  -- pulled OUT of those blobs into typed, dated, indexed rows, so the DB can diff,
  -- and cross-join them to surface anomalies. Blobs stay the source of truth; the
  -- ledgers are always rebuildable (delete by extractor_version, re-extract), so
  -- improving an extractor never risks the raw data.
  --
  -- UNIVERSAL SUBJECT: every ledger row points at ONE entity_id (→ entities.id),
  -- never a per-type column. A subject can be ANY kind of node — person (incl.
  -- politician, family, associate), company, party, ministry, department, org —
  -- so the scanner treats all of them symmetrically. subject_kind is a denormalized
  -- copy of entities.kind, so "outliers among companies" is as cheap to ask as
  -- "outliers among politicians". Extraction MUST resolve the subject to an entity
  -- first (creating a provisional entity if none exists), so entity_id is always
  -- present; the raw source id (politician_id, raw name) is kept in the data blob
  -- for provenance. Politicians are not special here — they are kind='person'
  -- entities carrying strong_ids.politician_id, exactly like the graph already does.

  -- Numeric ledger — one row per measured quantity, per subject, per date. Feeds
  -- the statistical detectors in server/anomaly.js (peer outlier, growth spike).
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL, subject_kind TEXT,
    metric TEXT, value REAL, unit TEXT,
    as_of_date TEXT, period TEXT,
    source_type TEXT, tier INTEGER,
    evidence_id TEXT, extractor_version TEXT, created_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(entity_id, metric, as_of_date);
  CREATE INDEX IF NOT EXISTS idx_facts_kind    ON facts(subject_kind, metric, value);
  -- Re-running an extractor is idempotent: same measurement/subject/date/source
  -- (per version) folds to one row under INSERT OR IGNORE.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_uniq ON facts(
    metric, entity_id, coalesce(as_of_date,''), coalesce(evidence_id,''), coalesce(extractor_version,'')
  );

  -- Claim ledger — allegations/links asserted by a source, WITH confidence + a
  -- verification status. Kept separate from facts so an unverified news claim never
  -- mixes into a tier-1 affidavit number. subject → (claim_type) → object, where
  -- BOTH sides are entities (object_text holds an as-yet-unresolved name).
  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    subject_entity_id TEXT NOT NULL, subject_kind TEXT,
    claim_type TEXT, object_entity_id TEXT, object_text TEXT,
    status TEXT DEFAULT 'unverified', confidence REAL,
    as_of_date TEXT, source_type TEXT, tier INTEGER,
    evidence_id TEXT, extractor_version TEXT, created_at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_claims_subj   ON claims(subject_entity_id, claim_type);
  CREATE INDEX IF NOT EXISTS idx_claims_kind   ON claims(subject_kind, claim_type);
  CREATE INDEX IF NOT EXISTS idx_claims_obj    ON claims(object_entity_id, claim_type);
  CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_uniq ON claims(
    claim_type, subject_entity_id,
    coalesce(object_entity_id,''), coalesce(object_text,''),
    coalesce(evidence_id,''), coalesce(extractor_version,'')
  );

  -- (The events table above IS the third ledger — one row per dated occurrence.)

  -- Full-text index over evidence prose. Standalone FTS5 table, populated by
  -- server/backfill-fts.js. Turns "every doc mentioning both X and Y" from a 36k
  -- blob scan into an indexed MATCH — the basis for text co-occurrence mining.
  CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
    evidence_id UNINDEXED, politician_id UNINDEXED, source_type UNINDEXED,
    title, summary, body, tokenize = 'unicode61'
  );
`);

// Shared connection for the entity layer (server/entities.js) — one DB handle,
// one schema init, honouring PANDOROS_DB_PATH exactly like every other table here.
export { db };

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
  insReport.run(repRow(row));
  return row;
}

// ---- Summarizer report cards (Branch 1) ----
const insCard = db.prepare(`INSERT OR REPLACE INTO cards
  (id, kind, subject_key, scope, card_version, generated_at, score, grade, data)
  VALUES (@id, @kind, @subject_key, @scope, @card_version, @generated_at, @score, @grade, @data)`);

export function addCard(card) {
  const row = { id: id(), generated_at: new Date().toISOString(), ...card };
  insCard.run({
    id: row.id, kind: row.kind, subject_key: row.subject_key,
    scope: row.scope ?? "union", card_version: row.card_version ?? null,
    generated_at: row.generated_at,
    score: typeof row.score === "number" ? row.score : null,
    grade: row.grade ?? null, data: JSON.stringify(row),
  });
  return row;
}

export function latestCard(kind, subjectKey, scope = null) {
  const sql = scope
    ? "SELECT data FROM cards WHERE kind = ? AND subject_key = ? AND scope = ? ORDER BY generated_at DESC LIMIT 1"
    : "SELECT data FROM cards WHERE kind = ? AND subject_key = ? ORDER BY generated_at DESC LIMIT 1";
  const args = scope ? [kind, subjectKey, scope] : [kind, subjectKey];
  return J(db.prepare(sql).get(...args));
}

// Like listPoliticiansWithLatest, but joined against cards instead of reports.
export function listPoliticiansWithCard() {
  const pols = db.prepare("SELECT data FROM politicians").all().map(J);
  const latest = db.prepare(`
    SELECT c.subject_key, c.grade, c.score, c.generated_at,
           json_extract(c.data, '$.headline') headline
    FROM cards c
    JOIN (SELECT subject_key, MAX(generated_at) mg FROM cards WHERE kind = 'politician' GROUP BY subject_key) m
      ON c.subject_key = m.subject_key AND c.generated_at = m.mg
    WHERE c.kind = 'politician'
  `).all();
  const byPol = {};
  for (const r of latest) byPol[r.subject_key] = r;
  return pols.map((p) => {
    const r = byPol[p.id];
    return { ...p, card: r ? { grade: r.grade, score: r.score, headline: r.headline, generated_at: r.generated_at } : null };
  });
}

// One indexed row per latest politician card with the leaderboard-relevant
// computed facts pulled out via json_extract — avoids parsing 4,000+ blobs.
export function cardLeaderboardRows() {
  return db.prepare(`
    SELECT c.subject_key id, c.grade, c.score,
      json_extract(c.data,'$.computed_facts.criminal_cases')      cases,
      json_extract(c.data,'$.computed_facts.net_worth')           net_worth_num,
      json_extract(c.data,'$.computed_facts.net_worth_display')   net_worth,
      json_extract(c.data,'$.computed_facts.asset_growth_multiple') asset_growth_x
    FROM cards c
    JOIN (SELECT subject_key, MAX(generated_at) mg FROM cards WHERE kind = 'politician' GROUP BY subject_key) m
      ON c.subject_key = m.subject_key AND c.generated_at = m.mg
    WHERE c.kind = 'politician'
  `).all();
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

// ---- Lead feedback ledger (the human-decision signal for precision reporting) ----
// `decision`: approved | rejected | dismissed | glm_proposed | glm_dismissed.
// `detector` is derived from the lead's data.engine_flag_key / data.flags when
// present so cluster leads attribute back to their contributing detectors.
// Table created HERE (not in the later flags/engine_settings db.exec block) —
// module top-level code runs in order, so the CREATE TABLE must precede this
// db.prepare() of an INSERT against it, or every import of this module throws
// "no such table: lead_feedback" before a single line of app code runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_feedback (
    id TEXT PRIMARY KEY, lead_key TEXT, lead_id TEXT, vector TEXT, detector TEXT,
    decision TEXT, source TEXT, signal_score REAL, at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_vector ON lead_feedback(vector, decision);
  CREATE INDEX IF NOT EXISTS idx_feedback_detector ON lead_feedback(detector, decision);
`);
const insFeedback = db.prepare(`INSERT INTO lead_feedback
  (id, lead_key, lead_id, vector, detector, decision, source, signal_score, at, data)
  VALUES (@id, @lead_key, @lead_id, @vector, @detector, @decision, @source, @signal_score, @at, @data)`);

export function recordLeadFeedback(lead, decision, { source = "admin" } = {}) {
  if (!lead) return null;
  // Attribute to contributing detectors: a cluster lead lists them; a promoted big
  // flag carries its flag key (detector is the prefix); else fall back to the vector.
  const detectors = new Set();
  if (Array.isArray(lead.data?.flags)) for (const f of lead.data.flags) if (f.detector) detectors.add(f.detector);
  if (lead.data?.engine_flag_key) detectors.add(String(lead.data.engine_flag_key).split("|")[0]);
  if (!detectors.size && lead.vector) detectors.add(String(lead.vector).toLowerCase());
  const now = new Date().toISOString();
  for (const detector of detectors) {
    insFeedback.run({
      id: id(), lead_key: lead.key ?? null, lead_id: lead.id ?? null,
      vector: lead.vector ?? null, detector, decision, source,
      signal_score: Number(lead.signal_score) || 0, at: now,
      data: JSON.stringify({ headline: lead.headline, actor_name: lead.actor_name }),
    });
  }
  return { decision, detectors: [...detectors] };
}

// Per-detector precision: approvals vs rejections/dismissals, with a suggestion
// when the reject rate is high on a meaningful sample. Suggestion-only — the ops
// console shows it; nothing auto-changes a threshold.
export function detectorPrecision({ minSample = 5 } = {}) {
  const rows = db.prepare(`
    SELECT detector, decision, COUNT(*) n, AVG(signal_score) avg_score
    FROM lead_feedback GROUP BY detector, decision
  `).all();
  const byDetector = {};
  for (const r of rows) {
    const d = (byDetector[r.detector] ??= { detector: r.detector, approved: 0, rejected: 0, dismissed: 0, glm_proposed: 0, glm_dismissed: 0, avg_score: 0, total: 0 });
    d[r.decision] = (d[r.decision] ?? 0) + r.n;
    d.total += r.n;
  }
  const out = [];
  for (const d of Object.values(byDetector)) {
    const judged = d.approved + d.rejected + d.dismissed; // human-decided only
    const rejectRate = judged >= 1 ? (d.rejected + d.dismissed) / judged : null;
    let suggestion = null;
    if (judged >= minSample && rejectRate != null) {
      if (rejectRate >= 0.8) suggestion = `High reject rate (${Math.round(rejectRate * 100)}% of ${judged}) — consider RAISING this detector's thresholds (fewer, stronger flags).`;
      else if (rejectRate <= 0.2 && d.approved >= minSample) suggestion = `Low reject rate (${Math.round(rejectRate * 100)}% of ${judged}) — this detector is reliable; you could LOWER thresholds to surface more.`;
    }
    out.push({ ...d, judged, reject_rate: rejectRate, suggestion });
  }
  out.sort((a, b) => (b.reject_rate ?? -1) - (a.reject_rate ?? -1));
  return out;
}

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
// (lead_feedback table is created earlier, right before its first db.prepare() —
// see the "Lead feedback ledger" section above.)

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

// ---- Stories (incident-centric narrative articles built from verified leads) ----
// A story is generated as status:'draft' and advances draft → proposed →
// published (or rejected) through the admin gate — never public until published.
const insStory = db.prepare(`INSERT OR REPLACE INTO stories
  (id, slug, status, headline, generated_at, lead_ids, data)
  VALUES (@id, @slug, @status, @headline, @generated_at, @lead_ids, @data)`);

export function upsertStory(s) {
  const existing = s.slug ? J(db.prepare("SELECT data FROM stories WHERE slug = ?").get(s.slug)) : null;
  const row = existing ? { ...existing, ...s } : { id: id(), ...s };
  if (!row.id) row.id = id();
  if (row.status == null) row.status = "draft";
  insStory.run({
    id: row.id, slug: row.slug ?? null, status: row.status,
    headline: row.headline ?? null,
    generated_at: Number(row.generated_at) || null,
    lead_ids: JSON.stringify(row.lead_ids ?? []),
    data: JSON.stringify(row),
  });
  return row;
}

export function getStory(idOrSlug) {
  return J(db.prepare("SELECT data FROM stories WHERE id = ? OR slug = ? LIMIT 1").get(idOrSlug, idOrSlug));
}

export function listStories({ status } = {}) {
  const rows = status
    ? db.prepare("SELECT data FROM stories WHERE status = ? ORDER BY generated_at DESC").all(status)
    : db.prepare("SELECT data FROM stories ORDER BY generated_at DESC").all();
  return rows.map(J);
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

// ---- Queue control: pause / cancel / edit / requeue / trim ----
// Pause is a persisted meta flag the worker consults before each claim, so it
// survives a restart and BOTH the in-process and standalone workers honour it.
// (Pausing doesn't kill the running job — a serial worker finishes it, mirroring
// the existing "SIGINT finishes the current job" semantics.)
const QUEUE_PAUSED_KEY = "worker_paused";
export function isQueuePaused() { return getMeta(QUEUE_PAUSED_KEY, false) === true; }
export function setQueuePaused(on) { return setMeta(QUEUE_PAUSED_KEY, !!on); }

// Cancel a QUEUED job (delete it). A running job can't be yanked mid-flight from a
// serial worker, so the caller pauses the queue and lets it finish. Returns
// { ok, reason?, status? }.
export function cancelJob(id) {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  if (!job) return { ok: false, reason: "not found" };
  if (job.status === "running") return { ok: false, reason: "running", status: "running" };
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  return { ok: true };
}

// Patch a QUEUED job's priority / run_at / payload — nothing else is editable
// (a running/done/dead job is history). `payload`, when supplied, fully replaces
// the old one. Returns { ok, job? } / { ok:false, reason }.
export function updateJob(id, { priority, payload, runAt } = {}) {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  if (!job) return { ok: false, reason: "not found" };
  if (job.status !== "queued") return { ok: false, reason: `not editable (${job.status})` };
  const sets = [], vals = { id };
  if (priority !== undefined) { sets.push("priority = @priority"); vals.priority = Number(priority) || 0; }
  if (runAt !== undefined)    { sets.push("run_at = @run_at");     vals.run_at = Math.round(Number(runAt) || Date.now()); }
  if (payload !== undefined)  { sets.push("payload = @payload");   vals.payload = JSON.stringify(payload ?? {}); }
  if (sets.length) db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = @id`).run(vals);
  return { ok: true, job: getJob(id) };
}

// Re-run a finished/dead/failed job: reset it to queued, clear attempts + error,
// make it due now. Refuses jobs still queued/running (nothing to re-run yet).
export function requeueJob(id) {
  const job = db.prepare("SELECT status FROM jobs WHERE id = ?").get(id);
  if (!job) return { ok: false, reason: "not found" };
  if (job.status === "queued" || job.status === "running") return { ok: false, reason: `already ${job.status}` };
  db.prepare(`UPDATE jobs SET status = 'queued', attempts = 0, last_error = NULL,
      run_at = @now, started_at = NULL, finished_at = NULL WHERE id = @id`).run({ id, now: Date.now() });
  return { ok: true, job: getJob(id) };
}

// Reset orphaned 'running' jobs back to 'queued'. A serial worker processes one
// job at a time, so a 'running' row with no live worker is a zombie left by a
// crash or restart mid-job. olderThanMs>0 reclaims only jobs whose started_at is
// older than the cutoff, so a MANUAL reclaim while a worker is live won't yank the
// job it's actively running; the worker itself calls this with 0 at boot, when it
// is the sole consumer and nothing of its own can be running yet. attempts is
// preserved (not reset), so a job that keeps zombie-ing still dead-letters. Returns
// the count reclaimed.
export function reclaimRunningJobs({ olderThanMs = 0 } = {}) {
  if (olderThanMs > 0) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return db.prepare(
      "UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND (started_at IS NULL OR started_at < ?)")
      .run(cutoff).changes;
  }
  return db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run().changes;
}

// Bulk-trim jobs. Filter by status and/or type; olderThanMs drops only jobs
// created before the cutoff. RUNNING jobs are NEVER trimmed. Returns count deleted.
export function trimJobs({ status, type, olderThanMs } = {}) {
  const where = ["status != 'running'"], vals = {};
  if (status) { where.push("status = @status"); vals.status = status; }
  if (type)   { where.push("type = @type");     vals.type = type; }
  if (olderThanMs != null) {
    where.push("created_at < @cutoff");
    vals.cutoff = new Date(Date.now() - Number(olderThanMs)).toISOString();
  }
  return db.prepare(`DELETE FROM jobs WHERE ${where.join(" AND ")}`).run(vals).changes;
}

// ---- Fetch-run health tracking ----
// One row per fetcher per ingestFor() call. This is how the platform notices a
// scraper has rotted: at 100+ sources, a source that silently returns [] forever
// is invisible without a per-source runs/success/items ledger.
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

// Per-source_type evidence coverage: how many rows, how many carry real content,
// and the freshest fetch. source_type lives in the JSON blob (not a hot column).
export function evidenceCoverage() {
  return db.prepare(`
    SELECT json_extract(data, '$.source_type') AS source_type,
           COUNT(*)          AS rows,
           SUM(has_content)  AS with_content,
           MAX(fetched_at)   AS last_fetched
    FROM evidence GROUP BY source_type ORDER BY rows DESC`).all()
    .map((r) => ({
      source_type: r.source_type ?? "(unknown)",
      rows: r.rows,
      with_content: r.with_content ?? 0,
      last_fetched: r.last_fetched ?? null,
    }));
}

// Real (non-demo) reps with zero evidence rows / with no report at all — the two
// coverage gaps the owner most needs to see. Also returns the non-demo total.
export function politiciansMissing() {
  const total = db.prepare("SELECT COUNT(*) c FROM politicians WHERE is_demo = 0").get().c;
  const noEvidence = db.prepare(
    "SELECT COUNT(*) c FROM politicians p WHERE p.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.politician_id = p.id)").get().c;
  const noReport = db.prepare(
    "SELECT COUNT(*) c FROM politicians p WHERE p.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.politician_id = p.id)").get().c;
  return { total, noEvidence, noReport };
}

// Jobs grouped by status ({ queued, running, done, dead }) for the queue header.
export function jobCounts() {
  return tally(db.prepare("SELECT status AS k, COUNT(*) AS n FROM jobs GROUP BY status").all());
}

// Map of politician_id → evidence-row count (one query), for the roster grid's
// per-rep evidence column and the has-evidence filter.
export function evidenceCounts() {
  const m = {};
  for (const r of db.prepare("SELECT politician_id AS pid, COUNT(*) AS n FROM evidence GROUP BY politician_id").all()) {
    m[r.pid] = r.n;
  }
  return m;
}

export function pingDb() { return db.prepare("SELECT 1 AS ok").get().ok === 1; }
