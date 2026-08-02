// Per-source VOLUME_DROP detection: a fetcher that returns HTTP 200 and zero
// rows must stop being indistinguishable from a healthy fetcher for a quiet
// politician. Synthetic fetch_runs only — no network, no LLM, temp DB.
//
// Half of these cases exist to prove the detector does NOT fire: a false alarm
// here trains the owner to ignore the whole report, which is worse than no
// detector at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-volume-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
// A prior run whose unlink failed (common on Windows) would otherwise be reopened
// dirty by PID reuse and flake the exact-count assertions.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch { /* nothing to clean */ }
}

const { recordFetchRun, fetchRunDailySeries } = await import("../server/store/store.js");
const {
  classifyVolume, detectVolumeDrops, classifyHealth, volumeThresholds, volumeReport,
} = await import("../server/platform/health.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* handle not released yet */ }
  }
});

const DAY = 86400000;
// Build one day of a source's history: `oks` successful runs each yielding
// `itemsPerRun` items, `daysAgo` days back.
function seedDay(source, daysAgo, oks, itemsPerRun, { failures = 0 } = {}) {
  const at = Date.now() - daysAgo * DAY;
  for (let i = 0; i < oks; i++) {
    recordFetchRun({ source, politician_id: `pol_${i}`, ok: 1, items: itemsPerRun, ms: 10, at: at + i });
  }
  for (let i = 0; i < failures; i++) {
    recordFetchRun({ source, politician_id: `bad_${i}`, ok: 0, items: 0, ms: 10, error: "boom", at: at + 500 + i });
  }
}

// A hand-built series lets the pure classifier be tested without the DB at all.
const day = (source, dayIdx, oks, avg) => ({
  source, day: `2026-07-${String(dayIdx).padStart(2, "0")}`,
  runs: oks, oks, items: oks * avg, avg_items: avg,
});

test("fetchRunDailySeries buckets runs per source per day and averages over SUCCESSFUL runs only", () => {
  seedDay("bucket_src", 3, 5, 10);
  seedDay("bucket_src", 1, 5, 10, { failures: 5 });

  const series = fetchRunDailySeries({ days: 10, source: "bucket_src" });
  assert.equal(series.length, 2, "two distinct days");
  assert.deepEqual(series.map((d) => d.source), ["bucket_src", "bucket_src"]);
  // Oldest-first, so the last row is the most recent day.
  assert.ok(series[0].day < series[1].day, "series is oldest-first");

  const latest = series[1];
  assert.equal(latest.runs, 10, "failed runs are still counted as runs");
  assert.equal(latest.oks, 5);
  assert.equal(latest.items, 50);
  // 50 items / 5 successful runs — the 5 errored runs must NOT dilute the mean,
  // otherwise a partially-failing day would be misreported as a volume collapse
  // when it is really a ROTTED signal.
  assert.equal(latest.avg_items, 10);

  // A source filter really filters.
  assert.deepEqual([...new Set(fetchRunDailySeries({ days: 10 }).map((d) => d.source))].includes("bucket_src"), true);
  assert.deepEqual(fetchRunDailySeries({ days: 10, source: "no_such_source" }), []);
});

test("VOLUME_DROP fires when a source's latest day collapses against its own median", () => {
  const series = [
    day("news", 1, 40, 52), day("news", 2, 40, 48), day("news", 3, 40, 50),
    day("news", 4, 40, 51),
    day("news", 5, 40, 2), // upstream redesigned: still ok=1, yield gone
  ];
  const v = classifyVolume(series);
  assert.equal(v.status, "VOLUME_DROP");
  assert.equal(v.source, "news");
  assert.equal(v.baseline, 50.5, "median of 48/50/51/52 is (50+51)/2");
  assert.equal(v.baseline_days, 4);
  assert.equal(v.latest_avg, 2);
  assert.ok(v.ratio < 0.25, `ratio ${v.ratio} is under the 25% threshold`);
});

