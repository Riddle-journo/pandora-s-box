// Analysis ledgers — idempotent writers + readers for the facts & claims tables
// (the numeric ledger and the allegation ledger). This is the write surface of
// the ANALYSIS store, the sibling of server/relations.js (which owns events +
// relationships) and server/entities.js (the entity layer). Same idiom as
// relations.js: INSERT OR IGNORE dedupes via the table's UNIQUE index, and each
// writer returns {id, inserted}. Extractors (server/extract.js) and detectors
// (server/anomaly.js) write through here rather than touching SQL directly.
//
// Shared better-sqlite3 handle from store.js (one connection, one schema init).
import { db, id } from "./store.js";

const J = (v) => JSON.stringify(v ?? {});
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const parseFact = (r) => ({ ...r, data: safeJson(r.data) });
const parseClaim = (r) => ({ ...r, data: safeJson(r.data) });

// Idempotent via idx_facts_uniq
// (metric, entity_id, coalesce(as_of_date,''), coalesce(evidence_id,''), coalesce(extractor_version,'')).
export function upsertFact(f = {}) {
  if (!f.entity_id) throw new Error("upsertFact: entity_id is required (resolve the subject first)");
  const row = {
    id: id(), entity_id: f.entity_id, subject_kind: f.subject_kind ?? null,
    metric: f.metric, value: f.value == null ? null : Number(f.value), unit: f.unit ?? null,
    as_of_date: f.as_of_date ?? null, period: f.period ?? null,
    source_type: f.source_type ?? null, tier: f.tier ?? null,
    evidence_id: f.evidence_id ?? null, extractor_version: f.extractor_version ?? null,
    created_at: new Date().toISOString(), data: J(f.data),
  };
  const info = db.prepare(`INSERT OR IGNORE INTO facts
    (id, entity_id, subject_kind, metric, value, unit, as_of_date, period, source_type, tier, evidence_id, extractor_version, created_at, data)
    VALUES (@id,@entity_id,@subject_kind,@metric,@value,@unit,@as_of_date,@period,@source_type,@tier,@evidence_id,@extractor_version,@created_at,@data)`).run(row);
  if (info.changes === 0) {
    const ex = db.prepare(
      "SELECT id FROM facts WHERE metric=? AND entity_id=? AND coalesce(as_of_date,'')=coalesce(?,'') AND coalesce(evidence_id,'')=coalesce(?,'') AND coalesce(extractor_version,'')=coalesce(?,'') LIMIT 1"
    ).get(row.metric, row.entity_id, row.as_of_date, row.evidence_id, row.extractor_version);
    return { id: ex?.id ?? null, inserted: false };
  }
  return { id: row.id, inserted: true };
}

// Idempotent via idx_claims_uniq
// (claim_type, subject_entity_id, coalesce(object_entity_id,''), coalesce(object_text,''), coalesce(evidence_id,''), coalesce(extractor_version,'')).
export function upsertClaim(c = {}) {
  if (!c.subject_entity_id) throw new Error("upsertClaim: subject_entity_id is required (resolve the subject first)");
  const row = {
    id: id(), subject_entity_id: c.subject_entity_id, subject_kind: c.subject_kind ?? null,
    claim_type: c.claim_type, object_entity_id: c.object_entity_id ?? null, object_text: c.object_text ?? null,
    status: c.status ?? "unverified", confidence: c.confidence == null ? null : Number(c.confidence),
    as_of_date: c.as_of_date ?? null, source_type: c.source_type ?? null, tier: c.tier ?? null,
    evidence_id: c.evidence_id ?? null, extractor_version: c.extractor_version ?? null,
    created_at: new Date().toISOString(), data: J(c.data),
  };
  const info = db.prepare(`INSERT OR IGNORE INTO claims
    (id, subject_entity_id, subject_kind, claim_type, object_entity_id, object_text, status, confidence, as_of_date, source_type, tier, evidence_id, extractor_version, created_at, data)
    VALUES (@id,@subject_entity_id,@subject_kind,@claim_type,@object_entity_id,@object_text,@status,@confidence,@as_of_date,@source_type,@tier,@evidence_id,@extractor_version,@created_at,@data)`).run(row);
  if (info.changes === 0) {
    const ex = db.prepare(
      "SELECT id FROM claims WHERE claim_type=? AND subject_entity_id=? AND coalesce(object_entity_id,'')=coalesce(?,'') AND coalesce(object_text,'')=coalesce(?,'') AND coalesce(evidence_id,'')=coalesce(?,'') AND coalesce(extractor_version,'')=coalesce(?,'') LIMIT 1"
    ).get(row.claim_type, row.subject_entity_id, row.object_entity_id, row.object_text, row.evidence_id, row.extractor_version);
    return { id: ex?.id ?? null, inserted: false };
  }
  return { id: row.id, inserted: true };
}

// Reprocessing lever: drop every facts/claims row a given extractor version wrote,
// so an improved extractor can re-run cleanly. Raw evidence is untouched, so this
// is always safe — the ledgers are rebuildable by design.
export function deleteByExtractorVersion(version) {
  const facts = db.prepare("DELETE FROM facts WHERE extractor_version = ?").run(version).changes;
  const claims = db.prepare("DELETE FROM claims WHERE extractor_version = ?").run(version).changes;
  return { facts, claims };
}

// ── readers (for detectors + tests) ─────────────────────────────────────────
export function factsFor(entityId, metric = null) {
  return (metric
    ? db.prepare("SELECT * FROM facts WHERE entity_id=? AND metric=? ORDER BY as_of_date").all(entityId, metric)
    : db.prepare("SELECT * FROM facts WHERE entity_id=? ORDER BY metric, as_of_date").all(entityId)
  ).map(parseFact);
}
export function claimsFor(entityId, claimType = null) {
  return (claimType
    ? db.prepare("SELECT * FROM claims WHERE subject_entity_id=? AND claim_type=?").all(entityId, claimType)
    : db.prepare("SELECT * FROM claims WHERE subject_entity_id=?").all(entityId)
  ).map(parseClaim);
}
