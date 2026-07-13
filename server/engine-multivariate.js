// Multivariate + time-series detectors — the "unusual COMBINATION" and "trajectory
// BROKE" signals that per-metric checks miss. Pure functions over prepared arrays
// (DB-free, unit-testable); engine.js wires them to the ledger and to flag output.
//
//   • mahalanobisOutliers — a rep unremarkable on every SINGLE metric but whose
//     whole vector is far from the cohort centre (robustified: standardise each
//     axis by median/MAD, then squared distance on the axes the rep actually has,
//     scaled by how many that is — so missing metrics neither help nor hurt).
//   • changePoints — the largest step-change in a per-subject time series (a mean
//     shift a consecutive-year ratio can't see), scored by shift magnitude × the
//     evidence on each side. Works on any series ≥ minPoints.

// ── shared robust stats ──────────────────────────────────────────────────────
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Signed-log so heavy-tailed money metrics sit on a comparable scale (same choice
// as generic_outlier — a rep 100× the median shouldn't dominate every axis).
export const slog = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v));

// ── a. Robust multivariate outlier ───────────────────────────────────────────
// rows: [{ id, name, cohort, metrics: { metricName: value, … } }]
// For each cohort with ≥ minCohort members: per metric, median + MAD over the
// members that HAVE it (in slog space); each member's per-axis robust z; the
// member's score is the MEAN of squared robust-z over its present axes — i.e. the
// average squared deviation across the profile. For roughly-normal data that mean
// is ~1, so a score of 4 means "≈2σ on every axis, on average" and 9 means "≈3σ" —
// thresholds that read directly as per-axis sigma and don't inflate with axis count
// (missing metrics neither help nor hurt; minAxes enforces that breadth exists).
export function mahalanobisOutliers(rows = [], { minCohort = 12, minAxes = 3, zSqFlag = 4, zSqBig = 9, zClamp = 6 } = {}) {
  const byCohort = new Map();
  for (const r of rows) (byCohort.get(r.cohort) ?? byCohort.set(r.cohort, []).get(r.cohort)).push(r);

  const out = [];
  for (const [cohort, members] of byCohort) {
    if (members.length < minCohort) continue;
    // Per-metric median/MAD over slog values present in this cohort.
    const axes = new Map(); // metric → { med, mad }
    const metricNames = new Set(members.flatMap((m) => Object.keys(m.metrics)));
    for (const metric of metricNames) {
      const vals = members.map((m) => m.metrics[metric]).filter((v) => v != null).map(slog);
      if (vals.length < minCohort) continue; // this axis too sparse in this cohort
      const med = median(vals);
      const mad = median(vals.map((v) => Math.abs(v - med)));
      if (mad > 0) axes.set(metric, { med, mad });
    }
    if (axes.size < minAxes) continue;

    for (const m of members) {
      const contribs = [];
      for (const [metric, { med, mad }] of axes) {
        const v = m.metrics[metric];
        if (v == null) continue;
        // Clamp per-axis z: count metrics that are mostly zero (e.g. criminal_cases)
        // give a tiny MAD, so one nonzero value would otherwise blow up the whole
        // profile score. Clamping keeps the signal "extreme on this axis" without
        // letting a single degenerate axis dominate the multivariate distance.
        const raw = 0.6745 * (slog(v) - med) / mad;
        const z = Math.max(-zClamp, Math.min(zClamp, raw));
        contribs.push({ metric, z, z2: z * z });
      }
      if (contribs.length < minAxes) continue;
      const meanSq = contribs.reduce((s, c) => s + c.z2, 0) / contribs.length; // avg squared per-axis σ
      if (meanSq < zSqFlag) continue;
      contribs.sort((a, b) => b.z2 - a.z2);
      out.push({
        id: m.id, name: m.name, cohort,
        score: meanSq, n_axes: contribs.length, cohort_n: members.length,
        top: contribs.slice(0, 5).map((c) => ({ metric: c.metric, z: c.z })),
        big: meanSq >= zSqBig,
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ── b. Change-point (single best split) ──────────────────────────────────────
// series: sorted [{ x, value, evidence_id }] for ONE subject+metric.
// Returns the split that maximises the standardised difference of means either
// side (a simple, robust 1-change-point test), or null if none clears minShift.
export function changePoint(series = [], { minPoints = 4, minShiftZ = 2 } = {}) {
  const pts = series.filter((p) => p.value != null).sort((a, b) => (a.x > b.x ? 1 : a.x < b.x ? -1 : 0));
  if (pts.length < minPoints) return null;
  const vals = pts.map((p) => slog(p.value));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  const whole = mean(vals), wholeSd = sd(vals, whole) || 1e-9;

  let best = null;
  // Split after index i (both sides need ≥2 points for a meaningful mean).
  for (let i = 1; i < pts.length - 1; i++) {
    const left = vals.slice(0, i + 1), right = vals.slice(i + 1);
    if (left.length < 2 || right.length < 2) continue;
    const lm = mean(left), rm = mean(right);
    const shiftZ = Math.abs(rm - lm) / wholeSd; // shift in whole-series std units
    if (!best || shiftZ > best.shiftZ) {
      best = {
        index: i, at: pts[i].x, next: pts[i + 1].x,
        left_mean: lm, right_mean: rm, shiftZ,
        direction: rm > lm ? "jump" : "drop",
        left_pts: left.length, right_pts: right.length,
        evidence_ids: [pts[i].evidence_id, pts[i + 1].evidence_id].filter(Boolean),
      };
    }
  }
  if (!best || best.shiftZ < minShiftZ) return null;
  return best;
}
