// Ledger-backed card data — the second source a report card draws on.
//
// WHY THIS EXISTS
// ---------------
// `cards.js` was built to read the structured `numbers` blob that fetchers
// attach to an evidence row. That works for the sources whose fetcher happens
// to attach one, and produces nothing at all for everyone else — even when the
// same figures were extracted into the typed `facts` ledger minutes later by a
// different code path (bulk affidavit rows, for instance, write straight to the
// ledger and never mint an evidence row carrying `.numbers`).
//
// Measured on the live database before this module existed: 2,993 of the 3,053
// politicians whose card read "INSUFFICIENT_DATA" already had declared assets,
// liabilities and criminal-case counts sitting in `facts`. The data was there;
// the card could not see it.
//
// The ledger is the system's normalised, queryable analysis layer (see
// SYSTEM-COMPONENTS.md §5 — "Floor 2"). Detectors already read it. Cards
// reading raw evidence blobs instead was the inconsistency. This module closes
// it: evidence-derived numbers still win where present (they carry richer
// nested detail like the per-property list), and the ledger fills every gap.
//
// Everything here is deterministic and read-only. No LLM, no writes.
import { db } from "../store/store.js";
import { resolveEntityIdForPolitician } from "../entities/entities.js";
import { formatRupees } from "../util/numbers.js";

// Metrics surfaced on a public card, each with the unit it is stored in. Kept
// as an explicit allow-list rather than "whatever is in the table" so a new
// extractor cannot silently push an unreviewed metric onto a public page.
export const CARD_METRICS = {
  declared_assets: "inr",
  declared_liabilities: "inr",
  declared_income: "inr",
  election_expenditure: "inr",
  declared_immovable_properties: "count",
  declared_business_interests: "count",
  criminal_cases: "count",
  cash_in_hand: "inr",
  jewellery_value: "inr",
  vehicles_value: "inr",
  immovable_total: "inr",
  loans_given: "inr",
  birth_year: "year",
  mplads_allocated: "inr",
  mplads_spent: "inr",
  mplads_utilization_pct: "pct",
  mplads_completion_pct: "pct",
  mplads_works_recommended: "count",
  mplads_works_completed: "count",
  questions_asked: "count",
  debates_participated: "count",
  assurances_count: "count",
};

