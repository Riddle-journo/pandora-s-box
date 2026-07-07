// Fact-check fetcher (task #6) — a genuinely NEW, non-redundant content source.
//
// Pulls fact-checks ABOUT a representative from India's established fact-check
// outlets (Alt News, BOOM, Factly, Vishvas News, The Quint's WebQoof, Newschecker).
// This is exactly what the report's "claims" / "hypocrisy" layer needs — a
// documented record of statements found true/false/misleading — which GDELT's
// generic news soup doesn't surface cleanly. Free, no key (Google News RSS).
import { fetchText } from "./http.js";

const FC_OUTLETS = /alt\s*news|boom|factly|vishvas|webqoof|quint|newschecker|fact[\s-]*crescendo|the\s*logical\s*indian|pib\s*fact/i;

function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const b = m[1];
    const pick = (tag) => {
      const mm = b.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
      return mm ? mm[1].trim() : "";
    };
    return { title: pick("title").replace(/&amp;/g, "&").replace(/&#39;/g, "'"), link: pick("link"), pubDate: pick("pubDate"), source: pick("source") };
  }).filter((i) => i.title && i.link);
}

export async function fetchFactChecks(p) {
  if (!p?.name || process.env.FACTCHECK_DISABLE === "1") return [];
  const q = encodeURIComponent(`"${p.name}" (fact check OR fact-check OR fake OR misleading OR false claim)`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`;
  let xml = "";
  try { xml = await fetchText(url, { timeoutMs: 12000 }); } catch { return []; }
  if (!xml) return [];

  const hits = [];
  const seen = new Set();
  for (const item of parseRss(xml)) {
    if (!FC_OUTLETS.test(item.source) && !FC_OUTLETS.test(item.title)) continue; // keep only real fact-checks
    const key = item.link.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    let date = null; const t = Date.parse(item.pubDate);
    if (!Number.isNaN(t)) date = new Date(t).toISOString().slice(0, 10);
    hits.push({ title: item.title, source: item.source || "fact-check", date });
    if (hits.length >= 8) break;
  }
  if (!hits.length) return [];

  const lines = hits.map((h) => `• [${h.source}${h.date ? ` ${h.date}` : ""}] ${h.title}`);
  return [{
    politician_id: p.id,
    source_type: "fact_check",
    tier: 9,
    admissible: false,
    title: `Fact-checks involving ${p.name}`,
    url: `https://news.google.com/search?q=${q}`,
    date: hits[0].date,
    summary: `${hits.length} fact-check(s) from established fact-checking outlets reference ${p.name}. Use for the claims/hypocrisy record; verify each item.`,
    content: `Fact-checks referencing "${p.name}" (from recognised fact-checkers — read each to see the verdict):\n${lines.join("\n")}`,
  }];
}
