// Statistical outlier detectors (L1, code-only). The 7 hand-coded conflict
// vectors can only find shapes a human imagined. These detectors instead let the
// DATA nominate its own suspects: they compute distributions over the stored
// numbers (asset growth, fund utilisation, donation→award timing) and manufacture
// investigation_leads for the outliers. Every lead is a CANDIDATE (status
// 'detected'), never a finding — it flows into the same L2/L3 funnel the
// hand-coded vectors feed, where the AI Investigator + Referee + a human gate
// decide what, if anything, is real.
//
// Pure & code-only: no network, no model. The three detectors are pure functions
// over prepared arrays (so tests need no DB); runAnomalyScan() is the only part
// that touches the store — it loads data, runs the detectors, and upserts leads.
import {
  listPoliticians, listEvidence, upsertLead, db,
} from "./store.js";

// Detector identity — bump when any threshold/weight/formula below changes.
export const DETECTOR_VERSION = "anomaly-v1";

// ── Thresholds (all named; one line each) ────────────────────────────────────
// These are the DEFAULTS. Each detector accepts an optional overrides object so
// the engine can pass DB-backed, ops-console-tuned values (see engine.js); called
// with no overrides (e.g. tests, the standalone CLI) they behave exactly as before.
export const ANOMALY_DEFAULTS = {
  MIN_COHORT_N: 8,        // z-scores need a cohort of at least this many growth events
  ASSET_Z_MIN: 3,         // flag asset growth this many std-devs above the cohort mean
  ASSET_ABS_MIN: 2e7,     // …and only if the absolute jump is ≥ ₹2 crore (2e7 rupees)
  UTIL_LOW_PCT: 15,       // MPLADS utilisation below this % is an extreme (funds parked)
  UTIL_HIGH_PCT: 98,      // …above this % is the other extreme (spent to the rupee)
  UTIL_MIN_FUND: 1e7,     // …only material when the fund is ≥ ₹1 crore (1e7 rupees)
  TIMING_WINDOW_DAYS: 90, // a tender within this many days of a donor's bond purchase
};

// Score scaling — kept inside conflict.js's observed range (~8–50) so anomaly
// leads rank alongside the hand-coded vectors rather than dominating or vanishing.
const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");
const CR = 1e7;

// Population mean / standard deviation over an array of numbers.
function meanStd(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

// ── a. STAT_ASSET_OUTLIER — cohort-relative asset-growth spikes ───────────────
// records: [{ politician_id, name, cohort, year, assets_total, evidence_id }]
// Growth is measured between a politician's own consecutive declared years; the
// z-score is taken over the GROWTH RATIOS within a cohort (state, or party as a
// fallback) — a rep whose wealth multiplied far faster than their peers stands
// out even if everyone got richer. Cohorts with fewer than MIN_COHORT_N growth
// events are suppressed (a z-score over 3 points is noise).
export function detectAssetGrowthOutliers(records = [], overrides = {}) {
  const { MIN_COHORT_N, ASSET_Z_MIN, ASSET_ABS_MIN } = { ...ANOMALY_DEFAULTS, ...overrides };
  // 1. Per-politician consecutive-year growth events.
  const byPol = new Map();
  for (const r of records) {
    if (r.assets_total == null || r.year == null) continue;
    (byPol.get(r.politician_id) ?? byPol.set(r.politician_id, []).get(r.politician_id)).push(r);
  }
  const growths = [];
  for (const rows of byPol.values()) {
    rows.sort((a, b) => a.year - b.year);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (!prev.assets_total || prev.assets_total <= 0) continue; // ratio undefined at zero base
      const abs_growth = cur.assets_total - prev.assets_total;
      const ratio = cur.assets_total / prev.assets_total;
      growths.push({
        politician_id: cur.politician_id, name: cur.name, cohort: cur.cohort ?? "(none)",
        from_year: prev.year, to_year: cur.year, from_assets: prev.assets_total, to_assets: cur.assets_total,
        abs_growth, ratio, evidence_ids: [prev.evidence_id, cur.evidence_id].filter(Boolean),
      });
    }
  }

  // 2. Cohort stats over the growth ratios; flag the outliers.
  const byCohort = new Map();
  for (const g of growths) (byCohort.get(g.cohort) ?? byCohort.set(g.cohort, []).get(g.cohort)).push(g);

  const candidates = [];
  for (const [cohort, gs] of byCohort) {
    if (gs.length < MIN_COHORT_N) continue; // small-cohort suppression
    const { mean, std } = meanStd(gs.map((g) => g.ratio));
    if (std === 0) continue; // a degenerate cohort (everyone identical) has no outliers
    for (const g of gs) {
      const z = (g.ratio - mean) / std;
      if (z < ASSET_Z_MIN || g.abs_growth < ASSET_ABS_MIN) continue;
      const growthCr = g.abs_growth / CR;
      const signal_score = Math.min(Math.round(z * 6) + Math.min(Math.round(growthCr / 2), 15), 45);
      candidates.push({
        actor_id: g.politician_id, actor_name: g.name,
        vector: "STAT_ASSET_OUTLIER", instrument: `declared-asset growth vs ${cohort} cohort`,
        beneficiary: `assets ${g.from_year}→${g.to_year}`, beneficiary_kind: "asset_growth",
        signal_score, severity: sev(signal_score),
        headline: `Declared assets grew ~${g.ratio.toFixed(1)}× (≈₹${growthCr.toFixed(2)} Cr) between ${g.from_year} and ${g.to_year} — ${z.toFixed(1)} std-devs above the ${cohort} cohort.`,
        detail: `From ₹${(g.from_assets / CR).toFixed(2)} Cr (${g.from_year}) to ₹${(g.to_assets / CR).toFixed(2)} Cr (${g.to_year}). Cohort "${cohort}" ratio mean ${mean.toFixed(2)}, std ${std.toFixed(2)}, n=${gs.length}; this rep's ratio ${g.ratio.toFixed(2)} → z=${z.toFixed(2)}. A statistical outlier is a candidate for review, not a finding.`,
        detector_version: DETECTOR_VERSION, evidence_urls: [],
        data: {
          statistic: "asset_growth_zscore",
          cohort, cohort_n: gs.length, cohort_mean_ratio: mean, cohort_std_ratio: std,
          ratio: g.ratio, z, abs_growth: g.abs_growth,
          from_year: g.from_year, to_year: g.to_year, from_assets: g.from_assets, to_assets: g.to_assets,
          evidence_ids: g.evidence_ids, // provenance: the affidavit rows the numbers came from
        },
      });
    }
  }
  return candidates;
}