// Metrics a peer comparison is meaningful for. Ranking someone's `birth_year`
// against their peers would be noise; ranking their declared assets is the
// single most-asked question a reader has.
const RANKED_METRICS = [
  "declared_assets",
  "declared_liabilities",
  "declared_income",
  "election_expenditure",
  "criminal_cases",
  "mplads_utilization_pct",
];

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// A four-digit year out of `as_of_date` / `period`, whichever carries one.
// Ledger rows are inconsistent here by design (different extractors, different
// source granularity), so the card must not assume a format.
function yearOf(row) {
  const m = String(row.as_of_date ?? row.period ?? "").match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

// Newest-first, with undated rows last. An undated figure is not "year zero" —
// it is a figure whose vintage we do not know, and it must never displace a
// dated one when the card asks for "the latest".
function byRecency(a, b) {
  const ya = yearOf(a), yb = yearOf(b);
  if (ya != null && yb != null) return yb - ya;
  if (ya != null) return -1;
  if (yb != null) return 1;
  return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
}

/**
 * Every card-relevant ledger fact for one politician, grouped by metric.
 * @param {string} politicianId
 * @returns {{hasData: boolean, entity_id: string|null, metrics: Object, series: Object, sources: string[]}}
 */
export function ledgerViewForPolitician(politicianId) {
  const empty = { hasData: false, entity_id: null, metrics: {}, series: {}, sources: [] };
  const eid = resolveEntityIdForPolitician(politicianId);
  if (!eid) return empty;

  const names = Object.keys(CARD_METRICS);
  const rows = db.prepare(`
    SELECT f.metric, f.value, f.unit, f.as_of_date, f.period, f.source_type,
           f.evidence_id, f.created_at, e.url
      FROM facts f
      LEFT JOIN evidence e ON e.id = f.evidence_id
     WHERE f.entity_id = ?
       AND f.metric IN (${names.map(() => "?").join(",")})
  `).all(eid, ...names);
  if (!rows.length) return { ...empty, entity_id: eid };

  const grouped = new Map();
  for (const r of rows) {
    if (num(r.value) == null) continue;
    if (!grouped.has(r.metric)) grouped.set(r.metric, []);
    grouped.get(r.metric).push(r);
  }

  const metrics = {};
  const series = {};
  const sources = new Set();
  for (const [metric, list] of grouped) {
    list.sort(byRecency);
    const latest = list[0];
    metrics[metric] = {
      value: num(latest.value),
      unit: latest.unit ?? CARD_METRICS[metric] ?? null,
      year: yearOf(latest),
      url: latest.url ?? null,
      source_type: latest.source_type ?? null,
      observations: list.length,
    };
    if (latest.url) sources.add(latest.url);

    // A dated series is what makes a number a story rather than a statistic:
    // "₹4.1 cr" is inert, "₹0.9 cr in 2018 → ₹4.1 cr in 2023" is not.
    const dated = list.filter((r) => yearOf(r) != null);
    if (dated.length >= 2) {
      const seen = new Set();
      series[metric] = dated
        .map((r) => ({ year: yearOf(r), value: num(r.value), url: r.url ?? null }))
        .filter((p) => (seen.has(p.year) ? false : seen.add(p.year)))
        .sort((a, b) => a.year - b.year);
    }
  }
  return { hasData: true, entity_id: eid, metrics, series, sources: [...sources] };
}

/**
 * Growth between the first and last dated observation of a metric.
 * Returns null unless both ends are positive and the span is real — a multiple
 * computed off a zero or a missing year is a fabricated statistic.
 */
export function growthOf(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const first = series[0], last = series[series.length - 1];
  if (!(first.value > 0) || !(last.value > 0)) return null;
  if (!(last.year > first.year)) return null;
  return {
    from: first.value, to: last.value,
    from_year: first.year, to_year: last.year,
    years: last.year - first.year,
    multiple: Number((last.value / first.value).toFixed(1)),
  };
}

// ── Peer comparison ────────────────────────────────────────────────────────
//
// A number alone tells a reader nothing: is ₹12 crore a lot for an MLA? The
// only honest answer is relative — against the people elected under the same
// rules, in the same state, at the same level. That is the cohort.
//
// Built once and cached, because a full card regeneration asks for it 4,559
// times and the underlying tables do not change mid-run.

let PEER_INDEX = null;

/** Test hook — drops the cache so a fixture DB is not scored against a stale index. */
export function resetPeerIndex() { PEER_INDEX = null; }

export function cohortKeyFor(office, state) {
  return `${office ?? "?"}::${state ?? "?"}`;
}

/** Human label for a cohort, used verbatim in card prose. */
export function cohortLabel(office, state) {
  if (office === "MP") return "sitting Lok Sabha MPs";
  if (office === "RS") return "sitting Rajya Sabha members";
  if (office === "MLA" && state) return `MLAs in ${state}`;
  return "peers in the same house";
}

/**
 * Latest value of every ranked metric for every politician, bucketed by cohort
 * and sorted, so a percentile is a binary search rather than a query.
 */
export function buildPeerIndex({ force = false } = {}) {
  if (PEER_INDEX && !force) return PEER_INDEX;

  const pols = db.prepare(`
    SELECT id, office, json_extract(data,'$.state') AS state FROM politicians
  `).all();

  // politician -> entity, in one pass (resolveEntityIdForPolitician per person
  // would be 4,559 round trips).
  const p2e = new Map();
  for (const e of db.prepare(
    "SELECT id, strong_ids FROM entities WHERE kind='person' AND strong_ids LIKE '%politician_id%'"
  ).all()) {
    try {
      const pid = JSON.parse(e.strong_ids)?.politician_id;
      if (pid) p2e.set(String(pid), e.id);
    } catch { /* a malformed strong_ids blob costs one person their ranking, not the run */ }
  }

  const rows = db.prepare(`
    SELECT entity_id, metric, value, as_of_date, period, created_at
      FROM facts
     WHERE subject_kind='person'
       AND metric IN (${RANKED_METRICS.map(() => "?").join(",")})
  `).all(...RANKED_METRICS);

  const byEntity = new Map();
  for (const r of rows) {
    if (num(r.value) == null) continue;
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, new Map());
    const m = byEntity.get(r.entity_id);
    const prev = m.get(r.metric);
    if (!prev || byRecency(r, prev) < 0) m.set(r.metric, r);
  }

  const cohorts = new Map();
  const values = new Map(); // politicianId -> {metric: value}
  for (const p of pols) {
    const eid = p2e.get(String(p.id));
    const own = eid ? byEntity.get(eid) : null;
    const key = cohortKeyFor(p.office, p.state);
    if (!cohorts.has(key)) {
      cohorts.set(key, { office: p.office, state: p.state, size: 0, metrics: new Map() });
    }
    const c = cohorts.get(key);
    c.size++;
    if (!own) continue;
    const mine = {};
    for (const metric of RANKED_METRICS) {
      const v = num(own.get(metric)?.value);
      if (v == null) continue;
      mine[metric] = v;
      if (!c.metrics.has(metric)) c.metrics.set(metric, []);
      c.metrics.get(metric).push(v);
    }
    values.set(String(p.id), mine);
  }
  for (const c of cohorts.values()) {
    for (const arr of c.metrics.values()) arr.sort((a, b) => a - b);
  }

  PEER_INDEX = { cohorts, values };
  return PEER_INDEX;
}

