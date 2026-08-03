// Press-release scanner — fetches ED and CBI listing pages, finds the
// politician's name, extracts the surrounding context, AND follows the
// individual press release links near the name to fetch full release text.
//
// PIB removed: government's own press bureau adds PR noise, not accountability signal.
// Free, no key. Two-level scrape: listing page → individual release pages.
import { fetchText, htmlToText, fetchPdfText, mapLimit, contextAround, isPdf , TIMEOUT_DEFAULT } from "./http.js";
import { noteFetchFailure, noteParseMiss, circuitOpen } from "./observe.js";


// [label, source_type, tier, listing URL, base URL for resolving relative links]
//
// ED: RESTORED 2026-07-27 after being deleted in an observability-only change.
// The deletion's justification was that enforcementdirectorate.gov.in/press-release
// 404s and that ED is better covered by the L1 json-api source "ed-pmla-releases".
// That replacement is plausible and probably right — but it exists only as an
// UNCOMMITTED entry in server/orchestration/ingest.js (the deletion comment cited
// the stale pre-refactor path "server/ingest.js"), so if that work is reworked or
// reverted, ED coverage disappears with no trace. Dropping an anti-corruption
// source is a deliberate coverage decision that belongs to whoever owns the
// source-expansion change, not to a telemetry pass.
//
// Keeping it is also now cheap to be WRONG about: if the endpoint really is dead,
// fetchText records `press_releases:ed_press#http_text` in the fetch_failures
// table on every run, so the health CLI reports it with evidence instead of us
// guessing — and because that table is separate from fetch_runs, a dead source
// here cannot manufacture a ROTTED verdict. Remove this line once
// "ed-pmla-releases" is committed and confirmed ingesting.
const SOURCES = [
  ["Enforcement Directorate", "ed_press", 3,
    "https://enforcementdirectorate.gov.in/press-release",
    "https://enforcementdirectorate.gov.in"],
  ["Central Bureau of Investigation", "cbi_press", 3,
    "https://cbi.gov.in/press-releases",
    "https://cbi.gov.in"],
];

// Return text within ±window chars of the first name occurrence.

// Extract same-domain links from raw HTML within ±windowChars of the name.
// Filters out root-level nav links (pathname too short).
function linksNear(html, name, base, windowChars = 2500) {
  const idx = html.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) return [];
  const chunk = html.slice(Math.max(0, idx - windowChars), idx + name.length + windowChars);
  let baseHost;
  try { baseHost = new URL(base).hostname; }
  catch (err) { noteFetchFailure("press_releases", "bad_base_url", err, { base }); return []; }
  return [...chunk.matchAll(/href=['"]([^'"]+)['"]/gi)]
    .map(([, href]) => {
      try {
        const u = new URL(href, base);
        if (u.hostname !== baseHost) return null;
        if (u.pathname.length < 5) return null; // skip short nav links
        return u.href;
      } catch { return null; }
    })
    .filter(Boolean)
    .filter((u, i, a) => a.indexOf(u) === i) // dedupe
    .slice(0, 3);
}

export async function fetchPressReleases(p) {
  const all = await Promise.all(SOURCES.map(async ([label, source_type, tier, listingUrl, base]) => {
    // This listing is fetched once per politician. When it is down — ED 404s,
    // CBI times out after ~24s — a full-roster run pays that cost 4,559 times,
    // which for CBI alone is about twenty hours of waiting. After a few
    // failures the breaker skips it for the rest of this process (per-process
    // only: the next run gets a clean try).
    if (circuitOpen(`press_releases:${source_type}`)) return [];
    const html = await fetchText(listingUrl, { timeoutMs: TIMEOUT_DEFAULT, source: `press_releases:${source_type}` });
    // An ED/CBI listing that will not load is a whole enforcement channel
    // going dark for every politician in the run, not a quiet week.
    if (!html) { noteFetchFailure("press_releases", `listing:${source_type}`, "empty listing page", { url: listingUrl, label }); return []; }

    // Convert full page to text (large limit so we get the whole listing)
    const text = htmlToText(html, 30000);
    const ctx = contextAround(text, p.name);
    if (!ctx) return []; // name not on this page at all

    // Level 1: listing-page snippet
    const listingItem = {
      politician_id: p.id,
      source_type,
      tier,
      admissible: false,
      title: `${label} listing — mention of ${p.name}`,
      url: listingUrl,
      date: null,
      summary: `${label}: name appears on the current releases listing page (lead — confirm same person and read the linked release).`,
      content: `From ${label} listing:\n…${ctx}…`,
    };

    // Level 2: fetch the individual press release pages linked near the name
    const deepLinks = linksNear(html, p.name, base);
    const deepItems = await mapLimit(deepLinks, 2, async (url) => {
      // Many ED/CBI releases are PDFs → read them with pdf-parse.
      // `source` is passed so a broken release page is attributed to THIS fetcher
      // rather than to a bare hostname (which would not be recorded at all).
      const src = `press_releases:${source_type}`;
      const dText = isPdf(url)
        ? await fetchPdfText(url, { maxLen: 5000, source: src })
        : htmlToText(await fetchText(url, { timeoutMs: TIMEOUT_DEFAULT, source: src }), 5000);
      if (!dText || dText.length < 120) return null;
      return {
        politician_id: p.id,
        source_type,
        tier,
        admissible: false,
        title: `${label} press release — ${p.name}`,
        url,
        date: null,
        summary: `Full text of ${label} press release naming ${p.name} (lead — not an adjudicated finding; corroborate with eCourts).`,
        content: dText,
      };
    });

    return [listingItem, ...deepItems.filter(Boolean)];
  }));

  return all.flat();
}
