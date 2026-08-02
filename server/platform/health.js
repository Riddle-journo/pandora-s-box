// Source-health CLI. Reads the fetch_runs ledger (written by ingestFor) and
// prints a per-source table plus ROTTED / VOLUME_DROP / STALE sections, so a
// human — or a gating script — can see at a glance which scrapers have quietly
// stopped working. Read-only against the DB; never touches the network or the LLM.
//
// Usage:  node server/platform/health.js [--days 14] [--junk]
// Exit code 1 if any source is ROTTED or in VOLUME_DROP (so automation can gate).
//
// --junk audits fetch_runs.source against the fetcher roster and prints any value
// that is not a configured source, plus the SQL to remove it. READ-ONLY: it
// prints the statement, it never runs it.
import { sourceHealth, fetchRunDailySeries, fetchFailureHealth, fetchRunSourceCounts } from "../store/store.js";
import { insecureTlsInventory } from "../util/tls-policy.js";
import { fetchFailureInventory } from "../fetchers/observe.js";

// Pure classifier — extracted from the CLI so it is unit-testable without any
// I/O. `health` is sourceHealth()'s output; `knownSources` is the full fetcher
// roster (for detecting STALE sources that produced zero runs in the window);
// `daily` is fetchRunDailySeries()'s output (optional — omit it and volumeDrops
// is simply empty, so existing two-argument callers are unaffected).
//   ROTTED = actually failing: erroring on ≥50% of its runs. The only state
//            that means "provably broken" (a fetcher throwing/timing out).
//   QUIET  = runs cleanly (no errors) but has found ZERO items every time.
//            NOT a failure — many sources are legitimately rare-hit (ICIJ
//            leaks, SEBI orders, ED/CBI press releases only match a sliver of
//            politicians) or are optional/unconfigured (no MCA_DB_PATH set).
//            Zero items only becomes suspicious once a source has run against
//            enough politicians that "never once matched" is itself a signal
//            — that judgment belongs to a human reading the numbers, not a
//            blanket rule, so QUIET is reported separately and never treated
//            as rot (previously ROTTED conflated the two; see fetch-health.test.js).
//   VOLUME_DROP = ok=1 throughout, but this source's own recent yield collapsed
//            against its own trailing baseline. This is the class that catches
//            an upstream HTML redesign, which ROTTED and QUIET both miss: the
//            fetcher still returns 200 and simply parses nothing.
//   STALE  = a known source with no runs at all in the window.
export function classifyHealth(health = [], knownSources = [], daily = []) {
  const ran = new Set(health.map((h) => h.source));
  const rotted = health.filter((h) => h.runs > 0 && h.ok_rate < 0.5);
  const quiet = health.filter((h) => h.runs > 0 && h.ok_rate >= 0.5 && h.total_items === 0);
  const stale = knownSources.filter((s) => !ran.has(s));
  const volume = detectVolumeDrops(daily);
  return { rows: health, rotted, quiet, stale, volumeDrops: volume.drops, volumeStatus: volume.all };
}

