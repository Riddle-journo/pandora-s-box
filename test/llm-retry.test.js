// Task 5.1 — callWithRetry (paid-LLM retry + usage accounting). Isolated temp
// DB (env set before the store import chain), fake client, instant sleeps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

process.env.PANDOROS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-llm-")), "test.db");

const { callWithRetry, isRateLimit } = await import("../server/llm.js");
const { db } = await import("../server/store/db.js");
const { llmUsageSummary } = await import("../server/store/llm-usage.js");

const noSleep = async () => {};

function fakeClient(script) {
  let i = 0;
  return {
    calls: () => i,
    chat: { completions: { create: async () => {
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step instanceof Error) throw step;
      return step;
    } } },
  };
}

const okResponse = {
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
};

const httpErr = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

test("success on first attempt records one ok usage row with tokens", async () => {
  const client = fakeClient([okResponse]);
  const res = await callWithRetry(client, { model: "test-model" }, { module: "unit-a", sleepImpl: noSleep });
  assert.equal(res.choices[0].message.content, "hello");
  const row = db.prepare("SELECT * FROM llm_usage WHERE module = 'unit-a'").get();
  assert.equal(row.ok, 1);
  assert.equal(row.total_tokens, 120);
  assert.equal(row.attempts, 1);
});

test("429 then success: retried, usage row says 2 attempts", async () => {
  const client = fakeClient([httpErr(429, "rate limited"), okResponse]);
  await callWithRetry(client, { model: "m" }, { module: "unit-b", sleepImpl: noSleep });
  assert.equal(client.calls(), 2);
  const row = db.prepare("SELECT * FROM llm_usage WHERE module = 'unit-b'").get();
  assert.equal(row.ok, 1);
  assert.equal(row.attempts, 2);
});

test("500s exhausting attempts: throws, records a failed row", async () => {
  const client = fakeClient([httpErr(500), httpErr(502), httpErr(503)]);
  await assert.rejects(
    () => callWithRetry(client, { model: "m" }, { module: "unit-c", attempts: 3, sleepImpl: noSleep }),
    /HTTP 503/
  );
  assert.equal(client.calls(), 3);
  const row = db.prepare("SELECT * FROM llm_usage WHERE module = 'unit-c'").get();
  assert.equal(row.ok, 0);
  assert.match(row.error, /HTTP 503/);
});

test("401 fails fast — no retry", async () => {
  const client = fakeClient([httpErr(401, "bad key"), okResponse]);
  await assert.rejects(() => callWithRetry(client, { model: "m" }, { module: "unit-d", sleepImpl: noSleep }));
  assert.equal(client.calls(), 1);
});

test("connection error (no status) is retried", async () => {
  const client = fakeClient([new Error("socket hang up"), okResponse]);
  await callWithRetry(client, { model: "m" }, { module: "unit-e", sleepImpl: noSleep });
  assert.equal(client.calls(), 2);
});

test("params-as-function lets callers lower temperature per attempt", async () => {
  const temps = [];
  const client = {
    chat: { completions: { create: async (p) => {
      temps.push(p.temperature);
      if (temps.length < 2) throw httpErr(500);
      return okResponse;
    } } },
  };
  await callWithRetry(client, (attempt) => ({ model: "m", temperature: attempt === 1 ? 0.3 : 0.15 }),
    { module: "unit-f", sleepImpl: noSleep });
  assert.deepEqual(temps, [0.3, 0.15]);
});

test("llmUsageSummary aggregates by module", () => {
  const s = llmUsageSummary({ sinceDays: 1 });
  assert.ok(s.totals.calls >= 6);
  const mods = s.byModule.map((r) => r.module);
  assert.ok(mods.includes("unit-a"));
});

test("isRateLimit: status, code, and message sniffing", () => {
  assert.ok(isRateLimit(httpErr(429)));
  assert.ok(isRateLimit(new Error("Provider quota exceeded")));
  assert.ok(isRateLimit(new Error("Too Many Requests")));
  assert.ok(!isRateLimit(httpErr(500)));
});