// ── b. STAT_FUND_UTILIZATION — MPLADS spend at the extremes ───────────────────
// records: [{ politician_id, name, utilization_pct, allocated, evidence_id }]
// Both tails are suspicious: near-zero utilisation means public money sits idle;
// ~100% to the rupee is unusual for lumpy infrastructure spend and can signal
// rushed/round-tripped disbursement. Only material when the fund is ≥ ₹1 crore.
export function detectUtilizationExtremes(records = [], overrides = {}) {
  const { UTIL_LOW_PCT, UTIL_HIGH_PCT, UTIL_MIN_FUND } = { ...ANOMALY_DEFAULTS, ...overrides };
  const candidates = [];
  for (const r of records) {
    const util = r.utilization_pct, fund = r.allocated;
    if (util == null || fund == null || fund < UTIL_MIN_FUND) continue;
    const low = util < UTIL_LOW_PCT, high = util > UTIL_HIGH_PCT;
    if (!low && !high) continue;
    // Distance past the threshold, scaled into the conflict range.
    const dist = low ? (UTIL_LOW_PCT - util) : (util - UTIL_HIGH_PCT);
    const signal_score = Math.min(10 + Math.round(dist) + Math.min(Math.round(fund / CR), 10), 40);
    const kind = low ? "under-utilised" : "fully-drawn";
    candidates.push({
      actor_id: r.politician_id, actor_name: r.name,
      vector: "STAT_FUND_UTILIZATION", instrument: "MPLADS constituency fund",
      beneficiary: `MPLADS utilisation (${kind})`, beneficiary_kind: "fund",
      signal_score, severity: sev(signal_score),
      headline: `MPLADS utilisation is ${util.toFixed(1)}% of ≈₹${(fund / CR).toFixed(2)} Cr — an extreme (${kind}).`,
      detail: `Utilisation ${util.toFixed(1)}% on an allocation of ₹${(fund / CR).toFixed(2)} Cr falls ${low ? `below ${UTIL_LOW_PCT}%` : `above ${UTIL_HIGH_PCT}%`}. ${low ? "Idle public funds" : "Spend to the rupee"} is a candidate for review, not a finding.`,
      detector_version: DETECTOR_VERSION, evidence_urls: [],
      data: {
        statistic: "mplads_utilization_extreme",
        utilization_pct: util, allocated: fund, threshold: low ? UTIL_LOW_PCT : UTIL_HIGH_PCT, extreme: kind,
        evidence_ids: [r.evidence_id].filter(Boolean), // provenance
      },
    });
  }
  return candidates;
}

