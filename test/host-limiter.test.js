// host-limiter: the shared cross-job gate that keeps N parallel jobs at one
// request per interval per external host. Pure in-memory — no DB needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquire, penalize, resetLimiter } from "../server/util/host-limiter.js";

test("acquire spaces same-key callers by at least the interval, FIFO", async () => {
  resetLimiter();
  const INTERVAL = 60;
  const done = [];
  await Promise.all([
    acquire("k", INTERVAL).then(() => done.push(["a", Date.now()])),
    acquire("k", INTERVAL).then(() => done.push(["b", Date.now()])),
    acquire("k", INTERVAL).then(() => done.push(["c", Date.now()])),
  ]);
  assert.deepEqual(done.map(([name]) => name), ["a", "b", "c"], "FIFO order");
  // Timers can fire a hair early on Windows; allow small slack.
  const SLACK = 15;
  assert.ok(done[1][1] - done[0][1] >= INTERVAL - SLACK, `b waited (${done[1][1] - done[0][1]}ms)`);
  assert.ok(done[2][1] - done[1][1] >= INTERVAL - SLACK, `c waited (${done[2][1] - done[1][1]}ms)`);
});

test("different keys do not block each other", async () => {
  resetLimiter();
  const t0 = Date.now();
  await Promise.all([acquire("x", 5000), acquire("y", 5000), acquire("z", 5000)]);
  // First slot per key is immediate; only SUBSEQUENT calls wait.
  assert.ok(Date.now() - t0 < 1000, "three first-time keys resolved immediately");
});

test("penalize pushes the next slot out for everyone on that key", async () => {
  resetLimiter();
  await acquire("p", 10); // take the first slot
  penalize("p", 120);     // simulate a 429 backoff
  const t0 = Date.now();
  await acquire("p", 10);
  assert.ok(Date.now() - t0 >= 100, `waited out the penalty (${Date.now() - t0}ms)`);
});

test("penalize honored even for a waiter already queued", async () => {
  resetLimiter();
  await acquire("q", 50);        // slot taken; next slot ~50ms away
  const waiter = acquire("q", 50); // queued waiter
  penalize("q", 200);            // 429 arrives while it waits
  const t0 = Date.now();
  await waiter;
  assert.ok(Date.now() - t0 >= 150, `queued waiter re-checked nextAt after penalty (${Date.now() - t0}ms)`);
});
