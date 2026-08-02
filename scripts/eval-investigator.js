// Investigation-quality EVAL HARNESS — scores the AI Investigator's verdicts
// against human labels (eval/labels.jsonl, produced by scripts/label-leads.js).
//
// WHY: 491 unit tests prove the code runs. None of them can tell you whether the
// investigator is RIGHT. Without this, a prompt edit or a model swap is a blind
// bet. The artifact that matters most here is the CALIBRATION table: it is the
// only thing that says whether the model's confidence numbers mean anything.
//
// MODES
//   --stored  (default) score the verdicts ALREADY in the DB. Zero cost, zero
//             LLM calls, read-only. Run this on every prompt change.
//   --live    re-investigate the labelled leads with the CURRENT prompts/model.
//             Costs money AND writes to the DB (investigateLead upserts the lead,
//             records evidence and feedback), so it is gated three ways: --live,
//             --confirm-spend, and a database that is NOT data/pandoros.db —
//             compared as resolved absolute paths, so pointing PANDOROS_DB_PATH at
//             the live file does not sneak past the gate. Use a COPY
//             (npm run db:backup), or pass --allow-live-db to mean it.
//
// SCORING DEFINITIONS (also in eval/README.md — keep them in step)
//   ground truth  true_positive | false_positive | undecidable (excluded from
//                 every rate, but always COUNTED so exclusions stay visible).
//   prediction    the verdict tier: SUBSTANTIATED | SUGGESTIVE | COINCIDENCE.
//   tier precision  of leads predicted at tier T, the share labelled true_positive.
//   tier recall     of all labelled true_positives that got a prediction, the
//                   share predicted at tier T.
//   GATE            the operationally meaningful binary view: a verdict of
//                   SUBSTANTIATED or SUGGESTIVE surfaces the lead to a human
//                   (status 'proposed'); COINCIDENCE buries it. Gate precision is
//                   "how much of the human's queue is real", gate recall is "how
//                   much real material the referee threw away".
//   claim probability  confidence is stated with respect to the VERDICT, not the
//                   allegation: 0.9 on COINCIDENCE means "confidently innocent".
//                   Calibration therefore uses P(adverse claim is real) =
//                   confidence for SUBSTANTIATED/SUGGESTIVE, 1 - confidence for
//                   COINCIDENCE. Without this flip the table is meaningless.
//
// SMALL SAMPLES: every rate carries its numerator and denominator, and anything
// under --min-sample (default 5) is reported as insufficient data instead of a
// percentage. A "100% precision" over n=1 is a lie told with arithmetic.
//
// USAGE
//   node scripts/eval-investigator.js                       score stored verdicts
//   node scripts/eval-investigator.js --min-sample 3 --json
//   node scripts/eval-investigator.js --no-save             don't persist a run
//   node scripts/eval-investigator.js --live --confirm-spend --max-leads 10
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  EVAL_DIR, DEFAULT_LABELS_PATH, VERDICT_TIERS, LIVE_DB_PATH,
  parseArgs, numFlag, reportFatal, openReadOnly, dbPath, samePath, loadLead, readLabels,
  detectorsForLead, investigationOf, normalizeConfidence, isAmbiguousConfidenceScale,
} from "./label-leads.js";

export const RUNS_DIR = path.join(EVAL_DIR, "runs");
export const GATE_POSITIVE_TIERS = ["SUBSTANTIATED", "SUGGESTIVE"];
export const DEFAULT_MIN_SAMPLE = 5;
export const CALIBRATION_BUCKETS = [
  [0.0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0],
];

// ---- rate arithmetic --------------------------------------------------------
/**
 * A rate that refuses to lie: null value when there is nothing to divide by, and
 * an explicit `insufficient` flag under the sample floor.
 * @param {number} num @param {number} den @param {number} minSample
 */
export function rate(num, den, minSample = DEFAULT_MIN_SAMPLE) {
  const value = den > 0 ? num / den : null;
  return { value, num, den, insufficient: den < minSample };
}

export function f1(precision, recall) {
  const p = precision?.value, r = recall?.value;
  if (p == null || r == null || p + r === 0) return null;
  return (2 * p * r) / (p + r);
}

/** Confidence re-expressed as P(the adverse claim is real). See header. */
export function claimProbability(verdict, confidence) {
  const c = normalizeConfidence(confidence);
  if (c == null) return null;
  return String(verdict ?? "").toUpperCase() === "COINCIDENCE" ? 1 - c : c;
}