// ── Volume-drop thresholds ──────────────────────────────────────────────
// All env-tunable, because the right numbers depend on roster size and ingest
// cadence, and a false alarm here trains the owner to ignore the whole report.
// Defaults and their reasoning:
//   DAYS (45)       — how much history to load. Long enough that a weekly ingest
//                     cadence still yields several baseline days, short enough to
//                     stay inside the ledger's 90-day prune horizon.
//   MIN_RUNS (5)    — a day must contain ≥5 SUCCESSFUL runs to be usable at all.
//                     One run against one politician says nothing about a source.
//   MIN_DAYS (3)    — ≥3 usable days BEFORE the latest one are required for a
//                     baseline. With fewer, the median is not a baseline, it is
//                     an anecdote — so a brand-new source can never be flagged.
//   MIN_BASELINE(1) — the baseline mean must be ≥1 item per successful run.
//                     Rare-hit sources (ICIJ, SEBI orders) average ~0.02 items
//                     per run; a "75% drop" on 0.02 is Poisson noise, and those
//                     sources belong to QUIET, which is reported separately.
//   RATIO (0.25)    — flag when the latest day's mean is under 25% of baseline.
//                     A three-quarters collapse is far outside the day-to-day
//                     variation of a working scraper, while leaving room for the
//                     legitimate case of a smaller/partial ingest batch.
//   MIN_RUN_RATIO(0.5) — the latest day must hold at least half as many
//                     successful runs as a typical baseline day, or no verdict is
//                     issued. THIS IS THE COHORT GUARD, and it is the difference
//                     between an alert that means something and one that doesn't.
//                     Every fetcher runs for every politician, and the
//                     office-conditional ones (sansad, mplads) legitimately
//                     return zero items for an MLA while still recording ok=1.
//                     So an operator using the ops console's run-on-a-SET to
//                     re-ingest 6 state MLAs produces, for `sansad`, a day with
//                     6 successful runs averaging 0 items — against a full-roster
//                     baseline of ~8. Ratio 0, VOLUME_DROP, red gate, and NOTHING
//                     UPSTREAM CHANGED: the operator changed the cohort. A 6-run
//                     day is not a comparable sample to a 300-run day, so it gets
//                     no verdict at all rather than a false accusation.
const envNum = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
export const volumeThresholds = () => ({
  days: envNum("HEALTH_VOLUME_DAYS", 45),
  minRuns: envNum("HEALTH_VOLUME_MIN_RUNS", 5),
  minDays: envNum("HEALTH_VOLUME_MIN_DAYS", 3),
  minBaseline: envNum("HEALTH_VOLUME_MIN_BASELINE", 1),
  ratio: envNum("HEALTH_VOLUME_RATIO", 0.25),
  minRunRatio: envNum("HEALTH_VOLUME_MIN_RUN_RATIO", 0.5),
});

