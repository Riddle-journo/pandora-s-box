// Robust statistics + plausibility bounds for outlier detectors.
//
// WHY THIS EXISTS
// ---------------
// Two failures found in the live MGNREGA wage data, which together produced
// leads that were pure data artefacts:
//
// 1. NO PLAUSIBILITY BOUND. 407 of 6,410 district wage rows carry impossible
//    values — the worst is ₹1,481,735 as an average DAILY wage. MGNREGA wage
//    rates are centrally notified per state and sit in the low hundreds of
//    rupees. A row like that is a broken extraction, not a scandal, and
//    reporting it as a finding is worse than useless: it burns the reader's
//    trust on something a moment's thought refutes.
//
// 2. MEAN AND STANDARD DEVIATION. Both are destroyed by the very outliers they
//    are meant to find. One ₹1.4M row dragged a month's cohort mean from about
//    ₹368 to ₹2,403 — which then MASKS the genuine outliers, because everything
//    real now sits close to a wildly inflated centre. The engine emitted
//    "26.9σ above the mean" about a number that was never a wage.
//
// The fix is standard practice and not novel: judge outliers with the MEDIAN and
// the MEDIAN ABSOLUTE DEVIATION, which a handful of absurd values cannot move,
// and refuse to score any value outside a declared plausible range at all.
//
// The rejected rows are COUNTED AND RETURNED, never silently dropped. A source
// that suddenly starts failing its plausibility band is an extractor breaking,
// and that is a thing an operator needs told — quietly discarding it would trade
// a visible bad lead for an invisible bad pipeline.

/** Middle value of a sorted copy. */
export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).slice().sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Scaling that makes MAD comparable to a standard deviation for normally
// distributed data, so a "3σ" threshold keeps roughly its usual meaning after
// the switch. (For a normal distribution, MAD ≈ 0.6745σ.)
const MAD_TO_SIGMA = 1.4826;

/** Value below which `p` of the sorted data falls (linear interpolation). */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Median and a robust estimate of spread.
 *
 * MAD is preferred, but it COLLAPSES TO ZERO whenever more than half the cohort
 * shares one value — and that is the normal case here, not an edge case:
 * MGNREGA wage rates are centrally notified, so most districts in a state
 * report the identical figure. A detector that goes silent exactly when the
 * baseline is tightest would miss the clearest outliers there are.
 *
 * So the scale falls back down a ladder, and reports which rung it used:
 *   mad  → the interquartile range → the plain standard deviation.
 *
 * Falling back to a plain standard deviation is safe HERE and only here,
 * because callers run `plausibilityFilter` first: the values that destroy a
 * standard deviation have already been removed as impossible. Robustness and a
 * hard bound do different jobs, and this module expects both to be used.
 *
 * @returns {{median, mad, sigma, n, method: "mad"|"iqr"|"stddev"|"none"}}
 */
export function medianMad(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  const med = median(a);
  if (med == null) return { median: null, mad: 0, sigma: 0, n: 0, method: "none" };

  const mad = median(a.map((x) => Math.abs(x - med))) ?? 0;
  if (mad > 0) return { median: med, mad, sigma: mad * MAD_TO_SIGMA, n: a.length, method: "mad" };

  const sorted = a.slice().sort((p, q) => p - q);
  // 1.349 is the interquartile range of a standard normal, so dividing by it
  // puts the IQR on the same scale as a standard deviation.
  const iqr = (quantile(sorted, 0.75) ?? 0) - (quantile(sorted, 0.25) ?? 0);
  if (iqr > 0) return { median: med, mad, sigma: iqr / 1.349, n: a.length, method: "iqr" };

  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / a.length);
  if (sd > 0) return { median: med, mad, sigma: sd, n: a.length, method: "stddev" };

  // Every value identical: genuinely nothing to be an outlier of.
  return { median: med, mad: 0, sigma: 0, n: a.length, method: "none" };
}

/**
 * Outlier score in standard-deviation-like units, measured from the MEDIAN.
 *
 * The centre is always the median — unlike the scale, it never collapses, and
 * it cannot be dragged by the outliers being looked for.
 *
 * Returns null when there is no dispersion at all, which is an honest answer
 * rather than a division by zero dressed up as infinite certainty.
 */
export function robustZ(value, { median: med, sigma }) {
  if (med == null || !(sigma > 0) || !Number.isFinite(value)) return null;
  return (value - med) / sigma;
}

/**
 * Split records into the plausible and the impossible, before any statistics
 * are computed over them.
 *
 * @param {Array} records
 * @param {(r:any)=>number|null|undefined} valueOf
 * @param {{min?: number, max?: number, label?: string}} bounds
 * @returns {{kept: Array, rejected: Array, summary: object}}
 */
export function plausibilityFilter(records = [], valueOf = (r) => r, bounds = {}) {
  const { min = -Infinity, max = Infinity, label = "value" } = bounds;
  const kept = [], rejected = [];
  for (const r of records) {
    const v = valueOf(r);
    if (v == null || !Number.isFinite(v)) { rejected.push({ record: r, value: v, reason: "not a number" }); continue; }
    if (v < min) { rejected.push({ record: r, value: v, reason: `below plausible ${label} minimum ${min}` }); continue; }
    if (v > max) { rejected.push({ record: r, value: v, reason: `above plausible ${label} maximum ${max}` }); continue; }
    kept.push(r);
  }
  return {
    kept, rejected,
    summary: {
      total: records.length, kept: kept.length, rejected: rejected.length,
      bounds: { min, max, label },
      // The worst offenders, so an operator can jump straight to the broken
      // extraction rather than going looking for it.
      worst: rejected
        .filter((x) => Number.isFinite(x.value))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 5)
        .map((x) => ({ value: x.value, reason: x.reason, name: x.record?.name ?? null, period: x.record?.period ?? null })),
    },
  };
}
