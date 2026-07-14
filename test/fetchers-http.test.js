// Task 4.1 — the shared requestWithRetry core behind fetchText/fetchJson and
// the new status-aware fetchTextEx/fetchJsonEx. All via fetchImpl injection.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchText, fetchJson, fetchTextEx, fetchJsonEx } from "../server/fetchers/http.js";

const resp = (status, body = "", headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body,
  json: async () => JSON.parse(body || "null"),
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

function fakeFetch(responses) {
  const state = { calls: 0 };
  const impl = async () => {
    const r = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    if (r instanceof Error) throw r;
    return r;
  };
  impl.state = state;
  return impl;
}

test("retries are ON by default: 500,500,200 succeeds without passing retries", async () => {
  const t = fakeFetch([resp(500), resp(500), resp(200, "third time lucky")]);
  assert.equal(await fetchText("http://x", { retryDelayMs: 1, fetchImpl: t }), "third time lucky");
  assert.equal(t.state.calls, 3);
});

test("429 is retried and Retry-After (seconds) is honoured", async () => {
  const t = fakeFetch([resp(429, "", { "retry-after": "0" }), resp(200, "ok now")]);
  const r = await fetchTextEx("http://x", { retryDelayMs: 1, fetchImpl: t });
  assert.equal(r.ok, true);
  assert.equal(r.text, "ok now");
  assert.equal(r.attempts, 2);
  assert.equal(t.state.calls, 2);
});

test("429 exhausting retries reports ok:false with status 429", async () => {
  const t = fakeFetch([resp(429, "", { "retry-after": "0" })]);
  const r = await fetchTextEx("http://x", { retries: 1, retryDelayMs: 1, fetchImpl: t });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(t.state.calls, 2);
});

test("404 is never retried and Ex reports the status", async () => {
  const t = fakeFetch([resp(404), resp(200, "never seen")]);
  const r = await fetchTextEx("http://x", { retryDelayMs: 1, fetchImpl: t });
  assert.deepEqual({ ok: r.ok, status: r.status, text: r.text }, { ok: false, status: 404, text: "" });
  assert.equal(t.state.calls, 1);
});

test("network error exhausts retries → Ex carries the error, plain form returns ''", async () => {
  const boom = new Error("ECONNRESET-ish");
  const t = fakeFetch([boom, boom, boom, boom]);
  const r = await fetchTextEx("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: t });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
  assert.equal(r.error, boom);
  assert.equal(r.attempts, 3);

  const t2 = fakeFetch([boom, boom, boom, boom]);
  assert.equal(await fetchText("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: t2 }), "");
});

test("timeout-then-success recovers (throw, then 200)", async () => {
  const t = fakeFetch([new Error("The operation was aborted due to timeout"), resp(200, "recovered")]);
  assert.equal(await fetchText("http://x", { retryDelayMs: 1, fetchImpl: t }), "recovered");
  assert.equal(t.state.calls, 2);
});

test("fetchJsonEx: malformed JSON on a 200 is ok:false with the parse error", async () => {
  const t = fakeFetch([resp(200, "not json {")]);
  const r = await fetchJsonEx("http://x", { retryDelayMs: 1, fetchImpl: t });
  assert.equal(r.ok, false);
  assert.equal(r.status, 200);
  assert.ok(r.error);
  // and the plain form flattens to null
  const t2 = fakeFetch([resp(200, "not json {")]);
  assert.equal(await fetchJson("http://x", { retryDelayMs: 1, fetchImpl: t2 }), null);
});