// Median is the right centre here, not the mean: one exceptional ingest day (a
// full-roster backfill) must not inflate the baseline and then make every
// ordinary day afterwards look like a collapse.
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * PURE. Classify ONE source's daily series against its own trailing baseline.
 *
 * Returns a status of:
 *   "NO_DATA"              — nothing usable in the window
 *   "INSUFFICIENT_HISTORY" — too few usable days to have a baseline at all
 *   "LOW_VOLUME_SOURCE"    — baseline too small for a ratio test to mean anything
 *   "INCOMPARABLE_SAMPLE"  — the latest day covers far fewer politicians than the
 *                            baseline days, so its yield says nothing about the
 *                            source (see MIN_RUN_RATIO above)
 *   "OK" | "VOLUME_DROP"
 * plus the numbers behind the verdict, so the CLI can show the arithmetic rather
 * than an unexplained accusation.
 *
 * fetchRunDailySeries returns oldest-first, but this function is exported for
 * reuse and takes an arbitrary array (classifyHealth's `daily` argument, or
 * volumeReport's injected seriesFn), so it sorts rather than assume. A
 * newest-first series previously INVERTED the verdict — reporting OK on a real
 * collapse and naming the wrong day — which is a silent-precondition trap in a
 * function documented PURE.
 *
 * @param {{ source: string, day: string, runs: number, oks: number, items: number, avg_items: number }[]} series
 * @param {ReturnType<typeof volumeThresholds>} [t]
 */
export function classifyVolume(series = [], t = volumeThresholds()) {
  const source = series[0]?.source ?? null;
  // A day with no successful run carries no volume information — its yield is
  // zero because the fetcher errored, which is ROTTED's territory, not this one's.
  const usable = series
    .filter((d) => d.oks >= t.minRuns)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const base = { source, samples: usable.length, threshold_ratio: t.ratio };
  if (!usable.length) return { ...base, status: "NO_DATA" };

  const latest = usable[usable.length - 1];
  const prior = usable.slice(0, -1);
  const latestInfo = { latest_day: latest.day, latest_avg: latest.avg_items, latest_oks: latest.oks, latest_items: latest.items };
  if (prior.length < t.minDays) {
    return { ...base, ...latestInfo, status: "INSUFFICIENT_HISTORY", baseline: null, baseline_days: prior.length };
  }

  const baseline = median(prior.map((d) => d.avg_items));
  const baselineOks = median(prior.map((d) => d.oks));
  const info = {
    ...base, ...latestInfo, baseline, baseline_days: prior.length,
    baseline_oks: baselineOks, run_ratio: baselineOks > 0 ? latest.oks / baselineOks : 1,
  };
  if (baseline < t.minBaseline) return { ...info, status: "LOW_VOLUME_SOURCE", ratio: null };

  // COHORT GUARD. items-per-run is only comparable across days that ingested a
  // comparable set of politicians. A targeted 6-rep batch against 300-rep
  // baseline days measures the operator's selection, not the source.
  if (info.run_ratio < t.minRunRatio) return { ...info, status: "INCOMPARABLE_SAMPLE", ratio: null };

  const ratio = baseline > 0 ? latest.avg_items / baseline : 1;
  return { ...info, ratio, status: ratio < t.ratio ? "VOLUME_DROP" : "OK" };
}

/**
 * PURE. Run classifyVolume over a multi-source daily series.
 * @returns {{ all: ReturnType<typeof classifyVolume>[], drops: ReturnType<typeof classifyVolume>[] }}
 */
export function detectVolumeDrops(daily = [], t = volumeThresholds()) {
  const bySource = new Map();
  for (const row of daily) {
    if (!bySource.has(row.source)) bySource.set(row.source, []);
    bySource.get(row.source).push(row);
  }
  const all = [...bySource.values()]
    .map((series) => classifyVolume(series, t))
    .sort((a, b) => String(a.source).localeCompare(String(b.source)));
  return { all, drops: all.filter((v) => v.status === "VOLUME_DROP") };
}

/**
 * DB-reading convenience for the worker's periodic health sweep and the ops API:
 * loads the daily series and returns the volume verdicts in one call. Read-only.
 * Hook-up for server/orchestration/worker.js#source_health (a file this
 * workstream does not own) is a single line — see the report.
 */
export function volumeReport({ days = volumeThresholds().days, seriesFn = fetchRunDailySeries } = {}) {
  const t = { ...volumeThresholds(), days };
  return detectVolumeDrops(seriesFn({ days }), t);
}

function humanizeAge(at) {
  if (!at) return "never";
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// A long-lived worker accumulates one inventory entry per (source, phase); an
// uncapped dump is hundreds of lines that nobody reads to the end.
const DEGRADED_CAP = 25;

/**
 * READ-ONLY audit of fetch_runs.source against the fetcher roster.
 *
 * fetch_runs.source is a closed vocabulary — sourceHealth() groups by it and
 * every consumer treats a distinct value as a configured source and a 0%-ok one
 * as ROTTED. Anything in there that is not a fetcher id is junk that permanently
 * reddens the automation gate. Two known ways it got written: a `<source>#<phase>`
 * telemetry row (now in the separate fetch_failures table) and a bare hostname
 * defaulted in by fetchText (now never persisted). This finds the leftovers.
 *
 * It PRINTS the DELETE statement and does not execute it. Deleting rows from a
 * 432 MB live corpus is an operator's decision, not a health check's.
 */
function reportJunkSources(knownSources = []) {
  const known = new Set(knownSources);
  const all = fetchRunSourceCounts();
  // Junk = a `#phase` composite, or a bare hostname (a dot and no roster entry).
  const junk = all.filter((r) => {
    const s = String(r.source ?? "");
    if (known.has(s)) return false;
    return s.includes("#") || /\.[a-z]{2,}$/i.test(s);
  });
  console.log(`\nJUNK fetch_runs.source VALUES (not a configured fetcher): ${junk.length} of ${all.length} distinct`);
  if (!known.size) console.log("  ! fetcher roster unavailable — hostname/# heuristics only, review before deleting");
  let rows = 0;
  for (const r of junk) {
    rows += r.rows;
    console.log(`  ✗ ${padR(trunc(r.source, 40), 42)} ${padL(r.rows, 7)} row(s), ${r.oks} ok, last ${humanizeAge(r.last_at)} ago`);
  }
  if (!junk.length) { console.log("  (clean — every source in the ledger is a configured fetcher)"); return; }
  console.log(`\n  ${rows} row(s) total. To remove them, BACK UP FIRST (npm run db:backup) then run:`);
  const list = junk.map((r) => `'${String(r.source).replaceAll("'", "''")}'`).join(", ");
  console.log(`    DELETE FROM fetch_runs WHERE source IN (${trunc(list, 900)});`);
  console.log("  (printed, NOT executed — this CLI never writes to the DB)");
}

const padR = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const num = (x, d = 2) => (x == null ? "—" : Number(x).toFixed(d));

async function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf("--days");
  const days = di >= 0 ? Number(args[di + 1]) || 14 : 14;

  const health = sourceHealth(days);
  const t = volumeThresholds();
  // Volume needs its OWN (longer) window: the baseline has to predate the run
  // being judged, so it cannot be limited to the table's --days view.
  const daily = fetchRunDailySeries({ days: t.days });
  let knownSources = [];
  try { ({ FETCHER_NAMES: knownSources } = await import("../orchestration/ingest.js")); } catch { /* roster unavailable → no STALE */ }

  const { rows, rotted, quiet, stale, volumeDrops, volumeStatus } = classifyHealth(health, knownSources, daily);

  console.log(`\nSource health — last ${days} day(s)  (${rows.length} source(s) with runs)\n`);
  if (rows.length) {
    console.log(
      padR("SOURCE", 22) + padL("RUNS", 6) + padL("OK%", 7) + padL("ITEMS", 8) +
      "  " + padR("LAST OK", 8) + "  LAST ERROR");
    console.log("─".repeat(90));
    for (const r of rows) {
      console.log(
        padR(r.source, 22) +
        padL(r.runs, 6) +
        padL(`${Math.round(r.ok_rate * 100)}%`, 7) +
        padL(r.total_items, 8) + "  " +
        padR(humanizeAge(r.last_success_at), 8) + "  " +
        trunc(r.last_error ?? "", 60));
    }
  } else {
    console.log("  (no fetch_runs recorded in this window)");
  }

  console.log(`\nROTTED (runs>0, success <50% — actually failing): ${rotted.length}`);
  for (const r of rotted) {
    console.log(`  ✗ ${padR(r.source, 22)} ${Math.round(r.ok_rate * 100)}% ok, ${r.total_items} items — ${trunc(r.last_error ?? "no error logged", 60)}`);
  }

  // The class that catches an upstream redesign: still HTTP 200, still ok=1, but
  // the yield collapsed against this source's OWN history.
  console.log(`\nVOLUME_DROP (ok, but latest day's yield <${Math.round(t.ratio * 100)}% of its own ${t.minDays}+-day median, ` +
    `baseline ≥${t.minBaseline} item/run, ≥${t.minRuns} successful runs/day): ${volumeDrops.length}`);
  for (const v of volumeDrops) {
    console.log(`  ▼ ${padR(v.source, 22)} ${num(v.latest_avg)} items/run on ${v.latest_day} ` +
      `(${v.latest_oks} runs) vs baseline ${num(v.baseline)} over ${v.baseline_days} day(s) — ${Math.round((v.ratio ?? 0) * 100)}%`);
  }
  const SUPPRESSED = ["INSUFFICIENT_HISTORY", "LOW_VOLUME_SOURCE", "INCOMPARABLE_SAMPLE"];
  const suppressed = volumeStatus.filter((v) => SUPPRESSED.includes(v.status));
  const nSup = (s) => suppressed.filter((v) => v.status === s).length;
  console.log(`  (not eligible for a volume verdict: ${suppressed.length} source(s) — ` +
    `${nSup("INSUFFICIENT_HISTORY")} too little history, ` +
    `${nSup("LOW_VOLUME_SOURCE")} legitimately low-yield, ` +
    `${nSup("INCOMPARABLE_SAMPLE")} latest day too small a cohort to compare)`);
  // Show the cohort-suppressed ones: they are the cases an operator would
  // otherwise see as a red gate after running a targeted batch.
  for (const v of suppressed.filter((x) => x.status === "INCOMPARABLE_SAMPLE")) {
    console.log(`    ? ${padR(v.source, 22)} ${v.latest_oks} run(s) on ${v.latest_day} vs a ` +
      `${num(v.baseline_oks, 0)}-run typical day — cohort changed, no verdict`);
  }

  console.log(`\nQUIET (runs cleanly, but zero items every time — not necessarily broken, ` +
    `may be a rare-hit or unconfigured source): ${quiet.length}`);
  for (const r of quiet) console.log(`  · ${padR(r.source, 22)} ${r.runs} run(s), 0 items`);

  console.log(`\nSTALE (known source, zero runs in window): ${stale.length}`);
  for (const s of stale) console.log(`  · ${s}`);

  // Provenance, not plumbing: these upstreams fed the accusation engine over a
  // channel whose bytes nobody authenticated. Empty is the healthy state, and an
  // entry disappearing means the upstream FIXED its chain (secure-first retries
  // verification every call). In-process only, so this is populated when health
  // runs inside a long-lived worker; a bare CLI invocation shows an empty list.
  const tls = insecureTlsInventory();
  console.log(`\nUNVERIFIED TLS (fetched this process without cert verification): ${tls.length}`);
  for (const h of tls) console.log(`  ! ${padR(h.host, 34)} ${h.count} fetch(es), last ${h.last_code} at ${h.last_at}`);

  // Degraded fetcher returns seen THIS PROCESS. Includes unattributed ones (a
  // news host with no `source` opt) that are deliberately never persisted.
  const degraded = fetchFailureInventory();
  console.log(`\nDEGRADED RETURNS this process (fetcher failures that fell back to null/""/[]): ${degraded.length}`);
  for (const f of degraded.slice(0, DEGRADED_CAP)) {
    console.log(`  ~ ${padR(f.key, 30)} ${f.count}× — ${trunc(f.last_message, 60)}${f.ledger === false ? "  [in-process only]" : ""}`);
  }
  if (degraded.length > DEGRADED_CAP) console.log(`    … ${degraded.length - DEGRADED_CAP} more (capped)`);

  // The PERSISTENT view of the same signal: the fetch_failures table. Kept apart
  // from the source table on purpose — see the header comment in
  // server/fetchers/observe.js. A (source, phase) here is NEVER a source.
  const persisted = fetchFailureHealth({ days, limit: DEGRADED_CAP + 1 });
  console.log(`\nDEGRADED RETURNS on record (fetch_failures, last ${days} day(s)): ${persisted.length}`);
  for (const f of persisted.slice(0, DEGRADED_CAP)) {
    console.log(`  ~ ${padR(f.key, 30)} ${f.count}× last ${humanizeAge(f.last_at)} ago — ${trunc(f.last_message, 50)}`);
  }
  if (persisted.length > DEGRADED_CAP) console.log(`    … more (capped at ${DEGRADED_CAP})`);
  console.log("  (these are PARSE/PHASE findings, not sources — they never enter the ROTTED gate)");

  if (args.includes("--junk")) reportJunkSources(knownSources);

  console.log("");
  // A volume collapse is at least as serious as rot — both mean the corpus is
  // silently losing coverage — so both gate automation.
  process.exit(rotted.length || volumeDrops.length ? 1 : 0);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("health.js");
if (invokedDirectly) main();
