// Directorship crossfeed (Phase 5 / Plans B2 + B3). The bidirectional loop that turns
// a single politician↔company mention into a whole co-directorship network.
//
// Extraction is POLITICIAN-FIRST and SUBJECT-ONLY: from a news/court/leak item it
// learns "politician P is a director of company C" and (once verified) C's CIN. Tofler
// is COMPANY-FIRST: given C's CIN it returns C's ENTIRE registered board. So here we
// feed each extraction-discovered, CIN-resolved company INTO the Tofler board lookup,
// then run the existing director→politician matcher over the fetched board. The result:
//   • B2 — OTHER politicians on the same board surface (co-directorship / collusion),
//          discovered without any evidence text ever naming them together.
//   • B3 — a politician's RELATIVE on the board surfaces (dynasty directorship) — the
//          subject-only extraction path drops these, but the matcher checks family_of.
//
// Reuses, unchanged: fetchToflerDirectors (fetch board by CIN), upsertToflerCompany
// (cache), matchDirectorsToPoliticians (Phase-4: writes director_of edges + leads for
// self AND relatives). The board fetch is INJECTABLE (fetchBoard) so tests stay offline.
// Network use is opt-in by the caller (this is an on-demand step, like the Tofler path).
import { db, upsertToflerCompany } from "../store.js";
import { fetchToflerDirectors, companyKey } from "../fetchers/tofler.js";
import { matchDirectorsToPoliticians } from "../director-link.js";

const DIRECTORSHIP_REL_TYPES = [
  "director_of", "promoter_of", "beneficial_owner_of", "partner_of",
  "proprietor_of", "chairman_of", "officer_of", "shareholder_of",
];

// Extraction-discovered companies worth pulling a full board for: a CIN-bearing company
// entity that is the target of a NON-Tofler directorship edge (i.e. found from evidence
// text, not already from Tofler) and whose board we haven't cached yet.
export function seedCompaniesForCrossfeed() {
  const ph = DIRECTORSHIP_REL_TYPES.map(() => "?").join(",");
  return db.prepare(
    `SELECT DISTINCT e.canonical_name AS name, json_extract(e.strong_ids,'$.cin') AS cin
       FROM relationships r
       JOIN entities e ON e.id = r.dst_entity_id
      WHERE r.rel_type IN (${ph}) AND r.source != 'tofler'
        AND e.kind = 'company'
        AND json_extract(e.strong_ids,'$.cin') IS NOT NULL
        AND json_extract(e.strong_ids,'$.cin') NOT IN
            (SELECT cin FROM tofler_companies WHERE cin IS NOT NULL)`
  ).all(...DIRECTORSHIP_REL_TYPES);
}

// Fetch each seed company's board, cache it, then re-run the director→politician matcher
// so the newly cached boards produce edges/leads for every politician/relative on them.
export async function runDirectorshipCrossfeed({ fetchBoard = fetchToflerDirectors, limit = null } = {}) {
  const seeds = seedCompaniesForCrossfeed();
  const use = limit != null && Number.isFinite(Number(limit)) ? seeds.slice(0, Number(limit)) : seeds;
  let fetched = 0, cached = 0;
  for (const s of use) {
    let board;
    try { board = await fetchBoard({ name: s.name, cin: s.cin }); } catch { board = null; }
    fetched++;
    if (!board?.directors?.length) continue;
    const cin = board.cin ?? s.cin;
    const name = board.name ?? s.name;
    upsertToflerCompany({
      company_key: companyKey({ name, cin }), cin, name,
      source_url: board.source_url ?? null, directors: board.directors,
      resolved_by: board.resolved_by ?? "crossfeed",
    });
    cached++;
  }
  // Match the newly cached boards → self/relative/other-politician edges + leads.
  const matched = cached ? matchDirectorsToPoliticians() : { edges: 0, leads: 0 };
  return { seeds: use.length, fetched, cached, edges: matched.edges ?? 0, leads: matched.leads ?? 0 };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/directorship-crossfeed.js");
if (invokedDirectly) {
  runDirectorshipCrossfeed().then((c) => { console.log("[directorship-crossfeed] done:", JSON.stringify(c)); process.exit(0); });
}
