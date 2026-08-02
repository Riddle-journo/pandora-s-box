// Secure-first TLS policy for the handful of government sources whose cert
// chains are genuinely misconfigured.
//
// Before this module, a source marked `insecure: true` went straight to
// rejectUnauthorized:false forever — so a chain that got FIXED upstream stayed
// unverified, and nothing downstream could tell that a given evidence row had
// arrived over an unauthenticated channel. Both matter here: this data feeds an
// accountability engine, so "which bytes could a network attacker have chosen"
// is a provenance question, not a plumbing detail.
//
// Policy: always try verified TLS first. Fall back to an unverified fetch ONLY
// when the failure is specifically a certificate-trust error, and record the
// host when we do, so the inventory is visible in the health console. Set
// STRICT_TLS=1 to disable the fallback entirely (nothing insecure is fetched).

import { logger } from "./log.js";

const tlog = logger("tls");

// Node/OpenSSL codes that mean "the chain did not verify" — as opposed to DNS
// failures, resets, or timeouts, which must NOT downgrade to an insecure retry.
const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

export const strictTls = () => process.env.STRICT_TLS === "1";

// fetch() wraps the underlying socket error, so the real code is on `cause`.
const errCode = (err) => String(err?.cause?.code ?? err?.code ?? "");

export const isTlsTrustError = (err) => TLS_TRUST_CODES.has(errCode(err));

const hostOf = (url) => { try { return new URL(url).host; } catch { return "?"; } };

// Per-process inventory of hosts we actually had to fetch without verification.
// Read by the health console; deliberately in-memory (single-process app, and a
// restart SHOULD re-discover the current state of each upstream's cert).
const insecureHosts = new Map();

export function recordInsecureUse(host, code) {
  const prev = insecureHosts.get(host);
  if (prev) { prev.count += 1; prev.last_code = code; prev.last_at = new Date().toISOString(); return; }
  insecureHosts.set(host, { host, count: 1, last_code: code, first_at: new Date().toISOString(), last_at: new Date().toISOString() });
  // Warn once per host per process: a recurring entry here is a real finding
  // (an upstream serving unverifiable certs), not noise to be tuned out.
  tlog.warn({ host, code }, "TLS chain unverifiable — fetched WITHOUT verification");
}

/** Hosts fetched over an unverified channel this process, most-used first. */
export function insecureTlsInventory() {
  return [...insecureHosts.values()].sort((a, b) => b.count - a.count);
}

/** Test seam: forget the recorded hosts. */
export function resetInsecureTlsInventory() { insecureHosts.clear(); }

// Unverified GET returning a Buffer, or null. Node's global fetch has no
// per-call TLS override, so a broken chain needs the classic https module.
export async function fetchBufferInsecure(url, { timeoutMs = 30_000, headers = {} } = {}) {
  const { default: https } = await import("node:https");
  return new Promise((resolve) => {
    const req = https.get(url, { headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * Verified fetch, downgrading to an unverified one only on a cert-trust error.
 * Returns { buffer, insecure, status, error } — `insecure: true` means the bytes
 * arrived unauthenticated and callers should propagate that onto any evidence
 * they derive from them.
 */
export async function fetchBufferSecureFirst(url, { timeoutMs = 30_000, headers = {}, allowInsecure = true, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!res.ok) return { buffer: null, insecure: false, status: res.status, error: null };
    return { buffer: Buffer.from(await res.arrayBuffer()), insecure: false, status: res.status, error: null };
  } catch (err) {
    if (!allowInsecure || strictTls() || !isTlsTrustError(err)) {
      return { buffer: null, insecure: false, status: 0, error: err };
    }
    const host = hostOf(url);
    const buffer = await fetchBufferInsecure(url, { timeoutMs, headers });
    if (buffer) recordInsecureUse(host, errCode(err));
    return { buffer, insecure: Boolean(buffer), status: buffer ? 200 : 0, error: buffer ? null : err };
  }
}
