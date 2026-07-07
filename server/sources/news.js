// News connector. Primary source: GDELT 2.0 DOC API — free, no key, covers
// global news (including most Indian English-language outlets) back to 2017,
// with tone scoring. For pre-2017 coverage, use newspaper archive links
// (returned as research pointers, not parsed).
//
// News is NOT court-admissible for the truth of its contents — every item is
// tagged admissible:false. It is used for leads, manifesto-tracking, and
// public-statement history, with the report required to corroborate against
// primary records before scoring.

import { gdeltJson } from "./gdelt-fetch.js";

const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";

export async function fetchNews(p, { maxRecords = 100 } = {}) {
  const query = `"${p.name}"`;
  const url =
    `${GDELT}?query=${encodeURIComponent(query)}` +
    `&mode=ArtList&maxrecords=${maxRecords}&sort=DateDesc&format=json` +
    `&startdatetime=20170101000000`;
  try {
    const data = await gdeltJson(url, { headers: { "User-Agent": "RateMyRep/0.1" } });
    if (!data) return [];
    return (data.articles ?? []).map((a) => ({
      politician_id: p.id,
      source_type: "news",
      tier: 9,
      admissible: false,
      title: a.title,
      url: a.url,
      date: a.seendate
        ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}`
        : null,
      summary: `${a.domain ?? "unknown outlet"} — news coverage (lead only; corroborate against primary records).`,
    }));
  } catch {
    return [];
  }
}

/** Archive pointers for coverage older than GDELT's window. */
export function archiveLinks(p) {
  const q = encodeURIComponent(`"${p.name}"`);
  return [
    {
      politician_id: p.id,
      source_type: "news_archive",
      tier: 9,
      admissible: false,
      title: `Google News archive search — ${p.name}`,
      url: `https://news.google.com/search?q=${q}`,
      date: null,
      summary: "Manual archive research pointer for coverage before 2017.",
    },
    {
      politician_id: p.id,
      source_type: "news_archive",
      tier: 9,
      admissible: false,
      title: `The Hindu archive — ${p.name}`,
      url: `https://www.thehindu.com/search/?q=${q}`,
      date: null,
      summary: "Newspaper archive search (goes back decades for major figures).",
    },
  ];
}
