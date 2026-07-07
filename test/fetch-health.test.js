// Bounded fan-out + fetch_runs health tracking. Temp DB via PANDOROS_DB_PATH.
// FAKE fetchers only — no real fetcher, no network, no LLM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-health-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;

const store = await import("../server/store.js");
const { runFetchers } = await import("../server/ingest.js");
const { classifyHealth } = await import("../server/health.js");
const { sourceHealth } = store;

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("runFetchers records one fetch_run per fetcher with correct ok/items/error", async () => {
  const FETCHERS = [
    { name: "ok_source",    run: async () => [{ url: "a" }, { url: "b" }] }, // succeeds, 2 items
    { name: "bad_source",   run: async () => { throw new Error("boom kaboom"); } }, // throws
    { name: "empty_source", run: async () => [] },                           // succeeds, 0 items
  ];
  const results = await runFetchers(FETCHERS, { id: "pol_1" }, { limit: 2 });

  // A failure degrades to [] but is recorded, never swallowed.
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.deepEqual(results.find((r) => r.name === "bad_source").result, []);

  const health = sourceHealth(1);
  const bySrc = Object.fromEntries(health.map((h) => [h.source, h]));

  assert.equal(bySrc.ok_source.runs, 1);
  assert.equal(bySrc.ok_source.ok_rate, 1);
  assert.equal(bySrc.ok_source.total_items, 2);
  assert.ok(bySrc.ok_source.last_success_at, "successful source has a last_success_at");
  assert.equal(bySrc.ok_source.last_error, null);

  assert.equal(bySrc.bad_source.runs, 1);
  assert.equal(bySrc.bad_source.ok_rate, 0);
  assert.equal(bySrc.bad_source.total_items, 0);
  assert.equal(bySrc.bad_source.last_success_at, null);
  assert.match(bySrc.bad_source.last_error, /boom kaboom/);

  assert.equal(bySrc.empty_source.runs, 1);
  assert.equal(bySrc.empty_source.ok_rate, 1);
  assert.equal(bySrc.empty_source.total_items, 0);
});

test("classifyHealth flags ROTTED (failing / zero-item) and STALE (no runs) sources", () => {
  const health = [
    { source: "healthy", runs: 4, ok_rate: 1,    total_items: 40, last_success_at: Date.now(), last_error: null },
    { source: "flaky",   runs: 4, ok_rate: 0.25, total_items: 3,  last_success_at: Date.now(), last_error: "429" },
    { source: "dry",     runs: 4, ok_rate: 1,    total_items: 0,  last_success_at: Date.now(), last_error: null },
  ];
  const known = ["healthy", "flaky", "dry", "never_ran"];
  const { rotted, stale } = classifyHealth(health, known);

  const rottedNames = rotted.map((r) => r.source).sort();
  assert.deepEqual(rottedNames, ["dry", "flaky"], "low success-rate AND zero-items are both ROTTED");
  assert.ok(!rottedNames.includes("healthy"));

  assert.deepEqual(stale, ["never_ran"], "a known source with no runs is STALE");
});

test("pruneFetchRuns removes rows older than the window", () => {
  const old = Date.now() - 100 * 86400000; // 100 days ago
  store.recordFetchRun({ source: "aged", ok: 1, items: 1, ms: 1, at: old });
  store.recordFetchRun({ source: "aged", ok: 1, items: 1, ms: 1, at: Date.now() });
  const removed = store.pruneFetchRuns(90);
  assert.ok(removed >= 1, "at least the 100-day-old row is pruned");
  // The fresh row survives.
  const health = sourceHealth(1).find((h) => h.source === "aged");
  assert.equal(health.runs, 1);
});
