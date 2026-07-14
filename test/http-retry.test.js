// Task 4.7 — the opt-in retry/backoff in fetchText/fetchJson. A fake fetchImpl
// counts calls and returns scripted responses; retryDelayMs:1 keeps the backoff
// sleeps near-instant so the suite stays fast. Default (retries:0) is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchText, fetchJson } from "../server/fetchers/http.js";

// Minimal Response-shaped stub.
const resp = (status, body = "") => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => body,
  json: async () => JSON.parse(body || "null"),
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

test("retries:0 + always-500 → returns ''/null, fetch called exactly once", async () => {
  const t = fakeFetch([resp(500), resp(500), resp(500)]);
  assert.equal(await fetchText("http://x", { retries: 0, fetchImpl: t }), "");
  assert.equal(t.state.calls, 1);

  const j = fakeFetch([resp(500), resp(500), resp(500)]);
  assert.equal(await fetchJson("http://x", { retries: 0, fetchImpl: j }), null);
  assert.equal(j.state.calls, 1);
});

test("retries:2 + 500,500,200 → success, called 3 times", async () => {
  const t = fakeFetch([resp(500), resp(500), resp(200, "hello")]);
  assert.equal(await fetchText("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: t }), "hello");
  assert.equal(t.state.calls, 3);

  const j = fakeFetch([resp(500), resp(500), resp(200, '{"ok":true}')]);
  assert.deepEqual(await fetchJson("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: j }), { ok: true });
  assert.equal(j.state.calls, 3);
});

test("404 + retries:2 → called once, no retry", async () => {
  const t = fakeFetch([resp(404), resp(200, "nope")]);
  assert.equal(await fetchText("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: t }), "");
  assert.equal(t.state.calls, 1);

  const j = fakeFetch([resp(404), resp(200, '{"ok":true}')]);
  assert.equal(await fetchJson("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: j }), null);
  assert.equal(j.state.calls, 1);
});

test("network error (fetch throws) is retried too", async () => {
  const t = fakeFetch([new Error("boom"), resp(200, "recovered")]);
  assert.equal(await fetchText("http://x", { retries: 2, retryDelayMs: 1, fetchImpl: t }), "recovered");
  assert.equal(t.state.calls, 2);
});
