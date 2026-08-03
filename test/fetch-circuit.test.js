// Per-process circuit breaker for dead fetch endpoints.
//
// Several fetchers hit the SAME url once per politician. Measured on one real
// ingest: cbi.gov.in/press-releases times out after ~24 seconds and
// enforcementdirectorate.gov.in/press-release 404s. Across the 2,931
// politicians who have never been ingested, the CBI timeout alone is roughly
// twenty hours of waiting for a page that is not coming — which is part of why
// a full ingest has never been finished.
//
// The risk of the cure is worse than the disease if it over-trips: a breaker
// that skipped too eagerly, or outlived the process, would silently turn a
// momentary blip into permanently missing coverage on an accountability site.
// These tests pin that it is loud, counted, per-process, and resettable.
import test from "node:test";
import assert from "node:assert/strict";

process.env.PANDOROS_TELEMETRY = "0";   // in-process inventory only, no ledger writes

const {
  circuitOpen, openCircuits, noteFetchFailure, resetFetchFailureInventory, fetchFailureInventory,
} = await import("../server/fetchers/observe.js");

const fail = (source, phase = "http_text", msg = "HTTP 404") =>
  noteFetchFailure(source, phase, msg, { ledger: false });

test("a healthy source is never skipped", () => {
  resetFetchFailureInventory();
  assert.equal(circuitOpen("healthy_source"), false);
  fail("healthy_source");
  assert.equal(circuitOpen("healthy_source"), false, "one failure is a blip, not a dead endpoint");
  assert.equal(openCircuits().length, 0);
});

test("the breaker opens only after repeated failures, and then stays open", () => {
  resetFetchFailureInventory();
  for (let i = 0; i < 2; i++) fail("dead_source");
  assert.equal(circuitOpen("dead_source"), false, "still under the threshold");
  fail("dead_source");
  assert.equal(circuitOpen("dead_source"), true, "third failure trips it");
  assert.equal(circuitOpen("dead_source"), true, "and it stays tripped for this process");
});

test("tripping is recorded, not silent", () => {
  // "We stopped asking" must be visible to an operator, or a dead source looks
  // identical to a source that simply had nothing to say.
  resetFetchFailureInventory();
  for (let i = 0; i < 3; i++) fail("loud_source", "http_text", "the operation was aborted due to timeout");
  circuitOpen("loud_source");
  const open = openCircuits();
  assert.equal(open.length, 1);
  assert.equal(open[0].source, "loud_source");
  assert.equal(open[0].failures, 3, "how many failures justified it");
  assert.match(open[0].reason, /timeout/, "and why");
  assert.ok(open[0].at, "and when");
});

test("sub-source failures count toward their parent", () => {
  // The press-release scanner records under "press_releases:cbi_press" while
  // the caller asks about that same id — and a parent-level check must also see
  // its children, or a source failing under two phase names never trips.
  resetFetchFailureInventory();
  fail("press_releases:cbi_press", "http_text", "timeout");
  fail("press_releases:cbi_press", "listing", "empty listing page");
  fail("press_releases:cbi_press", "http_text", "timeout");
  assert.equal(circuitOpen("press_releases:cbi_press"), true);

  resetFetchFailureInventory();
  fail("parent:childA", "http_text", "boom");
  fail("parent:childB", "http_text", "boom");
  fail("parent:childC", "http_text", "boom");
  assert.equal(circuitOpen("parent"), true, "a parent id sees its own children");
});

test("one dead source never trips another", () => {
  resetFetchFailureInventory();
  for (let i = 0; i < 5; i++) fail("noisy_source");
  assert.equal(circuitOpen("noisy_source"), true);
  assert.equal(circuitOpen("quiet_source"), false, "breakers are per source, not global");
});

test("a threshold of 0 disables the breaker entirely", () => {
  // The escape hatch: an operator who would rather pay the timeouts than risk
  // any skipped coverage can turn it off.
  resetFetchFailureInventory();
  for (let i = 0; i < 10; i++) fail("some_source");
  assert.equal(circuitOpen("some_source", { threshold: 0 }), false);
});

test("REGRESSION: the breaker does not survive a reset — a blip must not cost a run", () => {
  // Per-process by construction, and nothing persists it. A site down this
  // morning gets a clean try on the next run; a breaker that outlived the
  // process would quietly convert an outage into permanent lost coverage.
  resetFetchFailureInventory();
  for (let i = 0; i < 3; i++) fail("temporarily_down");
  assert.equal(circuitOpen("temporarily_down"), true);

  resetFetchFailureInventory();
  assert.equal(openCircuits().length, 0, "the tripped set is cleared with the inventory");
  assert.equal(circuitOpen("temporarily_down"), false, "the next run asks again");
  assert.equal(fetchFailureInventory().length, 0);
});
