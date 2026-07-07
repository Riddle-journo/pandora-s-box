// Shared fetch + content-extraction helpers for all content fetchers.
// Built on Node's global fetch (Node 18+). Heavy optional deps (pdf parsing)
// are lazy-loaded so the app runs fine without them installed.

export const UA = { "User-Agent": "Mozilla/5.0 (PandorosBox public-accountability research)" };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch raw text with timeout + polite UA. Returns "" on any failure.
export async function fetchText(url, { timeoutMs = 15000, headers = {} } = {}) {
  try {
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "";
    return await res.text();
  } catch { return ""; }
}

// Fetch + parse JSON. Returns null on any failure.
export async function fetchJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  try {
    const res = await fetch(url, { headers: { ...UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

const ENTITIES = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&quot;": '"', "&rsquo;": "'", "&lsquo;": "'", "&rdquo;": '"', "&ldquo;": '"', "&mdash;": "—", "&ndash;": "–" };
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? (m.startsWith("&#") ? String.fromCharCode(+m.slice(2, -1)) : " "));

// Turn an HTML page into readable plain text. Strips scripts/styles/nav/markup
// and prefers the main article region when present.
export function htmlToText(html, maxLen = 2500) {
  if (!html) return "";
  let h = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|header|footer|form|aside)[\s\S]*?<\/\1>/gi, " ");

  // Prefer the main content region if the page marks one.
  const main = h.match(/<article[\s\S]*?<\/article>/i)?.[0]
            ?? h.match(/<main[\s\S]*?<\/main>/i)?.[0]
            ?? h;

  const text = decode(main.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLen);
}

// Download a PDF and extract its text. Requires the optional `pdf-parse`
// package (v2.x, which exports a PDFParse class); returns "" (and logs once)
// if it isn't installed.
let pdfWarned = false;
export async function fetchPdfText(url, { timeoutMs = 30000, maxLen = 4000 } = {}) {
  let PDFParse;
  try {
    ({ PDFParse } = await import("pdf-parse"));
    if (typeof PDFParse !== "function") throw new Error("unexpected pdf-parse API");
  } catch {
    if (!pdfWarned) { console.warn("[fetchers] pdf-parse v2 not available — PDF sources skipped. Run: npm install pdf-parse"); pdfWarned = true; }
    return "";
  }
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "";
    const buf = new Uint8Array(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const data = await parser.getText();
    return (data.text ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
  } catch { return ""; }
}

// Run async tasks with limited concurrency (politeness + speed).
export async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
