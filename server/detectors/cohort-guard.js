// Cohort base-rate guard — the difference between an anomaly and a norm.
//
// THE BUG THIS FIXES
// ------------------
// A detector fires when a value crosses a fixed threshold. It has no idea how
// many of the subject's peers cross the same threshold. So when a condition is
// widespread, the engine emits one indignant lead per person and calls a
// commonplace fact a finding.
//
// Measured on the live database: `fund_utilization` fired on 128 of the 472
// members who have MPLADS figures at all — 27.1% of the cohort. Twenty-seven
// percent is not an anomaly. It is how the scheme runs. The engine produced
// 128 individual leads implying 128 individual failures, which is both wrong
// and, for the reader, indistinguishable from noise.
//
// THE RULE
// --------
// A finding that applies to a large share of the cohort is evidence about the
// COHORT, not about its members. So above a fire-rate ceiling the guard:
//
//   1. keeps only the genuine tail as individual leads — the members who are
//      extreme relative to their peers, not relative to a constant;
//   2. emits ONE systemic finding about the institution or scheme itself; and
//   3. tells the survivors what the base rate is, so a reader (and the
//      Investigator's prompt) sees "worst 5%, where 27% are under-spending"
//      rather than a bare accusation.
//
// Point 2 is not a consolation prize. "128 of 472 MPs left MPLADS money largely
// unspent" is a bigger story than any single MP's line item — it is the kind of
// finding that indicts a scheme rather than a person, and this project exists
// to do both.
//
// The guard NEVER invents a denominator. If a detector does not declare where
// its eligible population comes from, or the population is too small to reason
// about, candidates pass through untouched.

export const COHORT_DEFAULTS = {
  // Above this share of the cohort, the finding is treated as systemic.
  // 0.15 is deliberately conservative: at one in seven, "unusual" is a stretch.
  systemicAt: 0.15,
  // How much of the cohort still deserves an individual lead once the finding
  // is systemic — the true tail, measured against peers.
  tailPct: 0.05,
  // Below this many subjects a rate is not evidence of anything.
  minPopulation: 30,
  // Never drop every candidate: even in a fully systemic condition the most
  // extreme handful stay individually reportable.
  minKeep: 3,
};

/** Rounded percentage, for headlines that must not imply false precision. */
const share = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/**
 * Apply the base-rate rule to one detector's candidates.
 *
 * @param {Array} candidates      what the detector produced
 * @param {object} cohort         the detector's cohort descriptor:
 *   @param {number} cohort.population  size of the eligible population
 *   @param {(c:any)=>number|null} cohort.stat  the comparable statistic per candidate
 *   @param {"low"|"high"} cohort.direction  which tail is the adverse one
 *   @param {string} cohort.subjectName  what the systemic finding is ABOUT
 *   @param {string} [cohort.unit]       how to render the statistic
 * @param {object} [settings]     threshold overrides (ops-console tunables)
 * @returns {{candidates: Array, systemic: object|null, stats: object}}
 */
export function applyCohortGuard(candidates = [], cohort = {}, settings = {}) {
  const S = { ...COHORT_DEFAULTS, ...settings };
  const population = Number(cohort.population ?? 0);
  const n = candidates.length;
  const stats = {
    population, fired: n, fire_rate: share(n, population),
    systemic: false, kept: n, suppressed: 0,
  };

  // No denominator, too small a denominator, or nothing fired → say nothing.
  // An unknown base rate must never be treated as a low one.
  if (!population || population < S.minPopulation || !n) return { candidates, systemic: null, stats };

  const rate = n / population;
  if (rate <= S.systemicAt) return { candidates, systemic: null, stats };

  stats.systemic = true;

  // A DUTY is not excused by being commonly breached.
  //
  // Two different things were being run through one rule. "Assets worth 40
  // years of declared income" breaks no rule — it is an inference, and how
  // common it is genuinely bears on whether it means anything. But MPLADS is a
  // statutory entitlement each MP is responsible for spending: not spending it
  // is that member's failure whether 1% or 90% of members also fail. Base rate
  // is evidence about an inference; it is not a defence against a duty.
  //
  // For a standard, the base rate is reported ALONGSIDE every individual
  // finding — never instead of it.
  if (cohort.standard) {
    stats.kept = n;
    stats.suppressed = 0;
    return {
      candidates: candidates.map((c) => annotate(c, stats, cohort, true)),
      systemic: systemicFinding(candidates, cohort, stats),
      stats,
    };
  }

  // Rank the candidates against each other on their own statistic. The adverse
  // tail is the low end for "under-utilisation", the high end for "overspend".
  const statOf = typeof cohort.stat === "function" ? cohort.stat : () => null;
  const scored = candidates.map((c) => ({ c, v: statOf(c) }));
  const measurable = scored.filter((s) => Number.isFinite(s.v));

  // Without a comparable statistic we cannot identify a tail honestly. Keep
  // everything, but still emit the systemic finding and mark the context —
  // silently dropping leads we cannot rank would be worse than keeping them.
  if (measurable.length !== scored.length) {
    return {
      candidates: candidates.map((c) => annotate(c, stats, cohort, false)),
      systemic: systemicFinding(candidates, cohort, stats),
      stats,
    };
  }

  measurable.sort((a, b) => (cohort.direction === "high" ? b.v - a.v : a.v - b.v));
  const keep = Math.max(S.minKeep, Math.min(measurable.length, Math.ceil(population * S.tailPct)));
  const kept = measurable.slice(0, keep).map((s) => annotate(s.c, stats, cohort, true));

  stats.kept = kept.length;
  stats.suppressed = n - kept.length;
  return { candidates: kept, systemic: systemicFinding(candidates, cohort, stats), stats };
}

