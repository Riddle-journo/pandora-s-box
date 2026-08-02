// Denominator anomaly detectors (Phase-0 open-data ledger). Sibling of
// ledger-detectors.js, but where THOSE detectors key leads on POLITICIANS, these
// key on the BASELINE subjects the open-data connectors ingest — districts and
// schemes (universal-subjects rule). They turn the match:"none" facts written by
// mega-ingest's ogd-resource kind (ogd-mgnrega-glance, ogd-scheme-expenditure) into
// governance-failure candidates:
//   • MGNREGA_WAGE_OUTLIER   — a district whose average wage rate is a cohort
//                              outlier for the month (over-reported wages / skim).
//   • MGNREGA_PAYMENT_DELAY   — a district paying wages late on material spend
//                              (funds parked/diverted; the 15-day mandate is law).
//   • SCHEME_OVERSPEND        — a scheme that spent well beyond its allocation.
//
// Same shape + funnel as ledger-detectors: pure detectors over prepared arrays
// (DB-free tests), thin loaders that read the facts ledger, one orchestrator that
// touches the store. Every lead is a CANDIDATE (status 'detected'), keyed on the
// subject ENTITY (actor_id = entity_id → upsertLead stores it, fromLegacy routes it
// to a non-politician actor). A statistical outlier is a lead to verify, never a
// finding.
import { db, upsertLead } from "../store/store.js";

export const DENOM_DETECTOR_VERSION = "denominator-detector-v1";

export const DENOM_DEFAULTS = {
  // Wage-rate cohort outlier (per fin_year+month across districts).
  WAGE_MIN_COHORT_N: 12,   // need this many districts in a month for a stable z-score
  WAGE_Z_MIN: 3,           // flag wage rate this many std-devs above the month's mean
  WAGE_ABS_MIN: 200,       // …and only if the rate itself is ≥ ₹200/day (noise floor)
  // Payment-delay (the MGNREGA 15-day wage mandate).
  PCT_PAID_MAX: 50,        // flag districts paying ≤ this % of wages within 15 days
  DELAY_EXP_MIN: 100,      // …only when expenditure is material (≥ ₹100 lakh), so a
                           //   tiny-spend district with a bad ratio isn't noise
  // Scheme over-spend (expenditure vs allocation).
  OVERSPEND_RATIO_MIN: 1.15, // spent ≥ 1.15× the allocation
  OVERSPEND_ABS_MIN: 50,     // …and the overspend is ≥ 50 (crore, the source's unit)
  // Procurement above prevailing market (mandi) price.
  PROC_RATIO_MIN: 1.5,       // paid ≥ 1.5× the commodity's median mandi modal price
  PROC_BASELINE_MIN_N: 3,    // need ≥ this many mandi quotes for a trustworthy baseline
};

