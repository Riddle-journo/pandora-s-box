// Ledger-native anomaly detectors (Phase 4). server/anomaly.js's detectors read
// raw evidence.numbers; these read the ANALYSIS LEDGER (the facts table) instead —
// the canonical, populated substrate the Phase-2 extractors filled. That unlocks
// two signals the old loaders could not produce:
//   • STAT_INCOME_OUTLIER   — cohort-relative spikes in the declared-income TIME
//                             SERIES (affidavits are single-year, so the old
//                             asset-growth detector had nothing to diff; the eci
//                             income series does).
//   • STAT_SPEND_VS_INCOME  — a CROSS-SOURCE flag: campaign spend (eci_expenditure)
//                             vs declared annual income (eci affidavit content).
//
// Same shape + same funnel as anomaly.js: pure detectors over prepared arrays
// (DB-free tests), thin loaders that read the ledger, and runLedgerDetectors() as
// the only part that touches the store. Every lead is a CANDIDATE (status
// 'detected'), never a finding — it flows into the same L2/L3 review funnel.
// actor_id is the politician_id (leads are keyed on politicians, like the existing
// detectors), resolved from each fact's entity via strong_ids.politician_id.
import { db, listPoliticians, upsertLead } from "../store/store.js";

export const LEDGER_DETECTOR_VERSION = "ledger-detector-v1";

// ── Thresholds ───────────────────────────────────────────────────────────────
// DEFAULTS; each detector accepts an overrides object so the engine can pass
// DB-backed, ops-console-tuned values. No overrides → unchanged behaviour.
export const LEDGER_DEFAULTS = {
  MIN_COHORT_N: 8,      // z-scores need a cohort of at least this many growth events
  INCOME_Z_MIN: 3,      // flag income growth this many std-devs above the cohort mean
  INCOME_ABS_MIN: 1e6,  // …and only if the absolute jump is ≥ ₹10 lakh
  INCOME_BASE_MIN: 1e5, // …off a base of ≥ ₹1 lakh (ratios off a tiny base are noise)
  // Spend-vs-income is COHORT-RELATIVE: flag reps whose spend/income ratio is a
  // statistical OUTLIER among their peers, with absolute floors as a pre-filter.
  SPEND_MIN: 1e6,       // ignore campaigns spending under ₹10 lakh outright
  SPEND_RATIO_FLOOR: 3, // pre-filter: only ratios ≥ 3× are even considered
  SPEND_Z_MIN: 2,       // then flag those ≥ 2 std-devs above the cohort's ratio mean
  SPEND_RATIO_HARD: 12, // small-cohort fallback: a ≥12× ratio is an outlier on its own
  MULTI_SOURCE_MIN: 3,  // distinct adverse source_types before a concentration is a lead
};

