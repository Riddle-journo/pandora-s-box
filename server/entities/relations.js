// Temporal relationship/event store. Persists edges between entities with
// validity dates and per-edge evidence provenance, so "who owned this company
// WHEN the tender was awarded" is a query, not a stateless in-memory recompute.
//
// Uses the shared better-sqlite3 handle from store.js (one connection, one schema
// init, PANDOROS_DB_PATH honoured), like server/entities.js.
import { db, id } from "../store/store.js";

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

function parseRel(r) {
  const data = safeJson(r.data);
  // Null valid_from = unknown-start: surface it so callers know the window is open
  // on the left rather than genuinely beginning at time zero.
  if (r.valid_from == null) data.undated = true;
  return { ...r, data };
}
const parseEvent = (r) => ({ ...r, entity_ids: safeJson(r.entity_ids), data: safeJson(r.data) });

// Idempotent via the unique index (src,dst,rel_type,source,coalesce(valid_from,'')).
export function upsertRelationship(r = {}) {
  const row = {
    id: id(), src_entity_id: r.src_entity_id, dst_entity_id: r.dst_entity_id,
    rel_type: r.rel_type, valid_from: r.valid_from ?? null, valid_to: r.valid_to ?? null,
    confidence: Number(r.confidence) || 0, evidence_id: r.evidence_id ?? null,
    source: r.source ?? "", detector_version: r.detector_version ?? null,
    created_at: new Date().toISOString(), data: JSON.stringify(r.data ?? {}),
  };
  const info = db.prepare(`INSERT OR IGNORE INTO relationships
    (id, src_entity_id, dst_entity_id, rel_type, valid_from, valid_to, confidence, evidence_id, source, detector_version, created_at, data)
    VALUES (@id,@src_entity_id,@dst_entity_id,@rel_type,@valid_from,@valid_to,@confidence,@evidence_id,@source,@detector_version,@created_at,@data)`).run(row);
  if (info.changes === 0) {
    const ex = db.prepare(
      "SELECT id FROM relationships WHERE src_entity_id = ? AND dst_entity_id = ? AND rel_type = ? AND source = ? AND coalesce(valid_from,'') = coalesce(?,'') LIMIT 1"
    ).get(row.src_entity_id, row.dst_entity_id, row.rel_type, row.source, row.valid_from);
    return { id: ex?.id ?? null, inserted: false };
  }
  return { id: row.id, inserted: true };
}

// Raise an existing edge's confidence (never lowers it) and merge fields into its
// `data`. Plan A2 uses this to mark an extraction edge CORROBORATED once a second
// independent source (a Tofler DIRECTOR_LINK lead) confirms the same politician↔company
// link — without minting a duplicate edge. Returns true if the row existed.
export function updateRelationship(relId, { confidence, data } = {}) {
  const row = db.prepare("SELECT confidence, data FROM relationships WHERE id = ?").get(relId);
  if (!row) return false;
  const nextData = data ? { ...safeJson(row.data), ...data } : safeJson(row.data);
  const nextConf = confidence != null ? Math.max(Number(row.confidence) || 0, Number(confidence) || 0) : row.confidence;
  db.prepare("UPDATE relationships SET confidence = ?, data = ? WHERE id = ?").run(nextConf, JSON.stringify(nextData), relId);
  return true;
}

// Idempotent via the unique index (kind,source,coalesce(at,''),entity_ids).
export function upsertEvent(e = {}) {
  const entity_ids = JSON.stringify(e.entity_ids ?? []);
  const row = {
    id: id(), kind: e.kind, at: e.at ?? null, entity_ids,
    evidence_id: e.evidence_id ?? null, source: e.source ?? "",
    created_at: new Date().toISOString(), data: JSON.stringify(e.data ?? {}),
  };
  const info = db.prepare(`INSERT OR IGNORE INTO events
    (id, kind, at, entity_ids, evidence_id, source, created_at, data)
    VALUES (@id,@kind,@at,@entity_ids,@evidence_id,@source,@created_at,@data)`).run(row);
  if (info.changes === 0) {
    const ex = db.prepare(
      "SELECT id FROM events WHERE kind = ? AND source = ? AND coalesce(at,'') = coalesce(?,'') AND entity_ids = ? LIMIT 1"
    ).get(row.kind, row.source, row.at, entity_ids);
    return { id: ex?.id ?? null, inserted: false };
  }
  return { id: row.id, inserted: true };
}

// True when the relationship is active at ISO date `at`. Null valid_to = still
// open (sentinel far-future); null valid_from = unknown start → not excluded on
// the left, only on the right (an edge that already ended before `at` is out).
function activeAt(r, at) {
  const to = r.valid_to ?? "9999-12-31";
  if (at > to) return false;
  if (r.valid_from == null) return true;
  return r.valid_from <= at;
}

// Edges touching an entity (either direction). Optional relType filter, optional
// `at` date-window filter. Rows with null valid_from are flagged data.undated.
export function relationsOf(entityId, { relType, at } = {}) {
  let sql = "SELECT * FROM relationships WHERE (src_entity_id = ? OR dst_entity_id = ?)";
  const args = [entityId, entityId];
  if (relType) { sql += " AND rel_type = ?"; args.push(relType); }
  let rows = db.prepare(sql).all(...args).map(parseRel);
  if (at != null) rows = rows.filter((r) => activeAt(r, at));
  return rows;
}

export const relationsAt = (entityId, date) => relationsOf(entityId, { at: date });

// All edges of a given rel_type (the caller extracts whichever endpoint it wants).
export function entitiesLinkedBy(relType) {
  return db.prepare("SELECT * FROM relationships WHERE rel_type = ?").all(relType).map(parseRel);
}

export function eventsFor(entityId, { kind } = {}) {
  const rows = kind
    ? db.prepare("SELECT * FROM events WHERE kind = ? ORDER BY at").all(kind)
    : db.prepare("SELECT * FROM events ORDER BY at").all();
  return rows.map(parseEvent).filter((e) => e.entity_ids.includes(entityId));
}

// Aggregate counts for reporting / verification.
export function relationshipCountsByType() {
  return Object.fromEntries(
    db.prepare("SELECT rel_type, COUNT(*) c FROM relationships GROUP BY rel_type ORDER BY rel_type").all().map((r) => [r.rel_type, r.c]));
}
export function eventCountsByKind() {
  return Object.fromEntries(
    db.prepare("SELECT kind, COUNT(*) c FROM events GROUP BY kind ORDER BY kind").all().map((r) => [r.kind, r.c]));
}