export function bucketOf(p, buckets = CALIBRATION_BUCKETS) {
  if (p == null || !Number.isFinite(p)) return -1;
  for (let i = 0; i < buckets.length; i++) {
    const [lo, hi] = buckets[i];
    if (p >= lo && (p < hi || (i === buckets.length - 1 && p <= hi))) return i;
  }
  return -1;
}

const bucketLabel = ([lo, hi]) => `${lo.toFixed(1)}–${hi.toFixed(1)}`;

// ---- pair construction ------------------------------------------------------
/**
 * One row per label: the human verdict beside the machine verdict.
 * `missing_lead` means the lead row is gone — only a deliberate purge
 * (deleteLead) does that now, since rejecting a lead soft-deletes it
 * (status:'rejected') precisely so its label keeps something to score against.
 * Still reported rather than silently dropped: a missing row means the label is
 * unscoreable, which is a data-quality fact the run should surface.
 */
export function makePair(labelRec, lead, { resolvedBy = null } = {}) {
  const inv = lead ? investigationOf(lead) : null;
  const verdictRaw = inv?.verdict ? String(inv.verdict).toUpperCase() : null;
  const verdict = VERDICT_TIERS.includes(verdictRaw) ? verdictRaw : null;
  // A non-array `detectors` (hand-edited labels.jsonl) would iterate by CHARACTER
  // in scoreDetectors and invent one "detector" per letter. readLabels rejects it
  // at parse time; this is the belt to that braces for direct callers.
  const labelDetectors = Array.isArray(labelRec.detectors) ? labelRec.detectors.map(String) : [];
  return {
    lead_id: labelRec.lead_id,
    lead_key: lead?.key ?? labelRec.lead_key ?? null,
    // Which identifier found the lead: "lead_key" means the id in the label is
    // stale (the lead was purged and re-detected), which the audit trail should say.
    resolved_by: lead ? (resolvedBy ?? "lead_id") : null,
    label: labelRec.label,
    labeler: labelRec.labeler ?? null,
    vector: lead?.vector ?? labelRec.vector ?? null,
    detectors: lead ? detectorsForLead(lead) : labelDetectors,
    verdict,
    unknown_verdict: verdictRaw && !verdict ? verdictRaw : null,
    confidence: normalizeConfidence(inv?.confidence),
    claim_probability: verdict ? claimProbability(verdict, inv?.confidence) : null,
    // The model stated a bare number on no stated scale and we guessed percent.
    ambiguous_confidence_scale: verdict ? isAmbiguousConfidenceScale(inv?.confidence) : false,
    model: inv?.model ?? null,
    investigated_at: inv?.investigated_at ?? null,
    missing_lead: !lead,
  };
}

const isDecided = (p) => p.label === "true_positive" || p.label === "false_positive";
const isTP = (p) => p.label === "true_positive";

// ---- metrics ----------------------------------------------------------------
export function counts(pairs) {
  const withPrediction = pairs.filter((p) => p.verdict);
  return {
    labels_total: pairs.length,
    true_positive: pairs.filter((p) => p.label === "true_positive").length,
    false_positive: pairs.filter((p) => p.label === "false_positive").length,
    undecidable: pairs.filter((p) => p.label === "undecidable").length,
    missing_lead: pairs.filter((p) => p.missing_lead).length,
    key_resolved: pairs.filter((p) => p.resolved_by === "lead_key").length,
    no_verdict: pairs.filter((p) => !p.verdict).length,
    scoreable: withPrediction.filter(isDecided).length,
    // Confidences where percent-vs-1-to-10 was a GUESS. Counted, never hidden:
    // one 1–10-scale model would silently invert the whole calibration table.
    ambiguous_confidence_scale: pairs.filter((p) => p.ambiguous_confidence_scale).length,
    unknown_verdicts: [...new Set(pairs.map((p) => p.unknown_verdict).filter(Boolean))],
  };
}

/** Per-tier precision + recall over decided, predicted pairs. */
export function scoreTiers(pairs, { minSample = DEFAULT_MIN_SAMPLE } = {}) {
  const scoreable = pairs.filter((p) => p.verdict && isDecided(p));
  const totalTP = scoreable.filter(isTP).length;
  return VERDICT_TIERS.map((tier) => {
    const atTier = pairs.filter((p) => p.verdict === tier);
    const decided = atTier.filter(isDecided);
    const tp = decided.filter(isTP).length;
    const fp = decided.length - tp;
    return {
      tier,
      predicted: atTier.length,
      undecidable: atTier.length - decided.length,
      true_positive: tp,
      false_positive: fp,
      precision: rate(tp, decided.length, minSample),
      recall: rate(tp, totalTP, minSample),
    };
  });
}

