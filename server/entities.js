// Canonical entity layer. There are no entity IDs upstream — each fetcher
// fuzzy-matches names independently and throws the identity decision away. This
// module gives those decisions a home: a canonical `entities` store, an alias
// index, and an append-only `entity_assertions` log (every "this raw name IS
// that entity" claim, with its method + confidence, auto-accepted for strong IDs
// and left proposed for the gray zone a human reviews).
//
// Uses the shared better-sqlite3 handle from store.js so there is ONE connection
// and ONE schema init (PANDOROS_DB_PATH honoured).
import { db, id } from "./store.js";

// ── normName — the single canonical name normalizer ─────────────────────────
// Uppercase, strip punctuation, drop leading honorifics, and fold the common
// company-suffix spellings so "X Pvt Ltd" and "X Private Limited" collapse.
// server/synthesis.js beneficiaryKey now imports THIS so both use one function.
const HONORIFICS = new Set([
  "SHRI", "SHRIMATI", "SMT", "SRI", "DR", "KUMARI", "KUM", "MS", "MR", "MRS",
  "MISS", "PROF", "ADV", "MOHD", "MD", "SARDAR", "COL", "GEN", "CAPT", "LATE",
  "THIRU", "MAJ", "LT", "HON", "HONBLE",
]);
// Company-form spellings folded to one token so equivalent firm names collapse.
const SUFFIX_MAP = {
  PRIVATE: "PVT", LIMITED: "LTD", CORPORATION: "CORP", INCORPORATED: "INC",
  COMPANY: "CO", "AND": "", "&": "",
};

export function normName(s) {
  const up = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  if (!up) return "";
  return up.split(/\s+/)
    .filter((t) => !HONORIFICS.has(t))
    .map((t) => (t in SUFFIX_MAP ? SUFFIX_MAP[t] : t))
    .filter(Boolean)
    .join(" ")
    .trim();
}

const key = (s) => normName(s).toLowerCase();

// Which strong-id key each instrumenting source contributes.
const SOURCE_STRONG_KEY = {
  mca_directors: "din",
  sansad_mp: "mpsno",
  myneta: "myneta_url",
  backfill_politician: "politician_id",
};

const parseEntity = (r) => r && ({ ...r, strong_ids: safeJson(r.strong_ids), data: safeJson(r.data) });
const parseAssertion = (r) => r && ({ ...r, data: safeJson(r.data) });
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// ── Lookup ──────────────────────────────────────────────────────────────────
export function findEntityByStrongId(kind, ids = {}) {
  for (const [k, v] of Object.entries(ids ?? {})) {
    if (v == null || v === "") continue;
    const row = db.prepare(
      "SELECT * FROM entities WHERE kind = ? AND json_extract(strong_ids, ?) = ? LIMIT 1"
    ).get(kind, `$.${k}`, String(v));
    if (row) return parseEntity(row);
  }
  return null;
}

function findEntitiesByAlias(kind, name) {
  const aliasLc = key(name);
  if (!aliasLc) return [];
  return db.prepare(
    "SELECT DISTINCT e.* FROM entities e JOIN entity_aliases a ON a.entity_id = e.id WHERE e.kind = ? AND a.alias_lc = ?"
  ).all(kind, aliasLc).map(parseEntity);
}

export function findEntityByAlias(kind, name) {
  return findEntitiesByAlias(kind, name)[0] ?? null;
}

// ── Mutation ──────────────────────────────────────────────────────────────
function upsertAlias(entityId, name, source) {
  const aliasLc = key(name);
  if (!aliasLc) return;
  db.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_lc, source) VALUES (?,?,?,?)")
    .run(entityId, String(name ?? ""), aliasLc, source ?? null);
}

function cleanIds(ids) {
  const out = {};
  for (const [k, v] of Object.entries(ids ?? {})) if (v != null && v !== "") out[k] = String(v);
  return out;
}