const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");
function meanStd(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

// ── a. MGNREGA_WAGE_OUTLIER — cohort-relative average-wage-rate spikes ─────────
// records: [{ entity_id, name, period, wage_rate, total_exp }]. Cohort = period
// (fin_year-month): compare each district's declared average daily wage against all
// districts reporting that month. A statewide wage rate is centrally notified, so a
// district far above the pack is a candidate for over-reported muster/wage figures.
export function detectMgnregaWageOutliers(records = [], overrides = {}) {
  const { WAGE_MIN_COHORT_N, WAGE_Z_MIN, WAGE_ABS_MIN } = { ...DENOM_DEFAULTS, ...overrides };
  const byPeriod = new Map();
  for (const r of records) {
    if (r.wage_rate == null || !r.period) continue;
    (byPeriod.get(r.period) ?? byPeriod.set(r.period, []).get(r.period)).push(r);
  }
  const out = [];
  for (const [period, rows] of byPeriod) {
    if (rows.length < WAGE_MIN_COHORT_N) continue;
    const { mean, std } = meanStd(rows.map((r) => r.wage_rate));
    if (std === 0) continue;
    for (const r of rows) {
      const z = (r.wage_rate - mean) / std;
      if (z < WAGE_Z_MIN || r.wage_rate < WAGE_ABS_MIN) continue;
      const signal_score = Math.min(Math.round(z * 6), 40);
      out.push({
        actor_id: r.entity_id, actor_name: r.name,
        vector: "MGNREGA_WAGE_OUTLIER", instrument: "average MGNREGA wage rate vs same-month district cohort",
        beneficiary: `wage rate ${period}`, beneficiary_kind: "district",
        signal_score, severity: sev(signal_score),
        headline: `${r.name}: MGNREGA average wage ₹${r.wage_rate.toFixed(0)}/day in ${period} is ${z.toFixed(1)}σ above the national district mean (₹${mean.toFixed(0)}).`,
        detail: `Average daily wage ₹${r.wage_rate.toFixed(1)} vs the ${period} district-cohort mean ₹${mean.toFixed(1)} (std ₹${std.toFixed(1)}, n=${rows.length}) → z=${z.toFixed(2)}. Wage rates are centrally notified per state, so a large positive outlier is a candidate for over-reported wage/muster figures — verify against the state's notified rate, not a finding.`,
        detector_version: DENOM_DETECTOR_VERSION, evidence_urls: [],
        data: { statistic: "wage_rate_zscore", period, wage_rate: r.wage_rate, cohort_mean: mean, cohort_std: std, cohort_n: rows.length, z, source: "ogd-mgnrega-glance" },
      });
    }
  }
  return out;
}

// ── b. MGNREGA_PAYMENT_DELAY — late wage payment on material spend ─────────────
// records: [{ entity_id, name, period, pct_paid_15d, total_exp }]. The Act mandates
// wages within 15 days; a district paying a low share on time while spending heavily
// is a funds-flow red flag (money released but parked/diverted downstream).
export function detectMgnregaPaymentDelay(records = [], overrides = {}) {
  const { PCT_PAID_MAX, DELAY_EXP_MIN } = { ...DENOM_DEFAULTS, ...overrides };
  const out = [];
  for (const r of records) {
    if (r.pct_paid_15d == null || r.total_exp == null) continue;
    if (r.pct_paid_15d > PCT_PAID_MAX || r.total_exp < DELAY_EXP_MIN) continue;
    // Worse (lower %) + bigger spend → higher score.
    const shortfall = PCT_PAID_MAX - r.pct_paid_15d;             // 0..PCT_PAID_MAX
    const signal_score = Math.min(Math.round(shortfall / 2) + Math.min(Math.round(r.total_exp / 200), 15), 40);
    out.push({
      actor_id: r.entity_id, actor_name: r.name,
      vector: "MGNREGA_PAYMENT_DELAY", instrument: "share of MGNREGA wages paid within the 15-day mandate",
      beneficiary: `late wages ${r.period}`, beneficiary_kind: "district",
      signal_score, severity: sev(signal_score),
      headline: `${r.name}: only ${r.pct_paid_15d.toFixed(0)}% of MGNREGA wages paid within 15 days in ${r.period} on ₹${r.total_exp.toFixed(0)} lakh spend.`,
      detail: `The MGNREGA Act mandates wage payment within 15 days. This district paid just ${r.pct_paid_15d.toFixed(1)}% on time while booking ₹${r.total_exp.toFixed(1)} lakh of expenditure in ${r.period} — a candidate for a funds-parked/diverted or muster-manipulation review, not a finding.`,
      detector_version: DENOM_DETECTOR_VERSION, evidence_urls: [],
      data: { statistic: "pct_paid_within_15d", period: r.period, pct_paid_15d: r.pct_paid_15d, total_exp: r.total_exp, source: "ogd-mgnrega-glance" },
    });
  }
  return out;
}

// ── c. SCHEME_OVERSPEND — expenditure beyond allocation ───────────────────────
// records: [{ entity_id, name, period, allocated, expenditure }]. Spending well
// past the sanctioned allocation implies re-appropriation/diversion worth a look.
export function detectSchemeOverspend(records = [], overrides = {}) {
  const { OVERSPEND_RATIO_MIN, OVERSPEND_ABS_MIN } = { ...DENOM_DEFAULTS, ...overrides };
  const out = [];
  for (const r of records) {
    if (!r.allocated || r.allocated <= 0 || r.expenditure == null) continue;
    const ratio = r.expenditure / r.allocated;
    const over = r.expenditure - r.allocated;
    if (ratio < OVERSPEND_RATIO_MIN || over < OVERSPEND_ABS_MIN) continue;
    const signal_score = Math.min(Math.round((ratio - 1) * 30) + Math.min(Math.round(over / 100), 12), 40);
    out.push({
      actor_id: r.entity_id, actor_name: r.name,
      vector: "SCHEME_OVERSPEND", instrument: "scheme expenditure vs sanctioned allocation",
      beneficiary: `overspend ${r.period ?? ""}`.trim(), beneficiary_kind: "scheme",
      signal_score, severity: sev(signal_score),
      headline: `${r.name}: spent ${ratio.toFixed(2)}× its allocation (₹${r.expenditure.toFixed(0)} vs ₹${r.allocated.toFixed(0)} cr) in ${r.period ?? "period"}.`,
      detail: `Expenditure ₹${r.expenditure.toFixed(1)} cr against a sanctioned allocation of ₹${r.allocated.toFixed(1)} cr (${ratio.toFixed(2)}× / ₹${over.toFixed(1)} cr over) in ${r.period ?? "the period"}. Large overspend implies re-appropriation or diversion worth tracing — a candidate for review, not a finding.`,
      detector_version: DENOM_DETECTOR_VERSION, evidence_urls: [],
      data: { statistic: "expenditure_over_allocation", period: r.period ?? null, allocated: r.allocated, expenditure: r.expenditure, ratio, over, source: "ogd-scheme-expenditure" },
    });
  }
  return out;
}

// ── d. PROCUREMENT_ABOVE_MARKET — purchase price vs mandi baseline ────────────
// The cross-source payoff of the mandi denominator: a government purchase booked
// well above the prevailing market (mandi) modal price for the same commodity is a
// classic over-invoicing / kickback signal. procRecords: [{ entity_id, name,
// commodity, unit_price, period }]. baseline: Map(normCommodity → { median, n }).
export function detectProcurementAboveMarket(procRecords = [], baseline = new Map(), overrides = {}) {
  const { PROC_RATIO_MIN, PROC_BASELINE_MIN_N } = { ...DENOM_DEFAULTS, ...overrides };
  const out = [];
  for (const r of procRecords) {
    if (r.unit_price == null || !r.commodity) continue;
    const b = baseline.get(normCommodity(r.commodity));
    if (!b || b.n < PROC_BASELINE_MIN_N || !b.median) continue;
    const ratio = r.unit_price / b.median;
    if (ratio < PROC_RATIO_MIN) continue;
    const signal_score = Math.min(Math.round((ratio - 1) * 20) + 6, 40);
    out.push({
      actor_id: r.entity_id, actor_name: r.name,
      vector: "PROCUREMENT_ABOVE_MARKET", instrument: "government purchase price vs prevailing mandi modal price",
      beneficiary: `${r.commodity} ${r.period ?? ""}`.trim(), beneficiary_kind: "procurement",
      signal_score, severity: sev(signal_score),
      headline: `${r.name || r.commodity}: purchased ${r.commodity} at ₹${r.unit_price.toFixed(0)} vs a mandi modal median of ₹${b.median.toFixed(0)} (${ratio.toFixed(1)}×).`,
      detail: `A government purchase of ${r.commodity}${r.period ? ` (${r.period})` : ""} at ₹${r.unit_price.toFixed(1)} against the prevailing mandi modal-price median of ₹${b.median.toFixed(1)} (from ${b.n} market quotes) — a ${ratio.toFixed(2)}× markup. Above-market procurement is a candidate for over-invoicing/kickback review, not a finding (grade, transport, timing can explain part of a gap).`,
      detector_version: DENOM_DETECTOR_VERSION, evidence_urls: [],
      data: { statistic: "procurement_vs_mandi_ratio", commodity: r.commodity, unit_price: r.unit_price, mandi_median: b.median, mandi_n: b.n, ratio, period: r.period ?? null, source: "cross:ogd-mandi-prices" },
    });
  }
  return out;
}

const normCommodity = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Loaders (read the facts ledger by subject_kind + metric) ──────────────────
// One row per (entity, period) with the metrics pivoted into columns, so a detector
// sees a district-month (or scheme-period) as a single record.
function pivotFacts(subjectKind, metricToCol) {
  const metrics = Object.keys(metricToCol);
  const placeholders = metrics.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT f.entity_id, e.canonical_name AS name, f.metric, f.value, f.as_of_date AS period
    FROM facts f JOIN entities e ON e.id = f.entity_id
    WHERE f.subject_kind = ? AND f.metric IN (${placeholders})
  `).all(subjectKind, ...metrics);
  const by = new Map();
  for (const r of rows) {
    const key = `${r.entity_id}|${r.period}`;
    const rec = by.get(key) ?? by.set(key, { entity_id: r.entity_id, name: r.name, period: r.period }).get(key);
    rec[metricToCol[r.metric]] = r.value;
  }
  return [...by.values()];
}

export function loadMgnregaRecords() {
  return pivotFacts("district", {
    mgnrega_avg_wage_rate: "wage_rate",
    mgnrega_total_expenditure: "total_exp",
    mgnrega_pct_paid_15d: "pct_paid_15d",
    mgnrega_active_job_cards: "active_job_cards",
    mgnrega_active_workers: "active_workers",
  });
}

export function loadSchemeRecords() {
  return pivotFacts("scheme", {
    scheme_allocated_fund: "allocated",
    scheme_expenditure: "expenditure",
  });
}

// Median mandi modal price per commodity, from the ogd-mandi-prices facts. The mandi
// entity name is "State / District / Market / Commodity / Variety / Grade" — index 3
// is the commodity. Returns Map(normCommodity → { median, n }).
export function loadMandiBaseline() {
  const rows = db.prepare(`
    SELECT e.canonical_name AS name, f.value
    FROM facts f JOIN entities e ON e.id = f.entity_id
    WHERE f.subject_kind = 'market_commodity' AND f.metric = 'mandi_modal_price' AND f.value IS NOT NULL
  `).all();
  const byCommodity = new Map();
  for (const r of rows) {
    const commodity = String(r.name).split(" / ")[3];
    if (!commodity) continue;
    const k = normCommodity(commodity);
    (byCommodity.get(k) ?? byCommodity.set(k, []).get(k)).push(r.value);
  }
  const out = new Map();
  for (const [k, vals] of byCommodity) out.set(k, { median: median(vals), n: vals.length });
  return out;
}

// Government purchase unit-prices from the ledger. Populated once a procurement
// source writes `procurement_unit_price` facts (subject_kind 'procurement', with
// data.commodity). Empty until then — the detector simply produces nothing.
export function loadProcurementRecords() {
  const rows = db.prepare(`
    SELECT f.entity_id, e.canonical_name AS name, f.value, f.as_of_date AS period, f.data
    FROM facts f JOIN entities e ON e.id = f.entity_id
    WHERE f.subject_kind = 'procurement' AND f.metric = 'procurement_unit_price' AND f.value IS NOT NULL
  `).all();
  const out = [];
  for (const r of rows) {
    let commodity = null;
    try { commodity = JSON.parse(r.data || "{}").commodity ?? null; } catch { /* ignore */ }
    if (!commodity) commodity = String(r.name).split(" / ").pop();
    out.push({ entity_id: r.entity_id, name: r.name, commodity, unit_price: r.value, period: r.period });
  }
  return out;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
export function runDenominatorDetectors({ log = console.log } = {}) {
  const mgnrega = loadMgnregaRecords();
  const scheme = loadSchemeRecords();
  const procurement = loadProcurementRecords();
  const mandiBaseline = loadMandiBaseline();

  const wage = detectMgnregaWageOutliers(mgnrega);
  const delay = detectMgnregaPaymentDelay(mgnrega);
  const overspend = detectSchemeOverspend(scheme);
  const priced = detectProcurementAboveMarket(procurement, mandiBaseline);

  const all = [...wage, ...delay, ...overspend, ...priced];
  for (const c of all) upsertLead(c);

  return {
    inputs: {
      mgnrega_district_months: mgnrega.length, scheme_periods: scheme.length,
      procurement_rows: procurement.length, mandi_commodities: mandiBaseline.size,
    },
    counts: {
      MGNREGA_WAGE_OUTLIER: wage.length,
      MGNREGA_PAYMENT_DELAY: delay.length,
      SCHEME_OVERSPEND: overspend.length,
      PROCUREMENT_ABOVE_MARKET: priced.length,
    },
    upserted: all.length,
  };
}

const isMain = process.argv[1] && /[\\/]denominator-detectors\.js$/.test(process.argv[1]);
if (isMain) {
  const res = runDenominatorDetectors();
  console.log(`\n[denominator-detectors] version: ${DENOM_DETECTOR_VERSION}`);
  console.log("[denominator-detectors] inputs:", JSON.stringify(res.inputs));
  console.log("[denominator-detectors] candidates:", JSON.stringify(res.counts));
  console.log(`[denominator-detectors] total upserted: ${res.upserted}`);
}
