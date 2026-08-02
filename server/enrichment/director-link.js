// Director→politician matching (Phase 2) — turn a flagged company's DIRECTORS
// (harvested by the Phase-1 Tofler enrichment) into leads when a director turns
// out to BE a tracked politician, or one of their relatives.
//
// Only flagged companies ever reach the tofler_companies cache (Phase 1 fetches
// on a flag, never crawls), so iterating that cache IS iterating "directors of
// flagged companies". For each director we match against:
//   • the politician themselves (self)         — the strongest conflict
//   • their relatives (persisted family_of edges)
//   • an exact DIN (Director ID Number) on either entity — identity certainty
//
// Identity is defamation-sensitive: we reuse graph.js's sameName (≥2 distinctive
// shared tokens; the guard that stops "Sunil Kumar"-style coincidences), and a
// director name that resolves to MORE THAN ONE politician is dropped as ambiguous
// rather than guessed. DIN, being a hard id, overrides name noise.
//
// Pure-ish & code-only (no network, no LLM). Reads the store, upserts leads.
import { listPoliticians, listToflerCompanies, upsertLead, db } from "../store/store.js";
import { entitiesLinkedBy, upsertRelationship } from "../entities/relations.js";
import { getEntity, ensureEntity, ensureCompanyEntity } from "../entities/entities.js";
import { sameName, candidateTokens } from "../publishing/graph.js";

export const DETECTOR_VERSION = "director-link-v1";

// Plan B1: besides the private lead, each match also becomes a director_of GRAPH edge
// so the detectors that already read those edges (conflict.js, anomaly.js) get Tofler's
// authoritative registered-board data for free, and corroboration (A2) can work edge-to-
// edge. Confidence by how the director was matched — DIN is identity-certain.
const VIA_CONFIDENCE = { din: 0.95, self_name: 0.85, relative_name: 0.75 };

const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");
const din8 = (d) => (d ? String(d).replace(/\D/g, "").padStart(8, "0") : null);

// Build the match index once: an entry per (politician self) and per (relative),
// each carrying its display name, an optional DIN, plus a token bucket and a DIN
// bucket for fast candidate lookup.
export function buildDirectorMatchIndex() {
  const entries = [];
  const tokenIndex = new Map(); // token → Set(entryIdx)
  const dinIndex = new Map();   // din8  → Set(entryIdx)

  const addEntry = (e) => {
    const idx = entries.push(e) - 1;
    for (const t of candidateTokens(e.displayName)) {
      (tokenIndex.get(t) ?? tokenIndex.set(t, new Set()).get(t)).add(idx);
    }
    if (e.din) (dinIndex.get(e.din) ?? dinIndex.set(e.din, new Set()).get(e.din)).add(idx);
    return idx;
  };

  // Self-DIN: politician person entities that carry a DIN strong id.
  const selfDinByPol = new Map();
  for (const r of db.prepare(
    "SELECT strong_ids FROM entities WHERE kind='person' AND json_extract(strong_ids,'$.din') IS NOT NULL"
  ).all()) {
    let s; try { s = JSON.parse(r.strong_ids); } catch { continue; }
    if (s?.politician_id && s?.din) selfDinByPol.set(String(s.politician_id), din8(s.din));
  }

  // Self: every non-demo roster politician.
  for (const p of listPoliticians()) {
    if (p.is_demo) continue;
    addEntry({
      politician_id: p.id, politician_name: p.name, displayName: p.name,
      kind: "self", relation: null, din: selfDinByPol.get(String(p.id)) ?? null,
    });
  }

  // Relatives: persisted family_of edges (src = politician entity → dst = relative).
  for (const edge of entitiesLinkedBy("family_of")) {
    const src = getEntity(edge.src_entity_id);
    const dst = getEntity(edge.dst_entity_id);
    const politicianId = src?.strong_ids?.politician_id;
    const relName = dst?.canonical_name;
    if (!politicianId || !relName) continue;
    addEntry({
      politician_id: String(politicianId), politician_name: src.canonical_name ?? "",
      displayName: relName, kind: "relative", relation: edge.data?.relation ?? "relative",
      din: din8(dst?.strong_ids?.din), entity_id: dst.id, // the relative IS the director
    });
  }

  return { entries, tokenIndex, dinIndex };
}

