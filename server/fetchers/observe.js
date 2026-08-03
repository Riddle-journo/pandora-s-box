// Failure observability for the fetcher layer.
//
// Every fetcher in this tree degrades to null / "" / [] on error so one broken
// upstream can never abort an ingest run. That fail-soft is deliberate — but a
// degraded return is byte-for-byte indistinguishable from "this politician
// genuinely has no record", and for a corpus whose credibility rests on
// completeness that ambiguity is the worst failure mode there is. A source's
// HTML redesign must not read as silence.
//
// So every degraded return routes through here, and a failure is RECORDED three
// ways:
//   1. a structured warn carrying the source id and the PHASE that failed,
//   2. an in-process inventory the health CLI prints (survives no restart, by
//      design — a restart should re-discover the current state of each upstream),
//   3. a row in the `fetch_failures` table, keyed by (source, phase), so the
//      error string survives a restart instead of being flattened by the caller
//      into a successful-looking zero-item run.
//
// (3) is a SEPARATE table, not a `<source>#<phase>` row in fetch_runs, and that
// separation is the whole design. fetch_runs.source is a closed vocabulary:
// sourceHealth() groups by it and every consumer (health.js, the worker's health
// sweep, GET /api/ops/health, db-maintenance's freshness()) reads each distinct
// value as a CONFIGURED SOURCE, classifying any at <50% ok as ROTTED —
// "provably broken", the automation gate. Phase rows are 0%-ok by construction,
// so putting them there would make the rot detector manufacture rot: a single
// transient 503, one scanned PDF or one page-cap hit would redden the gate and
// drown the real signal. Two ledgers, two vocabularies, one honest gate.
//
// Corollary: a failure we cannot attribute to a configured source id (an
// arbitrary news host from article-body.js, say) is recorded in-process ONLY —
// see the `ledger: false` meta flag. Unbounded key cardinality in a persistent
// telemetry table is not observability, it is noise with a disk cost.

import { logger } from "../util/log.js";

const flog = logger("fetch-observe");

/** @typedef {{ key: string, source: string, phase: string, count: number,
 *              last_message: string, first_at: string, last_at: string,
 *              ledger?: boolean }} FetchFailure */

/** @type {Map<string, FetchFailure>} */
const failures = new Map();

// Errors reach here from fetch() (code on `cause`), from node:https (code on the
// error), and as bare strings. Keep the code — "ENOTFOUND" vs "CERT_HAS_EXPIRED"
// vs a parse message is the whole diagnostic value — and cap the length so one
// pathological upstream can't bloat the ledger row (fetch_failures.message is
// clipped to 500 chars anyway).
export function errText(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err.slice(0, 300);
  const code = err?.cause?.code ?? err?.code;
  const msg = err?.message ?? String(err);
  return (code ? `${code}: ${msg}` : msg).slice(0, 300);
}

// Is this process a test run? Persisting telemetry means opening the store, i.e.
// the DB — which defaults to the live 432 MB corpus — and an unrelated test that
// trips a fetcher's failure path must never append rows to it.
//
// Deliberately layered, and deliberately NOT gated on NODE_TEST_CONTEXT alone:
// that variable is an implementation detail of `node --test`'s child-process
// isolation, so `node test/foo.test.js` or `--experimental-test-isolation=none`
// would have sailed straight through it and written to the live DB. The signals
// below are ones this REPO controls (its own test-file naming convention) plus
// the standard NODE_ENV, so the guard no longer depends on how the runner is
// invoked. Default-ON outside tests is intentional: an opt-in flag would silently
// disable the instrument in production the day someone forgets to set it.
function looksLikeTestRun() {
  if (process.env.NODE_TEST_CONTEXT) return true;        // `node --test` child
  if (process.env.NODE_ENV === "test") return true;
  const argv = process.argv.slice(1).map((a) => String(a).replaceAll("\\", "/"));
  // Covers both `node test/x.test.js` (argv[1] is the spec) and the parent
  // process of `node --test test/*.test.js` (specs listed after the flag).
  return argv.some((a) => /(^|\/)test\/|\.test\.[cm]?js$/.test(a));
}

