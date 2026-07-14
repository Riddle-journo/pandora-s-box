// Multilingual Indian news via Google News RSS (free, no key, no captcha).
//
// Why: GDELT skews heavily English, so a huge amount of Indian political
// reporting — in Hindi and the regional-language press — was invisible to the
// dossier. Google News exposes a language-parameterised RSS search; querying a
// rep's (English) name with hl=<lang>&gl=IN returns that language's coverage
// (Google matches transliterations). We target Hindi + the rep's state language
// so volume stays sane and relevant.
//
// Items are headline-level news leads (admissible:false, tier 9), same posture
// as GDELT: corroborate against primary records before scoring. The existing
// article-body enricher will fetch full text for the most recent ones.
import { fetchText , TIMEOUT_DEFAULT , fetchTextEx } from "./http.js";
import { logger } from "../util/log.js";

const log = logger("news-multilingual");

// Indian state → primary regional language (Google News hl code).
const STATE_LANG = {
  "tamil nadu": "ta", "puducherry": "ta",
  "andhra pradesh": "te", "telangana": "te",
  "west bengal": "bn", "tripura": "bn",
  "maharashtra": "mr",
  "gujarat": "gu", "dadra and nagar haveli and daman and diu": "gu",
  "karnataka": "kn",
  "kerala": "ml", "lakshadweep": "ml",
  "punjab": "pa", "chandigarh": "pa",
  "odisha": "or",
  "assam": "as",
  // Hindi-belt + default handled below.
};
const LANG_NAME = {
  en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", bn: "Bengali", mr: "Marathi",
  gu: "Gujarati", kn: "Kannada", ml: "Malayalam", pa: "Punjabi", or: "Odia", as: "Assamese",
};

const ALL_LANGS = ["hi", "ta", "te", "bn", "mr", "gu", "kn", "ml", "pa", "or", "as"];

function langsFor(p) {
  // Explicit override wins.
  const env = (process.env.NEWS_LANGS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.length) return [...new Set(env)];
  // NEWS_ALL_LANGS=1 → every supported Indian language (broad but heavier).
  if (process.env.NEWS_ALL_LANGS === "1") return ALL_LANGS;
  // Default: English (reliable baseline — covers what GDELT does, without its
  // harsh rate limit) + Hindi (widest reach) + the rep's state language.
  const langs = ["en", "hi"];
  const sl = STATE_LANG[(p.state ?? "").toLowerCase().trim()];
  if (sl && !langs.includes(sl)) langs.push(sl);
  return langs;
}

const PER_LANG = Number(process.env.NEWS_INTL_LIMIT || 8);

function parseRss(xml) {
  const blocks = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const pick = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
    return m ? m[1].trim() : "";
  };
  return blocks.map((b) => ({
    title: pick(b, "title").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
    link: pick(b, "link"),
    pubDate: pick(b, "pubDate"),
    source: pick(b, "source"),
  })).filter((i) => i.title && i.link);
}

export async function fetchMultilingualNews(p) {
  if (!p?.name) return [];
  if (process.env.NEWS_INTL_DISABLE === "1") return [];
  const out = [];
  const seen = new Set();
  for (const lang of langsFor(p)) {
    const q = encodeURIComponent(`"${p.name}"`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=${lang}&gl=IN&ceid=IN:${lang}`;
    const r = await fetchTextEx(url, { timeoutMs: TIMEOUT_DEFAULT });
    if (!r.ok) { log.warn({ url, lang, status: r.status, err: r.error?.message }, "news feed failed"); continue; }
    const xml = r.text;
    if (!xml) continue;
    let n = 0;
    for (const item of parseRss(xml)) {
      if (n >= PER_LANG) break;
      const key = item.link.split("?")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      n++;
      let date = null;
      const t = Date.parse(item.pubDate);
      if (!Number.isNaN(t)) date = new Date(t).toISOString().slice(0, 10);
      out.push({
        politician_id: p.id,
        source_type: "news",
        tier: 9,
        admissible: false,
        title: item.title,
        url: item.link,
        date,
        summary: `${item.source || "news"} · ${LANG_NAME[lang] ?? lang}-language coverage (regional-language lead; corroborate against primary records).`,
      });
    }
  }
  return out;
}