test("a total collapse to zero items — the HTML-redesign signature — is a VOLUME_DROP, not a quiet source", () => {
  const series = [
    day("myneta", 1, 20, 1.0), day("myneta", 2, 20, 1.0),
    day("myneta", 3, 20, 1.0), day("myneta", 4, 20, 0),
  ];
  const v = classifyVolume(series);
  assert.equal(v.status, "VOLUME_DROP");
  assert.equal(v.ratio, 0);
});

test("ordinary day-to-day variation does NOT fire", () => {
  const series = [
    day("sansad", 1, 30, 12), day("sansad", 2, 30, 9), day("sansad", 3, 30, 15),
    day("sansad", 4, 30, 7), // 7/12 ≈ 58% of baseline — well inside normal noise
  ];
  const v = classifyVolume(series);
  assert.equal(v.status, "OK");
  assert.ok(v.ratio > 0.25);
});

test("too little history can never fire: a brand-new source is INSUFFICIENT_HISTORY", () => {
  const series = [day("brand_new", 1, 30, 40), day("brand_new", 2, 30, 0)];
  const v = classifyVolume(series);
  assert.equal(v.status, "INSUFFICIENT_HISTORY");
  assert.equal(v.baseline, null);
  assert.equal(v.baseline_days, 1);
});

test("a legitimately rare-hit source is LOW_VOLUME_SOURCE, never a false alarm", () => {
  // ICIJ/SEBI-shaped: ~1 item every 50 politicians. A "100% drop" on 0.02
  // items/run is Poisson noise, and QUIET already reports these separately.
  const series = [
    day("icij", 1, 60, 0.02), day("icij", 2, 60, 0.03), day("icij", 3, 60, 0),
    day("icij", 4, 60, 0.02), day("icij", 5, 60, 0),
  ];
  const v = classifyVolume(series);
  assert.equal(v.status, "LOW_VOLUME_SOURCE");
  assert.equal(v.ratio, null, "no ratio verdict is offered at all");
});

test("a day with too few successful runs is not a verdict-worthy sample", () => {
  const base = [day("cppp", 1, 30, 20), day("cppp", 2, 30, 22), day("cppp", 3, 30, 21), day("cppp", 4, 30, 20)];

  // One politician re-ingested on its own — a single zero-item run is not evidence.
  const oneRunDay = classifyVolume([...base, day("cppp", 5, 1, 0)]);
  assert.equal(oneRunDay.status, "OK", "the 1-run day is ignored, so the verdict falls back to day 4");
  assert.equal(oneRunDay.latest_day, "2026-07-04");

  // Raising the per-day minimum discards the small baseline days too.
  const strict = classifyVolume([...base, day("cppp", 5, 1, 0)], { ...volumeThresholds(), minRuns: 40 });
  assert.equal(strict.status, "NO_DATA");
});

test("a day where half the runs errored is left to ROTTED, not scored as a volume drop", () => {
  // avg_items is per SUCCESSFUL run, so 20 items from 10 oks stays at 2.0 even
  // though 10 sibling runs threw. Volume is unchanged; the failures are ROTTED's.
  const series = [
    day("press_releases", 1, 20, 2), day("press_releases", 2, 20, 2),
    day("press_releases", 3, 20, 2),
    { source: "press_releases", day: "2026-07-04", runs: 20, oks: 10, items: 20, avg_items: 2 },
  ];
  assert.equal(classifyVolume(series).status, "OK");
});

test("no usable data at all yields NO_DATA rather than an accusation", () => {
  assert.equal(classifyVolume([]).status, "NO_DATA");
  assert.equal(classifyVolume([]).source, null);
  assert.equal(classifyVolume([day("thin", 1, 1, 5)]).status, "NO_DATA");
});

test("thresholds are env-tunable", () => {
  const prev = process.env.HEALTH_VOLUME_RATIO;
  try {
    process.env.HEALTH_VOLUME_RATIO = "0.9";
    assert.equal(volumeThresholds().ratio, 0.9);
    const series = [
      day("tune", 1, 30, 10), day("tune", 2, 30, 10), day("tune", 3, 30, 10),
      day("tune", 4, 30, 8), // 80% — fine at the default, a drop at 0.9
    ];
    assert.equal(classifyVolume(series, volumeThresholds()).status, "VOLUME_DROP");
    assert.equal(classifyVolume(series, { ...volumeThresholds(), ratio: 0.25 }).status, "OK");
  } finally {
    if (prev === undefined) delete process.env.HEALTH_VOLUME_RATIO;
    else process.env.HEALTH_VOLUME_RATIO = prev;
  }
});