// PANDOROS_FETCH_TELEMETRY=1 forces persistence on (used by the suites that
// assert on the table, against their own PANDOROS_DB_PATH); =0 forces it off.
export function telemetryEnabled() {
  const flag = process.env.PANDOROS_FETCH_TELEMETRY;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return !looksLikeTestRun();
}

// Lazy import: a static one would pull the DB into every module that touches
// http.js, which is all of them.
async function persist(source, phase, message, url) {
  if (!telemetryEnabled()) return false;
  try {
    const { recordFetchFailure } = await import("../store/store.js");
    recordFetchFailure({ source, phase, message, url: url ?? null });
    return true;
  } catch (err) {
    // The ledger being unavailable is itself a finding, not a reason to go quiet.
    flog.error({ source, phase, err: errText(err) }, "could not persist fetch failure to fetch_failures");
    return false;
  }
}

/**
 * Record a degraded fetcher return. Never throws, never rejects: callers are
 * already inside a catch block and must not acquire a second failure mode.
 * Returns the persistence promise so a test can await the ledger write; ignoring
 * it is the normal case.
 *
 * @param {string} source  fetcher/source id (a CONFIGURED fetcher, not a hostname)
 * @param {string} phase   which step degraded: "fetch" | "parse" | "pdf" | …
 * @param {unknown} err    the caught error, or a string describing the miss
 * @param {Record<string, any> & { ledger?: boolean, url?: string }} [meta]
 *   extra structured fields (url, host, status, bytes…). `meta.ledger === false`
 *   means "in-process inventory + warn only, do not persist" — for failures that
 *   cannot be attributed to a configured source id.
 */
export function noteFetchFailure(source, phase, err, meta = {}) {
  const { ledger = true, ...rest } = meta;
  const message = errText(err);
  const key = `${source}#${phase}`;
  const now = new Date().toISOString();
  const prev = failures.get(key);
  if (prev) { prev.count += 1; prev.last_message = message; prev.last_at = now; }
  else failures.set(key, { key, source, phase, count: 1, last_message: message, first_at: now, last_at: now, ledger });
  flog.warn({ source, phase, ...rest, err: message }, `${source}: ${phase} failed — returning degraded result`);
  if (!ledger) return Promise.resolve(false);
  return persist(source, phase, message, rest.url);
}

/**
 * A fetch that SUCCEEDED but whose parse yielded nothing. This is the signature
 * of an upstream HTML redesign, and it is the case the fetch_runs ledger used to
 * score as a healthy zero-item run.
 *
 * `got` defaults to 0 but MUST be passed when the parse yielded something and was
 * merely too little to use — a ledger row reading "parsed 0 characters" next to a
 * function that returned 25 of them is a row an operator cannot act on.
 *
 * @param {string} source
 * @param {string} phase
 * @param {{ bytes?: number, url?: string, expected?: string, got?: number, ledger?: boolean }} [meta]
 */
export function noteParseMiss(source, phase, meta = {}) {
  const { bytes, expected, got = 0, ...rest } = meta;
  const detail = `parsed ${got} ${expected ?? "rows"} from ${bytes ?? "?"} bytes of a 200 response`;
  return noteFetchFailure(source, phase, detail, rest);
}

/**
 * A page-size / result cap that was reached, i.e. the upstream almost certainly
 * had more rows than we took. Recorded through the same channel as a failure on
 * purpose: silently returning a short list is a completeness loss, and "we
 * stopped early, reason X" is the honest version of it. Recording it costs
 * nothing and is the only way a fixed cap that started truncating gets noticed.
 *
 * "at or past" rather than "exactly": every caller breaks on `>= cap` after
 * pushing a batch, so `got` legitimately overshoots (cppp pushes up to 25 rows
 * per term before testing against 50, so it lands on 50..74). Claiming exactness
 * left an operator unable to tell whether the cap was `got` or `cap`.
 *
 * @param {string} source
 * @param {string} phase
 * @param {{ got: number, cap: number, url?: string }} info
 */