const L = 1e5, CR = 1e7;
const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");
function meanStd(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

// ── a. STAT_INCOME_OUTLIER — cohort-relative income-growth spikes ─────────────
// records: [{ politician_id, name, cohort, year, income, evidence_id }]
export function detectIncomeGrowthOutliers(records = [], overrides = {}) {
  const { MIN_COHORT_N, INCOME_Z_MIN, INCOME_ABS_MIN, INCOME_BASE_MIN } = { ...LEDGER_DEFAULTS, ...overrides };
  const byPol = new Map();
  for (const r of records) {
    if (r.income == null || r.year == null) continue;
    (byPol.get(r.politician_id) ?? byPol.set(r.politician_id, []).get(r.politician_id)).push(r);
  }
  const growths = [];
  for (const rows of byPol.values()) {
    rows.sort((a, b) => a.year - b.year);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (!prev.income || prev.income < INCOME_BASE_MIN) continue;
      growths.push({
        politician_id: cur.politician_id, name: cur.name, cohort: cur.cohort ?? "(none)",
        from_year: prev.year, to_year: cur.year, from_income: prev.income, to_income: cur.income,
        abs_growth: cur.income - prev.income, ratio: cur.income / prev.income,
        evidence_ids: [prev.evidence_id, cur.evidence_id].filter(Boolean),
      });
    }
  }

  const byCohort = new Map();
  for (const g of growths) (byCohort.get(g.cohort) ?? byCohort.set(g.cohort, []).get(g.cohort)).push(g);

  const candidates = [];
  for (const [cohort, gs] of byCohort) {
    if (gs.length < MIN_COHORT_N) continue;
    const { mean, std } = meanStd(gs.map((g) => g.ratio));
    if (std === 0) continue;
    for (const g of gs) {
      const z = (g.ratio - mean) / std;
      if (z < INCOME_Z_MIN || g.abs_growth < INCOME_ABS_MIN) continue;
      const growthL = g.abs_growth / L;
      const signal_score = Math.min(Math.round(z * 6) + Math.min(Math.round(growthL / 10), 15), 45);
      candidates.push({
        actor_id: g.politician_id, actor_name: g.name,
        vector: "STAT_INCOME_OUTLIER", instrument: `declared-income growth vs ${cohort} cohort`,
        beneficiary: `income ${g.from_year}→${g.to_year}`, beneficiary_kind: "income_growth",
        signal_score, severity: sev(signal_score),
        headline: `Declared income grew ~${g.ratio.toFixed(1)}× (≈₹${growthL.toFixed(1)} L) between ${g.from_year} and ${g.to_year} — ${z.toFixed(1)} std-devs above the ${cohort} cohort.`,
        detail: `From ₹${(g.from_income / L).toFixed(1)} L (${g.from_year}) to ₹${(g.to_income / L).toFixed(1)} L (${g.to_year}). Cohort "${cohort}" ratio mean ${mean.toFixed(2)}, std ${std.toFixed(2)}, n=${gs.length}; this rep's ratio ${g.ratio.toFixed(2)} → z=${z.toFixed(2)}. A statistical outlier is a candidate for review, not a finding.`,
        detector_version: LEDGER_DETECTOR_VERSION, evidence_urls: [],
        data: {
          statistic: "income_growth_zscore", cohort, cohort_n: gs.length,
          cohort_mean_ratio: mean, cohort_std_ratio: std, ratio: g.ratio, z, abs_growth: g.abs_growth,
          from_year: g.from_year, to_year: g.to_year, from_income: g.from_income, to_income: g.to_income,
          evidence_ids: g.evidence_ids,
        },
      });
    }
  }
  return candidates;
}

// ── b. STAT_SPEND_VS_INCOME — campaign spend vs declared income (cohort-relative) ─
// records: [{ politician_id, name, cohort, spend, income, spend_year, income_year, evidence_ids }]
// A high spend/income ratio is systemic, so we flag only ratios that are OUTLIERS
// within the rep's peer cohort (z-score), with absolute floors as a pre-filter. In
// cohorts too small for a stable z-score, only a very high hard ratio (≥12×) flags.
export function detectSpendVsIncome(records = [], overrides = {}) {
  const { MIN_COHORT_N, SPEND_MIN, SPEND_RATIO_FLOOR, SPEND_Z_MIN, SPEND_RATIO_HARD } = { ...LEDGER_DEFAULTS, ...overrides };
  // Pre-filter to plausible pairs and compute the ratio once.
  const pairs = [];
  for (const r of records) {
    if (r.spend == null || r.income == null || r.income <= 0 || r.spend < SPEND_MIN) continue;
    const ratio = r.spend / r.income;
    if (ratio < SPEND_RATIO_FLOOR) continue;
    pairs.push({ ...r, cohort: r.cohort ?? "(none)", ratio });
  }
  const byCohort = new Map();
  for (const p of pairs) (byCohort.get(p.cohort) ?? byCohort.set(p.cohort, []).get(p.cohort)).push(p);

  const candidates = [];
  for (const [cohort, ps] of byCohort) {
    const bigEnough = ps.length >= MIN_COHORT_N;
    const { mean, std } = bigEnough ? meanStd(ps.map((p) => p.ratio)) : { mean: 0, std: 0 };
    for (const r of ps) {
      const z = bigEnough && std > 0 ? (r.ratio - mean) / std : null;
      // Outlier if it clears the cohort z-gate, OR (small/degenerate cohort) if the
      // raw ratio is extreme on its own.
      const isOutlier = (z != null && z >= SPEND_Z_MIN) || r.ratio >= SPEND_RATIO_HARD;
      if (!isOutlier) continue;
      const signal_score = Math.min(10 + Math.round((z ?? SPEND_Z_MIN) * 5) + Math.round(Math.min(r.ratio, 20)), 40);
      candidates.push({
        actor_id: r.politician_id, actor_name: r.name,
        vector: "STAT_SPEND_VS_INCOME", instrument: "campaign spend vs declared income",
        beneficiary: `election spend ${r.spend_year ?? ""}`.trim(), beneficiary_kind: "spend_vs_income",
        signal_score, severity: sev(signal_score),
        headline: `Declared campaign spend ≈₹${(r.spend / L).toFixed(1)} L is ~${r.ratio.toFixed(1)}× declared annual income${z != null ? ` — ${z.toFixed(1)}σ above the ${cohort} cohort` : ""}.`,
        detail: `Election expenditure ₹${(r.spend / L).toFixed(1)} L (${r.spend_year ?? "?"}) against declared income ₹${(r.income / L).toFixed(1)} L (${r.income_year ?? "?"}) — a ${r.ratio.toFixed(1)}× ratio${z != null ? `, which is ${z.toFixed(2)} std-devs above the ${cohort}-cohort mean of ${mean.toFixed(1)}× (n=${ps.length})` : ` (small cohort — flagged on the raw ratio alone)`}. Campaigns can draw on savings, loans or party funds, so an outlier ratio is a candidate for review, not a finding.`,
        detector_version: LEDGER_DETECTOR_VERSION, evidence_urls: [],
        data: {
          statistic: "spend_vs_income_ratio", spend: r.spend, income: r.income, ratio: r.ratio,
          cohort, cohort_n: ps.length, cohort_mean_ratio: bigEnough ? mean : null, z,
          spend_year: r.spend_year, income_year: r.income_year, evidence_ids: r.evidence_ids ?? [],
        },
      });
    }
  }
  return candidates;
}