/** The referee gate as a binary classifier — the number the owner acts on. */
export function scoreGate(pairs, { minSample = DEFAULT_MIN_SAMPLE } = {}) {
  const scoreable = pairs.filter((p) => p.verdict && isDecided(p));
  const pos = (p) => GATE_POSITIVE_TIERS.includes(p.verdict);
  const tp = scoreable.filter((p) => pos(p) && isTP(p)).length;
  const fp = scoreable.filter((p) => pos(p) && !isTP(p)).length;
  const fn = scoreable.filter((p) => !pos(p) && isTP(p)).length;
  const tn = scoreable.filter((p) => !pos(p) && !isTP(p)).length;
  const precision = rate(tp, tp + fp, minSample);
  const recall = rate(tp, tp + fn, minSample);
  return {
    positive_tiers: GATE_POSITIVE_TIERS,
    confusion: { tp, fp, fn, tn },
    precision, recall,
    f1: f1(precision, recall),
    // f1 is a bare number with no counts of its own, so it inherits the honesty
    // guard from its inputs: an f1 built on an insufficient precision or recall is
    // just as unquotable as they are, and printing "1.00" off n=2 was the single
    // most misleading line in the report.
    f1_insufficient: !!(precision.insufficient || recall.insufficient),
    accuracy: rate(tp + tn, scoreable.length, minSample),
  };
}

/**
 * Confidence calibration: predicted P(claim real) bucket → observed precision.
 * `gap` is observed minus mean predicted — negative means over-confident, which
 * is the failure mode that gets an accountability platform sued.
 */
export function calibration(pairs, { minSample = DEFAULT_MIN_SAMPLE, buckets = CALIBRATION_BUCKETS } = {}) {
  const rows = buckets.map((b) => ({
    range: bucketLabel(b), lo: b[0], hi: b[1],
    n: 0, decided: 0, true_positive: 0, false_positive: 0, undecidable: 0,
    sum_predicted: 0, verdict_mix: {},
  }));
  let unbucketed = 0;
  for (const p of pairs) {
    if (!p.verdict) continue;
    const i = bucketOf(p.claim_probability, buckets);
    if (i < 0) { unbucketed++; continue; }
    const r = rows[i];
    r.n++;
    r.verdict_mix[p.verdict] = (r.verdict_mix[p.verdict] ?? 0) + 1;
    if (!isDecided(p)) { r.undecidable++; continue; }
    r.decided++;
    r.sum_predicted += p.claim_probability;
    if (isTP(p)) r.true_positive++; else r.false_positive++;
  }
  const table = rows.map((r) => {
    const observed = rate(r.true_positive, r.decided, minSample);
    const mean_predicted = r.decided > 0 ? r.sum_predicted / r.decided : null;
    return {
      range: r.range, n: r.n, decided: r.decided,
      true_positive: r.true_positive, false_positive: r.false_positive,
      undecidable: r.undecidable, verdict_mix: r.verdict_mix,
      mean_predicted, observed_precision: observed,
      gap: observed.value != null && mean_predicted != null && !observed.insufficient
        ? observed.value - mean_predicted : null,
    };
  });
  // ECE weights each bucket by its decided count; withheld entirely when the
  // whole sample is below the floor, since a 2-lead ECE is noise with a name.
  const totalDecided = table.reduce((a, r) => a + r.decided, 0);
  const ece = totalDecided >= minSample
    ? table.reduce((a, r) => (r.decided && r.observed_precision.value != null && r.mean_predicted != null
      ? a + (r.decided / totalDecided) * Math.abs(r.observed_precision.value - r.mean_predicted) : a), 0)
    : null;
  return { buckets: table, unbucketed, decided: totalDecided, expected_calibration_error: ece };
}

/**
 * Per-detector precision — which detectors generate noise. A lead attributed to
 * several detectors counts once for EACH, exactly as store/content.js's
 * detectorPrecision does, so the two reports are comparable.
 */
