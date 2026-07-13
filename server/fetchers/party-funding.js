// Party financials — scrapes the FULL income/expenditure/assets/liabilities and
// donation records of the party a politician belongs to, from MyNeta's /party/
// section (ADR's structuring of ECI-filed party financial returns, incl. foreign
// & corporate donations and electoral-bond income where disclosed).
//
// Maps p.party (e.g. "BJP") → MyNeta party id via the abbreviation MyNeta prints
// in parentheses, e.g. "Bharatiya Janata Party (BJP)". Free, no key.
import { fetchText, htmlToText, mapLimit } from "./http.js";

const BASE = "https://www.myneta.info/party/index.php";

// Cached party directory: abbreviation + full name → MyNeta party id.
let mapPromise = null;
async function partyMap() {
  if (!mapPromise) mapPromise = (async () => {
    const html = await fetchText("https://www.myneta.info/party/", { timeoutMs: 25000 });
    const map = new Map();
    if (!html) return map;
    for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = m[1];
      const idm = row.match(/action=summary&id=(\d+)/);
      if (!idm) continue;
      const text = htmlToText(row, 200);
      const name = (text.match(/^(.*?)\s*Financials Summary/)?.[1] ?? text.slice(0, 70)).trim();
      const entry = { id: idm[1], name };
      const abbr = name.match(/\(([^)]+)\)\s*$/)?.[1]?.trim().toLowerCase();
      if (abbr) map.set(abbr, entry);
      map.set(name.toLowerCase(), entry);
    }
    return map;
  })();
  return mapPromise;
}

function resolveParty(party, map) {
  const key = party.trim().toLowerCase();
  if (map.has(key)) return map.get(key);
  // try matching our abbr against any entry's abbr, or full-name contains
  for (const [k, v] of map) {
    if (k === key) return v;
    if (v.name.toLowerCase().includes(key) && key.length >= 3) return v;
  }
  return null;
}

const trim = (s, cap) => {
  const di = s.toLowerCase().indexOf("disclaimer");
  return (di > 200 ? s.slice(0, di) : s).trim().slice(0, cap);
};

// How many recent financial years of the detailed line-item breakdown to pull.
const DETAIL_YEARS = 3;
const SECTIONS = ["Assets", "Liabilities", "Income", "Expenditure"];

// Strip a cell's inner HTML down to plain text.
const cellText = (h) => h.replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// Pull the labelled line items of one section (Assets/Liabilities/Income/
// Expenditure) from a per-year "action=itr" detail page. The section is a
// bordered <table> of <td>Label</td><td>Rs. N Lacs</td> rows plus a final
// "Total X" row whose HTML is malformed (the label <td> is never closed), so we
// capture cell text tolerantly — stopping at the next <td>/</td>/</tr>/</table>
// — and pair cells as (label, amount). This is where the genuinely distinct
// figures live; the summary table only carries the four balancing totals.
function itrSection(html, name) {
  const start = html.search(new RegExp(`<th[^>]*>\\s*${name}\\s*</th>`, "i"));
  if (start < 0) return [];
  const end = html.indexOf("</table>", start);
  const chunk = html.slice(start, end < 0 ? html.length : end);
  const cells = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)(?=<\/td>|<td\b|<\/tr>|<\/table>)/gi)]
    .map((m) => cellText(m[1])).filter(Boolean);
  const items = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const label = cells[i];
    const amount = cells[i + 1].match(/Rs\.?\s*([\d,]+\.?\d*)/)?.[1];
    if (label && amount) items.push({ label, amount });
  }
  return items;
}

// Format one ITR detail page into a compact, extractor-friendly block.
function formatItr(html, fyLabel) {
  const lines = [];
  for (const name of SECTIONS) {
    const items = itrSection(html, name);
    if (items.length) lines.push(`  ${name}: ${items.map((it) => `${it.label} Rs.${it.amount}`).join(" | ")} (lacs)`);
  }
  return lines.length ? `FY ${fyLabel}:\n${lines.join("\n")}` : "";
}

