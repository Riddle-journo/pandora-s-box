// TLS policy: verified-first, downgrade ONLY on a cert-trust error, and record
// every host that was fetched unverified.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isTlsTrustError,
  fetchBufferSecureFirst,
  insecureTlsInventory,
  resetInsecureTlsInventory,
  recordInsecureUse,
} from "../server/util/tls-policy.js";

const tlsErr = (code) => Object.assign(new Error("fetch failed"), { cause: { code } });

test("classifies cert-trust failures apart from ordinary network failures", () => {
  assert.equal(isTlsTrustError(tlsErr("CERT_HAS_EXPIRED")), true);
  assert.equal(isTlsTrustError(tlsErr("UNABLE_TO_VERIFY_LEAF_SIGNATURE")), true);
  assert.equal(isTlsTrustError(tlsErr("SELF_SIGNED_CERT_IN_CHAIN")), true);
  // A reset/DNS/timeout must never downgrade to an unverified retry.
  assert.equal(isTlsTrustError(tlsErr("ECONNRESET")), false);
  assert.equal(isTlsTrustError(tlsErr("ENOTFOUND")), false);
  assert.equal(isTlsTrustError(new Error("boom")), false);
});

test("a verified fetch that succeeds never touches the insecure path", async () => {
  resetInsecureTlsInventory();
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("hello").buffer });
  const r = await fetchBufferSecureFirst("https://ok.example/x.json", { fetchImpl });
  assert.equal(r.insecure, false);
  assert.equal(r.buffer.toString(), "hello");
  assert.deepEqual(insecureTlsInventory(), []);
});

test("a non-ok verified response is a plain miss, not an insecure downgrade", async () => {
  resetInsecureTlsInventory();
  const fetchImpl = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
  const r = await fetchBufferSecureFirst("https://gone.example/x", { fetchImpl });
  assert.equal(r.buffer, null);
  assert.equal(r.insecure, false);
  assert.equal(r.status, 404);
  assert.deepEqual(insecureTlsInventory(), []);
});

test("a non-TLS error does NOT downgrade, and records nothing", async () => {
  resetInsecureTlsInventory();
  const fetchImpl = async () => { throw tlsErr("ECONNRESET"); };
  const r = await fetchBufferSecureFirst("https://reset.example/x", { fetchImpl });
  assert.equal(r.buffer, null);
  assert.equal(r.insecure, false);
  assert.deepEqual(insecureTlsInventory(), []);
});

test("STRICT_TLS=1 refuses the fallback even for a cert-trust error", async () => {
  resetInsecureTlsInventory();
  const prev = process.env.STRICT_TLS;
  process.env.STRICT_TLS = "1";
  try {
    const fetchImpl = async () => { throw tlsErr("CERT_HAS_EXPIRED"); };
    const r = await fetchBufferSecureFirst("https://expired.example/x", { fetchImpl });
    assert.equal(r.buffer, null);
    assert.equal(r.insecure, false);
    assert.deepEqual(insecureTlsInventory(), [], "strict mode must not record an insecure use it never made");
  } finally {
    if (prev === undefined) delete process.env.STRICT_TLS; else process.env.STRICT_TLS = prev;
  }
});

test("allowInsecure:false refuses the fallback for a cert-trust error", async () => {
  resetInsecureTlsInventory();
  const fetchImpl = async () => { throw tlsErr("CERT_HAS_EXPIRED"); };
  const r = await fetchBufferSecureFirst("https://expired.example/x", { fetchImpl, allowInsecure: false });
  assert.equal(r.buffer, null);
  assert.equal(r.insecure, false);
  assert.deepEqual(insecureTlsInventory(), []);
});

test("inventory de-duplicates by host and counts repeats", () => {
  resetInsecureTlsInventory();
  // Driven through recordInsecureUse directly: exercising the real fallback
  // would need a live server serving a broken cert chain.
  recordInsecureUse("a.gov.in", "CERT_HAS_EXPIRED");
  recordInsecureUse("a.gov.in", "CERT_HAS_EXPIRED");
  recordInsecureUse("b.gov.in", "SELF_SIGNED_CERT_IN_CHAIN");
  const inv = insecureTlsInventory();
  assert.equal(inv.length, 2);
  assert.equal(inv[0].host, "a.gov.in", "most-used host sorts first");
  assert.equal(inv[0].count, 2);
  assert.equal(inv[1].count, 1);
  resetInsecureTlsInventory();
  assert.deepEqual(insecureTlsInventory(), []);
});