// Resolve a single director to at most one politician match, or null. DIN first
// (unambiguous), then name — and a name resolving to >1 politician is dropped.
export function matchDirector(director, index) {
  const { entries, tokenIndex, dinIndex } = index;
  const dDin = din8(director.din);

  // ── DIN match (identity certainty) ──
  if (dDin && dinIndex.has(dDin)) {
    const pols = new Set([...dinIndex.get(dDin)].map((i) => entries[i].politician_id));
    if (pols.size === 1) {
      const e = entries[[...dinIndex.get(dDin)][0]];
      return { ...e, via: "din", signal_score: 24 };
    }
    return null; // a DIN mapping to two politicians is corrupt data — don't guess
  }

  // ── Name match (defamation-aware) ──
  const candIdx = new Set();
  for (const t of candidateTokens(director.name)) {
    for (const i of tokenIndex.get(t) ?? []) candIdx.add(i);
  }
  const hits = [...candIdx].map((i) => entries[i]).filter((e) => sameName(director.name, e.displayName));
  const pols = new Set(hits.map((h) => h.politician_id));
  if (pols.size !== 1) return null; // 0 = no match; >1 = ambiguous → skip
  // Prefer a self hit over a relative hit for the same politician.
  const e = hits.find((h) => h.kind === "self") ?? hits[0];
  return { ...e, via: e.kind === "self" ? "self_name" : "relative_name", signal_score: e.kind === "self" ? 20 : 14 };
}

// Build a DIRECTOR_LINK lead from a match + the flagged company it was found on.
function toLead(match, company, director) {
  const who = match.kind === "self"
    ? `${director.name} appears to be the member themselves`
    : `${director.name} appears to be ${match.politician_name}'s ${match.relation}`;
  return {
    vector: "DIRECTOR_LINK", actor_id: match.politician_id, actor_name: match.politician_name,
    detector_version: DETECTOR_VERSION,
    instrument: `directorship in ${company.name ?? company.cin}`,
    beneficiary: company.name ?? company.cin, beneficiary_kind: "company", beneficiary_cin: company.cin ?? null,
    signal_score: match.signal_score, severity: sev(match.signal_score),
    match_kind: match.via, director_name: director.name, director_din: director.din ?? null,
    headline: `A director of a flagged company (${company.name ?? company.cin}) matches ${match.kind === "self" ? "the member" : `a relative of ${match.politician_name}`}.`,
    evidence_urls: [company.source_url].filter(Boolean),
    detail: `On the flagged company ${company.name ?? company.cin}${company.cin ? ` (CIN ${company.cin})` : ""}, ${who} (DIN ${director.din ?? "?"}), matched ${match.via === "din" ? "by exact DIN" : "by name"}. A director-name/DIN match is a LEAD for the Investigator/Referee — confirm against the primary MCA filing before treating it as a finding.`,
  };
}

// Write the Plan-B1 director_of edge for a match. The DIRECTOR is the politician
// (self) or the relative (relative match) — the edge sits on whichever really holds
// the board seat; the politician's tie to a relative's directorship stays inferred via
// the family_of edge. Company entity is CIN-resolved (ensureCompanyEntity) so it lands
// on the SAME entity extraction uses. Returns true if a new edge was inserted.
function writeDirectorEdge(match, company, director) {
  // Self: resolve-or-create the politician's person entity (a roster politician may
  // not have an entity yet — asserting a directorship is reason enough to mint one).
  // Relative: the relative entity captured on the match index entry.
  const directorEntityId = match.kind === "self"
    ? ensureEntity({ kind: "person", name: match.politician_name, strongIds: { politician_id: match.politician_id }, source: DETECTOR_VERSION })
    : match.entity_id;
  if (!directorEntityId || !(company.name || company.cin)) return false;
  const companyEntityId = ensureCompanyEntity({ name: company.name ?? company.cin, cin: company.cin, source: "tofler" });
  const r = upsertRelationship({
    src_entity_id: directorEntityId,
    dst_entity_id: companyEntityId,
    rel_type: "director_of",
    confidence: VIA_CONFIDENCE[match.via] ?? 0.7,
    source: "tofler",
    detector_version: DETECTOR_VERSION,
    data: {
      via: match.via, is_relative: match.kind === "relative", relation: match.relation ?? null,
      director_name: director.name, director_din: director.din ?? null,
      politician_id: match.politician_id, company_text: company.name ?? null, company_cin: company.cin ?? null,
    },
  });
  return r.inserted;
}

// Runner: match every director of every cached (flagged) company; upsert leads AND
// (Plan B1) director_of graph edges.
export function matchDirectorsToPoliticians() {
  const index = buildDirectorMatchIndex();
  const companies = listToflerCompanies();
  let directors = 0, leads = 0, edges = 0;
  const emitted = [];
  for (const company of companies) {
    for (const d of company.directors ?? []) {
      directors++;
      const match = matchDirector(d, index);
      if (!match) continue;
      const lead = toLead(match, company, d);
      upsertLead({ ...lead, status: "detected" });
      emitted.push(lead);
      leads++;
      if (writeDirectorEdge(match, company, d)) edges++;
    }
  }
  return { companies: companies.length, directors, leads, edges, emitted };
}
