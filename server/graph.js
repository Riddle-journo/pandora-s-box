// Relationship graph — the "a smart operator covers their tracks via relatives"
// layer. Given a politician's evidence (which now carries NAMED relatives from
// Wikidata) plus the whole roster and scandal corpus, it builds concrete,
// citable edges: politician → relative → (is that relative ALSO an elected
// politician? do they appear in a documented scandal?). This catches political
// dynasties and family-network overlaps deterministically, in code — no LLM
// guessing, every edge traceable to a source.
import { listPoliticians, listScandals } from "./store.js";
import { findEntityByStrongId, getEntity } from "./entities.js";
import { relationsOf } from "./relations.js";

const HON = new Set(["dr", "shri", "smt", "kumari", "ms", "mr", "mrs", "prof", "adv", "shrimati", "sardar", "km"]);
const toks = (s) => (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !HON.has(t));

// Extremely common Indian name tokens. A match built ONLY from these (e.g. two
// unrelated "Sunil Kumar"s among 4,500+ reps) is worthless as identity evidence
// — and a false DYNASTY claim on a public accountability site is defamation.
const COMMON = new Set([
  "kumar", "kumari", "singh", "devi", "lal", "ram", "prasad", "sharma", "yadav",
  "khan", "das", "patel", "reddy", "rao", "gupta", "verma", "mishra", "nath",
  "chandra", "mohan", "bai", "ben", "bhai", "raj", "dev", "ali", "begum", "kaur",
]);

// Two names refer plausibly to the same person: the shorter name's tokens are
// ALL present in the longer, AND the shared tokens carry real identity signal —
// ≥2 distinctive tokens, or 1 distinctive among ≥3 shared. "Sunil Kumar" vs a
// roster "Sunil Kumar" fails (1 distinctive, 2 total): at India's scale that is
// a coin-flip identity, and a wrong DYNASTY claim is defamation. "Priyanka
// Vadra" (2 distinctive) and "Lalu Prasad Yadav" (1 distinctive, 3 total) pass.
function identityStrong(shared) {
  const distinctive = shared.filter((t) => !COMMON.has(t));
  return distinctive.length >= 2 || (distinctive.length >= 1 && shared.length >= 3);
}
function sameName(a, b) {
  const ta = toks(a), tb = toks(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t));
  const shorter = ta.length <= tb.length ? ta : tb;
  const longerSet = ta.length <= tb.length ? setB : new Set(ta);
  return shared.length >= 2 && shorter.every((t) => longerSet.has(t)) && identityStrong(shared);
}

// A relative's name appears in a title only if EVERY token matches as a whole
// word ("ram" must never match inside "programme") and the same identity
// strength holds.
function nameInTitle(name, title) {
  const t = toks(name);
  if (t.length < 2) return false;
  const hay = String(title ?? "").toLowerCase();
  return t.every((tok) => new RegExp(`\\b${tok}\\b`).test(hay)) && identityStrong(t);
}

// Build relationship edges for one politician from their evidence's Wikidata
// relatives. Returns { relatives:[...], links:[...] } — links are the notable,
// citable findings (dynasty overlaps, scandal ties).
export function buildRelations(politician, evidence) {
  // Pull named relatives out of the Wikidata evidence.
  const relatives = [];
  for (const e of evidence) {
    if (e.source_type === "wikidata" && Array.isArray(e.numbers?.relatives)) {
      for (const r of e.numbers.relatives)
        if (r.name && !relatives.some((x) => x.name === r.name))
          relatives.push({ ...r, source_url: e.url });
    }
  }
  if (!relatives.length) return { relatives: [], links: [] };

  const roster = listPoliticians().filter((x) => !x.is_demo && x.id !== politician.id);
  const scandals = listScandals();
  const links = [];

  for (const rel of relatives) {
    // Is this relative ALSO an elected representative in our roster? → dynasty.
    // Collect ALL candidate matches: if several unrelated reps share the name,
    // identity is ambiguous — publish nothing rather than pick one arbitrarily.
    const matches = roster.filter((x) => sameName(x.name, rel.name));
    const match = matches.length === 1 ? matches[0]
      : matches.length > 1 ? matches.find((x) => (x.state ?? "").toLowerCase() === (politician.state ?? "").toLowerCase()) ?? null
      : null;
    if (matches.length > 1 && !match)
      console.warn(`[graph] ambiguous relative match skipped: "${rel.name}" matches ${matches.length} reps`);
    if (match) {
      links.push({
        type: "DYNASTY", relation: rel.relation, relative_name: rel.name,
        target_kind: "politician", target_id: match.id, target_name: match.name,
        note: `${rel.name} — ${politician.name}'s ${rel.relation} — is also an elected representative (${[match.office, match.party, match.constituency].filter(Boolean).join(", ")}).`,
        source_url: rel.source_url,
      });
    }
    // Does this relative appear in a documented scandal (as minister/subject)?
    const sc = scandals.find((s) =>
      sameName(s.minister_in_charge?.name ?? "", rel.name) || nameInTitle(rel.name, s.title));
    if (sc) {
      links.push({
        type: "RELATIVE_IN_SCANDAL", relation: rel.relation, relative_name: rel.name,
        target_kind: "scandal", target_id: sc.slug, target_name: sc.title,
        note: `${rel.name} (${politician.name}'s ${rel.relation}) is connected to a documented governance failure: "${sc.title}".`,
        source_url: rel.source_url,
      });
    }
  }
  return { relatives, links };
}

// Persisted-read path (Plan 5): reconstruct the {relatives, links} shape from the
// relationships table via the politician's person entity, so relationships are no
// longer recomputed statelessly on every request. Returns null when the politician
// has no person entity; returns empty arrays when the entity exists but carries no
// family edges (the caller treats both as "fall back to buildRelations").
export function persistedRelations(politicianId) {
  const ent = findEntityByStrongId("person", { politician_id: politicianId });
  if (!ent) return null;
  const family = relationsOf(ent.id, { relType: "family_of" }).filter((r) => r.src_entity_id === ent.id);
  const relatives = [];
  const links = [];
  for (const e of family) {
    const dst = getEntity(e.dst_entity_id);
    const name = dst?.canonical_name ?? "";
    if (!name) continue;
    const relation = e.data?.relation ?? "relative";
    if (!relatives.some((x) => x.name === name)) relatives.push({ name, relation, source_url: null });
    if (e.data?.dynasty) {
      links.push({
        type: "DYNASTY", relation, relative_name: name, target_kind: "politician",
        target_id: dst?.strong_ids?.politician_id ?? null, target_name: name,
        note: `${name} — ${relation} — persisted family/dynasty edge.`, source_url: null,
      });
    }
  }
  return { relatives, links };
}

// Non-breaking wrapper: prefer the persisted store, fall back to the in-memory
// buildRelations when nothing is persisted for this politician's entity.
export function relationsForPolitician(politician, evidence) {
  const persisted = persistedRelations(politician.id);
  if (persisted && (persisted.links.length || persisted.relatives.length)) return persisted;
  return buildRelations(politician, evidence);
}
