// Phase 1 analysis-ledger schema: facts, claims, and evidence_fts.
//
// These tests run against a throwaway temp DB (via PANDOROS_DB_PATH), so importing
// store.js builds the schema from scratch — which is itself the migration test:
// if the DDL is malformed, the import throws here. The rest proves what the
// ledgers promise: (1) a UNIVERSAL subject key (one entity_id, typed by
// subject_kind — so a company or ministry is a first-class subject, not just a
// politician), (2) re-extraction is idempotent (UNIQUE indexes fold duplicates),
// and (3) FTS5 co-occurrence search works.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-ledgers-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db, id } = await import("../server/store.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const tableCols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const objExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

test("schema: universal-subject ledgers + indexes exist, no per-type key columns", () => {
  for (const t of ["facts", "claims", "evidence_fts"]) assert.ok(objExists(t), `${t} missing`);

  // ONE subject key + a kind discriminator on each ledger.
  for (const c of ["entity_id", "subject_kind", "metric", "value", "as_of_date", "extractor_version"])
    assert.ok(tableCols("facts").includes(c), `facts.${c} missing`);
  for (const c of ["subject_entity_id", "subject_kind", "claim_type", "object_entity_id", "status"])
    assert.ok(tableCols("claims").includes(c), `claims.${c} missing`);

  // The politician-specific columns must be GONE — politicians aren't privileged.
  assert.ok(!tableCols("facts").includes("politician_id"), "facts.politician_id should be dropped");
  assert.ok(!tableCols("claims").includes("subject_politician_id"), "claims.subject_politician_id should be dropped");

  for (const idx of ["idx_facts_uniq", "idx_facts_kind", "idx_claims_uniq", "idx_claims_kind", "idx_claims_status"])
    assert.ok(objExists(idx), `${idx} missing`);
});

const insFact = db.prepare(`INSERT OR IGNORE INTO facts
  (id, entity_id, subject_kind, metric, value, unit, as_of_date, period, source_type, tier, evidence_id, extractor_version, created_at, data)
  VALUES (@id, @entity_id, @subject_kind, @metric, @value, @unit, @as_of_date, @period, @source_type, @tier, @evidence_id, @extractor_version, @created_at, @data)`);

const fact = (o) => ({
  id: id(), entity_id: "E0", subject_kind: "person", metric: "declared_assets", value: 0,
  unit: "inr", as_of_date: "2024", period: "LS2024", source_type: "eci_affidavit", tier: 1,
  evidence_id: "ev1", extractor_version: "affidavit-v1", created_at: "t", data: "{}", ...o,
});

test("facts: re-extraction is idempotent (same measurement folds to one row)", () => {
  const base = fact({ entity_id: "E1", value: 30916833 });
  insFact.run(base);
  insFact.run({ ...base, id: id() }); // same logical measurement, new UUID → must NOT duplicate
  const n = db.prepare("SELECT COUNT(*) n FROM facts WHERE entity_id='E1' AND metric='declared_assets' AND as_of_date='2024'").get().n;
  assert.equal(n, 1, "duplicate measurement was not deduped by idx_facts_uniq");

  // A different date for the same subject is a distinct fact (history is kept).
  insFact.run(fact({ entity_id: "E1", as_of_date: "2019", value: 6000000 }));
  const hist = db.prepare("SELECT COUNT(*) n FROM facts WHERE entity_id='E1' AND metric='declared_assets'").get().n;
  assert.equal(hist, 2, "distinct-date fact should coexist, giving a 2-point history");
});

test("facts: a growth-spike query is expressible in plain SQL", () => {
  // The whole point of the ledger: self-join across dates to find a jump.
  const row = db.prepare(`
    SELECT older.value AS v_old, newer.value AS v_new, (newer.value / older.value) AS ratio
    FROM facts older JOIN facts newer
      ON older.entity_id = newer.entity_id AND older.metric = newer.metric
     AND older.as_of_date < newer.as_of_date
    WHERE older.entity_id='E1' AND older.metric='declared_assets'`).get();
  assert.ok(row && row.ratio > 5, `expected >5x growth, got ${row && row.ratio}`);
});

test("facts: the scanner can find outliers AMONG a subject_kind (not just politicians)", () => {
  // A company is a first-class subject: give two companies a contract_value fact,
  // one an outlier. The scanner filters by subject_kind — same query shape it would
  // use for ministries or departments.
  insFact.run(fact({ entity_id: "C1", subject_kind: "company", metric: "contract_value", value: 1_000_000, source_type: "cppp", evidence_id: "t1" }));
  insFact.run(fact({ entity_id: "C2", subject_kind: "company", metric: "contract_value", value: 900_000_000, source_type: "cppp", evidence_id: "t2" }));
  const top = db.prepare(`
    SELECT entity_id, value FROM facts
    WHERE subject_kind='company' AND metric='contract_value'
    ORDER BY value DESC LIMIT 1`).get();
  assert.equal(top.entity_id, "C2", "subject_kind filter should surface the outlier company");
  // And it does NOT bleed into the person cohort.
  const persons = db.prepare("SELECT COUNT(*) n FROM facts WHERE subject_kind='company' AND metric='declared_assets'").get().n;
  assert.equal(persons, 0);
});

test("claims: unverified allegation stored, deduped, and status-filterable", () => {
  const insClaim = db.prepare(`INSERT OR IGNORE INTO claims
    (id, subject_entity_id, subject_kind, claim_type, object_entity_id, object_text, status, confidence, as_of_date, source_type, tier, evidence_id, extractor_version, created_at, data)
    VALUES (@id, @subject_entity_id, @subject_kind, @claim_type, @object_entity_id, @object_text, @status, @confidence, @as_of_date, @source_type, @tier, @evidence_id, @extractor_version, @created_at, @data)`);
  const c = {
    id: id(), subject_entity_id: "e1", subject_kind: "person", claim_type: "named_in_scandal",
    object_entity_id: null, object_text: "coal allocation scam", status: "unverified", confidence: 0.6,
    as_of_date: "2023-05-01", source_type: "news", tier: 9, evidence_id: "ev9",
    extractor_version: "claims-v1", created_at: "t", data: "{}",
  };
  insClaim.run(c);
  insClaim.run({ ...c, id: id() }); // dup → folds
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims WHERE subject_entity_id='e1'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM claims WHERE status='unverified'").get().n, 1);
});

test("evidence_fts: co-occurrence search finds a doc mentioning two entities", () => {
  const insFts = db.prepare(`INSERT INTO evidence_fts (evidence_id, politician_id, source_type, title, summary, body)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insFts.run("d1", "p1", "news", "Land deal probe", "MP Ravi Kumar and Acme Infra named in tender inquiry", "");
  insFts.run("d2", "p2", "news", "Budget session", "Parliament debates the finance bill", "");

  // AND query: only the doc mentioning BOTH terms should match.
  const hits = db.prepare("SELECT evidence_id FROM evidence_fts WHERE evidence_fts MATCH ?")
    .all('"Ravi Kumar" AND "Acme Infra"');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].evidence_id, "d1");
});