// ── c. MULTI_SOURCE_ADVERSE — cross-source corroboration ──────────────────────
// The vision payoff of the new link/prose extractors: one politician named across
// SEVERAL independent adverse sources (court + CBI + offshore leak + tender + …) is
// worth a look even when each mention alone is a namesake. records:
// [{ politician_id, name, sources:Set<source_type>, claim_types:Set, evidence_ids }]
const ADVERSE_CLAIM_TYPES = new Set([
  "named_in_court_judgment", "named_in_sec_filing", "named_in_offshore_leak",
  "named_in_government_contract", "named_in_cbi_action",
  "linked_electoral_bond_purchase", "linked_electoral_bond_encashment", "news_allegation",
]);
export function detectMultiSourceAdverse(records = [], overrides = {}) {
  const { MULTI_SOURCE_MIN } = { ...LEDGER_DEFAULTS, ...overrides };
  const out = [];
  for (const r of records) {
    const nSources = r.sources?.size ?? 0;
    if (nSources < MULTI_SOURCE_MIN) continue;
    const signal_score = Math.min(6 * nSources, 40);
    const srcList = [...r.sources].join(", ");
    out.push({
      actor_id: r.politician_id, actor_name: r.name,
      vector: "MULTI_SOURCE_ADVERSE", instrument: "concentration of adverse mentions across independent sources",
      beneficiary: `${nSources} distinct sources`, beneficiary_kind: "cross_source",
      signal_score, severity: sev(signal_score),
      headline: `Named in ${nSources} independent adverse sources (${srcList}).`,
      detail: `This person's name appears across ${nSources} distinct source types — ${srcList}. Each individual mention is an unverified name match, but the concentration across independent datasets is a candidate for a journalist to verify identity and connect. Not a finding.`,
      detector_version: LEDGER_DETECTOR_VERSION, evidence_urls: [],
      data: { statistic: "distinct_adverse_sources", n_sources: nSources, sources: [...r.sources], claim_types: [...r.claim_types], evidence_ids: (r.evidence_ids ?? []).slice(0, 20) },
    });
  }
  return out;
}

// ── Loaders (read the facts ledger, keyed back to politicians) ────────────────
function politicianMap() {
  const m = new Map();
  for (const p of listPoliticians()) if (!p.is_demo) m.set(p.id, p);
  return m;
}

// Facts for one metric, joined back to the politician via the entity's strong id.
function factsByMetric(metric) {
  return db.prepare(`
    SELECT f.value, f.as_of_date, f.evidence_id, json_extract(e.strong_ids,'$.politician_id') pid
    FROM facts f JOIN entities e ON e.id = f.entity_id
    WHERE f.metric = ? AND json_extract(e.strong_ids,'$.politician_id') IS NOT NULL
  `).all(metric);
}

function loadIncomeRecords(pmap) {
  const out = [];
  for (const f of factsByMetric("declared_income")) {
    const p = pmap.get(f.pid);
    if (!p || f.value == null || f.as_of_date == null) continue;
    const year = Number(f.as_of_date);
    if (!Number.isFinite(year)) continue;
    out.push({ politician_id: p.id, name: p.name, cohort: p.state || p.party || "(none)", year, income: f.value, evidence_id: f.evidence_id });
  }
  return out;
}