export function scoreDetectors(pairs, { minSample = DEFAULT_MIN_SAMPLE } = {}) {
  const by = {};
  for (const p of pairs) {
    for (const d of (p.detectors.length ? p.detectors : ["(unattributed)"])) {
      const row = (by[d] ??= { detector: d, labelled: 0, true_positive: 0, false_positive: 0, undecidable: 0, predicted: 0, gate_positive: 0 });
      row.labelled++;
      if (p.verdict) row.predicted++;
      if (p.verdict && GATE_POSITIVE_TIERS.includes(p.verdict)) row.gate_positive++;
      if (p.label === "true_positive") row.true_positive++;
      else if (p.label === "false_positive") row.false_positive++;
      else row.undecidable++;
    }
  }
  return Object.values(by).map((r) => {
    const decided = r.true_positive + r.false_positive;
    return { ...r, decided, precision: rate(r.true_positive, decided, minSample) };
  }).sort((a, b) => (b.labelled - a.labelled) || a.detector.localeCompare(b.detector));
}

// ---- run assembly, persistence, delta ---------------------------------------
export function buildRun(pairs, { mode = "stored", minSample = DEFAULT_MIN_SAMPLE, labelsPath = null, model = null, extra = {} } = {}) {
  return {
    schema: 1,
    at: new Date().toISOString(),
    mode, min_sample: minSample,
    labels_path: labelsPath, db_path: dbPath(), model,
    counts: counts(pairs),
    gate: scoreGate(pairs, { minSample }),
    tiers: scoreTiers(pairs, { minSample }),
    calibration: calibration(pairs, { minSample }),
    detectors: scoreDetectors(pairs, { minSample }),
    ...extra,
  };
}

/**
 * Headline metrics WITH their numerator, denominator and insufficiency flag.
 *
 * The delta section is the one part of the report an operator reads to decide
 * whether a prompt change helped, so it is the last place that may print a bare
 * percentage: a "+50 points of precision" off two labels is exactly the blind bet
 * this harness exists to prevent. Everything downstream (the delta renderer)
 * carries these counts through.
 */
export function headlineMetricDetails(run) {
  const fromRate = (r) => ({ value: r?.value ?? null, num: r?.num ?? null, den: r?.den ?? null, insufficient: !!r?.insufficient });
  const plain = (v, insufficient = false) => ({ value: v ?? null, num: null, den: null, insufficient });
  const minSample = run?.min_sample ?? DEFAULT_MIN_SAMPLE;
  const eceDecided = run?.calibration?.decided ?? 0;
  const m = {
    "labels.total": plain(run?.counts?.labels_total),
    "labels.scoreable": plain(run?.counts?.scoreable),
    "gate.precision": fromRate(run?.gate?.precision),
    "gate.recall": fromRate(run?.gate?.recall),
    "gate.f1": plain(run?.gate?.f1, !!run?.gate?.f1_insufficient),
    "calibration.ece": plain(run?.calibration?.expected_calibration_error, eceDecided < minSample),
  };
  for (const t of run?.tiers ?? []) m[`tier.${t.tier}.precision`] = fromRate(t.precision);
  return m;
}

/** Flat metric map (values only) — the shape the delta arithmetic compares. */
export function headlineMetrics(run) {
  return Object.fromEntries(Object.entries(headlineMetricDetails(run)).map(([k, v]) => [k, v.value]));
}

export function deltaAgainst(previous, current) {
  if (!previous) return { previous_run: null, changes: [], note: "no previous run to compare against — this is the baseline." };
  const a = headlineMetricDetails(previous), b = headlineMetricDetails(current);
  const changes = [];
  for (const k of Object.keys(b)) {
    const fromDetail = a[k] ?? { value: null, num: null, den: null, insufficient: false };
    const toDetail = b[k];
    const from = fromDetail.value ?? null, to = toDetail.value ?? null;
    if (from === to) continue;
    changes.push({
      metric: k, from, to,
      delta: typeof from === "number" && typeof to === "number" ? to - from : null,
      from_detail: fromDetail, to_detail: toDetail,
      // True when EITHER side is below the sample floor. A delta between two thin
      // numbers is thinner than both of them.
      insufficient: !!(fromDetail.insufficient || toDetail.insufficient),
    });
  }
  return { previous_run: previous.at ?? null, previous_mode: previous.mode ?? null, changes };
}

/** Newest saved run, excluding a filename (so a just-written run isn't its own baseline). */
export function findPreviousRun(dir = RUNS_DIR, excludeFile = null) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); }
  catch (err) { if (err.code !== "ENOENT") throw err; return null; }
  names.sort();
  for (let i = names.length - 1; i >= 0; i--) {
    const full = path.join(dir, names[i]);
    if (excludeFile && path.resolve(full) === path.resolve(excludeFile)) continue;
    try { return JSON.parse(fs.readFileSync(full, "utf8")); }
    catch { /* a corrupt run file must not block a new run; the next-newest wins */ }
  }
  return null;
}