export function noteTruncation(source, phase, { got, cap, url } = { got: 0, cap: 0 }) {
  return noteFetchFailure(source, `${phase}_page_cap`,
    `stopped early: took ${got} row(s), at or past the cap of ${cap} — upstream likely has more`,
    url ? { url } : {});
}

/** Degraded returns seen this process, most frequent first. Read by the health CLI. */
export function fetchFailureInventory() {
  return [...failures.values()].sort((a, b) => b.count - a.count);
}

/** Test seam: forget the recorded failures. */
export function resetFetchFailureInventory() { failures.clear(); tripped.clear(); }

// ── Circuit breaker ────────────────────────────────────────────────────────
//
// Several fetchers hit the SAME endpoint once per politician. When that
// endpoint is down, a full-roster run pays for it 4,559 times.
//
// Measured on a single real ingest: cbi.gov.in/press-releases times out after
// ~24 seconds, and enforcementdirectorate.gov.in/press-release 404s. Across the
// 2,931 politicians who have never been ingested, the CBI timeout ALONE is
// about twenty hours of waiting for a page that is not coming.
//
// After a source fails repeatedly within one process, stop calling it for the
// rest of that run. Deliberately per-PROCESS and never persisted: a site that
// was down this morning must get a clean try on the next run, and a breaker
// that outlived the process would quietly turn a blip into permanent lost
// coverage — the opposite of what this project needs.
//
// A tripped breaker is a loud, counted event, not a silent skip: it lands in
// the same inventory the health CLI reads, so "we stopped asking" is visible.
const CIRCUIT_THRESHOLD = Number(process.env.FETCH_CIRCUIT_THRESHOLD ?? 3);
const tripped = new Map();   // source -> { at, failures, reason }

/**
 * Should this source be skipped for the rest of this process?
 *
 * @param {string} source  the SAME id passed to noteFetchFailure
 * @param {{ threshold?: number }} [opts]
 */
export function circuitOpen(source, { threshold = CIRCUIT_THRESHOLD } = {}) {
  if (threshold <= 0) return false;              // 0 disables the breaker entirely
  if (tripped.has(source)) return true;
  // Count every phase recorded under this source id, plus the "source:sub" ids
  // the press-release scanner uses per listing.
  let count = 0, reason = "";
  for (const f of failures.values()) {
    if (f.source === source || f.source.startsWith(`${source}:`)) {
      count += f.count;
      if (!reason) reason = f.last_message;
    }
  }
  if (count < threshold) return false;
  tripped.set(source, { at: new Date().toISOString(), failures: count, reason });
  flog.warn({ source, failures: count, threshold, reason },
    `${source}: circuit OPEN — skipping this source for the rest of this run after ${count} failures`);
  return true;
}

/** Sources skipped this process, for the health CLI and the ops console. */
export function openCircuits() {
  return [...tripped.entries()].map(([source, v]) => ({ source, ...v }));
}

/**
 * Freshness honesty: stamp cached/stale data so a downstream consumer can tell a
 * fresh fact from a week-old one. ADDITIVE only — existing fields are never
 * replaced, matching the evidence "numbers-attach" rule.
 *
 * @template T
 * @param {T} value            a row, or an array of rows
 * @param {string|null} fetchedAt  when the cached copy was originally fetched
 * @param {object} [extra]     additional additive markers (e.g. stale_reason)
 * @returns {T}
 */
export function markStale(value, fetchedAt = null, extra = {}) {
  const stamp = { stale: true, stale_fetched_at: fetchedAt ?? null, ...extra };
  if (Array.isArray(value)) return /** @type {any} */ (value.map((r) => (r && typeof r === "object" ? { ...r, ...stamp } : r)));
  if (value && typeof value === "object") return /** @type {any} */ ({ ...value, ...stamp });
  return value;
}
