// Press-release scanner — fetches ED and CBI listing pages, finds the
// politician's name, extracts the surrounding context, AND follows the
// individual press release links near the name to fetch full release text.
//
// PIB removed: government's own press bureau adds PR noise, not accountability signal.
// Free, no key. Two-level scrape: listing page → individual release pages.
import { fetchText, htmlToText, fetchPdfText, mapLimit, contextAround, isPdf , TIMEOUT_DEFAULT } from "./http.js";


// [label, source_type, tier, listing URL, base URL for resolving relative links]
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
  try { baseHost = new URL(base).hostname; } catch { return []; }
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
    const html = await fetchText(listingUrl, { timeoutMs: TIMEOUT_DEFAULT });
    if (!html) return [];

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
      const dText = isPdf(url)
        ? await fetchPdfText(url, { maxLen: 5000 })
        : htmlToText(await fetchText(url, { timeoutMs: TIMEOUT_DEFAULT }), 5000);
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