// ── c. STAT_TIMING_CORRELATION — donation→award proximity ─────────────────────
// events: normalised [{ kind, at, donor_entity_id, party_entity_id, donor_name,
//                       awardee_entity_id, awardee_name, evidence_id }]
// opts.sharesDirector(a, b): predicate — true when entities a and b share a
// director (so a tender to a SISTER company of the donor still pairs). Pairs a
// bond_purchase (donor D → party P) with an awarded_tender to D — or to an entity
// sharing a director with D — within TIMING_WINDOW_DAYS. This detector only runs
// when relations.js is present (see runAnomalyScan); it is exported unconditionally
// so it stays unit-testable with fixtures.
export function detectTimingCorrelation(events = [], { sharesDirector = () => false, TIMING_WINDOW_DAYS = ANOMALY_DEFAULTS.TIMING_WINDOW_DAYS } = {}) {
  const purchases = events.filter((e) => e.kind === "bond_purchase" && e.at);
  const awards = events.filter((e) => e.kind === "awarded_tender" && e.at);
  const candidates = [];
  const DAY = 86_400_000;
  for (const bp of purchases) {
    const donor = bp.donor_entity_id;
    for (const aw of awards) {
      const linked = aw.awardee_entity_id === donor || sharesDirector(donor, aw.awardee_entity_id);
      if (!linked) continue;
      const days = Math.round(Math.abs(new Date(aw.at) - new Date(bp.at)) / DAY);
      if (days > TIMING_WINDOW_DAYS) continue;
      const sameEntity = aw.awardee_entity_id === donor;
      // Closer in time → higher score; a sister-company award is a touch weaker.
      const signal_score = Math.min(25 + Math.round((TIMING_WINDOW_DAYS - days) / 6) + (sameEntity ? 5 : 0), 45);
      candidates.push({
        actor_id: donor, actor_name: bp.donor_name ?? donor,
        vector: "STAT_TIMING_CORRELATION", instrument: "electoral-bond purchase → government award",
        beneficiary: `tender to ${aw.awardee_name ?? aw.awardee_entity_id} on ${aw.at}`, beneficiary_kind: "tender",
        signal_score, severity: sev(signal_score),
        headline: `A government award landed ${days} day(s) ${sameEntity ? "with the donor itself" : "with a company sharing the donor's director"} of an electoral-bond purchase.`,
        detail: `${bp.donor_name ?? donor} bought bonds (to ${bp.party_name ?? bp.party_entity_id ?? "a party"}) on ${bp.at}; a tender to ${aw.awardee_name ?? aw.awardee_entity_id} was awarded on ${aw.at} — ${days} days apart${sameEntity ? "" : " (sister company)"}. Temporal proximity is a candidate for review, not a finding.`,
        detector_version: DETECTOR_VERSION, evidence_urls: [],
        data: {
          statistic: "donation_award_timing",
          days_apart: days, window_days: TIMING_WINDOW_DAYS, same_entity: sameEntity,
          bond_purchase_at: bp.at, award_at: aw.at,
          donor_entity_id: donor, awardee_entity_id: aw.awardee_entity_id,
          evidence_ids: [bp.evidence_id, aw.evidence_id].filter(Boolean), // provenance
        },
      });
    }
  }
  return candidates;
}

// ── Data loaders (orchestration only) ─────────────────────────────────────────
// Extract asset-growth records from stored eci_affidavit evidence numbers.
function loadAssetRecords(politicians) {
  const records = [];
  for (const p of politicians) {
    const cohort = p.state || p.party || "(none)"; // state, or party as a fallback
    for (const e of listEvidence(p.id)) {
      const n = e.numbers;
      if (!n || e.source_type !== "eci_affidavit") continue;
      if (n.total_assets == null || n.election_year == null) continue;
      records.push({
        politician_id: p.id, name: p.name, cohort,
        year: n.election_year, assets_total: n.total_assets, evidence_id: e.id,
      });
    }
  }
  return records;
}

// Extract MPLADS utilisation records from stored mplads evidence numbers.
function loadUtilizationRecords(politicians) {
  const records = [];
  for (const p of politicians) {
    for (const e of listEvidence(p.id)) {
      const n = e.numbers;
      if (!n || e.source_type !== "mplads") continue;
      if (n.utilization_pct == null || n.allocated == null) continue;
      records.push({
        politician_id: p.id, name: p.name,
        utilization_pct: n.utilization_pct, allocated: n.allocated, evidence_id: e.id,
      });
    }
  }
  return records;
}

