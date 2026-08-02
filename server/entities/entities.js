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

export function getEntity(entityId) {
  const row = db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId);
  return row ? parseEntity(row) : null;
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

// True when `entity` already carries a DIFFERENT value for any strong id we hold.
// A strong id is an identity key (politician_id, din, mpsno, myneta_url, cin …), so
// a mismatch means this is a DIFFERENT real-world subject that merely shares a name.
function strongIdsConflict(entity, ids) {
  const cur = entity?.strong_ids ?? {};
  for (const [k, v] of Object.entries(cleanIds(ids))) {
    if (cur[k] != null && String(cur[k]) !== String(v)) return true;
  }
  return false;
}

// Match by strong id first, then by exact alias, else create. Always upserts the
// alias and folds in any new strong ids. Returns the entity id.
//
// Concurrency note: the whole lookup-then-insert is synchronous (no await), so
// in-process parallel jobs cannot interleave inside it — no duplicate entity can
// be minted by the worker pool. A schema-level UNIQUE index is deliberately NOT
// used here: strong_ids is a JSON blob whose keys vary by source, and
// (kind, name_lc) is legitimately non-unique (namesakes are DIFFERENT subjects —
// that's what strongIdsConflict protects). The db.transaction wrapper below adds
// cross-connection atomicity should a second process ever write entities.
export const ensureEntity = db.transaction(ensureEntityBody);
function ensureEntityBody({ kind, name, strongIds = {}, source = null } = {}) {
  let ent = findEntityByStrongId(kind, strongIds);
  // A strong-id match on ONE key must not merge subjects that DISAGREE on another:
  // two politician rows the roster gave the same myneta_url but distinct politician_ids
  // are different people (a source-roster duplicate) — collapsing them would silently
  // drop one identity. Reject the match and mint a fresh entity instead.
  if (ent && strongIdsConflict(ent, strongIds)) ent = null;
  // Likewise a bare name (alias) match must NEVER override a strong id: if the
  // name-matched entity already belongs to a different subject (a conflicting strong
  // id), it is a namesake, not the same person — fall through and mint a fresh entity
  // so two real people are never glued onto one shared entity. (The two guards share
  // strongIdsConflict; scripts/split-shared-entities.js is the one-time repair for the
  // rows the old, un-gated behaviour already created.)
  if (!ent) {
    const byAlias = findEntityByAlias(kind, name);
    if (byAlias && !strongIdsConflict(byAlias, strongIds)) ent = byAlias;
  }
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

// A company's reliable identity is its CIN (Corporate Identification Number) — name
// spellings drift ("Pvt Ltd" vs "Private Limited", "&" vs "AND"), the CIN does not.
// Accept anything registry-shaped (≥5 chars, has a digit) so foreign registration
// numbers (e.g. "F06579") aren't dropped, but reject junk like "" / "NA" / "-" that
// would wrongly glue unrelated companies onto one strong id.
const looksLikeCin = (s) => { const t = String(s ?? "").trim(); return t.length >= 5 && /\d/.test(t); };

// THE single canonical resolver/creator for a COMPANY entity — the shared dedup
// point the plan's A3 calls for. Keyed by CIN when known, so the two directorship
// paths converge on ONE entity: the extraction path learns a company by NAME first
// and its CIN later (directorship-verify), while the Tofler path knows the CIN up
// front — both land on the same entity via the `cin` strong id. When a CIN is
// present, every supplied name spelling is also registered as an alias, so a later
// lookup by any spelling resolves here. Without a CIN, only the primary name is used
// (differing names can't be safely merged without an identity key). Returns the id.
export function ensureCompanyEntity({ name, cin = null, names = [], source = null } = {}) {
  const cinNorm = looksLikeCin(cin) ? String(cin).trim().toUpperCase() : null;
  const strongIds = cinNorm ? { cin: cinNorm } : {};
  const spellings = [...new Set([name, ...names].map((n) => (n == null ? "" : String(n).trim())).filter(Boolean))];
  const primary = spellings[0] ?? String(name ?? "");
  const eid = ensureEntity({ kind: "company", name: primary, strongIds, source });
  // Extra spellings only fold onto this entity safely once a CIN proves identity.
  if (cinNorm) for (const n of spellings.slice(1)) ensureEntity({ kind: "company", name: n, strongIds, source });
  return eid;
}

// Fold additional strong ids onto an EXISTING entity (by id) — unless they conflict
// with an id it already holds (a conflicting id means a different real-world subject;
// see strongIdsConflict, so we refuse rather than corrupt identity). Returns true iff
// something was added. Plan A1 uses this to attach a director's DIN, learned from
// evidence text, onto the KNOWN politician entity (resolved by politician_id), so the
// Tofler director-matcher's DIN-certain lookup (director-link.js) finally has data.
export function attachStrongIds(entityId, ids = {}) {
  const ent = getEntity(entityId);
  if (!ent || strongIdsConflict(ent, ids)) return false;
  const before = JSON.stringify(ent.strong_ids ?? {});
  mergeStrongIds(ent, ids);
  return JSON.stringify(getEntity(entityId)?.strong_ids ?? {}) !== before;
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

// ── Subject resolution (Phase 2A) ───────────────────────────────────────────
// The analysis ledgers (facts/claims) key on a universal entity_id, so every
// extractor must turn the politician_id it holds into the canonical person
// entity. This is that bridge.

// Resolve a politician_id to its canonical person entity id. Fast path is the
// politician_id strong id; falls back to the accepted identity assertion that
// already bound this politician, so coverage is total even before every strong
// id is backfilled. Returns null only if the politician was never resolved.
export function resolveEntityIdForPolitician(politicianId) {
  if (politicianId == null || politicianId === "") return null;
  const pid = String(politicianId);
  const byStrong = findEntityByStrongId("person", { politician_id: pid });
  if (byStrong) return byStrong.id;
  const row = db.prepare(
    "SELECT entity_id FROM entity_assertions WHERE politician_id = ? AND entity_id IS NOT NULL ORDER BY (status = 'accepted') DESC, created_at ASC LIMIT 1"
  ).get(pid);
  return row?.entity_id ?? null;
}

// Annotate each politician's resolved entity with its politician_id strong id, so
// findEntityByStrongId('person', {politician_id}) becomes the total fast path.
// No fuzzy re-matching — it only touches the already-resolved entity, so it can
// never mint a duplicate. Four honest outcomes per politician:
//   folded    — entity had no politician_id; we set it (safe)
//   already   — entity already carries this exact politician_id
//   collision — entity already belongs to a DIFFERENT politician (a name-duplicate
//               merged two people); we do NOT steal the strong id — flagged for
//               a separate entity-dedup pass
//   created   — politician resolved to no entity at all (shouldn't happen post-backfill)
// Re-run-safe. `politicians` is an array of {id, name, myneta_url?}.
export function reconcilePoliticianStrongIds(politicians = []) {
  const c = { folded: 0, already: 0, collision: 0, created: 0 };
  for (const p of politicians) {
    const eid = resolveEntityIdForPolitician(p.id);
    if (!eid) {
      const strongIds = { politician_id: p.id };
      if (p.myneta_url) strongIds.myneta_url = p.myneta_url;
      ensureEntity({ kind: "person", name: p.name, strongIds, source: "reconcile_politician" });
      c.created++;
      continue;
    }
    const owner = getEntity(eid)?.strong_ids?.politician_id;
    if (owner == null) { mergeStrongIds(getEntity(eid), { politician_id: p.id }); c.folded++; }
    else if (String(owner) === String(p.id)) c.already++;
    else c.collision++;
  }
  return c;
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
