// Wikipedia biography fetcher — pulls the real intro extract for a politician
// so GLM has actual career/background prose to work from (not just a link).
// Secondary source → admissible:false, tier 9. Name-matched via search to
// avoid disambiguation errors; only accepted if the page looks like an
// Indian politician.

const API = "https://en.wikipedia.org/w/api.php";
const UA = { "User-Agent": "PandorosBox/0.1 (public-accountability research)" };

const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

// Score how well a Wikipedia page title matches the target name.
function titleScore(name, title) {
  const n = norm(name), t = norm(title);
  if (n === t) return 100;
  const nTok = new Set(n.split(" ")), tTok = t.split(" ");
  const overlap = tTok.filter((w) => nTok.has(w)).length;
  const allNamePresent = [...nTok].every((w) => t.includes(w));
  // Penalise titles with many extra tokens (e.g. a relative's longer name).
  let score = overlap * 20 - Math.max(0, tTok.length - nTok.size) * 8;
  if (allNamePresent) score += 15;
  if (t.startsWith(n)) score += 25;
  return score;
}

export async function fetchWikipedia(p) {
  const search = `${p.name} Indian politician ${p.party ?? ""}`.trim();
  const url =
    `${API}?action=query&format=json&generator=search` +
    `&gsrsearch=${encodeURIComponent(search)}&gsrlimit=5` +
    `&prop=extracts|info&exintro=1&explaintext=1&inprop=url`;

  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = await res.json();
    const pages = data?.query?.pages;
    if (!pages) return [];

    // Pick the candidate whose title best matches the name.
    const page = Object.values(pages)
      .map((pg) => ({ pg, score: titleScore(p.name, pg.title ?? "") }))
      .sort((a, b) => b.score - a.score)[0];
    if (!page || page.score < 20) return []; // no confident match → skip

    const extract = (page.pg.extract ?? "").trim();
    if (!extract || extract.length < 80) return [];

    // Guard against wrong-person matches: require a politics/India signal.
    const blob = `${page.pg.title} ${extract}`.toLowerCase();
    const looksRight = /(politician|member of|minister|mla|mp|lok sabha|assembly|party|constituency|india)/.test(blob);
    if (!looksRight) return [];

    return [{
      politician_id: p.id,
      source_type: "wikipedia",
      tier: 9,
      admissible: false,
      title: `Wikipedia biography — ${page.pg.title}`,
      url: page.pg.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.pg.title)}`,
      date: null,
      summary: "Wikipedia background (secondary source — corroborate against official records).",
      content: extract.slice(0, 1800),
    }];
  } catch { return []; }
}