// Load bond_purchase + awarded_tender events and a shares-director predicate from
// the relations store. Returns null when relations.js is absent (timing skipped).
async function loadTimingInputs() {
  let relations;
  try {
    relations = await import("./relations.js");
  } catch {
    return null; // relations.js absent → caller skips the timing detector
  }
  // Raw events for the two kinds the detector pairs.
  const rows = db.prepare(
    "SELECT * FROM events WHERE kind IN ('bond_purchase','awarded_tender')"
  ).all();
  const events = rows.map((r) => {
    const ids = (() => { try { return JSON.parse(r.entity_ids); } catch { return []; } })();
    if (r.kind === "bond_purchase") {
      return { kind: r.kind, at: r.at, donor_entity_id: ids[0], party_entity_id: ids[1], evidence_id: r.evidence_id };
    }
    // awarded_tender: first entity is the awardee (authority, if any, follows).
    return { kind: r.kind, at: r.at, awardee_entity_id: ids[0], evidence_id: r.evidence_id };
  });

  // shares-director predicate from director_of edges: two entities share a
  // director when a person is a director_of both.
  const directorEdges = relations.entitiesLinkedBy("director_of");
  const directorsOf = new Map(); // company entity → Set(director person entity)
  for (const e of directorEdges) {
    const set = directorsOf.get(e.dst_entity_id) ?? directorsOf.set(e.dst_entity_id, new Set()).get(e.dst_entity_id);
    set.add(e.src_entity_id);
  }
  const sharesDirector = (a, b) => {
    if (!a || !b || a === b) return false;
    const da = directorsOf.get(a), dbs = directorsOf.get(b);
    if (!da || !dbs) return false;
    for (const d of da) if (dbs.has(d)) return true;
    return false;
  };
  return { events, sharesDirector };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
// Loads data, runs the detectors, upserts every candidate as a lead. upsertLead
// dedupes on vector|actor_id|beneficiary and preserves any human-advanced status,
// so re-runs are idempotent. Returns per-detector input sizes + candidate counts.
export async function runAnomalyScan({ log = console.log } = {}) {
  const politicians = listPoliticians().filter((p) => !p.is_demo);

  const assetRecords = loadAssetRecords(politicians);
  const utilRecords = loadUtilizationRecords(politicians);
  const timing = await loadTimingInputs();

  const assetCandidates = detectAssetGrowthOutliers(assetRecords);
  const utilCandidates = detectUtilizationExtremes(utilRecords);
  let timingCandidates = [];
  if (timing) {
    timingCandidates = detectTimingCorrelation(timing.events, { sharesDirector: timing.sharesDirector });
  } else {
    log("[anomaly] relations.js absent — skipping STAT_TIMING_CORRELATION.");
  }

  const all = [...assetCandidates, ...utilCandidates, ...timingCandidates];
  for (const c of all) upsertLead(c);

  const inputs = {
    assets: assetRecords.length,
    utilization: utilRecords.length,
    timing_events: timing ? timing.events.length : null,
  };
  const counts = {
    STAT_ASSET_OUTLIER: assetCandidates.length,
    STAT_FUND_UTILIZATION: utilCandidates.length,
    STAT_TIMING_CORRELATION: timing ? timingCandidates.length : "skipped",
  };
  return { inputs, counts, candidates: all, upserted: all.length };
}

// ── CLI: node server/anomaly.js — run the scan against the real DB and print
// per-detector input sizes + candidate counts (zero candidates is acceptable). ──
const isMain = process.argv[1] && /[\\/]anomaly\.js$/.test(process.argv[1]);

if (isMain) {
  const res = await runAnomalyScan();
  console.log(`\n[anomaly] detector version: ${DETECTOR_VERSION}`);
  console.log("[anomaly] input sizes:");
  console.log(`  asset records      : ${res.inputs.assets}`);
  console.log(`  utilization records: ${res.inputs.utilization}`);
  console.log(`  timing events      : ${res.inputs.timing_events ?? "n/a (relations.js absent)"}`);
  console.log("[anomaly] candidate leads per detector:");
  for (const [k, v] of Object.entries(res.counts)) console.log(`  ${k.padEnd(24)}: ${v}`);
  console.log(`[anomaly] total upserted: ${res.upserted}`);
}