export function runFilename(at = new Date().toISOString()) {
  return `${at.replace(/[:.]/g, "-")}.json`; // ':' is illegal in Windows filenames
}

export function saveRun(run, dir = RUNS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, runFilename(run.at));
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n", "utf8");
  return file;
}

// ---- human-readable summary -------------------------------------------------
const pct = (r) => {
  if (!r) return "n/a";
  if (r.value == null) return `insufficient data (n=0)`;
  const body = `${(r.value * 100).toFixed(0)}% (${r.num}/${r.den})`;
  return r.insufficient ? `${body} — INSUFFICIENT DATA` : body;
};
const num = (x, digits = 2) => (typeof x === "number" ? x.toFixed(digits) : "n/a");

/**
 * One side of a delta, printed with whatever counts it has and marked when it is
 * below the floor. Never a bare percentage.
 */
export function fmtMetric(detail) {
  if (!detail || detail.value == null) return "n/a";
  const v = detail.value;
  const body = detail.den != null
    ? `${(v * 100).toFixed(0)}% (${detail.num}/${detail.den})`
    : (Number.isInteger(v) ? String(v) : v.toFixed(3));
  return detail.insufficient ? `${body} [INSUFFICIENT]` : body;
}

export function renderSummary(run) {
  const L = [];
  const c = run.counts;
  L.push(`INVESTIGATION EVAL — mode=${run.mode}  at=${run.at}  min-sample=${run.min_sample}`);
  L.push(`db=${run.db_path}`);
  L.push(`labels ${c.labels_total} (tp ${c.true_positive} / fp ${c.false_positive} / undecidable ${c.undecidable})`);
  L.push(`predictions: ${c.labels_total - c.no_verdict} of ${c.labels_total} labelled leads have a verdict; ${c.no_verdict} do not (${c.missing_lead} lead row(s) no longer exist)`);
  L.push(`SCOREABLE (decided label + verdict): ${c.scoreable}`);
  if (c.unknown_verdicts.length) L.push(`WARNING unrecognised verdict tier(s) in the DB: ${c.unknown_verdicts.join(", ")}`);
  if (c.scoreable === 0) {
    L.push("");
    L.push("NOTHING TO SCORE. Every rate below would be a division by zero.");
    L.push("Either the labelled leads have never been investigated (run L2/L3 on them),");
    L.push("or the investigated leads have never been labelled (node scripts/label-leads.js).");
  }

  L.push("");
  L.push("GATE (SUBSTANTIATED|SUGGESTIVE = surfaced to a human)");
  const g = run.gate;
  L.push(`  confusion: tp ${g.confusion.tp}  fp ${g.confusion.fp}  fn ${g.confusion.fn}  tn ${g.confusion.tn}`);
  L.push(`  precision (queue purity):   ${pct(g.precision)}`);
  L.push(`  recall (real leads kept):   ${pct(g.recall)}`);
  L.push(`  f1: ${num(g.f1)}${g.f1 != null && g.f1_insufficient ? " — INSUFFICIENT DATA" : ""}   accuracy: ${pct(g.accuracy)}`);
  if (g.f1 != null && g.f1_insufficient) {
    L.push(`  (f1 combines precision ${g.precision.num}/${g.precision.den} and recall ${g.recall.num}/${g.recall.den} — do not quote it.)`);
  }

  L.push("");
  L.push("PER-TIER");
  L.push(`  ${"tier".padEnd(14)} ${"pred".padStart(5)} ${"tp".padStart(4)} ${"fp".padStart(4)} ${"und".padStart(4)}  precision                recall`);
  for (const t of run.tiers) {
    L.push(`  ${t.tier.padEnd(14)} ${String(t.predicted).padStart(5)} ${String(t.true_positive).padStart(4)} ${String(t.false_positive).padStart(4)} ${String(t.undecidable).padStart(4)}  ${pct(t.precision).padEnd(24)} ${pct(t.recall)}`);
  }
  // COINCIDENCE precision/recall read backwards from the other two tiers: a real
  // lead landing there is a lead the gate threw away. Say so, or the table invites
  // the wrong conclusion.
  L.push("  note: for COINCIDENCE, precision = share of buried leads that were REAL and recall = the LEAK rate. Lower is better on both.");

  L.push("");
  L.push("CONFIDENCE CALIBRATION  (P(claim real): confidence, flipped for COINCIDENCE)");
  L.push(`  ${"bucket".padEnd(10)} ${"n".padStart(4)} ${"dec".padStart(4)} ${"tp".padStart(4)} ${"fp".padStart(4)}  ${"mean pred".padStart(9)}  observed precision        gap`);
  for (const b of run.calibration.buckets) {
    L.push(`  ${b.range.padEnd(10)} ${String(b.n).padStart(4)} ${String(b.decided).padStart(4)} ${String(b.true_positive).padStart(4)} ${String(b.false_positive).padStart(4)}  ${num(b.mean_predicted).padStart(9)}  ${pct(b.observed_precision).padEnd(24)}  ${num(b.gap)}`);
  }
  L.push(`  expected calibration error: ${run.calibration.expected_calibration_error == null ? "withheld (sample below floor)" : num(run.calibration.expected_calibration_error)}`);
  if (run.calibration.unbucketed) L.push(`  ${run.calibration.unbucketed} verdict(s) had no usable confidence number.`);
  if (c.ambiguous_confidence_scale) {
    L.push(`  WARNING ${c.ambiguous_confidence_scale} confidence value(s) in 1..10 were READ AS PERCENT (e.g. 7 → 0.07).`);
    L.push("  The prompt states no scale. If the model is answering on a 1-10 scale, every row above is wrong —");
    L.push("  pin the scale in server/synthesis/investigator.js before believing this table.");
  }

  L.push("");
  L.push("PER-DETECTOR (which detectors generate noise)");
  if (!run.detectors.length) L.push("  (no labelled leads yet)");
  L.push(...run.detectors.slice(0, 25).map((d) =>
    `  ${d.detector.padEnd(28)} labelled ${String(d.labelled).padStart(4)}  tp ${String(d.true_positive).padStart(3)}  fp ${String(d.false_positive).padStart(3)}  precision ${pct(d.precision)}`));

  if (run.delta) {
    L.push("");
    L.push(`DELTA vs previous run (${run.delta.previous_run ?? "none"})`);
    if (run.delta.note) L.push(`  ${run.delta.note}`);
    if (!run.delta.changes.length && !run.delta.note) L.push("  no headline metric changed.");
    for (const ch of run.delta.changes) {
      const d = ch.delta == null ? "" : ` (${ch.delta >= 0 ? "+" : ""}${ch.delta.toFixed(3)})`;
      L.push(`  ${ch.metric.padEnd(28)} ${fmtMetric(ch.from_detail ?? { value: ch.from })} → ${fmtMetric(ch.to_detail ?? { value: ch.to })}${d}`);
    }
    if (run.delta.changes.some((ch) => ch.insufficient)) {
      L.push("  [INSUFFICIENT] = that side is below the min-sample floor. A movement between two thin");
      L.push("  numbers is not evidence that anything improved — get more labels before acting on it.");
    }
  }
  if (run.live) {
    L.push("");
    L.push(`LIVE RUN: ${run.live.investigated} investigated, ${run.live.failed} failed, ${run.live.skipped ?? 0} not investigated`
      + ` (${run.live.over_cap ?? 0} over --max-leads ${run.live.max_leads}, ${run.live.missing_leads ?? 0} lead row(s) gone);`
      + ` llm_usage rows +${run.live.usage_rows ?? "?"}, tokens +${run.live.tokens ?? "?"}`);
  }
  return L.join("\n");
}