// Attach the base rate to a surviving candidate, so no downstream consumer —
// card, lead, or LLM prompt — can present it as a lone aberration.
function annotate(c, stats, cohort, isTail) {
  const context = {
    cohort_population: stats.population,
    cohort_fired: stats.fired,
    cohort_fire_rate_pct: stats.fire_rate,
    is_cohort_tail: isTail,
    note: `${stats.fired} of ${stats.population} comparable subjects (${stats.fire_rate}%) show this same pattern`
      + (isTail ? " — this one is in the most extreme few." : "."),
  };
  // How the base rate is phrased matters as much as whether it is applied.
  // "A condition this widespread is primarily a finding about the programme
  // rather than about this individual" — the previous wording — reads as an
  // excuse, and for a duty it is simply false. A standard breached by many is
  // still breached by each. For a statistical inference the base rate bears on
  // how much the number MEANS, which is a claim about evidence, not about
  // culpability.
  const framing = cohort.standard
    ? `Being common does not make it acceptable: this is a responsibility each holder carries individually, and ${cohort.subjectName ?? "the programme"} failing at scale is an additional finding, not a substitute for this one.`
    : `This is a widespread pattern rather than a distinguishing one, so it ranks lower for investigation — that is a statement about how much the number reveals, not an excuse.`;
  const ctx = { ...context, is_standard: !!cohort.standard };
  const annotatedDetail = `${c.detail ?? ""} ${context.note} ${framing}`.trim();
  const out = {
    ...c,
    cohort_context: ctx,
    detail: annotatedDetail,
    data: { ...(c.data ?? {}), cohort_context: ctx },
  };
  // Legacy detectors carry a SEPARATE `lead` payload, and that is the text that
  // actually reaches the lead a human reads. Annotating only the candidate left
  // the base rate stranded on an object nobody sees — the context has to travel
  // with the claim, not sit beside it.
  if (c.lead) {
    out.lead = {
      ...c.lead,
      detail: `${c.lead.detail ?? ""} ${context.note} ${framing}`.trim(),
      cohort_context: ctx,
      data: { ...(c.lead.data ?? {}), cohort_context: ctx },
    };
    if (!isTail && typeof out.lead.signal_score === "number") {
      out.lead.signal_score = Math.round(out.lead.signal_score / 2);
    }
  }
  // The tail keeps its score: being the most extreme of 472 peers is exactly
  // the claim worth making, and demoting it would defeat the guard's purpose.
  // Candidates we could NOT rank (no comparable statistic) are halved instead —
  // we know the pattern is common but cannot show this one is exceptional, and
  // an unverifiable claim should not compete for an investigator's attention.
  if (!isTail) {
    if (typeof out.signal_score === "number") out.signal_score = Math.round(out.signal_score / 2);
    if (typeof out.score === "number") out.score = Math.round(out.score / 2);
  }
  return out;
}

/**
 * The population-level finding: one lead about the scheme, party or institution,
 * carrying the arithmetic that makes it checkable.
 */
