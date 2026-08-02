// Shared citation + numbered-source-registry helpers.
//
// Extracted verbatim from report-generator.js so that BOTH the per-politician
// dossier engine and the incident-centric story engine attach citations the
// SAME way: the model only ever emits [n] markers in its prose, and this module
// mechanically resolves each [n] to the matching numbered registry entry. A
// model can never hand back a citation object — citation integrity is enforced
// in CODE, here, not by trusting the model.

// ── Citation integrity helper ──────────────────────────────────────────
// Scan [n] markers in text and return the matching registry items as
// {n,title,url,admissible}. Guarantees every UI citation resolves correctly.
export function citationsFor(text, registry) {
  const seen = new Set();
  const out = [];
  for (const m of String(text ?? "").matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    const src = registry.find((r) => r.n === n);
    if (src) { out.push({ n, title: src.title, url: src.url, admissible: src.admissible }); seen.add(n); }
  }
  return out;
}

// Real-content items first (full affidavit, biography, then news leads), so the
// model's budget goes to substance. Content-less "pointer" links (generic
// "search portal X" URLs GLM can't read) are EXCLUDED entirely — they only
// bloated the prompt and tempted citing unread sources. News/fact-check leads
// are kept: their headline is readable content.
export function selectSources(evidence, limit) {
  const rank = (e) =>
    e.content && e.source_type === "eci_affidavit" ? 0 :  // richest: full affidavit
    e.content ? 1 :                                         // other real document text
    2;                                                      // news / fact-check leads
  const usable = evidence.filter((e) =>
    e.content || e.source_type === "news" || e.source_type === "fact_check" || e.source_type === "prior_dossier");
  return usable.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

// ── Numbered source registry (for story generation) ─────────────────────
// Rank evidence rows the SAME way as selectSources (documents over news),
// cap the count, truncate each body, and number them 1..N. The returned
// registry is what a model's [n] markers resolve against via citationsFor.
export function buildRegistry(evidence, { cap = 40, truncate = 1500 } = {}) {
  return selectSources(evidence, cap).map((e, i) => ({
    n: i + 1,
    title: e.title ?? "",
    url: e.url ?? null,
    admissible: !!e.admissible,
    source_type: e.source_type ?? null,
    tier: e.tier ?? null,
    date: e.date ?? null,
    content: e.content ? String(e.content).slice(0, truncate) : "",
  }));
}
