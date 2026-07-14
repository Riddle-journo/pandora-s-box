// SEBI enforcement orders — searches SEBI's orders listing for the politician's
// name, then opens the actual order PDFs it links to. Catches insider trading,
// market manipulation, and promoter violations. SEBI orders are admissible
// public records (constitutional regulator). Free, no key.
//
// Two levels of evidence:
//   1. Full text — download the linked order PDFs and keep only those whose body
//      names the politician (strong: the order document itself mentions them).
//   2. Fallback — if no order PDF is found/matched, the search-results-page
//      excerpt (today's behaviour), so we never regress.
import { fetchText, htmlToText, contextAround, fetchPdfText, mapLimit, sleep , TIMEOUT_DEFAULT } from "./http.js";

const SEBI_BASE = "https://www.sebi.gov.in";
const SUMMARY = "SEBI enforcement orders — insider trading, market manipulation, or promoter violations (admissible public record from a statutory regulator).";

// How many linked order PDFs to actually download+read per politician.
// SEBI_FULLTEXT_LIMIT=0 cleanly disables the PDF step (falls back to the
// search-page excerpt). Default 5.
function fulltextLimit() {
  const raw = process.env.SEBI_FULLTEXT_LIMIT;
  if (raw === undefined || raw === "") return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5;
}

// Strip tags + decode the few entities SEBI uses in link text, collapse space.
const cleanTitle = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&rdquo;|&ldquo;/gi, '"')
    .replace(/&ndash;|&mdash;/gi, "–")
    .replace(/\s+/g, " ")
    .trim();

// PURE. From the search-results HTML, pull out the linked order documents:
// every anchor whose href points at a `.pdf`, absolutised against SEBI_BASE and
// de-duplicated. Returns [{ title, href }] (empty array on empty/garbage input).
export function parseOrderLinks(html) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    // Only order documents: href ends in `.pdf` (optionally + query/fragment).
    if (!/\.pdf(?:$|[?#])/i.test(raw)) continue;
    let href;
    try {
      href = new URL(raw, SEBI_BASE).href;
    } catch {
      continue; // malformed href — skip, never throw.
    }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title: cleanTitle(m[2]), href });
  }
  return out;
}

// Build the shared evidence-row shape (source_type/tier kept stable).
const orderRow = (p, url, content) => ({
  politician_id: p.id,
  source_type: "sebi_orders",
  tier: 6,
  admissible: true,
  title: `SEBI enforcement orders — ${p.name}`,
  url,
  date: null,
  summary: SUMMARY,
  content,
});

export async function fetchSEBIOrders(p) {
  const url = `${SEBI_BASE}/enforcement/orders/?text=${encodeURIComponent(p.name)}`;
  const html = await fetchText(url, { timeoutMs: TIMEOUT_DEFAULT });
  if (!html) return [];

  // Today's behaviour, computed up front as the guaranteed fallback.
  const pageCtx = contextAround(htmlToText(html, 20000), p.name);

  // Level 1: open the linked order PDFs and keep those that name the politician.
  const limit = fulltextLimit();
  let matched = [];
  if (limit > 0) {
    try {
      const links = parseOrderLinks(html).slice(0, limit);
      const results = await mapLimit(links, 3, async (link) => {
        const body = await fetchPdfText(link.href, { maxLen: 6000 });
        await sleep(700); // politeness between SEBI requests
        if (!body) return null;
        // KEEP ALL DATA: don't discard an order just because the politician's own
        // name isn't in the body — it may name their company, a relative, or an
        // associate, which is precisely the link we want the extractor to record
        // as a universal-entity relationship. The search is already name-scoped;
        // excerpt around the name when present, else the order's opening.
        const around = contextAround(body, p.name, 800);
        return { title: link.title, href: link.href, ctx: around || body.slice(0, 1000), named: !!around };
      });
      matched = results.filter(Boolean);
    } catch {
      matched = []; // never throw — degrade to the fallback below.
    }
  }

  if (matched.length) {
    const body = matched
      .map((o) => `— ${o.title || o.href}${o.named ? "" : " [politician's name not in this order's body — verify the named party]"}\n${o.href}\n…${o.ctx}…`)
      .join("\n\n");
    const noun = matched.length > 1 ? "orders" : "order";
    return [orderRow(p, url, `SEBI enforcement ${noun} from a search for "${p.name}" (${matched.length} order document${matched.length > 1 ? "s" : ""}; verify each named party before treating as a finding):\n\n${body}`)];
  }

  // Fallback: search-results-page excerpt (return [] exactly when today's code would).
  if (!pageCtx) return [];
  return [orderRow(p, url, `SEBI enforcement orders listing excerpt for "${p.name}":\n…${pageCtx}…`)];
}
