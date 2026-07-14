// Shared fetch + content-extraction helpers for all content fetchers.
// Built on Node's global fetch (Node 18+). Heavy optional deps (pdf parsing)
// are lazy-loaded so the app runs fine without them installed.

export const UA = { "User-Agent": "Mozilla/5.0 (PandorosBox public-accountability research)" };

import { sleep } from "../util/timing.js";
export { sleep };

export const isPdf = (url) => /\.pdf($|\?)/i.test(url);

// The passage surrounding the first mention of `name`, or null if unmentioned.
export function contextAround(text, name, window = 1000) {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  if (i < 0) return null;
  return text.slice(Math.max(0, i - window), i + name.length + window).trim();
}

// Some Indian government sites (e.g. wbindustries.gov.in) serve a broken/expired
// TLS chain — a real cert misconfiguration on their end, not a spoofing risk for
// a read-only public-document fetch. Node's global fetch has no per-call TLS
// override, so a broken chain needs the classic `https` module with
// rejectUnauthorized:false instead. Buffer-only (caller decides text/binary).
async function fetchInsecureBuffer(url, timeoutMs = 30000) {
  const { default: https } = await import("node:https");
  return new Promise((resolve) => {
    const req = https.get(url, { headers: UA, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// Fetch raw text with timeout + polite UA. Returns "" on any failure.
// `insecure: true` routes through fetchInsecureBuffer for sites with a broken
// TLS chain (see above) — off by default, since almost no site needs it.
export async function fetchText(url, { timeoutMs = 15000, headers = {}, insecure = false, retries = 0, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  if (insecure) {
    const buf = await fetchInsecureBuffer(url, timeoutMs);
    return buf ? buf.toString("utf8") : "";
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
        return "";
      }
      return await res.text();
    } catch {
      if (attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
      return "";
    }
  }
}

// Fetch + parse JSON. Returns null on any failure.
export async function fetchJson(url, { timeoutMs = 15000, headers = {}, retries = 0, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { ...UA, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        if (res.status >= 500 && attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
        return null;
      }
      return await res.json();
    } catch {
      if (attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
      return null;
    }
  }
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
export async function fetchPdfText(url, { timeoutMs = 30000, maxLen = 4000, insecure = false } = {}) {
  let PDFParse;
  try {
    ({ PDFParse } = await import("pdf-parse"));
    if (typeof PDFParse !== "function") throw new Error("unexpected pdf-parse API");
  } catch {
    if (!pdfWarned) { console.warn("[fetchers] pdf-parse v2 not available — PDF sources skipped. Run: npm install pdf-parse"); pdfWarned = true; }
    return "";
  }
  try {
    let buf;
    if (insecure) {
      const b = await fetchInsecureBuffer(url, timeoutMs);
      if (!b) return "";
      buf = new Uint8Array(b);
    } else {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return "";
      buf = new Uint8Array(await res.arrayBuffer());
    }
    const parser = new PDFParse({ data: buf });
    const data = await parser.getText();
    const text = (data.text ?? "").replace(/\s+/g, " ").trim();
    // OCR fallback: a scanned/image-only PDF has no text layer, so pdf-parse
    // returns (almost) nothing. When PDF_OCR=1, read the pixels instead. The
    // same downloaded buffer is reused — no second fetch. Fail-silent + off by
    // default (OCR is slow), so nothing changes for the common digital-PDF case.
    if (text.length < 40) {
      const { ocrEnabled, ocrPdfBuffer } = await import("./pdf-ocr.js");
      if (ocrEnabled()) {
        const ocr = await ocrPdfBuffer(buf, { maxLen });
        if (ocr) return ocr.slice(0, maxLen);
      }
    }
    return text.slice(0, maxLen);
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
