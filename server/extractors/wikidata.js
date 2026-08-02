// Wikidata extractor (Phase 2H) — the FAMILY GRAPH. wikidata evidence carries a
// clean structured `numbers.relatives` list ([{relation, name, wikidata_id}]), so
// this is the first extractor to grow the RELATIONSHIPS ledger: a family_of edge
// from the politician to each relative, with the relative resolved (or created) as
// its own person entity keyed by wikidata_id. That gives anomaly/relations queries
// their family dimension — the "his family, friends, companies" the design set out
// to support — and every relative becomes a first-class entity that can itself hold
// facts/claims later.
//
// The specific tie (father/mother/sibling/spouse/child) is kept in the edge's data;
// rel_type stays the established 'family_of' the graph already uses.
//
// It ALSO now pulls a birth YEAR out of the profile prose (data-gap fill for the
// young_wealth detector): the description line often reads "Indian politician
// (1970–present)" or "(born 1970)". Conservative — an explicit birth phrase, a
// plausible living-adult year only, else nothing.
import { registerExtractor, runExtraction } from "./extract.js";

export const WIKIDATA_VERSION = "wikidata-v2"; // bumped: now also emits birth_year facts

const PLAUSIBLE_BIRTH = (y) => Number.isFinite(y) && y >= 1920 && y <= 2005;

// Pure: wikidata profile content → a birth_year fact (or none). Exported for tests.
export function wikidataBirthYear(content) {
  const t = String(content ?? "");
  const patterns = [
    /\bborn\s+(?:\w+\s+\d{1,2},?\s+)?(\d{4})/i, // "born 12 March 1970" / "born 1970"
    /\bb\.\s*(\d{4})/i,                          // "b. 1970"
    /\((\d{4})[–\-—]\s*(?:present|\d{4})?\)/,   // "(1970–present)" / "(1970-2020)"
    /\(born\s+(\d{4})\)/i,                       // "(born 1970)"
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && PLAUSIBLE_BIRTH(Number(m[1])))
      return [{ metric: "birth_year", value: Number(m[1]), unit: "year", as_of_date: String(m[1]) }];
  }
  return [];
}

// Pure: a wikidata `numbers` object → relationship records (semantic fields only),
// deduped by relative identity.
export function wikidataRelationships(numbers) {
  const relatives = numbers?.relatives;
  if (!Array.isArray(relatives)) return [];
  const out = [];
  const seen = new Set();
  for (const r of relatives) {
    const name = r?.name?.trim?.();
    if (!name) continue;
    const key = String(r.wikidata_id ?? name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      rel_type: "family_of",
      dst_name: name,
      dst_kind: "person",
      dst_strong_ids: r.wikidata_id ? { wikidata_id: String(r.wikidata_id) } : {},
      confidence: 0.9, // Wikidata-sourced, structured
      data: { relation: r.relation ?? null },
    });
  }
  return out;
}

registerExtractor("wikidata", {
  version: WIKIDATA_VERSION,
  extract: (ev) => ({
    relationships: wikidataRelationships(ev.data?.numbers),
    facts: wikidataBirthYear(ev.data?.content),
  }),
});

export function runWikidataExtraction() {
  return runExtraction({ sourceType: "wikidata" });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/wikidata.js");
if (invokedDirectly) {
  console.log("[wikidata] extraction done:", JSON.stringify(runWikidataExtraction()));
  process.exit(0);
}
