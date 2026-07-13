// Extraction framework — the single chokepoint that turns raw evidence blobs into
// analysis-ledger rows. Each source_type registers ONE extractor with a version;
// the framework resolves the evidence's subject to an entity_id (Phase 2A), stamps
// provenance (source_type, tier, evidence_id, extractor_version), and writes
// idempotently through server/ledger.js + server/relations.js.
//
// Improving an extractor is safe by construction: bump its version,
// deleteByExtractorVersion(old), re-run — the raw evidence blobs are never touched.
//
// An extractor is a pure function (evidence, ctx) => { facts?, claims?, events? },
// emitting only the SEMANTIC fields of each record. The framework fills the
// boilerplate: id, entity_id (default = the evidence subject), subject_kind,
// source_type, tier, evidence_id, extractor_version, created_at. A record may set
// its own entity_id/subject_entity_id to attribute a fact to a DIFFERENT entity
// (e.g. a company named in the doc) — that's how the universal-subject model flows
// through extraction.
import { db, listPoliticians } from "./store.js";
import { resolveEntityIdForPolitician, getEntity, ensureEntity } from "./entities.js";
import { upsertFact, upsertClaim } from "./ledger.js";
import { upsertEvent, upsertRelationship } from "./relations.js";

const REGISTRY = new Map(); // source_type -> { version, extract }
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

export function registerExtractor(sourceType, def = {}) {
  if (!sourceType || typeof def.extract !== "function")
    throw new Error("registerExtractor: need a sourceType and an extract() function");
  REGISTRY.set(sourceType, { version: def.version ?? `${sourceType}-v1`, extract: def.extract });
}
export function listExtractors() { return [...REGISTRY.keys()]; }
export function _clearRegistry() { REGISTRY.clear(); } // test hook only

// The default subject of an evidence row is its politician, resolved to an entity.
function defaultSubject(evidence) {
  const entity_id = resolveEntityIdForPolitician(evidence.politician_id);
  if (!entity_id) return { entity_id: null, subject_kind: null };
  return { entity_id, subject_kind: getEntity(entity_id)?.kind ?? "person" };
}

// Run the registered extractor over ONE evidence row. Returns per-ledger counts of
// rows actually inserted (idempotent re-runs report zeros). `skipped` counts
// records dropped for want of a resolvable subject.
export function extractFromEvidence(evidence = {}) {
  const sourceType = evidence.source_type ?? evidence.data?.source_type ?? null;
  const out = { facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  const def = sourceType ? REGISTRY.get(sourceType) : null;
  if (!def) { out.skipped = 1; return out; }

  const subject = defaultSubject(evidence);
  const emitted = def.extract(evidence, { subject, resolveEntityIdForPolitician }) ?? {};

  for (const f of emitted.facts ?? []) {
    const entity_id = f.entity_id ?? subject.entity_id;
    if (!entity_id) { out.skipped++; continue; }
    const r = upsertFact({
      ...f, entity_id, subject_kind: f.subject_kind ?? subject.subject_kind,
      source_type: sourceType, tier: f.tier ?? evidence.tier ?? null,
      evidence_id: evidence.id, extractor_version: def.version,
    });
    if (r.inserted) out.facts++;
  }
  for (const c of emitted.claims ?? []) {
    const subject_entity_id = c.subject_entity_id ?? subject.entity_id;
    if (!subject_entity_id) { out.skipped++; continue; }
    const r = upsertClaim({
      ...c, subject_entity_id, subject_kind: c.subject_kind ?? subject.subject_kind,
      source_type: sourceType, tier: c.tier ?? evidence.tier ?? null,
      evidence_id: evidence.id, extractor_version: def.version,
    });
    if (r.inserted) out.claims++;
  }
  for (const e of emitted.events ?? []) {
    const entity_ids = e.entity_ids ?? (subject.entity_id ? [subject.entity_id] : []);
    if (!entity_ids.length) { out.skipped++; continue; }
    // events carry provenance in `source` (they have no extractor_version column);
    // the extractor version is preserved inside data for auditability.
    const r = upsertEvent({
      ...e, entity_ids, evidence_id: evidence.id, source: sourceType,
      data: { ...(e.data ?? {}), extractor_version: def.version },
    });
    if (r.inserted) out.events++;
  }
  // relationships: src defaults to the subject; the dst entity is resolved (or
  // created) from dst_name + dst_strong_ids, so an extractor can grow the graph
  // (e.g. wikidata family edges, later financial-link edges) without SQL.
  for (const rel of emitted.relationships ?? []) {
    const src = rel.src_entity_id ?? subject.entity_id;
    if (!src || !rel.rel_type) { out.skipped++; continue; }
    let dst = rel.dst_entity_id;
    if (!dst && rel.dst_name) {
      dst = ensureEntity({ kind: rel.dst_kind ?? "person", name: rel.dst_name, strongIds: rel.dst_strong_ids ?? {}, source: sourceType });
    }
    if (!dst || dst === src) { out.skipped++; continue; }
    const r = upsertRelationship({
      src_entity_id: src, dst_entity_id: dst, rel_type: rel.rel_type,
      valid_from: rel.valid_from ?? null, valid_to: rel.valid_to ?? null,
      confidence: rel.confidence ?? null, evidence_id: evidence.id,
      source: sourceType, detector_version: def.version, data: rel.data,
    });
    if (r.inserted) out.relationships++;
  }
  return out;
}

// Batch runner over the evidence table, optionally scoped to one source_type and
// bounded by `limit` (for trial runs). Wraps the whole pass in one transaction so
// a big backfill commits once. Returns aggregate counts.
export function runExtraction({ sourceType = null, limit = null } = {}) {
  const lim = limit != null && Number.isFinite(Number(limit)) ? ` LIMIT ${Number(limit)}` : "";
  const rows = sourceType
    ? db.prepare(`SELECT id, politician_id, data FROM evidence WHERE json_extract(data,'$.source_type') = ?${lim}`).all(sourceType)
    : db.prepare(`SELECT id, politician_id, data FROM evidence${lim}`).all();

  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  const run = db.transaction((rows) => {
    for (const raw of rows) {
      const d = safeJson(raw.data);
      const out = extractFromEvidence({
        id: raw.id, politician_id: raw.politician_id,
        source_type: d.source_type, tier: d.tier, date: d.date, data: d,
      });
      total.evidence++;
      total.facts += out.facts; total.claims += out.claims;
      total.events += out.events; total.relationships += out.relationships; total.skipped += out.skipped;
    }
  });
  run(rows);
  return total;
}

// Run an extractor over POLITICIAN rows instead of the evidence table, for sources
// that live on the politician blob (e.g. the parsed affidavit) rather than in
// evidence. buildEvidence(p) synthesizes an evidence-shaped object (with a STABLE
// synthetic id so re-runs stay idempotent). Reuses all of extractFromEvidence's
// resolution + provenance stamping + idempotency.
export function runPoliticianExtraction(sourceType, buildEvidence) {
  const pols = listPoliticians();
  const total = { evidence: 0, facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  const run = db.transaction((pols) => {
    for (const p of pols) {
      const out = extractFromEvidence(buildEvidence(p));
      total.evidence++;
      total.facts += out.facts; total.claims += out.claims;
      total.events += out.events; total.relationships += out.relationships; total.skipped += out.skipped;
    }
  });
  run(pols);
  return total;
}