export function systemicFinding(candidates, cohort, stats) {
  const subject = cohort.subjectName ?? "this programme";
  const worst = [...candidates]
    .map((c) => ({ name: c.actor_name ?? c.subject?.name ?? null, v: typeof cohort.stat === "function" ? cohort.stat(c) : null }))
    .filter((x) => x.name && Number.isFinite(x.v))
    .sort((a, b) => (cohort.direction === "high" ? b.v - a.v : a.v - b.v))
    .slice(0, 5);

  return {
    vector: "SYSTEMIC_PATTERN",
    kind: "systemic",
    subject_name: subject,
    subject_kind: cohort.subjectKind ?? "programme",
    entity_id: cohort.entityId ?? null,
    // Scaled by how widespread it is: a condition affecting most of a cohort is
    // a bigger institutional failure than one affecting a fifth of it.
    signal_score: Math.min(90, 30 + Math.round(stats.fire_rate)),
    severity: stats.fire_rate >= 40 ? "SIGNIFICANT" : "NOTABLE",
    headline: cohort.standard
      ? `${stats.fired} of ${stats.population} (${stats.fire_rate}%) are failing the same duty: ${subject}.`
      : `${stats.fired} of ${stats.population} (${stats.fire_rate}%) show the same pattern in ${subject}.`,
    detail: cohort.standard
      ? `${stats.fired} of ${stats.population} (${stats.fire_rate}%) fall short of the same standard in ${subject}. `
        + `This is a finding about the programme AND about each of them: a duty breached at scale is not thereby excused, `
        + `and every one of the ${stats.kept} individual findings is retained alongside this one. `
        + `A failure rate this high is itself evidence that the accountability mechanism for ${subject} is not working.`
      : `This is a base-rate finding, not an accusation against any individual. `
        + `${stats.fired} of ${stats.population} comparable subjects (${stats.fire_rate}%) cross the same threshold, `
        + `so the measure does not distinguish this group from its peers — which bears on what the number reveals, not on whether it matters. `
        + `The individual leads retained alongside this finding are the ${stats.kept} most extreme cases.`,
    data: {
      statistic: "cohort_base_rate",
      population: stats.population,
      fired: stats.fired,
      fire_rate_pct: stats.fire_rate,
      individually_retained: stats.kept,
      suppressed_as_typical: stats.suppressed,
      most_extreme: worst,
      unit: cohort.unit ?? null,
      direction: cohort.direction ?? null,
    },
  };
}

/**
 * Guard a detector's whole output, splitting into independently-judged groups
 * first when the detector flags more than one kind of thing.
 *
 * MPLADS is the motivating case: the same detector reports members who spent
 * almost nothing AND members who spent to the last rupee. Those are opposite
 * conditions with opposite base rates — pooling them would let 128 under-
 * spenders drag a handful of full-drawers into a "systemic" verdict they are
 * not part of.
 *
 * @returns {{candidates: Array, systemic: Array, stats: Object}}
 */
export function guardDetector(candidates = [], cohort = {}, settings = {}) {
  if (!candidates.length || !cohort.population) {
    return { candidates, systemic: [], stats: { population: cohort.population ?? 0, fired: candidates.length, groups: {} } };
  }
  const groupBy = typeof cohort.groupBy === "function" ? cohort.groupBy : null;
  if (!groupBy) {
    const r = applyCohortGuard(candidates, cohort, settings);
    return { candidates: r.candidates, systemic: r.systemic ? [r.systemic] : [], stats: { ...r.stats, groups: {} } };
  }

  const groups = new Map();
  for (const c of candidates) {
    const k = groupBy(c) ?? "_";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  const systemic = [];
  const groupStats = {};
  for (const [key, list] of groups) {
    const sub = {
      ...cohort,
      direction: cohort.directionFor?.(key) ?? cohort.direction,
      subjectName: cohort.subjectNameFor?.(key) ?? cohort.subjectName,
      groupKey: key,
    };
    const r = applyCohortGuard(list, sub, settings);
    out.push(...r.candidates);
    if (r.systemic) systemic.push({ ...r.systemic, group: key });
    groupStats[key] = r.stats;
  }
  return {
    candidates: out,
    systemic,
    stats: { population: cohort.population, fired: candidates.length, kept: out.length, groups: groupStats },
  };
}

/**
 * Eligible-population size for a metric-backed detector: how many politicians
 * actually have the figure the detector reads. This is the only honest
 * denominator — a detector that reads MPLADS utilisation can only ever fire on
 * the members who have an MPLADS record, not on the whole roster.
 */
export function populationForMetric(ctx, metric) {
  try {
    const rows = ctx?.factsForPoliticians?.(metric) ?? [];
    return new Set(rows.map((r) => r.pid)).size;
  } catch {
    return 0;
  }
}
