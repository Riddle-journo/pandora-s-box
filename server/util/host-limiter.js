// Cross-job host rate limiter. When several jobs run in parallel (the worker
// pool), each may want to hit the same external host (GDELT, MyNeta, the free
// LLM chain). Per-job politeness delays don't compose — N jobs each "waiting
// politely" still fire N requests at once. This module is the single shared
// gate: acquire(key, interval) resolves callers FIFO, one per interval per key,
// across every concurrent job in the process.
//
//   await acquire("gdelt", 5000);   // my turn — at most 1 GDELT hit / 5 s globally
//   penalize("gdelt", 30_000);      // got a 429 → push EVERYONE's next slot out
//
// Keys are arbitrary strings (one per host/service). State is in-memory and
// per-process, which matches the single-process worker design.
import { sleep } from "./timing.js";

const buckets = new Map(); // key -> { nextAt: epoch-ms, chain: Promise }

function bucket(key) {
  let b = buckets.get(key);
  if (!b) { b = { nextAt: 0, chain: Promise.resolve() }; buckets.set(key, b); }
  return b;
}

// Resolves when it's the caller's turn to talk to `key`. Waiters queue FIFO on
// the bucket's promise chain, so ordering is arrival order and exactly one
// caller is released per interval. Re-reads nextAt after the wait so a
// penalize() issued while we slept is honored.
export function acquire(key, minIntervalMs) {
  const b = bucket(key);
  const turn = b.chain.then(async () => {
    for (;;) {
      const wait = b.nextAt - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    b.nextAt = Date.now() + minIntervalMs;
  });
  b.chain = turn.catch(() => {}); // a cancelled/failed waiter must not wedge the queue
  return turn;
}

// External backoff (e.g. an HTTP 429): push the key's next slot at least `ms`
// into the future. Every queued and future acquire() waits it out — one job's
// rate-limit hit slows the whole pool down for that host, which is the point.
export function penalize(key, ms) {
  const b = bucket(key);
  b.nextAt = Math.max(b.nextAt, Date.now() + ms);
}

// Test hook: forget all buckets.
export function resetLimiter() {
  buckets.clear();
}