// ---- stored mode ------------------------------------------------------------
/**
 * Resolve a label to its lead by id, then by the lead_key the label carries.
 * The key fallback is the whole reason lead_key is persisted: upsertLead dedupes
 * on `key` and mints a NEW id when the row was purged, so an id-only lookup
 * scores a re-detected lead as `missing_lead`. Those dropped labels are
 * disproportionately the human-rejected FALSE POSITIVES, so losing them biases
 * gate precision upward — the harness would flatter the model by forgetting its
 * mistakes.
 * @param {(db: any, idOrKey: string) => any} [read] injectable for tests
 */
export function resolveLabelledLead(db, rec, read = loadLead) {
  const byId = rec.lead_id ? read(db, rec.lead_id) : null;
  if (byId) return { lead: byId, resolvedBy: "lead_id" };
  const byKey = rec.lead_key && rec.lead_key !== rec.lead_id ? read(db, rec.lead_key) : null;
  if (byKey) return { lead: byKey, resolvedBy: "lead_key" };
  return { lead: null, resolvedBy: null };
}

export function pairsFromStored(db, labels, read = loadLead) {
  return labels.map((rec) => {
    const { lead, resolvedBy } = resolveLabelledLead(db, rec, read);
    return makePair(rec, lead, { resolvedBy });
  });
}

