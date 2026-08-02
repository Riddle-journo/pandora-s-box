// Wikidata fetcher — free, structured, no key. Gives what prose sources can't:
// NAMED family members (spouse, parents, children, siblings), positions held,
// and party — as clean entities, not text the LLM has to guess at. This is the
// data that unblocks the relationship graph (server/graph.js): a real list of a
// politician's relatives by name, so dynasty / family-network patterns become
// computable instead of inferred.
import { fetchJson , TIMEOUT_DEFAULT } from "./http.js";
import { noteFetchFailure, noteParseMiss } from "./observe.js";

const API = "https://www.wikidata.org/w/api.php";

// Family + politics properties we care about.
const REL = {
  P26: "spouse", P40: "child", P22: "father", P25: "mother",
  P3373: "sibling", P1038: "relative", P102: "party", P39: "position held",
};

async function searchEntity(name) {
  const url = `${API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&type=item&limit=5&format=json&origin=*`;
  const d = await fetchJson(url, { timeoutMs: TIMEOUT_DEFAULT });
  return d?.search ?? [];
}

async function getEntities(ids) {
  if (!ids.length) return {};
  const url = `${API}?action=wbgetentities&ids=${ids.join("|")}&props=labels|claims|descriptions&languages=en&format=json&origin=*`;
  const d = await fetchJson(url, { timeoutMs: TIMEOUT_DEFAULT });
  return d?.entities ?? {};
}

const labelOf = (ent) => ent?.labels?.en?.value ?? null;
const descOf = (ent) => ent?.descriptions?.en?.value ?? "";

// Identity guards — a wrong entity here would attach someone ELSE's family to
// a politician's public dossier, which is unacceptable. Two checks:
//  1. the entity's label must actually match the politician's name (≥2 shared
//     tokens, shorter-name tokens all present);
//  2. the entity must carry political claims (position held / party / or a
//     politician occupation) — a namesake actor/cricketer is rejected.
const _toks = (s) => (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3);
function labelMatches(label, name) {
  const a = _toks(label), b = _toks(name);
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t));
  const shorter = a.length <= b.length ? a : b;
  const longerSet = a.length <= b.length ? setB : new Set(a);
  return (shared.length >= 2 || (shared.length >= 1 && shorter.length === 1)) && shorter.every((t) => longerSet.has(t));
}
const POLITICIAN_Q = "Q82955"; // occupation: politician
function looksPolitical(ent) {
  const c = ent.claims ?? {};
  if (c.P39?.length || c.P102?.length) return true; // position held / party
  return (c.P106 ?? []).some((cl) => cl.mainsnak?.datavalue?.value?.id === POLITICIAN_Q);
}

export async function fetchWikidata(p) {
  if (!p?.name || process.env.WIKIDATA_DISABLE === "1") return [];
  let hits;
  try { hits = await searchEntity(p.name); }
  catch (err) { noteFetchFailure("wikidata", "search", err, { politician_id: p.id, name: p.name }); return []; }
  hits = hits.filter((h) => labelMatches(h.label ?? h.display?.label?.value ?? "", p.name));
  if (!hits.length) return [];

  // Prefer a candidate whose description reads political; NO blind fallback to
  // hits[0] — the political-claims check below is the real gate either way.
  const cand = hits.find((h) => /politic|\bMP\b|MLA|minister|member of|lok sabha|rajya sabha/i.test(h.description ?? "")) ?? hits[0];
  let entities;
  try { entities = await getEntities([cand.id]); }
  catch (err) { noteFetchFailure("wikidata", "get_entity", err, { politician_id: p.id, qid: cand.id }); return []; }
  const ent = entities[cand.id];
  if (!ent || !looksPolitical(ent)) return [];

  // Collect related entity ids from the claims we care about.
  const claims = ent.claims ?? {};
  const relatedIds = new Set();
  const byProp = {};
  for (const [prop, key] of Object.entries(REL)) {
    const vals = (claims[prop] ?? []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
    if (vals.length) { byProp[key] = vals; vals.forEach((id) => relatedIds.add(id)); }
  }
  // Resolve related entity labels in one batch. If this lookup FAILS while we
  // know relatives exist, bail out entirely — emitting a row with an empty
  // relatives list would look like fresh data and could overwrite a previously
  // good fetch downstream. No data beats degraded data.
  let related = {};
  if (relatedIds.size) {
    try { related = await getEntities([...relatedIds].slice(0, 50)); }
    catch (err) { noteFetchFailure("wikidata", "get_relatives", err, { politician_id: p.id, qid: cand.id, wanted: relatedIds.size }); return []; }
    // Bailing out here is correct (no data beats degraded data) but it is a
    // DROP of known-present relatives, so it has to be recorded as one.
    if (!Object.keys(related).length) {
      noteParseMiss("wikidata", "get_relatives", { url: API, expected: `${relatedIds.size} relative label(s)` });
      return [];
    }
  }
  const nameOf = (id) => labelOf(related[id]) ?? id;

  // Build the structured relatives list (for graph.js) + readable content.
  // Skip relatives with no English label — publishing a raw QID ("Q1234567
  // (child)") is noise and useless for name-matching anyway.
  const relatives = [];
  for (const key of ["spouse", "father", "mother", "child", "sibling", "relative"])
    for (const id of byProp[key] ?? []) {
      const nm = nameOf(id);
      if (/^Q\d+$/.test(nm)) continue;
      relatives.push({ relation: key, name: nm, wikidata_id: id });
    }

  const lines = [`WIKIDATA STRUCTURED PROFILE — ${labelOf(ent) ?? p.name} (${cand.id})`];
  if (descOf(ent)) lines.push(`Description: ${descOf(ent)}`);
  if (relatives.length)
    lines.push(`Family (named relatives): ${relatives.map((r) => `${r.name} (${r.relation})`).join("; ")}.`);
  const positions = (byProp["position held"] ?? []).map(nameOf);
  if (positions.length) lines.push(`Positions held: ${[...new Set(positions)].slice(0, 12).join("; ")}.`);
  const parties = (byProp.party ?? []).map(nameOf);
  if (parties.length) lines.push(`Party affiliation(s) on record: ${[...new Set(parties)].join("; ")}.`);

  if (lines.length < 2 && !relatives.length) return []; // nothing useful

  return [{
    politician_id: p.id,
    source_type: "wikidata",
    tier: 6,
    admissible: false,
    title: `Wikidata structured profile — ${p.name}`,
    url: `https://www.wikidata.org/wiki/${cand.id}`,
    date: null,
    summary: `Structured biographical data: ${relatives.length} named relative(s), ${positions.length} position(s). Secondary reference — corroborate.`,
    content: lines.join("\n"),
    numbers: { relatives, wikidata_id: cand.id }, // consumed by graph.js
  }];
}
