// Resilient GDELT fetch.
//
// GDELT periodically serves an EXPIRED TLS certificate. When it does, a normal
// fetch throws CERT_HAS_EXPIRED and the ENTIRE news pipeline (fetchNews +
// scandal auto-discovery) silently goes dark — every rep loses its media
// dimension. GDELT is PUBLIC, non-sensitive news metadata, so when (and ONLY
// when) the failure is a certificate-trust error, we retry over a connection
// that tolerates it — and ONLY for the gdeltproject.org host. Every other host
// in the app stays fully certificate-verified. This is a scoped workaround, not
// a global `NODE_TLS_REJECT_UNAUTHORIZED=0`.
//
// The downgrade goes through server/util/tls-policy.js rather than a
// module-level `new https.Agent({ rejectUnauthorized: false })`. That agent was
// the problem: it existed for the whole process whether or not GDELT's chain was
// actually broken, and nothing recorded which bytes had arrived unverified. Now
// the verified path is always tried first (the retry loop below), the downgrade
// is per-call, the host lands in insecureTlsInventory() where the health console
// prints it, and STRICT_TLS=1 disables it entirely.
import { sleep } from "../util/timing.js";
import { acquire, penalize } from "../util/host-limiter.js";
import { fetchBufferInsecure, isTlsTrustError, recordInsecureUse, strictTls } from "../util/tls-policy.js";
import { noteFetchFailure } from "../fetchers/observe.js";
import { logger } from "../util/log.js";

// GDELT enforces ~1 request / 5 s ACROSS the whole client IP — with parallel
// ingest jobs the per-call retry alone isn't enough, so every request first
// takes a slot on the shared cross-job limiter.
const GDELT_INTERVAL_MS = 5000;

const glog = logger("gdelt");

// Returns the parsed JSON, or null on any failure (callers already treat news
// as best-effort). Every null is RECORDED, with the phase that produced it:
// a rate-limit notice, a cert problem, and a genuine empty result set are three
// different findings and used to be one indistinguishable null.
let warnedRate = false;
let warnedExpired = false; // was previously undeclared — a ReferenceError in ESM strict mode on the cert-expiry path
// `fetchImpl` / `insecureFetchImpl` are injectable ONLY so the policy branches
// (verified success, non-TLS failure, scoped downgrade, STRICT_TLS refusal) can be
// tested without touching the network. Production always uses the real pair.
export async function gdeltJson(url, { headers = {}, timeout = 20000, fetchImpl = fetch, insecureFetchImpl = fetchBufferInsecure } = {}) {
  let lastErr = null;
  // Only a cert-trust break may reach the unverified retry. Previously the loop
  // simply ran out on repeated 429s and fell through to the insecure fetch — a
  // downgrade for a rate limit, which the unverified channel cannot fix anyway.
  let certTrustFailure = false;
  // 1) Secure path first — the normal case, with 429 back-off. GDELT enforces
  // ~1 request / 5 s; under batch load it returns HTTP 429 with a plain-text
  // body, which would otherwise silently blank every rep's news. Retry a couple
  // of times with a polite wait before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    await acquire("gdelt", GDELT_INTERVAL_MS); // shared cross-job gate
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (err) {
          // 200 but non-JSON. Usually GDELT's plain-text rate-limit notice, but
          // it is ALSO what an API redesign looks like — so it is recorded with
          // the leading bytes rather than treated as "this rep has no news".
          noteFetchFailure("gdelt", "json_parse", err, { url, bytes: text.length, head: text.slice(0, 120) });
          return null;
        }
      }
      if (res.status === 429) {
        if (!warnedRate) { glog.warn("rate-limited (429) — backing off; regional-language news via Google News still flows."); warnedRate = true; }
        const backoff = 6000 + attempt * 2000;
        penalize("gdelt", backoff); // every concurrent job backs off, not just this one
        await sleep(backoff);
        lastErr = `HTTP 429 after ${attempt + 1} attempt(s)`;
        continue; // retry
      }
      noteFetchFailure("gdelt", "http", `HTTP ${res.status}`, { url, status: res.status });
      return null; // other HTTP error
    } catch (err) {
      lastErr = err;
      // Only a certificate-trust failure may downgrade. DNS failures, resets and
      // timeouts must not: an unverified retry would not fix them and would only
      // widen the unauthenticated surface.
      if (!isTlsTrustError(err)) {
        noteFetchFailure("gdelt", "http", err, { url });
        return null;
      }
      certTrustFailure = true;
      break; // cert-trust error → fall through to the scoped insecure retry below
    }
  }
  // 2) Scoped retry — ONLY for GDELT's host, ONLY on a cert-trust error.
  if (!certTrustFailure) {
    noteFetchFailure("gdelt", "rate_limited", lastErr ?? "retries exhausted", { url });
    return null;
  }
  let host;
  try { host = new URL(url).hostname; } catch (err) {
    noteFetchFailure("gdelt", "bad_url", err, { url });
    return null;
  }
  if (!host.endsWith("gdeltproject.org")) {
    noteFetchFailure("gdelt", "tls_out_of_scope", lastErr ?? "cert-trust error on a non-GDELT host", { url, host });
    return null;
  }
  if (strictTls()) {
    noteFetchFailure("gdelt", "tls_strict", lastErr ?? "cert-trust error; STRICT_TLS=1 forbids the downgrade", { url, host });
    return null;
  }
  if (!warnedExpired) { glog.warn({ host }, "certificate unverifiable on GDELT's side — using scoped insecure fallback for gdeltproject.org only."); warnedExpired = true; }
  const buf = await insecureFetchImpl(url, { timeoutMs: timeout, headers });
  if (!buf) {
    noteFetchFailure("gdelt", "insecure_fetch", lastErr ?? "unverified retry returned nothing", { url, host });
    return null;
  }
  recordInsecureUse(host, isTlsTrustError(lastErr) ? (lastErr?.cause?.code ?? lastErr?.code) : "CERT_TRUST");
  try { return JSON.parse(buf.toString("utf8")); }
  catch (err) {
    noteFetchFailure("gdelt", "insecure_json_parse", err, { url, host, bytes: buf.length });
    return null;
  }
}
