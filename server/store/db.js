// SQLite connection bootstrap + import-time schema DDL, extracted from store.js.
// This module owns the single DB handle and the schema init so every store
// module shares one connection honouring PANDOROS_DB_PATH.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PANDOROS_DB_PATH || path.join(__dirname, "..", "..", "data", "pandoros.db");

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
