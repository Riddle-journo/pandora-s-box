// Party financials — scrapes the FULL income/expenditure/assets/liabilities and
// donation records of the party a politician belongs to, from MyNeta's /party/
// section (ADR's structuring of ECI-filed party financial returns, incl. foreign
// & corporate donations and electoral-bond income where disclosed).
//
// Maps p.party (e.g. "BJP") → MyNeta party id via the abbreviation MyNeta prints
// in parentheses, e.g. "Bharatiya Janata Party (BJP)". Free, no key.
import { fetchText, htmlToText } from "./http.js";

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

export async function fetchPartyFunding(p) {
  if (!p.party || /independent|demo/i.test(p.party)) return [];
  const entry = resolveParty(p.party, await partyMap());
  if (!entry) return [];

  const summaryHtml = await fetchText(`${BASE}?action=summary&id=${entry.id}`, { timeoutMs: 20000 });
  if (!summaryHtml) return [];
  let summary = trim(htmlToText(summaryHtml, 5000), 4000);
  const si = summary.search(/Total (Assets|Income)/i);
  if (si > 0) summary = summary.slice(si);

  // Most-recent donation listing (donor names, amounts, foreign/corporate flags).
  let donations = "";
  const yr = summaryHtml.match(/action=donation&year=([\d-]+)&id=/)?.[1];
  if (yr) {
    const dHtml = await fetchText(`${BASE}?action=donation&year=${yr}&id=${entry.id}`, { timeoutMs: 20000 });
    if (dHtml) {
      let d = trim(htmlToText(dHtml, 4000), 3000);
      const dsi = d.search(/donat/i);
      donations = `\n\nDONATIONS (${yr}):\n${dsi > 0 ? d.slice(dsi) : d}`;
    }
  }

  return [{
    politician_id: p.id,
    source_type: "party_finance",
    tier: 6,
    admissible: true,
    title: `Party financials — ${entry.name} (${p.name}'s party)`,
    url: `${BASE}?action=summary&id=${entry.id}`,
    date: null,
    summary: `Income, expenditure, assets, liabilities and donation records of ${entry.name} (ADR/ECI data) — the party ${p.name} belongs to. Includes foreign/corporate donations where disclosed.`,
    content: `PARTY FINANCIALS — ${entry.name} (${p.name}'s party):\n${summary}${donations}`.slice(0, 7000),
  }];
}