function loadSpendVsIncomeRecords(pmap) {
  // Latest election_expenditure per politician.
  const spendByPol = new Map();
  for (const f of factsByMetric("election_expenditure")) {
    if (!pmap.has(f.pid) || f.value == null) continue;
    const cur = spendByPol.get(f.pid);
    if (!cur || String(f.as_of_date) > String(cur.as_of_date)) spendByPol.set(f.pid, f);
  }
  // Income per (politician, year) plus the latest income year, to match the spend year.
  const incomeByPolYear = new Map(); // pid → Map(year → {value, evidence_id})
  const latestIncome = new Map();    // pid → {year, value, evidence_id}
  for (const f of factsByMetric("declared_income")) {
    if (!pmap.has(f.pid) || f.value == null) continue;
    const y = String(f.as_of_date);
    (incomeByPolYear.get(f.pid) ?? incomeByPolYear.set(f.pid, new Map()).get(f.pid)).set(y, f);
    const li = latestIncome.get(f.pid);
    if (!li || y > String(li.as_of_date)) latestIncome.set(f.pid, f);
  }

  const out = [];
  for (const [pid, spend] of spendByPol) {
    const p = pmap.get(pid);
    const sy = String(spend.as_of_date);
    const inc = incomeByPolYear.get(pid)?.get(sy) ?? latestIncome.get(pid); // same-year income, else latest
    if (!inc) continue;
    out.push({
      politician_id: pid, name: p.name, cohort: p.state || p.party || "(none)",
      spend: spend.value, income: inc.value,
      spend_year: spend.as_of_date, income_year: inc.as_of_date,
      evidence_ids: [spend.evidence_id, inc.evidence_id].filter(Boolean),
    });
  }
  return out;
}

// Adverse claims per politician, grouped into the distinct source_types that named
// them — the substrate for cross-source corroboration.
function loadMultiSourceAdverse(pmap) {
  const adverse = [...ADVERSE_CLAIM_TYPES];
  const placeholders = adverse.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT c.source_type, c.claim_type, c.evidence_id, json_extract(e.strong_ids,'$.politician_id') pid
    FROM claims c JOIN entities e ON e.id = c.subject_entity_id
    WHERE c.claim_type IN (${placeholders}) AND json_extract(e.strong_ids,'$.politician_id') IS NOT NULL
  `).all(...adverse);
  const byPol = new Map();
  for (const r of rows) {
    const p = pmap.get(r.pid);
    if (!p) continue;
    const rec = byPol.get(r.pid) ?? byPol.set(r.pid, { politician_id: p.id, name: p.name, sources: new Set(), claim_types: new Set(), evidence_ids: [] }).get(r.pid);
    if (r.source_type) rec.sources.add(r.source_type);
    if (r.claim_type) rec.claim_types.add(r.claim_type);
    if (r.evidence_id) rec.evidence_ids.push(r.evidence_id);
  }
  return [...byPol.values()];
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
export function runLedgerDetectors({ log = console.log } = {}) {
  const pmap = politicianMap();
  const incomeRecords = loadIncomeRecords(pmap);
  const spendRecords = loadSpendVsIncomeRecords(pmap);
  const adverseRecords = loadMultiSourceAdverse(pmap);

  const incomeCandidates = detectIncomeGrowthOutliers(incomeRecords);
  const spendCandidates = detectSpendVsIncome(spendRecords);
  const adverseCandidates = detectMultiSourceAdverse(adverseRecords);

  const all = [...incomeCandidates, ...spendCandidates, ...adverseCandidates];
  for (const c of all) upsertLead(c);

  return {
    inputs: { income_facts: incomeRecords.length, spend_pairs: spendRecords.length, adverse_reps: adverseRecords.length },
    counts: {
      STAT_INCOME_OUTLIER: incomeCandidates.length,
      STAT_SPEND_VS_INCOME: spendCandidates.length,
      MULTI_SOURCE_ADVERSE: adverseCandidates.length,
    },
    upserted: all.length,
  };
}

const isMain = process.argv[1] && /[\\/]ledger-detectors\.js$/.test(process.argv[1]);
if (isMain) {
  const res = runLedgerDetectors();
  console.log(`\n[ledger-detectors] version: ${LEDGER_DETECTOR_VERSION}`);
  console.log("[ledger-detectors] inputs:", JSON.stringify(res.inputs));
  console.log("[ledger-detectors] candidates:", JSON.stringify(res.counts));
  console.log(`[ledger-detectors] total upserted: ${res.upserted}`);
}
