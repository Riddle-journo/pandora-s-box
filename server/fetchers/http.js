// Shared fetch + content-extraction helpers for all content fetchers.
// Built on Node's global fetch (Node 18+). Heavy optional deps (pdf parsing)
// are lazy-loaded so the app runs fine without them installed.

export const UA = { "User-Agent": "Mozilla/5.0 (PandorosBox public-accountability research)" };

import { sleep } from "../util/timing.js";
import { logger } from "../util/log.js";
export { sleep };

const hlog = logger("fetchers");

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

// Named timeout tiers — pick the nearest tier instead of inventing a number.
export const TIMEOUT_FAST = 10_000;    // small JSON APIs
export const TIMEOUT_DEFAULT = 15_000; // typical HTML/JSON page
export const TIMEOUT_SLOW = 30_000;    // slow government portals / big payloads
export const TIMEOUT_PDF = 60_000;     // PDF downloads

// How long a 429's Retry-After header may push the delay (seconds or HTTP-date).
const RETRY_AFTER_CAP_MS = 30_000;

function retryAfterMs(res) {
  const h = res?.headers?.get?.("retry-after");
  if (!h) return null;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(h).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : null;
}

// One retry loop for every fetch in the app. Retries network errors/timeouts,
// >=500, and 429 (honouring Retry-After, capped); never other 4xx. Jittered
// exponential backoff so a burst of failed fetchers doesn't retry in lockstep.
// Returns { res, error, attempts } — res may be non-ok (caller decides).
async function requestWithRetry(url, { timeoutMs = TIMEOUT_DEFAULT, headers = {}, method = "GET", body = undefined, retries = 2, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try {
      res = await fetchImpl(url, { method, body, headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { res, error: null, attempts: attempt + 1 };
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable || attempt >= retries) return { res, error: null, attempts: attempt + 1 };
    } catch (err) {
      if (attempt >= retries) return { res: null, error: err, attempts: attempt + 1 };
    }
    const backoff = retryDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
    await sleep((res && retryAfterMs(res)) ?? backoff);
  }
}

// Raw variant for callers that need the Response itself (Set-Cookie handshakes,
// content-type branching): same retry/429/timeout core, no body consumption.
// Returns { res, error, attempts } — res may be null (network failure) or non-ok.
export async function fetchRaw(url, opts = {}) {
  return requestWithRetry(url, opts);
}

/**
 * @typedef {object} FetchTextResult
 * @property {boolean} ok        true only for a 2xx whose body was read
 * @property {number} status     HTTP status; 0 = network/timeout failure
 * @property {string} text       "" unless ok
 * @property {Error|null} error  set when the transport (not HTTP) failed
 * @property {number} attempts   total tries incl. retries
 */
/**
 * @typedef {object} FetchJsonResult
 * @property {boolean} ok
 * @property {number} status
 * @property {any} data          null unless ok
 * @property {Error|null} error  transport OR JSON-parse failure
 * @property {number} attempts
 */

// Status-aware text fetch: { ok, status, text, error, attempts }. Use this when
// the caller needs to tell "empty page" from "timeout/blocked/500" — the plain
// fetchText below flattens both to "".
/** @returns {Promise<FetchTextResult>} */
export async function fetchTextEx(url, { timeoutMs = TIMEOUT_DEFAULT, headers = {}, method = "GET", body = undefined, insecure = false, retries = 2, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  if (insecure) {
    const buf = await fetchInsecureBuffer(url, timeoutMs);
    return buf
      ? { ok: true, status: 200, text: buf.toString("utf8"), error: null, attempts: 1 }
      : { ok: false, status: 0, text: "", error: new Error("insecure fetch failed"), attempts: 1 };
  }
  const { res, error, attempts } = await requestWithRetry(url, { timeoutMs, headers: { ...UA, ...headers }, method, body, retries, retryDelayMs, fetchImpl });
  if (!res) return { ok: false, status: 0, text: "", error, attempts };
  if (!res.ok) return { ok: false, status: res.status, text: "", error: null, attempts };
  try {
    return { ok: true, status: res.status, text: await res.text(), error: null, attempts };
  } catch (err) {
    return { ok: false, status: res.status, text: "", error: err, attempts };
  }
}

// Status-aware JSON fetch: { ok, status, data, error, attempts }.
/** @returns {Promise<FetchJsonResult>} */
export async function fetchJsonEx(url, { timeoutMs = TIMEOUT_DEFAULT, headers = {}, method = "GET", body = undefined, retries = 2, retryDelayMs = 1000, fetchImpl = fetch } = {}) {
  const { res, error, attempts } = await requestWithRetry(url, { timeoutMs, headers: { ...UA, Accept: "application/json", ...headers }, method, body, retries, retryDelayMs, fetchImpl });
  if (!res) return { ok: false, status: 0, data: null, error, attempts };
  if (!res.ok) return { ok: false, status: res.status, data: null, error: null, attempts };
  try {
    return { ok: true, status: res.status, data: await res.json(), error: null, attempts };
  } catch (err) {
    return { ok: false, status: res.status, data: null, error: err, attempts };
  }
}

// Fetch raw text with timeout + polite UA. Returns "" on any failure.
// `insecure: true` routes through fetchInsecureBuffer for sites with a broken
// TLS chain (see above) — off by default, since almost no site needs it.
// Retries (network/5xx/429) are ON by default now — pass retries:0 to opt out.
export async function fetchText(url, opts = {}) {
  return (await fetchTextEx(url, opts)).text;
}

// Fetch + parse JSON. Returns null on any failure. Retries on by default.
export async function fetchJson(url, opts = {}) {
  const r = await fetchJsonEx(url, opts);
  return r.ok ? r.data : null;
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
    if (!pdfWarned) { hlog.warn("[fetchers] pdf-parse v2 not available — PDF sources skipped. Run: npm install pdf-parse"); pdfWarned = true; }
    return "";
  }
  try {
    let buf;
    if (insecure) {
      const b = await fetchInsecureBuffer(url, timeoutMs);
      if (!b) return "";
      buf = new Uint8Array(b);
    } else {
      const { res } = await requestWithRetry(url, { timeoutMs, headers: UA });
      if (!res?.ok) return "";
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