// ---- live mode --------------------------------------------------------------
// Re-investigates the labelled leads with the CURRENT prompts/model. This is the
// only mode that spends money, and the only one that WRITES: investigateLead
// upserts the lead, records investigation evidence, and appends a glm_* feedback
// row. Hence the gates below. Concurrency is capped at 2 to match
// investigate.js's mapLimit, and every call still goes through llm.js
// callWithRetry, so 429s honour Retry-After and land in the llm_usage ledger.
function usageSnapshot(db) {
  try {
    const r = db.prepare("SELECT COUNT(*) rows, COALESCE(SUM(total_tokens),0) tokens FROM llm_usage").get();
    return { rows: r.rows, tokens: r.tokens };
  } catch { return { rows: null, tokens: null }; }
}

/**
 * The three gates on --live. The DB gate compares RESOLVED ABSOLUTE PATHS against
 * the live file, because "PANDOROS_DB_PATH is set" proves nothing: setting it to
 * `data/pandoros.db` (or `./data/../data/pandoros.db`, or the absolute path)
 * satisfied the old presence check while pointing --live straight at the real
 * 432 MB database, which investigateLead then writes to. The only question that
 * matters is "is this file the live one", so that is the question asked.
 */
export function assertLiveAllowed(flags, env = process.env) {
  if (!flags["confirm-spend"]) {
    throw new Error("--live spends real money on the paid model. Re-run with --confirm-spend once you mean it.");
  }
  if (!env.AI_API_KEY) throw new Error("--live needs AI_API_KEY in your .env.");
  const target = dbPath(env);
  if (samePath(target, LIVE_DB_PATH) && !flags["allow-live-db"]) {
    throw new Error(
      `--live WRITES to the database it is measuring (investigateLead upserts the lead, adds evidence, records glm feedback).\n` +
      `Refusing: ${path.resolve(target)} IS the live database.\n` +
      "Point it at a copy first:  npm run db:backup  then set PANDOROS_DB_PATH to the copy.\n" +
      "Pass --allow-live-db only if you genuinely want the live DB mutated.");
  }
  return true;
}

/**
 * Split the labels into the ones this run will investigate and the ones it will
 * not, WITHOUT losing or duplicating a single record.
 *
 * The bug this replaces: `labels.slice(targets.length)` indexed the ORIGINAL array
 * with the length of a FILTERED one, so with labels [A(gone), B, C] the tail was
 * [C] — label A vanished from the report entirely and C was counted twice, once
 * with its verdict and once as a phantom missing row. labels_total stayed
 * numerically right, which is what hid it.
 * @param {any[]} labels
 * @param {(idOrKey: string) => any} getLead
 * @param {number} maxLeads
 */
export function planLive(labels, getLead, maxLeads) {
  const resolved = labels.map((rec) => {
    // Same id-then-key fallback as stored mode: a re-detected lead has a new id.
    const byId = rec.lead_id ? getLead(rec.lead_id) : null;
    const lead = byId || (rec.lead_key && rec.lead_key !== rec.lead_id ? getLead(rec.lead_key) : null);
    return { rec, lead: lead ?? null, resolvedBy: lead ? (byId ? "lead_id" : "lead_key") : null };
  });
  const targets = resolved.filter((t) => t.lead).slice(0, maxLeads);
  const chosen = new Set(targets);
  return { targets, rest: resolved.filter((t) => !chosen.has(t)) };
}

/**
 * A label this run did NOT investigate. It keeps its identity and its
 * missing_lead status, but carries NO verdict: in live mode the prediction must
 * come from THIS run's model, so leaking the stored verdict in here would mix two
 * models' answers into one score.
 */
function notInvestigatedPair(rec, lead, resolvedBy, why) {
  return {
    ...makePair(rec, lead, { resolvedBy }),
    verdict: null, unknown_verdict: null, confidence: null,
    claim_probability: null, ambiguous_confidence_scale: false,
    model: null, investigated_at: null,
    not_investigated: why,
  };
}