test("detectVolumeDrops groups a multi-source series and returns only the drops", () => {
  const rows = [
    day("good", 1, 30, 10), day("good", 2, 30, 10), day("good", 3, 30, 10), day("good", 4, 30, 10),
    day("bad", 1, 30, 10), day("bad", 2, 30, 10), day("bad", 3, 30, 10), day("bad", 4, 30, 0),
    day("young", 1, 30, 10), day("young", 2, 30, 0),
  ];
  const { all, drops } = detectVolumeDrops(rows);
  assert.equal(all.length, 3);
  assert.deepEqual(drops.map((d) => d.source), ["bad"]);
  assert.deepEqual(all.map((v) => [v.source, v.status]).sort(),
    [["bad", "VOLUME_DROP"], ["good", "OK"], ["young", "INSUFFICIENT_HISTORY"]]);
});

test("volumeReport takes an injected series function, so the sweep needs no DB", () => {
  const rows = [day("x", 1, 30, 9), day("x", 2, 30, 11), day("x", 3, 30, 10), day("x", 4, 30, 1)];
  let askedFor = null;
  const { drops } = volumeReport({ days: 30, seriesFn: (opts) => { askedFor = opts; return rows; } });
  assert.deepEqual(askedFor, { days: 30 });
  assert.deepEqual(drops.map((d) => d.source), ["x"]);
});

test("classifyHealth surfaces volumeDrops without disturbing rotted/quiet/stale", () => {
  const health = [
    { source: "rotter", runs: 10, ok_rate: 0.2, total_items: 0, last_success_at: null, last_error: "boom" },
    { source: "quiet_one", runs: 10, ok_rate: 1, total_items: 0, last_success_at: 1, last_error: null },
    { source: "dropper", runs: 10, ok_rate: 1, total_items: 40, last_success_at: 1, last_error: null },
  ];
  const daily = [
    day("dropper", 1, 30, 10), day("dropper", 2, 30, 10),
    day("dropper", 3, 30, 10), day("dropper", 4, 30, 0),
  ];
  const r = classifyHealth(health, ["rotter", "quiet_one", "dropper", "never_ran"], daily);
  assert.deepEqual(r.rotted.map((x) => x.source), ["rotter"]);
  assert.deepEqual(r.quiet.map((x) => x.source), ["quiet_one"]);
  assert.deepEqual(r.stale, ["never_ran"]);
  assert.deepEqual(r.volumeDrops.map((x) => x.source), ["dropper"]);
  // A source can be healthy by every OLD measure and still be losing coverage —
  // "dropper" is not rotted and not quiet, which is exactly the blind spot.
  assert.equal(r.rotted.some((x) => x.source === "dropper"), false);
  assert.equal(r.quiet.some((x) => x.source === "dropper"), false);

  // Two-argument callers (worker.js, admin-ops.js) keep working, with no drops.
  const legacy = classifyHealth(health, ["rotter"]);
  assert.deepEqual(legacy.volumeDrops, []);
  assert.deepEqual(legacy.rotted.map((x) => x.source), ["rotter"]);
});

test("end-to-end over the real ledger: seeded collapse is detected through the DB query", () => {
  for (const d of [9, 8, 7, 6]) seedDay("e2e_src", d, 8, 12);
  seedDay("e2e_src", 0, 8, 0); // today: 200s, zero rows

  const { drops } = detectVolumeDrops(fetchRunDailySeries({ days: 45, source: "e2e_src" }));
  assert.deepEqual(drops.map((d) => d.source), ["e2e_src"]);
  assert.equal(drops[0].baseline, 12);
  assert.equal(drops[0].latest_avg, 0);
  assert.equal(drops[0].latest_oks, 8);
});
