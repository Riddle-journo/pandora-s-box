// US SEC EDGAR full-text search — free JSON API, no key, no registration.
// Searches all SEC filings (10-K, 6-K, 20-F, etc., back to 2001) for an exact
// quoted match on the politician's full name. Hit rate is near-zero for most
// state/local politicians — but a hit is gold: a US-listed or foreign-private
// issuer only names a foreign politician in a regulatory filing when a real
// business/regulatory event ties them together (e.g. Tata Motors' 6-K on the
// Singur land dispute names Mamata Banerjee). Zero-cost, low false-positive
// risk (exact-phrase match on a full name, then re-verified in the fetched
// document text before being accepted).
//
// Lead only — a mention in a filing is not an adjudicated finding.
import { fetchText, fetchJsonEx, UA, contextAround , TIMEOUT_SLOW } from "./http.js";
import { logger } from "../util/log.js";

const log = logger("sec-edgar");

const SEARCH_API = "https://efts.sec.gov/LATEST/search-index";


export async function fetchSECEdgar(p) {
  if (!p.name || p.name.split(/\s+/).length < 2) return []; // full-name phrase match only
  if (process.env.SEC_EDGAR_DISABLE === "1") return [];

  const url = `${SEARCH_API}?q=${encodeURIComponent(`"${p.name}"`)}`;
  const r = await fetchJsonEx(url, { headers: UA });
  if (!r.ok) {
    log.warn({ url, status: r.status, err: r.error?.message }, "sec-edgar search failed");
    return [];
  }
  const hits = r.data?.hits?.hits ?? [];
  if (!hits.length) return [];

  const items = [];
  for (const h of hits.slice(0, 3)) {
    const src = h._source ?? {};
    const [accessionRaw, filename] = String(h._id ?? "").split(":");
    const cik = (src.ciks ?? [])[0];
    if (!accessionRaw || !filename || !cik) continue;
    const accession = accessionRaw.replaceAll("-", "");
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${filename}`;

    const html = await fetchText(docUrl, { timeoutMs: TIMEOUT_SLOW });
    if (!html) continue;
    const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    const ctx = contextAround(text, p.name, 900);
    if (!ctx) continue; // name didn't actually resolve in the fetched document — skip

    const issuer = (src.display_names ?? [])[0] ?? "unknown filer";
    const form = src.form ?? "filing";
    const date = src.file_date ?? null;
    items.push({
      politician_id: p.id,
      source_type: "sec_edgar",
      tier: 6,
      admissible: true,
      title: `SEC EDGAR filing mentions ${p.name} — ${issuer} (${form})`,
      url: docUrl,
      date,
      summary: `A US SEC filing (${form}, ${issuer}, ${date ?? "date unknown"}) names "${p.name}" in its disclosure text — verify identity and context before drawing conclusions; a mention is not an allegation.`,
      content: `SEC EDGAR filing excerpt naming "${p.name}" (filer: ${issuer}, form ${form}, filed ${date ?? "unknown"}):\n…${ctx}…`,
    });
  }
  return items;
}