// Party-level scrape cache: many politicians share a party, so scraping the
// summary + per-year detail + donations once per party (keyed by MyNeta id)
// avoids re-fetching for every member during a single ingest run. `null` marks
// a party whose summary page failed, so we don't retry it repeatedly.
const partyCache = new Map();

async function scrapeParty(entry) {
  if (partyCache.has(entry.id)) return partyCache.get(entry.id);

  const summaryHtml = await fetchText(`${BASE}?action=summary&id=${entry.id}`, { timeoutMs: 20000 });
  if (!summaryHtml) { partyCache.set(entry.id, null); return null; }

  let summary = trim(htmlToText(summaryHtml, 5000), 2500);
  const si = summary.search(/Total (Assets|Income)/i);
  if (si > 0) summary = summary.slice(si);

  // Most-recent financial years linked from the summary table → detailed breakdown.
  const years = [];
  const seenYears = new Set();
  for (const m of summaryHtml.matchAll(/action=itr&year=(\d+)&id=\d+>\s*([\d-]+)/gi)) {
    if (seenYears.has(m[1])) continue;
    seenYears.add(m[1]);
    years.push({ year: m[1], label: m[2] });
  }
  years.sort((a, b) => Number(b.year) - Number(a.year));
  const blocks = await mapLimit(years.slice(0, DETAIL_YEARS), 2, async ({ year, label }) => {
    const h = await fetchText(`${BASE}?action=itr&year=${year}&id=${entry.id}`, { timeoutMs: 20000 });
    return h ? formatItr(h, label) : "";
  });
  const detail = blocks.filter(Boolean).join("\n");

  // Most-recent donation listing (donor names, amounts, foreign/corporate flags).
  let donations = "";
  const yr = summaryHtml.match(/action=donation&year=([\d-]+)&id=/)?.[1];
  if (yr) {
    const dHtml = await fetchText(`${BASE}?action=donation&year=${yr}&id=${entry.id}`, { timeoutMs: 20000 });
    if (dHtml) {
      const d = trim(htmlToText(dHtml, 4000), 2500);
      const dsi = d.search(/donat/i);
      donations = `DONATIONS (${yr}):\n${dsi > 0 ? d.slice(dsi) : d}`;
    }
  }

  const result = { entry, summary, detail, donations };
  partyCache.set(entry.id, result);
  return result;
}

export async function fetchPartyFunding(p) {
  if (!p.party || /independent|demo/i.test(p.party)) return [];
  const entry = resolveParty(p.party, await partyMap());
  if (!entry) return [];

  const data = await scrapeParty(entry);
  if (!data) return [];

  const detailBlock = data.detail
    ? `DETAILED BREAKDOWN — per-year income sources, spending categories, and asset/liability composition (the distinct, non-balancing figures):\n${data.detail}`
    : "";
  // The summary table's four top-line totals balance by accounting identity
  // (Total Assets = Total Liabilities; Total Income = Total Expenditure via the
  // surplus carried over) — flag that so it isn't mistaken for duplicated data.
  const summaryBlock = data.summary
    ? `MULTI-YEAR SUMMARY — top-line totals per year. By accounting identity Total Assets = Total Liabilities (balance sheet balances; net worth filed under Liabilities) and Total Income = Total Expenditure (surplus carried over to General Fund):\n${data.summary}`
    : "";
  const body = [detailBlock, summaryBlock, data.donations].filter(Boolean).join("\n\n");

  return [{
    politician_id: p.id,
    source_type: "party_finance",
    tier: 6,
    admissible: true,
    title: `Party financials — ${entry.name} (${p.name}'s party)`,
    url: `${BASE}?action=summary&id=${entry.id}`,
    date: null,
    summary: `Income, expenditure, assets, liabilities and donation records of ${entry.name} (ADR/ECI data) — the party ${p.name} belongs to. Includes foreign/corporate donations where disclosed.`,
    content: `PARTY FINANCIALS — ${entry.name} (${p.name}'s party):\n${body}`.slice(0, 9000),
  }];
}
