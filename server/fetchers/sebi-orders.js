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
import { noteFetchFailure, noteParseMiss, circuitOpen } from "./observe.js";

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

// SEBI's own phrasing for "your search matched nothing". When the page says
// this, zero order PDFs is the CORRECT answer, not a parse failure.
const NO_RESULTS_RE =
  /no\s+(?:records?|results?|orders?|data|matches?|entries)\s+(?:were\s+|was\s+)?(?:found|available|match)|search\s+(?:returned|found)\s+no|nothing\s+found/i;

/**
 * PURE. Should "zero order PDF links" be reported as a parse miss?
 *
 * Why this discriminator exists: parseOrderLinks() returns [] for the
 * OVERWHELMING MAJORITY of the ~4,559-politician roster, because most people
 * simply have no SEBI enforcement orders. The page loads (200, non-empty), it
 * just has no order rows. Flagging that fired a parse-miss per politician per
 * run — thousands of rows describing normal operation, which is worse than no
 * alert at all: it teaches the operator to ignore the report.
 *
 * The real signature we want — an upstream redesign — is: SEBI's listing DID
 * surface this person (their name is in the rendered listing text, which is why
 * the caller has a fallback excerpt to ship) and yet we extracted no document
 * link from it. That is "we failed to parse what upstream returned". So:
 *   - no name in the rendered listing  → legitimate no-orders, stay silent
 *   - an explicit "no records found"   → legitimate no-orders, stay silent
 *   - name present, no links parsed    → flag it
 *
 * Deliberately fail-CLOSED: an unexpected redesign that also stops echoing the
 * name goes unflagged rather than flagging every politician. Silence beats a
 * detector nobody believes; the transport failure is already covered by
 * fetchText, and the "search" phase note covers a blank page.
 *
 * @param {string} html      raw search-results HTML (200 body)
 * @param {string|null} pageCtx  rendered-text excerpt around the politician's
 *   name, or null when the name does not appear in the listing text at all
 */
export function shouldFlagMissingOrderLinks(html, pageCtx) {
  if (!pageCtx) return false;
  return !NO_RESULTS_RE.test(html ?? "");
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
  // SEBI answers 403 to this search (bot detection). It is queried once per
  // politician, so a full-roster run would issue 4,559 requests it already knows
  // will be refused — and hammering a regulator that has said no is both futile
  // and the fastest way to lose the IP for the sources that do work.
  if (circuitOpen("sebi")) return [];
  const url = `${SEBI_BASE}/enforcement/orders/?text=${encodeURIComponent(p.name)}`;
  const html = await fetchText(url, { timeoutMs: TIMEOUT_DEFAULT, source: "sebi" });
  // fetchText already recorded the transport failure; this records that SEBI
  // coverage for THIS politician is missing rather than empty.
  if (!html) { noteFetchFailure("sebi", "search", "empty search page", { url, politician_id: p.id }); return []; }

  // Today's behaviour, computed up front as the guaranteed fallback.
  const pageCtx = contextAround(htmlToText(html, 20000), p.name);

  // Level 1: open the linked order PDFs and keep those that name the politician.
  const limit = fulltextLimit();
  let matched = [];
  if (limit > 0) {
    try {
      const links = parseOrderLinks(html).slice(0, limit);
      const results = await mapLimit(links, 3, async (link) => {
        const body = await fetchPdfText(link.href, { maxLen: 6000, source: "sebi" });
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
      // Links parsed to nothing on a page that DID surface this politician is the
      // HTML-redesign signature: the fallback context excerpt still ships, but
      // the order PDFs — the admissible part — are gone. The discriminator is
      // essential; see shouldFlagMissingOrderLinks. "This politician has no SEBI
      // orders" is the normal case and must stay silent.
      if (!links.length && shouldFlagMissingOrderLinks(html, pageCtx)) {
        noteParseMiss("sebi", "order_links", { url, bytes: html.length, expected: "order PDF links" });
      }
    } catch (err) {
      noteFetchFailure("sebi", "order_pdfs", err, { url, politician_id: p.id });
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
