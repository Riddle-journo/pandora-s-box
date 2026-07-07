// Resilient GDELT fetch.
//
// GDELT periodically serves an EXPIRED TLS certificate. When it does, a normal
// fetch throws CERT_HAS_EXPIRED and the ENTIRE news pipeline (fetchNews +
// scandal auto-discovery) silently goes dark — every rep loses its media
// dimension. GDELT is PUBLIC, non-sensitive news metadata, so when (and ONLY
// when) the failure is specifically a cert expiry, we retry over a connection
// that tolerates it — and ONLY for the gdeltproject.org host. Every other host
// in the app stays fully certificate-verified. This is a scoped workaround, not
// a global `NODE_TLS_REJECT_UNAUTHORIZED=0`.
import https from "node:https";

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function httpsGetJson(url, { timeout = 20000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: insecureAgent, headers, timeout }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// Returns the parsed JSON, or null on any failure (callers already treat news
// as best-effort). Logs once if it had to use the insecure fallback.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warnedRate = false;
export async function gdeltJson(url, { headers = {}, timeout = 20000 } = {}) {
  // 1) Secure path first — the normal case, with 429 back-off. GDELT enforces
  // ~1 request / 5 s; under batch load it returns HTTP 429 with a plain-text
  // body, which would otherwise silently blank every rep's news. Retry a couple
  // of times with a polite wait before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); }
        catch { return null; } // 200 but non-JSON (rate-limit notice) → treat as miss
      }
      if (res.status === 429) {
        if (!warnedRate) { console.warn("[gdelt] rate-limited (429) — backing off; regional-language news via Google News still flows."); warnedRate = true; }
        await sleep(6000 + attempt * 2000);
        continue; // retry
      }
      return null; // other HTTP error
    } catch (err) {
      const code = err?.cause?.code || err?.code;
      if (code !== "CERT_HAS_EXPIRED") return null; // unknown failure → give up quietly
      break; // cert expiry → fall through to the scoped insecure retry below
    }
  }
  // 2) Scoped retry — ONLY for GDELT's host, ONLY on cert expiry.
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!host.endsWith("gdeltproject.org")) return null;
  if (!warnedExpired) { console.warn("[gdelt] certificate expired on GDELT's side — using scoped insecure fallback for gdeltproject.org only."); warnedExpired = true; }
  try { return await httpsGetJson(url, { headers, timeout }); }
  catch { return null; }
}