function mergeStrongIds(entity, ids) {
  const cur = { ...(entity.strong_ids ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(cleanIds(ids))) {
    if (cur[k] == null) { cur[k] = v; changed = true; }
  }
  if (changed) db.prepare("UPDATE entities SET strong_ids = ? WHERE id = ?").run(JSON.stringify(cur), entity.id);
}

// Match by strong id first, then by exact alias, else create. Always upserts the
// alias and folds in any new strong ids. Returns the entity id.
export function ensureEntity({ kind, name, strongIds = {}, source = null } = {}) {
  let ent = findEntityByStrongId(kind, strongIds);
  if (!ent) ent = findEntityByAlias(kind, name);
  if (ent) {
    mergeStrongIds(ent, strongIds);
    upsertAlias(ent.id, name, source);
    return ent.id;
  }
  const eid = id();
  db.prepare("INSERT INTO entities (id, kind, canonical_name, name_lc, strong_ids, created_at, data) VALUES (?,?,?,?,?,?,?)")
    .run(eid, kind, String(name ?? ""), key(name), JSON.stringify(cleanIds(strongIds)), new Date().toISOString(), JSON.stringify({}));
  upsertAlias(eid, name, source);
  return eid;
}

function strongIdsFrom(a) {
  const k = SOURCE_STRONG_KEY[a.source];
  return k && a.source_ref != null && a.source_ref !== "" ? { [k]: String(a.source_ref) } : {};
}

// Append an identity assertion (idempotent via the unique constraint). A
// strong_id method auto-accepts (resolving/creating the entity); an exact_alias
// auto-accepts only when it matches exactly one existing entity; everything else
// is left proposed with entity_id null for human review.
export function recordAssertion(a = {}) {
  const now = new Date().toISOString();
  const kind = a.subject_kind ?? "person";
  const method = a.method ?? "token_score";
  const source = a.source ?? "";
  const source_ref = a.source_ref != null ? String(a.source_ref) : "";
  const politician_id = a.politician_id != null ? String(a.politician_id) : "";
  const raw_name = a.raw_name ?? "";

  let status = "proposed", entity_id = null, decided_at = null;
  if (method === "strong_id") {
    entity_id = ensureEntity({ kind, name: raw_name, strongIds: strongIdsFrom({ ...a, source, source_ref }), source });
    status = "accepted"; decided_at = now;
  } else if (method === "exact_alias") {
    const matches = findEntitiesByAlias(kind, raw_name);
    if (matches.length === 1) { entity_id = matches[0].id; status = "accepted"; decided_at = now; }
  }

  const row = {
    id: id(), subject_kind: kind, raw_name, source, source_ref, politician_id,
    entity_id, confidence: Number(a.confidence) || 0, method, status,
    evidence_url: a.evidence_url ?? null, detector_version: a.detector_version ?? null,
    created_at: now, decided_at, data: JSON.stringify(a.data ?? {}),
  };
  const info = db.prepare(`INSERT OR IGNORE INTO entity_assertions
    (id, subject_kind, raw_name, source, source_ref, politician_id, entity_id, confidence, method, status, evidence_url, detector_version, created_at, decided_at, data)
    VALUES (@id,@subject_kind,@raw_name,@source,@source_ref,@politician_id,@entity_id,@confidence,@method,@status,@evidence_url,@detector_version,@created_at,@decided_at,@data)`).run(row);

  if (info.changes === 0) {
    const existing = db.prepare(
      "SELECT id, status, entity_id FROM entity_assertions WHERE source = ? AND source_ref = ? AND raw_name = ? AND politician_id = ? LIMIT 1"
    ).get(source, source_ref, raw_name, politician_id);
    return { id: existing?.id ?? null, inserted: false, status: existing?.status ?? null, entity_id: existing?.entity_id ?? null };
  }
  return { id: row.id, inserted: true, status, entity_id };
}

export function listProposed({ source, limit = 100 } = {}) {
  const rows = source
    ? db.prepare("SELECT * FROM entity_assertions WHERE status = 'proposed' AND source = ? ORDER BY confidence DESC LIMIT ?").all(source, limit)
    : db.prepare("SELECT * FROM entity_assertions WHERE status = 'proposed' ORDER BY confidence DESC LIMIT ?").all(limit);
  return rows.map(parseAssertion);
}

// Accept (optionally against a chosen entity id) or reject a proposed assertion.
// Accepting without an entityId resolves/creates the entity from raw_name.
export function decideAssertion(assertionId, decision, entityId = null) {
  const a = db.prepare("SELECT * FROM entity_assertions WHERE id = ?").get(assertionId);
  if (!a) return null;
  const now = new Date().toISOString();
  if (decision === "accepted") {
    let eid = entityId;
    if (eid) upsertAlias(eid, a.raw_name, a.source);
    else eid = ensureEntity({ kind: a.subject_kind, name: a.raw_name, strongIds: strongIdsFrom(a), source: a.source });
    db.prepare("UPDATE entity_assertions SET status = 'accepted', entity_id = ?, decided_at = ? WHERE id = ?").run(eid, now, assertionId);
    return { id: assertionId, status: "accepted", entity_id: eid };
  }
  if (decision === "rejected") {
    db.prepare("UPDATE entity_assertions SET status = 'rejected', decided_at = ? WHERE id = ?").run(now, assertionId);
    return { id: assertionId, status: "rejected", entity_id: null };
  }
  return null;
}