// Share of the cohort at or below `v`, 0–100. Ties count as "at or below", so
// twelve members who all declared zero cases are all reported as being at the
// same place rather than arbitrarily ordered against each other.
function percentileOf(sorted, v) {
  if (!sorted.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
  return Math.round((lo / sorted.length) * 100);
}

/**
 * Where this politician sits among comparable representatives.
 * Only reports a rank when the cohort is large enough for one to mean anything.
 *
 * @param {{id: string, office: string|null, state: string|null}} politician
 * @param {number} minCohort  fewest ranked peers before a percentile is honest
 */
export function peerContextFor(politician, { minCohort = 12 } = {}) {
  const idx = buildPeerIndex();
  const key = cohortKeyFor(politician.office, politician.state);
  const cohort = idx.cohorts.get(key);
  const mine = idx.values.get(String(politician.id));
  const out = {
    cohort_key: key,
    cohort_label: cohortLabel(politician.office, politician.state),
    cohort_size: cohort?.size ?? 0,
    ranks: {},
  };
  if (!cohort || !mine) return out;

  for (const metric of RANKED_METRICS) {
    const v = mine[metric];
    if (v == null) continue;
    const sorted = cohort.metrics.get(metric) ?? [];
    if (sorted.length < minCohort) continue;
    const pctile = percentileOf(sorted, v);
    // rank 1 = highest value, which is the direction a reader expects for
    // "richest" and, for criminal cases, for "most charged".
    const rank = sorted.length - percentileRankIndex(sorted, v);
    out.ranks[metric] = {
      value: v,
      percentile: pctile,
      rank,
      of: sorted.length,
      median: sorted[Math.floor(sorted.length / 2)],
      cohort_label: out.cohort_label,
    };
  }
  return out;
}

// Index of the first cohort member with this value — so equal values share a
// rank instead of being split by array order.
function percentileRankIndex(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

// ── Ledger-derived findings ────────────────────────────────────────────────
//
// The same computed findings `detectors/analyzer.js` derives from evidence
// `numbers`, derived instead from the ledger — deliberately reusing analyzer's
// codes and weights so a card scored from the ledger is scored on exactly the
// same rubric as one scored from evidence, and so merging the two is a plain
// dedup by code rather than a reconciliation of two scales.
//
// This adds no new judgement. If a threshold here disagreed with analyzer.js,
// the same politician would score differently depending on which pipeline
// happened to reach them first — which is precisely the bug this closes.

function mkFlag(code, param, weight, severity, headline, detail, sources = []) {
  return { code, param, weight, severity, headline, detail, sources: sources.filter(Boolean) };
}

/**
 * Findings the ledger supports, in analyzer.js's flag shape.
 * @param {ReturnType<typeof ledgerViewForPolitician>} view
 * @returns {{flags: Array, facts: Object}}
 */
export function ledgerFindings(view) {
  const flags = [];
  const facts = {};
  if (!view?.hasData) return { flags, facts };
  const m = view.metrics;
  const val = (k) => m[k]?.value ?? null;
  const src = (k) => m[k]?.url ?? null;

  const assets = val("declared_assets");
  const liabilities = val("declared_liabilities");
  if (assets != null) {
    const netWorth = liabilities != null ? assets - liabilities : assets;
    facts.net_worth = netWorth;
    facts.net_worth_display = formatRupees(netWorth);
    if (liabilities != null) facts.total_liabilities = liabilities;
    if (liabilities > assets && assets > 0) {
      flags.push(mkFlag("LIABILITIES_EXCEED_ASSETS", "corruption", -8, "NOTABLE",
        `Declared liabilities (${formatRupees(liabilities)}) exceed declared assets (${formatRupees(assets)}).`,
        "From the typed public-records ledger: liabilities are larger than total declared assets.",
        [src("declared_liabilities"), src("declared_assets")]));
    }
  }

  const growth = growthOf(view.series?.declared_assets);
  if (growth) {
    facts.asset_growth_multiple = growth.multiple;
    facts.asset_growth_span_years = growth.years;
    if (growth.multiple >= 3) {
      flags.push(mkFlag("ASSET_GROWTH_ANOMALY", "corruption", growth.multiple >= 8 ? -22 : -12,
        growth.multiple >= 8 ? "SIGNIFICANT" : "NOTABLE",
        `Declared assets grew ${growth.multiple}× (${formatRupees(growth.from)} → ${formatRupees(growth.to)}) over ${growth.years} years.`,
        `Computed from dated declarations of ${growth.from_year} and ${growth.to_year}. Rapid growth is not itself wrongdoing; it is flagged for explanation against declared income.`,
        [src("declared_assets")]));
    }
  }

  const cases = val("criminal_cases");
  if (cases != null) {
    facts.criminal_cases = cases;
    if (cases === 0) {
      flags.push(mkFlag("CLEAN_CRIMINAL_RECORD", "corruption", +6, "CLEAN",
        "No criminal cases declared in the sworn affidavit.",
        "A clean declared record — a documented positive.", [src("criminal_cases")]));
    } else if (cases >= 3) {
      flags.push(mkFlag("MULTIPLE_PENDING_CASES", "abuse_of_power", cases >= 8 ? -20 : -12,
        cases >= 8 ? "SIGNIFICANT" : "NOTABLE",
        `${cases} criminal cases declared (charges, not convictions).`,
        "Self-declared in the sworn affidavit. Charges are a public record, not proof of guilt.",
        [src("criminal_cases")]));
    }
  }

  // MPLADS, on the same ≥₹1 cr allocation guard analyzer.js uses: a member
  // whose allocation has barely been released cannot be judged on "0% spent".
  const util = val("mplads_utilization_pct");
  const alloc = val("mplads_allocated");
  if (util != null && (alloc ?? 0) >= 1e7) {
    facts.mplads_utilization_pct = Number(util.toFixed(1));
    const spent = val("mplads_spent");
    if (spent != null && alloc != null) facts.mplads_unspent = Math.max(0, alloc - spent);
    if (util < 50) {
      flags.push(mkFlag("MPLADS_UNDERUTILISED", "abuse_of_power", util < 25 ? -14 : -8,
        util < 25 ? "SIGNIFICANT" : "NOTABLE",
        `Only ${util.toFixed(1)}% of MPLADS local-development funds utilised${facts.mplads_unspent ? `, leaving ${formatRupees(facts.mplads_unspent)} unspent` : ""}.`,
        "From the official MPLADS record. Low utilisation means allocated development money for the constituency went unspent.",
        [src("mplads_utilization_pct")]));
    } else if (util >= 90) {
      flags.push(mkFlag("MPLADS_WELL_UTILISED", "abuse_of_power", +6, "CLEAN",
        `${util.toFixed(1)}% of MPLADS funds utilised — strong constituency-development spending.`,
        "A documented positive from the official MPLADS record.", [src("mplads_utilization_pct")]));
    }
  }

  return { flags, facts };
}

/**
 * Merge ledger findings into evidence-derived ones. Evidence wins on conflict:
 * it carries the richer nested detail (per-property lists, per-company status)
 * and is what the existing tests pin.
 */
export function mergeFindings(evidenceResult, ledgerResult) {
  const seen = new Set((evidenceResult.flags ?? []).map((f) => f.code));
  const flags = [...(evidenceResult.flags ?? [])];
  for (const f of ledgerResult.flags ?? []) if (!seen.has(f.code)) { flags.push(f); seen.add(f.code); }
  return { flags, facts: { ...(ledgerResult.facts ?? {}), ...(evidenceResult.facts ?? {}) } };
}
