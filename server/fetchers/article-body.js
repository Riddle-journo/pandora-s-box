// Enriches GDELT news leads (which are headline-only) with the FULL article
// body text, so GLM reads what each story actually says — the richest free,
// no-key fuel for the investigative dossier.
//
// Best-effort: paywalled or bot-blocked outlets are skipped silently. Only the
// most recent N articles are fetched to keep ingest fast and polite.
import { fetchText, htmlToText, fetchPdfText, mapLimit, isPdf , TIMEOUT_DEFAULT } from "./http.js";


export async function enrichNewsBodies(newsItems, { limit = 12 } = {}) {
  const targets = (newsItems ?? [])
    .filter((n) => n.url && /^https?:\/\//.test(n.url))
    .slice(0, limit);

  const enriched = await mapLimit(targets, 3, async (n) => {
    // PDF articles (e.g. some govt/press releases linked from news) → pdf-parse.
    const body = isPdf(n.url)
      ? await fetchPdfText(n.url, { maxLen: 3500 })
      : htmlToText(await fetchText(n.url, { timeoutMs: TIMEOUT_DEFAULT }), 3500);
    // Require a real article (filter out cookie walls / tiny stubs)
    if (!body || body.length < 250) return null;
    return {
      ...n,
      summary: `${n.summary ?? ""} (full text retrieved)`.trim(),
      content: body,
    };
  });

  return enriched.filter(Boolean);
}