export async function runLive(db, labels, flags, deps = null) {
  assertLiveAllowed(flags);
  const maxLeads = numFlag(flags, "max-leads", 10, { min: 1 });
  const delayMs = numFlag(flags, "delay-ms", 1500);
  const before = usageSnapshot(db);
  // Imported here, not at module top: server/store/store.js opens the DB
  // READ-WRITE and runs import-time DDL, which --stored must never trigger.
  // `deps` exists so the pairing/accounting can be tested without an LLM or a
  // writable database.
  const { investigateLead, getLead } = deps ?? await (async () => {
    const [inv, store] = await Promise.all([
      import("../server/synthesis/investigator.js"),
      import("../server/store/store.js"),
    ]);
    return { investigateLead: inv.investigateLead, getLead: store.getLead };
  })();
  // Rejected leads ARE re-investigable (they are soft-deleted, so getLead finds
  // them) — which is the point: re-running a rejected lead is how you tell
  // whether a prompt change fixed a known false positive. Re-investigating one is
  // safe because the terminal-status guard in store/content.js pins status
  // 'rejected' while still writing the fresh `investigation` blob, so an eval run
  // updates the verdict WITHOUT pushing the lead back into the human queue.
  const { targets, rest } = planLive(labels, getLead, maxLeads);
  const pairs = [];
  let investigated = 0, failed = 0;
  for (const { rec, lead, resolvedBy } of targets) {
    try {
      const updated = await investigateLead(lead);
      pairs.push(makePair(rec, updated ?? lead, { resolvedBy }));
      investigated++;
    } catch (err) {
      // Recorded, never swallowed: a failed investigation is a missing prediction,
      // which the counts surface as no_verdict.
      console.warn(`[eval] investigate failed for ${rec.lead_id}: ${err.message}`);
      pairs.push({ ...notInvestigatedPair(rec, lead, resolvedBy, "investigate_failed"), error: err.message });
      failed++;
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  // Every remaining label appears exactly once. `missing_lead` still means the row
  // is genuinely gone (a deliberate purge — rejection only soft-deletes now);
  // beyond-the-cap labels are reported as skipped, NOT as missing rows.
  for (const { rec, lead, resolvedBy } of rest) {
    pairs.push(notInvestigatedPair(rec, lead, resolvedBy, lead ? "over_max_leads" : "missing_lead"));
  }
  const after = usageSnapshot(db);
  return {
    pairs,
    live: {
      investigated, failed,
      skipped: rest.length,
      missing_leads: rest.filter((t) => !t.lead).length,
      over_cap: rest.filter((t) => t.lead).length,
      max_leads: maxLeads,
      usage_rows: after.rows != null && before.rows != null ? after.rows - before.rows : null,
      tokens: after.tokens != null && before.tokens != null ? after.tokens - before.tokens : null,
    },
  };
}

// ---- main -------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const labelsPath = typeof flags.labels === "string" ? path.resolve(flags.labels) : DEFAULT_LABELS_PATH;
  // numFlag, not Number(...) || DEFAULT: `--min-sample` with no value is boolean
  // true, Number(true) is 1, and a floor of 1 disables the whole honesty guard.
  const minSample = numFlag(flags, "min-sample", DEFAULT_MIN_SAMPLE);
  const runsDir = typeof flags.runs === "string" ? path.resolve(flags.runs) : RUNS_DIR;

  const { all, byLeadId, malformed } = readLabels(labelsPath);
  if (malformed.length) {
    console.warn(`[eval] WARNING ${malformed.length} unusable line(s) in ${labelsPath} — excluded from scoring:`);
    for (const m of malformed.slice(0, 5)) console.warn(`  line ${m.line}: ${m.why}`);
  }
  if (!all.length) {
    console.error(`[eval] no labels in ${labelsPath}. Seed them: node scripts/label-leads.js --seed`);
    return null;
  }
  const labels = [...byLeadId.values()]; // last label per lead wins

  const db = openReadOnly();
  let pairs, extra = {}, model = null;
  try {
    if (flags.live) {
      const r = await runLive(db, labels, flags);
      pairs = r.pairs; extra = { live: r.live };
      try { model = (await import("../server/synthesis/llm.js")).MODEL; } catch { /* reporting only */ }
    } else {
      pairs = pairsFromStored(db, labels);
      model = [...new Set(pairs.map((p) => p.model).filter(Boolean))][0] ?? null;
    }
  } finally {
    db.close();
  }

  const run = buildRun(pairs, { mode: flags.live ? "live" : "stored", minSample, labelsPath, model, extra });
  run.delta = deltaAgainst(findPreviousRun(runsDir), run);
  run.pairs = pairs; // the audit trail: every label beside the verdict it scored

  let saved = null;
  if (!flags["no-save"]) saved = saveRun(run, runsDir);
  if (flags.json) console.log(JSON.stringify(run, null, 2));
  else console.log(renderSummary(run));
  if (saved) console.log(`\n[eval] run saved to ${saved}`);
  return run;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(reportFatal);
}
