// ═══════════════════════════════════════════════════════════════════════════
// THE ANOMALY ENGINE (L1, code-only) — the deterministic layer before the LLM.
//
// One registry of DETECTORS runs over everything the store knows (evidence
// numbers, the facts/claims ledgers, relationships, events) and emits FLAGS:
//   'small' — worth counting, never a lead alone; feeds per-subject clusters.
//   'big'   — strong enough to be promoted to an investigation lead directly.
// Every flag carries evidence citations (evidence rows / URLs + a note saying
// what each shows), a rationale with the actual numbers, and the thresholds it
// tripped. lead-synthesis.js then turns big flags + flag clusters into leads
// for the SAME admin-gated GLM funnel that already exists (nothing publishes,
// nothing spends tokens, without a human).
//
// Detector methodology sources (encoded, not invented):
//   • Disproportionate-assets check-period formula (PCA 1988 s13(1)(e) practice)
//   • Open Contracting / DIGIWHIST procurement red-flag indicators
//   • Benford first-digit screening with Nigrini MAD conformity bands
//   • ICIJ-style nominee-director / shared-address shell markers
//   • ADR's expenditure-bunching finding (most candidates declare 45–55% of the
//     legal cap; near-cap or implausibly-low declarations are the tails)
//
// Tunables: every NEW detector declares its knobs below; values resolve from
// the engine_settings table (ops console, live) with code defaults as fallback.
// Wrapped LEGACY detectors (conflict/anomaly/ledger/collusion) keep their own
// in-module thresholds; the engine adds enabled + bigAt on top.
//
// Enrichment (free-only, evidence-recording): after detection, company-bearing
// big flags trigger the existing Tofler director lookup + director→politician
// matching. Both persist what they learn as evidence rows — every network call
// leaves a citable trail. No paid API is ever called from here.
import { db, listPoliticians, listEvidence } from "./store.js";
import { upsertFlag, markStaleExcept, flagCounts } from "./flags.js";
import { resolveSettings } from "./engine-settings.js";
import { detectConflicts, CONFLICT_DEFAULTS } from "./conflict.js";
import {
  detectAssetGrowthOutliers, detectUtilizationExtremes, detectTimingCorrelation, ANOMALY_DEFAULTS,
} from "./anomaly.js";
import {
  detectIncomeGrowthOutliers, detectSpendVsIncome, detectMultiSourceAdverse, LEDGER_DEFAULTS,
} from "./ledger-detectors.js";
import { detectCollusion } from "./collusion.js";
import { ENGINE_GROUPS } from "./engine-groups.js";
import { mahalanobisOutliers, changePoint } from "./engine-multivariate.js";
import { CPPP_DETECTORS, cpppBidderStats } from "./cppp-detectors.js";
import { normName as cpppNorm } from "./cppp-index.js";
import { rulingPartyOf, jurisdictionsGovernedBy, canonParty } from "./data/governance-map.js";

export const ENGINE_VERSION = "engine-v1";

const CR = 1e7, L = 1e5;

// ── Shared statistics helpers ────────────────────────────────────────────────
export function meanStd(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

// Benford first-digit screen: chi-square (8 dof) + Nigrini's Mean Absolute
// Deviation, so a deviation must clear BOTH a significance test and an effect-
// size band before it flags. Returns null when there are too few numbers.
const BENFORD_P = Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)));
export function benfordStats(values, { minN = 40 } = {}) {
  const digits = [];
  for (const v of values) {
    const s = String(Math.abs(Number(v) || 0)).replace(/[^1-9]/g, "");
    if (s) digits.push(Number(s[0]));
  }
  if (digits.length < minN) return null;
  const n = digits.length;
  const counts = Array(9).fill(0);
  for (const d of digits) counts[d - 1]++;
  let chi2 = 0, mad = 0;
  for (let i = 0; i < 9; i++) {
    const expected = BENFORD_P[i] * n;
    chi2 += (counts[i] - expected) ** 2 / expected;
    mad += Math.abs(counts[i] / n - BENFORD_P[i]);
  }
  mad /= 9;
  return { n, chi2, mad, counts };
}

// ── Evidence citation helper ─────────────────────────────────────────────────
// A flag's evidence array is its "why": [{ evidence_id?, url?, note }]. The note
// says what the row shows, so the lead (and later GLM) can cite it directly.
let _evStmt = null;
const evUrlStmt = () => (_evStmt ??= db.prepare("SELECT url, data FROM evidence WHERE id = ?"));
export function evidenceRef(evidence_id, note) {
  if (!evidence_id) return { note };
  try {
    const row = evUrlStmt().get(evidence_id);
    const title = row?.data ? (JSON.parse(row.data).title ?? null) : null;
    return { evidence_id, url: row?.url ?? null, title, note };
  } catch { return { evidence_id, note }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADERS — one cached context per run; detectors stay pure over it.
// ═══════════════════════════════════════════════════════════════════════════
function buildCtx({ log = () => {} } = {}) {
  const cache = new Map();
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn());
    return cache.get(key);
  };
  const politicians = memo("politicians", () => listPoliticians().filter((p) => !p.is_demo));
  const pmap = memo("pmap", () => new Map(politicians.map((p) => [p.id, p])));

  // facts for one metric, joined back to politicians via the entity strong id.
  const factsForPoliticians = (metric) => memo(`fpol:${metric}`, () =>
    db.prepare(`
      SELECT f.value, f.as_of_date, f.evidence_id, json_extract(e.strong_ids,'$.politician_id') pid
      FROM facts f JOIN entities e ON e.id = f.entity_id
      WHERE f.metric = ? AND json_extract(e.strong_ids,'$.politician_id') IS NOT NULL
    `).all(metric).filter((r) => pmap.has(r.pid) && r.value != null));

  // facts for one metric at ENTITY level (parties, companies, …).
  const factsForEntities = (metric) => memo(`fent:${metric}`, () =>
    db.prepare(`
      SELECT f.value, f.as_of_date, f.evidence_id, f.entity_id, e.canonical_name name, e.kind
      FROM facts f JOIN entities e ON e.id = f.entity_id
      WHERE f.metric = ? AND f.value IS NOT NULL
    `).all(metric));

  const relationsByType = (relType) => memo(`rel:${relType}`, () =>
    db.prepare("SELECT * FROM relationships WHERE rel_type = ?").all(relType));

  const eventsByKind = (kind) => memo(`ev:${kind}`, () =>
    db.prepare("SELECT * FROM events WHERE kind = ?").all(kind));

  const claimsByTypes = (types) => memo(`cl:${types.join(",")}`, () => {
    const ph = types.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM claims WHERE claim_type IN (${ph})`).all(...types);
  });

  const entityById = (idv) => memo(`ent1:${idv}`, () =>
    db.prepare("SELECT * FROM entities WHERE id = ?").get(idv));

  // politician_id → their person-entity id, resolved in ONE pass (not per rep).
  const selfEntityByPolitician = () => memo("selfByPid", () => {
    const m = new Map();
    for (const r of db.prepare("SELECT id, json_extract(strong_ids,'$.politician_id') pid FROM entities WHERE kind='person' AND pid IS NOT NULL").all())
      if (r.pid && !m.has(r.pid)) m.set(r.pid, r.id);
    return m;
  });

  const evidenceFor = (pid) => memo(`evid:${pid}`, () => listEvidence(pid));

  // Per-politician time series of a facts metric: pid → [{year, value, evidence_id}]
  const seriesByPolitician = (metric) => memo(`series:${metric}`, () => {
    const by = new Map();
    for (const r of factsForPoliticians(metric)) {
      const year = Number(String(r.as_of_date ?? "").slice(0, 4));
      if (!Number.isFinite(year)) continue;
      (by.get(r.pid) ?? by.set(r.pid, []).get(r.pid)).push({ year, value: r.value, evidence_id: r.evidence_id });
    }
    for (const rows of by.values()) rows.sort((a, b) => a.year - b.year);
    return by;
  });

  const cohortOf = (p) => p.state || p.party || "(none)";
  return {
    log, politicians, pmap, factsForPoliticians, factsForEntities, relationsByType,
    eventsByKind, claimsByTypes, entityById, evidenceFor, seriesByPolitician, cohortOf,
    selfEntityByPolitician,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FLAG CANDIDATE SHAPE (what a detector's run() returns, one per anomaly):
//   { subject: { politician_id? , entity_id?, name, kind },
//     score, fingerprint, headline, rationale, evidence: [evidenceRef…],
//     data?, lead? }             // lead = legacy candidate to promote verbatim
// The engine adds severity (score ≥ bigAt → 'big'), key, run_id, versions.
// ═══════════════════════════════════════════════════════════════════════════

// Common tunables every detector gets.
const BASE_TUNABLES = {
  enabled: { label: "Enabled", type: "boolean", def: true, desc: "Turn this detector on/off." },
  bigAt: { label: "Big-flag score", type: "number", def: 20, min: 1, max: 100, desc: "Score at/above which a flag is BIG (lead-worthy on its own)." },
};
const T = (extra = {}) => ({ ...BASE_TUNABLES, ...extra });

// Turn a legacy detector's DEFAULTS constant into tunable metadata (all numeric,
// labelled by their constant name) so the ops console can edit them live. `labels`
// optionally overrides the display label/desc for a given key.
function legacyTunables(defaults, labels = {}, base = {}) {
  const out = { ...BASE_TUNABLES, ...base };
  for (const [k, def] of Object.entries(defaults)) {
    out[k] = { label: labels[k]?.label ?? k, type: "number", def, min: 0, desc: labels[k]?.desc ?? `Threshold ${k} (default ${def}).` };
  }
  return out;
}
// Pull just the legacy-default keys out of a resolved settings object (drops
// enabled/bigAt) to pass as overrides to the pure detector.
const legacyOverrides = (S, defaults) =>
  Object.fromEntries(Object.keys(defaults).map((k) => [k, S[k]]));

// Adapter: legacy lead-candidates → flag candidates (keeps the original lead so
// promotion preserves the legacy vector + dedupe key exactly).
function fromLegacy(candidates, ctx) {
  return candidates.map((c) => ({
    subject: {
      politician_id: c.actor_id && ctx.pmap.has(c.actor_id) ? c.actor_id : null,
      entity_id: c.actor_id && !ctx.pmap.has(c.actor_id) ? c.actor_id : null,
      name: c.actor_name ?? c.beneficiary ?? "(population)",
      kind: c.beneficiary_kind ?? "lead",
    },
    score: c.signal_score ?? 0,
    fingerprint: `${c.vector}|${c.actor_id ?? ""}|${c.beneficiary ?? ""}`,
    headline: c.headline,
    rationale: c.detail ?? c.headline,
    evidence: [
      ...(c.data?.evidence_ids ?? []).map((eid) => evidenceRef(eid, "source row this signal was computed from")),
      ...(c.evidence_urls ?? []).map((u) => ({ url: u, note: "source cited by the detector" })),
    ],
    data: c.data ?? {},
    lead: c,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// THE DETECTOR REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
export const DETECTORS = [
  // ───────────────────────── Wrapped legacy detectors ────────────────────────
  {
    id: "conflict", label: "Conflict vectors (office × interests)", category: "legacy",
    desc: "The 5 hand-coded conflict shapes: regulatory self-dealing, project front-running, dynasty, donor reward, struck-off links.",
    tunables: legacyTunables(CONFLICT_DEFAULTS, {
      PROPERTY_MIN_VALUE: { label: "Property floor (₹)", desc: "Min property value for a weak location-only front-running lead (default ₹1 Cr)." },
      DYNASTY_SCORE: { label: "Dynasty score", desc: "Fixed score for a relative-holds-office link." },
      STRUCK_OFF_SCORE: { label: "Struck-off score", desc: "Fixed score for a struck-off company in a covered sector." },
    }),
    run(ctx, S) {
      const ov = legacyOverrides(S, CONFLICT_DEFAULTS);
      const out = [];
      for (const p of ctx.politicians) {
        try {
          const { leads } = detectConflicts(p, ctx.evidenceFor(p.id), null, null, ov);
          out.push(...fromLegacy(leads, ctx));
        } catch { /* per-rep isolation */ }
      }
      return out;
    },
  },
  {
    id: "asset_outlier", label: "Asset-growth outlier (cohort z)", category: "legacy",
    desc: "Declared-asset growth ratio far above the state/party cohort.",
    tunables: legacyTunables(
      { MIN_COHORT_N: ANOMALY_DEFAULTS.MIN_COHORT_N, ASSET_Z_MIN: ANOMALY_DEFAULTS.ASSET_Z_MIN, ASSET_ABS_MIN: ANOMALY_DEFAULTS.ASSET_ABS_MIN },
      { ASSET_Z_MIN: { label: "Z threshold", desc: "Std-devs above cohort mean to flag." }, ASSET_ABS_MIN: { label: "Min jump (₹)", desc: "Minimum absolute asset jump (default ₹2 Cr)." }, MIN_COHORT_N: { label: "Min cohort" } }),
    run(ctx, S) {
      const ov = { MIN_COHORT_N: S.MIN_COHORT_N, ASSET_Z_MIN: S.ASSET_Z_MIN, ASSET_ABS_MIN: S.ASSET_ABS_MIN };
      const records = [];
      for (const p of ctx.politicians) {
        const cohort = ctx.cohortOf(p);
        for (const e of ctx.evidenceFor(p.id)) {
          const n = e.numbers;
          if (!n || e.source_type !== "eci_affidavit") continue;
          if (n.total_assets == null || n.election_year == null) continue;
          records.push({ politician_id: p.id, name: p.name, cohort, year: n.election_year, assets_total: n.total_assets, evidence_id: e.id });
        }
      }
      return fromLegacy(detectAssetGrowthOutliers(records, ov), ctx);
    },
  },
  {
    id: "fund_utilization", label: "MPLADS utilisation extremes", category: "legacy",
    desc: "Constituency-fund spend near 0% (parked) or ~100% (to the rupee).",
    tunables: legacyTunables(
      { UTIL_LOW_PCT: ANOMALY_DEFAULTS.UTIL_LOW_PCT, UTIL_HIGH_PCT: ANOMALY_DEFAULTS.UTIL_HIGH_PCT, UTIL_MIN_FUND: ANOMALY_DEFAULTS.UTIL_MIN_FUND },
      { UTIL_LOW_PCT: { label: "Low tail %", desc: "Flag utilisation below this %." }, UTIL_HIGH_PCT: { label: "High tail %", desc: "Flag utilisation above this %." }, UTIL_MIN_FUND: { label: "Min fund (₹)", desc: "Only material when the fund is ≥ this (default ₹1 Cr)." } }),
    run(ctx, S) {
      const ov = { UTIL_LOW_PCT: S.UTIL_LOW_PCT, UTIL_HIGH_PCT: S.UTIL_HIGH_PCT, UTIL_MIN_FUND: S.UTIL_MIN_FUND };
      const records = [];
      for (const p of ctx.politicians) {
        for (const e of ctx.evidenceFor(p.id)) {
          const n = e.numbers;
          if (!n || e.source_type !== "mplads") continue;
          if (n.utilization_pct == null || n.allocated == null) continue;
          records.push({ politician_id: p.id, name: p.name, utilization_pct: n.utilization_pct, allocated: n.allocated, evidence_id: e.id });
        }
      }
      return fromLegacy(detectUtilizationExtremes(records, ov), ctx);
    },
  },
  {
    id: "timing_correlation", label: "Donation → award timing", category: "legacy",
    desc: "Electoral-bond purchase within N days of a government award to the donor (or a sister company sharing a director).",
    tunables: legacyTunables(
      { TIMING_WINDOW_DAYS: ANOMALY_DEFAULTS.TIMING_WINDOW_DAYS },
      { TIMING_WINDOW_DAYS: { label: "Window (days)", desc: "Max days between bond purchase and award." } }),
    run(ctx, S) {
      const rows = db.prepare("SELECT * FROM events WHERE kind IN ('bond_purchase','awarded_tender')").all();
      const events = rows.map((r) => {
        const ids = (() => { try { return JSON.parse(r.entity_ids); } catch { return []; } })();
        return r.kind === "bond_purchase"
          ? { kind: r.kind, at: r.at, donor_entity_id: ids[0], party_entity_id: ids[1], evidence_id: r.evidence_id }
          : { kind: r.kind, at: r.at, awardee_entity_id: ids[0], evidence_id: r.evidence_id };
      });
      const directorsOf = new Map();
      for (const e of ctx.relationsByType("director_of")) {
        (directorsOf.get(e.dst_entity_id) ?? directorsOf.set(e.dst_entity_id, new Set()).get(e.dst_entity_id)).add(e.src_entity_id);
      }
      const sharesDirector = (a, b) => {
        if (!a || !b || a === b) return false;
        const da = directorsOf.get(a), dbs = directorsOf.get(b);
        if (!da || !dbs) return false;
        for (const d of da) if (dbs.has(d)) return true;
        return false;
      };
      return fromLegacy(detectTimingCorrelation(events, { sharesDirector, TIMING_WINDOW_DAYS: S.TIMING_WINDOW_DAYS }), ctx);
    },
  },
  {
    id: "income_outlier", label: "Income-growth outlier (cohort z)", category: "legacy",
    desc: "Declared-income time-series growth far above cohort (ledger-native).",
    tunables: legacyTunables(
      { MIN_COHORT_N: LEDGER_DEFAULTS.MIN_COHORT_N, INCOME_Z_MIN: LEDGER_DEFAULTS.INCOME_Z_MIN, INCOME_ABS_MIN: LEDGER_DEFAULTS.INCOME_ABS_MIN, INCOME_BASE_MIN: LEDGER_DEFAULTS.INCOME_BASE_MIN },
      { INCOME_Z_MIN: { label: "Z threshold" }, INCOME_ABS_MIN: { label: "Min jump (₹)", desc: "default ₹10 L" }, INCOME_BASE_MIN: { label: "Min base (₹)", desc: "default ₹1 L" }, MIN_COHORT_N: { label: "Min cohort" } }),
    run(ctx, S) {
      const ov = { MIN_COHORT_N: S.MIN_COHORT_N, INCOME_Z_MIN: S.INCOME_Z_MIN, INCOME_ABS_MIN: S.INCOME_ABS_MIN, INCOME_BASE_MIN: S.INCOME_BASE_MIN };
      const records = [];
      for (const [pid, rows] of ctx.seriesByPolitician("declared_income")) {
        const p = ctx.pmap.get(pid);
        for (const r of rows) records.push({ politician_id: pid, name: p.name, cohort: ctx.cohortOf(p), year: r.year, income: r.value, evidence_id: r.evidence_id });
      }
      return fromLegacy(detectIncomeGrowthOutliers(records, ov), ctx);
    },
  },
  {
    id: "spend_vs_income", label: "Campaign spend vs income (cohort z)", category: "legacy",
    desc: "Election expenditure many multiples of declared annual income, outlier within cohort.",
    tunables: legacyTunables(
      { MIN_COHORT_N: LEDGER_DEFAULTS.MIN_COHORT_N, SPEND_MIN: LEDGER_DEFAULTS.SPEND_MIN, SPEND_RATIO_FLOOR: LEDGER_DEFAULTS.SPEND_RATIO_FLOOR, SPEND_Z_MIN: LEDGER_DEFAULTS.SPEND_Z_MIN, SPEND_RATIO_HARD: LEDGER_DEFAULTS.SPEND_RATIO_HARD },
      { SPEND_MIN: { label: "Min spend (₹)", desc: "default ₹10 L" }, SPEND_RATIO_FLOOR: { label: "Ratio pre-filter" }, SPEND_Z_MIN: { label: "Z threshold" }, SPEND_RATIO_HARD: { label: "Hard ratio", desc: "small-cohort fallback flag" }, MIN_COHORT_N: { label: "Min cohort" } }),
    run(ctx, S) {
      const ov = { MIN_COHORT_N: S.MIN_COHORT_N, SPEND_MIN: S.SPEND_MIN, SPEND_RATIO_FLOOR: S.SPEND_RATIO_FLOOR, SPEND_Z_MIN: S.SPEND_Z_MIN, SPEND_RATIO_HARD: S.SPEND_RATIO_HARD };
      const spendBy = new Map();
      for (const [pid, rows] of ctx.seriesByPolitician("election_expenditure")) spendBy.set(pid, rows.at(-1));
      const records = [];
      for (const [pid, spend] of spendBy) {
        const p = ctx.pmap.get(pid);
        const income = (ctx.seriesByPolitician("declared_income").get(pid) ?? []).at(-1);
        if (!income) continue;
        records.push({
          politician_id: pid, name: p.name, cohort: ctx.cohortOf(p),
          spend: spend.value, income: income.value, spend_year: spend.year, income_year: income.year,
          evidence_ids: [spend.evidence_id, income.evidence_id].filter(Boolean),
        });
      }
      return fromLegacy(detectSpendVsIncome(records, ov), ctx);
    },
  },
  {
    id: "multi_source_adverse", label: "Multi-source adverse mentions", category: "legacy",
    desc: "One person named across several independent adverse source types (court + CBI + leak + …).",
    tunables: legacyTunables(
      { MULTI_SOURCE_MIN: LEDGER_DEFAULTS.MULTI_SOURCE_MIN },
      { MULTI_SOURCE_MIN: { label: "Min distinct sources", desc: "Distinct adverse source types before flagging." } }),
    run(ctx, S) {
      const ov = { MULTI_SOURCE_MIN: S.MULTI_SOURCE_MIN };
      const ADVERSE = [
        "named_in_court_judgment", "named_in_sec_filing", "named_in_offshore_leak",
        "named_in_government_contract", "named_in_cbi_action",
        "linked_electoral_bond_purchase", "linked_electoral_bond_encashment", "news_allegation",
      ];
      const rows = db.prepare(`
        SELECT c.source_type, c.claim_type, c.evidence_id, json_extract(e.strong_ids,'$.politician_id') pid
        FROM claims c JOIN entities e ON e.id = c.subject_entity_id
        WHERE c.claim_type IN (${ADVERSE.map(() => "?").join(",")})
          AND json_extract(e.strong_ids,'$.politician_id') IS NOT NULL
      `).all(...ADVERSE);
      const byPol = new Map();
      for (const r of rows) {
        const p = ctx.pmap.get(r.pid);
        if (!p) continue;
        const rec = byPol.get(r.pid) ?? byPol.set(r.pid, { politician_id: r.pid, name: p.name, sources: new Set(), claim_types: new Set(), evidence_ids: [] }).get(r.pid);
        if (r.source_type) rec.sources.add(r.source_type);
        if (r.claim_type) rec.claim_types.add(r.claim_type);
        if (r.evidence_id) rec.evidence_ids.push(r.evidence_id);
      }
      return fromLegacy(detectMultiSourceAdverse([...byPol.values()], ov), ctx);
    },
  },
  {
    id: "collusion", label: "Shared-address clusters + collusive bidding", category: "legacy",
    desc: "Companies sharing a registered PIN + address token; multiple bidders on one tender from one cluster.",
    tunables: T(),
    run(ctx) {
      const companies = [];
      for (const p of ctx.politicians) {
        for (const e of ctx.evidenceFor(p.id)) {
          if (e.source_type === "mca_company" && Array.isArray(e.numbers?.companies)) {
            for (const c of e.numbers.companies) companies.push({ ...c, source_url: c.source_url ?? e.url });
          }
        }
      }
      return fromLegacy(detectCollusion({ companies, tenders: [] }).leads, ctx);
    },
  },

  // ───────────────────────────── New detectors ──────────────────────────────
  {
    id: "da_ratio", label: "Disproportionate assets (check-period)", category: "wealth",
    desc: "The CBI DA shape: asset growth between two affidavits vs total declared income over the same years. Growth far beyond plausible savings is the classic disproportionate-assets marker.",
    tunables: T({
      savingsRate: { label: "Savings rate", type: "number", def: 1.0, min: 0.1, max: 1.5, step: 0.1, desc: "Fraction of declared income assumed savable (1.0 = every rupee, maximally conservative)." },
      minExcessMultiple: { label: "Flag multiple", type: "number", def: 1.5, min: 1, max: 20, desc: "Flag when asset growth ≥ this × plausible savings." },
      bigExcessMultiple: { label: "Big multiple", type: "number", def: 3, min: 1, max: 50, desc: "BIG when growth ≥ this × plausible savings." },
      absMin: { label: "Min growth (₹)", type: "number", def: 1e7, min: 0, desc: "Ignore growth below this many rupees (noise floor)." },
    }),
    run(ctx, S) {
      const out = [];
      const assets = ctx.seriesByPolitician("declared_assets");
      const incomes = ctx.seriesByPolitician("declared_income");
      for (const [pid, rows] of assets) {
        const p = ctx.pmap.get(pid);
        const inc = incomes.get(pid) ?? [];
        for (let i = 1; i < rows.length; i++) {
          const a0 = rows[i - 1], a1 = rows[i];
          const gapYears = Math.max(1, a1.year - a0.year);
          const growth = a1.value - a0.value;
          if (growth < S.absMin) continue;
          // Income over the check period: known in-window incomes, else the
          // nearest known annual income, extrapolated across the gap.
          const inWindow = inc.filter((r) => r.year > a0.year && r.year <= a1.year);
          const annual = inWindow.length
            ? inWindow.reduce((s, r) => s + r.value, 0) / inWindow.length
            : (inc.at(-1)?.value ?? null);
          if (annual == null || annual <= 0) continue;
          const plausible = annual * gapYears * S.savingsRate;
          const multiple = growth / plausible;
          if (multiple < S.minExcessMultiple) continue;
          const score = Math.min(Math.round(10 + multiple * 4 + growth / (2 * CR)), 60);
          out.push({
            subject: { politician_id: pid, name: p.name, kind: "person" },
            score,
            fingerprint: `${a0.year}-${a1.year}`,
            headline: `Assets grew ₹${(growth / CR).toFixed(2)} Cr over ${a0.year}→${a1.year} — ${multiple.toFixed(1)}× the total declared income for that period.`,
            rationale: `Check period ${a0.year}→${a1.year} (${gapYears}y): declared assets ₹${(a0.value / CR).toFixed(2)} Cr → ₹${(a1.value / CR).toFixed(2)} Cr (growth ₹${(growth / CR).toFixed(2)} Cr). Declared annual income ≈₹${(annual / L).toFixed(1)} L → plausible savings ≤ ₹${(plausible / CR).toFixed(2)} Cr at a ${Math.round(S.savingsRate * 100)}% savings rate. Growth is ${multiple.toFixed(1)}× plausible savings. This is the disproportionate-assets check-period shape — a candidate for review, not a finding (undeclared legitimate sources, spouse income, inheritance or asset revaluation can all explain it).`,
            evidence: [
              evidenceRef(a0.evidence_id, `${a0.year} affidavit: declared assets ₹${(a0.value / CR).toFixed(2)} Cr`),
              evidenceRef(a1.evidence_id, `${a1.year} affidavit: declared assets ₹${(a1.value / CR).toFixed(2)} Cr`),
              ...inWindow.slice(0, 3).map((r) => evidenceRef(r.evidence_id, `${r.year} declared income ₹${(r.value / L).toFixed(1)} L`)),
            ],
            data: { statistic: "da_check_period", from_year: a0.year, to_year: a1.year, growth, annual_income: annual, plausible_savings: plausible, multiple },
            severityOverride: multiple >= S.bigExcessMultiple ? "big" : null,
          });
        }
      }
      return out;
    },
  },
  {
    id: "liability_spike", label: "Liability spike", category: "wealth",
    desc: "Declared liabilities jumping several-fold between affidavits — heavy fresh borrowing can be leverage, distress, or a layering vehicle.",
    tunables: T({
      ratioMin: { label: "Flag ratio", type: "number", def: 3, min: 1.1, max: 50, desc: "Flag when liabilities grew ≥ this ×." },
      bigRatio: { label: "Big ratio", type: "number", def: 8, min: 2, max: 100, desc: "BIG at/above this ×." },
      absMin: { label: "Min jump (₹)", type: "number", def: 5e6, min: 0, desc: "Ignore jumps below this many rupees." },
    }),
    run(ctx, S) {
      const out = [];
      for (const [pid, rows] of ctx.seriesByPolitician("declared_liabilities")) {
        const p = ctx.pmap.get(pid);
        for (let i = 1; i < rows.length; i++) {
          const l0 = rows[i - 1], l1 = rows[i];
          if (!l0.value || l0.value <= 0) continue;
          const ratio = l1.value / l0.value, jump = l1.value - l0.value;
          if (ratio < S.ratioMin || jump < S.absMin) continue;
          const score = Math.min(Math.round(8 + ratio * 2 + jump / (2 * CR)), 50);
          out.push({
            subject: { politician_id: pid, name: p.name, kind: "person" },
            score,
            fingerprint: `${l0.year}-${l1.year}`,
            headline: `Declared liabilities grew ${ratio.toFixed(1)}× (₹${(jump / CR).toFixed(2)} Cr) between ${l0.year} and ${l1.year}.`,
            rationale: `Liabilities ₹${(l0.value / CR).toFixed(2)} Cr (${l0.year}) → ₹${(l1.value / CR).toFixed(2)} Cr (${l1.year}). Fresh borrowing at this scale deserves a look at who the lender is and what secured it — a candidate for review, not a finding.`,
            evidence: [
              evidenceRef(l0.evidence_id, `${l0.year} affidavit: liabilities ₹${(l0.value / CR).toFixed(2)} Cr`),
              evidenceRef(l1.evidence_id, `${l1.year} affidavit: liabilities ₹${(l1.value / CR).toFixed(2)} Cr`),
            ],
            data: { statistic: "liability_spike", ratio, jump, from_year: l0.year, to_year: l1.year },
            severityOverride: ratio >= S.bigRatio ? "big" : null,
          });
        }
      }
      return out;
    },
  },
  {
    id: "criminal_escalation", label: "Criminal-case escalation", category: "legal",
    desc: "Self-declared criminal cases rising across affidavits, or a high absolute count.",
    tunables: T({
      minCases: { label: "Flag at cases", type: "number", def: 3, min: 1, max: 50, desc: "Flag when the latest declared case count is ≥ this." },
      bigCases: { label: "Big at cases", type: "number", def: 8, min: 2, max: 100, desc: "BIG at/above this many cases." },
      bigJump: { label: "Big at increase", type: "number", def: 5, min: 1, max: 50, desc: "BIG when cases grew by ≥ this between affidavits." },
    }),
    run(ctx, S) {
      const out = [];
      for (const [pid, rows] of ctx.seriesByPolitician("criminal_cases")) {
        const p = ctx.pmap.get(pid);
        const first = rows[0], last = rows.at(-1);
        if (last.value < S.minCases) continue;
        const jump = rows.length > 1 ? last.value - first.value : 0;
        const score = Math.min(Math.round(6 + last.value * 2 + jump * 2), 50);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `${last.year}`,
          headline: rows.length > 1 && jump > 0
            ? `Declared criminal cases rose from ${first.value} (${first.year}) to ${last.value} (${last.year}).`
            : `Declares ${last.value} criminal case(s) (${last.year} affidavit).`,
          rationale: `Sworn affidavit case counts: ${rows.map((r) => `${r.year}: ${r.value}`).join(" → ")}. Charges are not convictions; a rising or high count is context for the investigator, not a finding.`,
          evidence: rows.slice(-3).map((r) => evidenceRef(r.evidence_id, `${r.year} affidavit: ${r.value} declared case(s)`)),
          data: { statistic: "criminal_cases", series: rows.map((r) => ({ year: r.year, value: r.value })), jump },
          severityOverride: (last.value >= S.bigCases || jump >= S.bigJump) ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "expenditure_limit", label: "Election-spend vs legal cap", category: "electoral",
    desc: "ADR's finding: nearly all candidates declare 45–55% of the legal cap. The tails are the anomalies — spend AT the cap, or implausibly far below it.",
    tunables: T({
      capLs: { label: "LS cap (₹)", type: "number", def: 9.5e6, min: 1e6, desc: "Lok Sabha expenditure limit (₹95 lakh, large states)." },
      capOther: { label: "Assembly cap (₹)", type: "number", def: 4e6, min: 1e6, desc: "Assembly expenditure limit (₹40 lakh, large states)." },
      highPct: { label: "High tail %", type: "number", def: 90, min: 50, max: 100, desc: "Flag spend above this % of the cap." },
      lowPct: { label: "Low tail %", type: "number", def: 25, min: 1, max: 50, desc: "Flag spend below this % of the cap (under-declaration marker for a sitting winner)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 35 },
    }),
    run(ctx, S) {
      const out = [];
      for (const [pid, rows] of ctx.seriesByPolitician("election_expenditure")) {
        const p = ctx.pmap.get(pid);
        const last = rows.at(-1);
        const cap = /MP|Lok/i.test(p.office ?? "") ? S.capLs : S.capOther;
        const pct = (last.value / cap) * 100;
        const high = pct >= S.highPct && pct <= 130; // >130% is usually a unit error, not a signal
        const low = pct > 0 && pct <= S.lowPct;
        if (!high && !low) continue;
        const score = Math.min(Math.round(high ? 8 + (pct - S.highPct) : 6 + (S.lowPct - pct) / 2), 30);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `${last.year}-${high ? "high" : "low"}`,
          headline: high
            ? `Declared election spend is ${pct.toFixed(0)}% of the legal cap (₹${(last.value / L).toFixed(1)} L of ₹${(cap / L).toFixed(0)} L).`
            : `Declared election spend is only ${pct.toFixed(0)}% of the legal cap — the under-declaration tail (a sitting winner declaring ₹${(last.value / L).toFixed(1)} L).`,
          rationale: `ADR's affidavit analyses show ~99% of candidates declare 45–55% of the cap; both tails are unusual. ${high ? "Spending right at the cap is rare in declared data." : "A winning campaign declared at a fraction of the cap is the classic under-reporting shape (real spend is widely acknowledged to exceed declarations)."} Candidate for review, not a finding.`,
          evidence: [evidenceRef(last.evidence_id, `${last.year} expenditure declaration: ₹${(last.value / L).toFixed(1)} L`)],
          data: { statistic: "expenditure_vs_cap", pct, cap, spend: last.value, year: last.year, tail: high ? "high" : "low" },
        });
      }
      return out;
    },
  },
  {
    id: "asset_income_mismatch", label: "Assets vs income mismatch", category: "wealth",
    desc: "Latest declared assets worth an implausible number of years of declared income — works even with a single affidavit (no growth series needed).",
    tunables: T({
      yearsMin: { label: "Flag at years-of-income", type: "number", def: 40, min: 5, max: 500, desc: "Flag when assets ≥ this many years of declared annual income." },
      bigYears: { label: "Big at years", type: "number", def: 100, min: 10, max: 1000, desc: "BIG at/above this many years." },
      absMin: { label: "Min assets (₹)", type: "number", def: 5e7, min: 0, desc: "Ignore below this many rupees of assets." },
    }),
    run(ctx, S) {
      const out = [];
      const incomes = ctx.seriesByPolitician("declared_income");
      for (const [pid, rows] of ctx.seriesByPolitician("declared_assets")) {
        const p = ctx.pmap.get(pid);
        const a = rows.at(-1);
        const inc = (incomes.get(pid) ?? []).at(-1);
        if (!inc || inc.value <= 0 || a.value < S.absMin) continue;
        const years = a.value / inc.value;
        if (years < S.yearsMin) continue;
        const score = Math.min(Math.round(8 + years / 10 + a.value / (10 * CR)), 55);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `${a.year}`,
          headline: `Declared assets (₹${(a.value / CR).toFixed(2)} Cr) equal ~${Math.round(years)} years of declared income (₹${(inc.value / L).toFixed(1)} L/yr).`,
          rationale: `Latest affidavit (${a.year}): assets ₹${(a.value / CR).toFixed(2)} Cr against declared annual income ₹${(inc.value / L).toFixed(1)} L (${inc.year}) — a ${Math.round(years)}-year multiple. Inheritance, spouse income or old wealth can explain it; the multiple only ranks who is worth a closer look.`,
          evidence: [
            evidenceRef(a.evidence_id, `${a.year} affidavit: assets ₹${(a.value / CR).toFixed(2)} Cr`),
            evidenceRef(inc.evidence_id, `${inc.year} declared income ₹${(inc.value / L).toFixed(1)} L`),
          ],
          data: { statistic: "asset_income_years", years, assets: a.value, income: inc.value },
          severityOverride: years >= S.bigYears ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "young_wealth", label: "Young wealth", category: "wealth",
    desc: "Large declared assets at an unusually young age — a thin work history makes big wealth harder to explain.",
    tunables: T({
      maxAge: { label: "Max age", type: "number", def: 40, min: 25, max: 60, desc: "Only flag reps at/under this age at declaration." },
      minAssets: { label: "Min assets (₹)", type: "number", def: 1e8, min: 1e6, desc: "Flag assets at/above this (₹10 Cr default)." },
      bigAssets: { label: "Big assets (₹)", type: "number", def: 5e8, min: 1e7, desc: "BIG at/above this (₹50 Cr default)." },
    }),
    run(ctx, S) {
      const out = [];
      const births = ctx.seriesByPolitician("birth_year");
      for (const [pid, rows] of ctx.seriesByPolitician("declared_assets")) {
        const p = ctx.pmap.get(pid);
        const birth = (births.get(pid) ?? []).at(-1)?.value;
        const a = rows.at(-1);
        if (!birth || !a) continue;
        const age = a.year - birth;
        if (age <= 0 || age > S.maxAge || a.value < S.minAssets) continue;
        const score = Math.min(Math.round(10 + a.value / (5 * CR) + (S.maxAge - age)), 50);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `${a.year}`,
          headline: `Declared ₹${(a.value / CR).toFixed(1)} Cr in assets at age ~${age}.`,
          rationale: `Born ${birth}; the ${a.year} affidavit declares ₹${(a.value / CR).toFixed(2)} Cr. Substantial wealth accumulated young is worth asking how — family wealth and genuine business success are common, benami holding is the adverse shape. Candidate for review, not a finding.`,
          evidence: [evidenceRef(a.evidence_id, `${a.year} affidavit: assets ₹${(a.value / CR).toFixed(2)} Cr at age ~${age}`)],
          data: { statistic: "young_wealth", age, assets: a.value, birth_year: birth },
          severityOverride: a.value >= S.bigAssets ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "benford", label: "Benford first-digit screen", category: "forensic",
    desc: "First-digit distribution of a subject's declared financial numbers vs Benford's law — chi-square AND Nigrini MAD must both trip. Needs enough numbers, so it mostly fires on parties.",
    tunables: T({
      minN: { label: "Min numbers", type: "number", def: 40, min: 20, max: 500, desc: "Minimum count of numbers before the test is meaningful." },
      chi2Flag: { label: "Chi² flag", type: "number", def: 15.51, min: 5, desc: "Chi-square (8 dof) threshold — 15.51 ≈ p 0.05." },
      chi2Big: { label: "Chi² big", type: "number", def: 20.09, min: 10, desc: "20.09 ≈ p 0.01." },
      madFlag: { label: "MAD flag", type: "number", def: 0.012, min: 0.001, max: 0.1, step: 0.001, desc: "Nigrini marginal-conformity band starts at 0.012." },
      madBig: { label: "MAD big", type: "number", def: 0.015, min: 0.001, max: 0.1, step: 0.001, desc: "Nigrini nonconformity starts at 0.015." },
    }),
    run(ctx, S) {
      const out = [];
      // Group every fact value by entity (parties accumulate line items fast).
      const rows = db.prepare(`
        SELECT f.value, f.entity_id, f.evidence_id, e.canonical_name name, e.kind,
               json_extract(e.strong_ids,'$.politician_id') pid
        FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.value IS NOT NULL AND f.value >= 1000
      `).all();
      const byEntity = new Map();
      for (const r of rows) {
        const g = byEntity.get(r.entity_id) ?? byEntity.set(r.entity_id, { name: r.name, kind: r.kind, pid: r.pid, values: [], evidence: new Set() }).get(r.entity_id);
        g.values.push(r.value);
        if (r.evidence_id) g.evidence.add(r.evidence_id);
      }
      for (const [entity_id, g] of byEntity) {
        const stats = benfordStats(g.values, { minN: S.minN });
        if (!stats) continue;
        if (stats.chi2 < S.chi2Flag || stats.mad < S.madFlag) continue;
        const score = Math.min(Math.round(8 + (stats.chi2 - S.chi2Flag) + stats.mad * 1000), 45);
        out.push({
          subject: { politician_id: g.pid ?? null, entity_id: g.pid ? null : entity_id, name: g.name, kind: g.kind },
          score,
          fingerprint: `n${stats.n}`,
          headline: `${g.name}'s ${stats.n} declared financial figures deviate from Benford's law (χ²=${stats.chi2.toFixed(1)}, MAD=${stats.mad.toFixed(4)}).`,
          rationale: `First-digit test over ${stats.n} ledger values: chi-square ${stats.chi2.toFixed(1)} (flag ≥ ${S.chi2Flag}) and MAD ${stats.mad.toFixed(4)} (Nigrini marginal band ≥ ${S.madFlag}, nonconformity ≥ ${S.madBig}). Digit counts [1→9]: ${stats.counts.join(", ")}. Benford deviation is a screening signal used in forensic accounting — legitimate data can deviate (assigned amounts, caps); it ranks what deserves a manual look, nothing more.`,
          evidence: [...g.evidence].slice(0, 5).map((eid) => evidenceRef(eid, "one of the source rows whose figures fed the digit test")),
          data: { statistic: "benford", ...stats },
          severityOverride: (stats.chi2 >= S.chi2Big && stats.mad >= S.madBig) ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "parliament_inactivity", label: "Parliamentary inactivity (cohort z)", category: "conduct",
    desc: "Questions asked + debates joined both far below the office cohort. Small flags only — inactivity is context, not corruption.",
    tunables: T({
      zMin: { label: "Z below mean", type: "number", def: 1.5, min: 0.5, max: 4, step: 0.1, desc: "Flag when BOTH metrics sit ≥ this many σ below the cohort mean." },
      minCohort: { label: "Min cohort", type: "number", def: 8, min: 3, max: 100, desc: "Cohort size needed for a stable z-score." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 }, // small-only by default
    }),
    run(ctx, S) {
      const q = ctx.seriesByPolitician("questions_asked");
      const d = ctx.seriesByPolitician("debates_participated");
      const rows = [];
      for (const [pid, qs] of q) {
        const p = ctx.pmap.get(pid);
        const ds = d.get(pid) ?? [];
        rows.push({ pid, p, office: p.office ?? "?", qv: qs.at(-1)?.value ?? null, dv: ds.at(-1)?.value ?? null, qe: qs.at(-1)?.evidence_id, de: ds.at(-1)?.evidence_id });
      }
      const byOffice = new Map();
      for (const r of rows) (byOffice.get(r.office) ?? byOffice.set(r.office, []).get(r.office)).push(r);
      const out = [];
      for (const [office, rs] of byOffice) {
        if (rs.length < S.minCohort) continue;
        const qStat = meanStd(rs.map((r) => r.qv ?? 0));
        const dStat = meanStd(rs.map((r) => r.dv ?? 0));
        if (qStat.std === 0 || dStat.std === 0) continue;
        for (const r of rs) {
          const zq = ((r.qv ?? 0) - qStat.mean) / qStat.std;
          const zd = ((r.dv ?? 0) - dStat.mean) / dStat.std;
          if (zq > -S.zMin || zd > -S.zMin) continue;
          const score = Math.min(Math.round(5 + Math.abs(zq + zd) * 3), 25);
          out.push({
            subject: { politician_id: r.pid, name: r.p.name, kind: "person" },
            score,
            fingerprint: office,
            headline: `Parliamentary activity far below the ${office} cohort: questions z=${zq.toFixed(1)}, debates z=${zd.toFixed(1)}.`,
            rationale: `Questions asked ${r.qv ?? 0} (cohort mean ${qStat.mean.toFixed(0)}), debates ${r.dv ?? 0} (mean ${dStat.mean.toFixed(0)}), cohort n=${rs.length}. Low chamber activity alone proves nothing — it's a context flag that strengthens clusters, never a lead by itself.`,
            evidence: [r.qe && evidenceRef(r.qe, "parliamentary questions record"), r.de && evidenceRef(r.de, "debates record")].filter(Boolean),
            data: { statistic: "parliament_inactivity", zq, zd, questions: r.qv, debates: r.dv, cohort: office, cohort_n: rs.length },
          });
        }
      }
      return out;
    },
  },
  {
    id: "mplads_completion_gap", label: "MPLADS works-completion gap", category: "funds",
    desc: "Many works recommended, few completed — funds moving without outcomes (complements the utilisation-extremes detector).",
    tunables: T({
      pctMin: { label: "Flag below %", type: "number", def: 40, min: 5, max: 90, desc: "Flag when completed/recommended falls below this %." },
      bigPct: { label: "Big below %", type: "number", def: 15, min: 1, max: 50, desc: "BIG below this %." },
      minWorks: { label: "Min works", type: "number", def: 20, min: 1, desc: "Only when at least this many works were recommended." },
    }),
    run(ctx, S) {
      const rec = ctx.seriesByPolitician("mplads_works_recommended");
      const done = ctx.seriesByPolitician("mplads_works_completed");
      const out = [];
      for (const [pid, rrows] of rec) {
        const p = ctx.pmap.get(pid);
        const r = rrows.at(-1), c = (done.get(pid) ?? []).at(-1);
        if (!r || !c || r.value < S.minWorks) continue;
        const pct = (c.value / r.value) * 100;
        if (pct >= S.pctMin) continue;
        const score = Math.min(Math.round(8 + (S.pctMin - pct) / 2 + r.value / 50), 40);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `${r.year ?? "latest"}`,
          headline: `Only ${pct.toFixed(0)}% of recommended MPLADS works completed (${c.value} of ${r.value}).`,
          rationale: `${r.value} works recommended, ${c.value} completed — a ${pct.toFixed(0)}% completion rate below the ${S.pctMin}% flag line. Chronic non-completion can be administrative, or can mark funds recommended toward works that were never meant to finish. Candidate for review.`,
          evidence: [
            evidenceRef(r.evidence_id, `MPLADS record: ${r.value} works recommended`),
            evidenceRef(c.evidence_id, `MPLADS record: ${c.value} works completed`),
          ],
          data: { statistic: "mplads_completion", pct, recommended: r.value, completed: c.value },
          severityOverride: pct < S.bigPct ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "nominee_director", label: "Nominee-director / shell markers", category: "network",
    desc: "ICIJ shape: one person directing many politician-linked companies (nominee marker), weighted up when their companies are struck-off/dormant.",
    tunables: T({
      minDirectorships: { label: "Flag at directorships", type: "number", def: 6, min: 2, max: 100, desc: "Flag a person directing ≥ this many linked companies." },
      bigDirectorships: { label: "Big at directorships", type: "number", def: 12, min: 3, max: 200, desc: "BIG at/above this many." },
      struckBoost: { label: "Struck-off boost", type: "number", def: 5, min: 0, max: 30, desc: "Score added per struck-off company among theirs." },
    }),
    run(ctx, S) {
      const edges = ctx.relationsByType("director_of");
      const byPerson = new Map(); // person entity → { companies:Set, evidence:Set, struck:count }
      for (const e of edges) {
        const g = byPerson.get(e.src_entity_id) ?? byPerson.set(e.src_entity_id, { companies: new Set(), evidence: new Set(), struck: 0 }).get(e.src_entity_id);
        g.companies.add(e.dst_entity_id);
        if (e.evidence_id) g.evidence.add(e.evidence_id);
        try {
          const d = JSON.parse(e.data ?? "{}");
          if (/struck|dormant/i.test(d.status ?? "")) g.struck++;
        } catch { /* edge data optional */ }
      }
      const out = [];
      for (const [person, g] of byPerson) {
        if (g.companies.size < S.minDirectorships) continue;
        const ent = ctx.entityById(person);
        if (!ent) continue;
        const pid = (() => { try { return JSON.parse(ent.strong_ids ?? "{}").politician_id ?? null; } catch { return null; } })();
        const score = Math.min(Math.round(6 + g.companies.size * 2 + g.struck * S.struckBoost), 55);
        out.push({
          subject: { politician_id: pid, entity_id: pid ? null : person, name: ent.canonical_name, kind: ent.kind },
          score,
          fingerprint: `d${g.companies.size}`,
          headline: `${ent.canonical_name} holds ${g.companies.size} directorships across politician-linked companies${g.struck ? ` (${g.struck} struck-off/dormant)` : ""}.`,
          rationale: `${g.companies.size} director_of edges in the relationship ledger${g.struck ? `, ${g.struck} of the companies struck-off or dormant` : ""}. Serial directorships are the nominee-director marker from the offshore-leaks playbook — often legitimate professional directors, occasionally the hub of a shell network. Candidate for review.`,
          evidence: [...g.evidence].slice(0, 6).map((eid) => evidenceRef(eid, "directorship source row")),
          data: { statistic: "nominee_director", directorships: g.companies.size, struck_off: g.struck },
          severityOverride: g.companies.size >= S.bigDirectorships ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "award_concentration", label: "Award concentration", category: "network",
    desc: "Open-contracting red flag: one awardee entity winning many government awards in the ledger.",
    tunables: T({
      minAwards: { label: "Flag at awards", type: "number", def: 3, min: 2, max: 50, desc: "Flag an awardee named on ≥ this many government awards." },
      bigAwards: { label: "Big at awards", type: "number", def: 6, min: 3, max: 100, desc: "BIG at/above this many." },
    }),
    run(ctx, S) {
      // Reads BOTH the (future) company-level `awarded_tender` kind and the
      // `government_contract_mention` kind the financial-links extractor actually
      // writes today (keyed to the politician entity named in a CPPP/GeM award).
      const byAwardee = new Map();
      for (const kind of ["awarded_tender", "government_contract_mention"]) {
        for (const ev of ctx.eventsByKind(kind)) {
          const ids = (() => { try { return JSON.parse(ev.entity_ids); } catch { return []; } })();
          if (!ids[0]) continue;
          const d = (() => { try { return JSON.parse(ev.data ?? "{}"); } catch { return {}; } })();
          const g = byAwardee.get(ids[0]) ?? byAwardee.set(ids[0], { count: 0, evidence: new Set(), dates: [], orgs: new Set() }).get(ids[0]);
          g.count++;
          if (ev.evidence_id) g.evidence.add(ev.evidence_id);
          if (ev.at) g.dates.push(ev.at);
          if (d.org) g.orgs.add(d.org);
        }
      }
      const out = [];
      for (const [entity_id, g] of byAwardee) {
        if (g.count < S.minAwards) continue;
        const ent = ctx.entityById(entity_id);
        if (!ent) continue;
        const pid = (() => { try { return JSON.parse(ent.strong_ids ?? "{}").politician_id ?? null; } catch { return null; } })();
        const dates = g.dates.filter(Boolean).sort();
        const score = Math.min(Math.round(8 + g.count * 4), 45);
        out.push({
          subject: { politician_id: pid, entity_id: pid ? null : entity_id, name: ent.canonical_name, kind: ent.kind },
          score,
          fingerprint: `a${g.count}`,
          headline: `${ent.canonical_name} is named on ${g.count} government contract awards${g.orgs.size ? ` across ${g.orgs.size} authority/authorities` : ""}.`,
          rationale: `${g.count} government-award events name this ${ent.kind} (${dates[0] ?? "?"} → ${dates.at(-1) ?? "?"}). Supplier/awardee concentration is a standard Open Contracting red flag — a dominant incumbent can be merit; paired with donations or shared directors it is the capture shape. Note: these award mentions are name-matched and identity-unverified — confirming the person is a job for the investigator.`,
          evidence: [...g.evidence].slice(0, 6).map((eid) => evidenceRef(eid, "government-award source row")),
          data: { statistic: "award_concentration", awards: g.count, authorities: [...g.orgs].slice(0, 10) },
          severityOverride: g.count >= S.bigAwards ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "bond_contract_proximity", label: "Bond purchase near a government award", category: "network",
    desc: "The same rep is linked to an electoral-bond purchase AND a government-contract award within a window — the donation-to-benefit timing shape, at the politician level (the company-level timing detector needs company-donor data we don't yet have).",
    tunables: T({
      windowDays: { label: "Window (days)", type: "number", def: 180, min: 7, max: 730, desc: "Max days between the bond purchase and the award." },
      bigWindow: { label: "Big within (days)", type: "number", def: 45, min: 1, max: 365, desc: "BIG when the two are within this many days." },
    }),
    run(ctx, S) {
      // Group both event kinds by politician entity, keeping dates + evidence.
      const bonds = new Map(), awards = new Map();
      const collect = (kind, into) => {
        for (const ev of ctx.eventsByKind(kind)) {
          if (!ev.at) continue;
          const ids = (() => { try { return JSON.parse(ev.entity_ids); } catch { return []; } })();
          if (!ids[0]) continue;
          (into.get(ids[0]) ?? into.set(ids[0], []).get(ids[0])).push(ev);
        }
      };
      collect("electoral_bond_purchase", bonds);
      collect("government_contract_mention", awards);
      const DAY = 86_400_000;
      const out = [];
      for (const [entity_id, bList] of bonds) {
        const aList = awards.get(entity_id);
        if (!aList) continue;
        const ent = ctx.entityById(entity_id);
        if (!ent) continue;
        const pid = (() => { try { return JSON.parse(ent.strong_ids ?? "{}").politician_id ?? null; } catch { return null; } })();
        // Closest bond/award pair.
        let best = null;
        for (const b of bList) for (const a of aList) {
          const days = Math.round(Math.abs(new Date(a.at) - new Date(b.at)) / DAY);
          if (!Number.isFinite(days)) continue;
          if (!best || days < best.days) best = { days, b, a };
        }
        if (!best || best.days > S.windowDays) continue;
        const score = Math.min(Math.round(12 + (S.windowDays - best.days) / 8), 45);
        out.push({
          subject: { politician_id: pid, entity_id: pid ? null : entity_id, name: ent.canonical_name, kind: ent.kind },
          score,
          fingerprint: `${best.b.at}~${best.a.at}`,
          headline: `${ent.canonical_name} is linked to an electoral-bond purchase and a government-contract award ${best.days} day(s) apart.`,
          rationale: `A bond purchase (${best.b.at}) and a government award mention (${best.a.at}) both name this rep, ${best.days} days apart. Both mentions are name-matched and identity-unverified; the proximity is a candidate for the investigator to confirm the identities and check for a mechanism — not a finding.`,
          evidence: [
            evidenceRef(best.b.evidence_id, `electoral-bond purchase mention (${best.b.at})`),
            evidenceRef(best.a.evidence_id, `government-award mention (${best.a.at})`),
          ],
          data: { statistic: "bond_contract_proximity", days_apart: best.days, bond_at: best.b.at, award_at: best.a.at },
          severityOverride: best.days <= S.bigWindow ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "family_adverse", label: "Family-member adverse links", category: "network",
    desc: "A relative (family_of edge) who is named in adverse sources or directs struck-off companies — the family-as-proxy shape.",
    tunables: T({
      bigClaims: { label: "Big at signals", type: "number", def: 3, min: 1, max: 20, desc: "BIG when family members accumulate ≥ this many adverse signals." },
    }),
    run(ctx, S) {
      const ADVERSE = ["named_in_court_judgment", "named_in_sec_filing", "named_in_offshore_leak", "named_in_government_contract", "named_in_cbi_action"];
      const family = ctx.relationsByType("family_of");
      const adverseClaims = ctx.claimsByTypes(ADVERSE);
      const claimsBySubject = new Map();
      for (const c of adverseClaims) {
        (claimsBySubject.get(c.subject_entity_id) ?? claimsBySubject.set(c.subject_entity_id, []).get(c.subject_entity_id)).push(c);
      }
      const directorships = new Map();
      for (const e of ctx.relationsByType("director_of")) {
        (directorships.get(e.src_entity_id) ?? directorships.set(e.src_entity_id, []).get(e.src_entity_id)).push(e);
      }
      // family edges connect politician-entity ↔ relative-entity (either direction)
      const out = [];
      const byPolitician = new Map(); // pid → { relatives: Map(entity → {claims, directs}), evidence }
      for (const edge of family) {
        for (const [self, other] of [[edge.src_entity_id, edge.dst_entity_id], [edge.dst_entity_id, edge.src_entity_id]]) {
          const ent = ctx.entityById(self);
          if (!ent) continue;
          const pid = (() => { try { return JSON.parse(ent.strong_ids ?? "{}").politician_id ?? null; } catch { return null; } })();
          if (!pid || !ctx.pmap.has(pid)) continue;
          const rel = ctx.entityById(other);
          if (!rel) continue;
          const claims = claimsBySubject.get(other) ?? [];
          const directs = directorships.get(other) ?? [];
          const struck = directs.filter((d) => { try { return /struck|dormant/i.test(JSON.parse(d.data ?? "{}").status ?? ""); } catch { return false; } });
          if (!claims.length && !struck.length) continue;
          const g = byPolitician.get(pid) ?? byPolitician.set(pid, { relatives: [], evidence: new Set(), signals: 0 }).get(pid);
          g.relatives.push({ name: rel.canonical_name, claims: claims.length, struck: struck.length });
          g.signals += claims.length + struck.length;
          for (const c of claims.slice(0, 3)) if (c.evidence_id) g.evidence.add(c.evidence_id);
          for (const s of struck.slice(0, 3)) if (s.evidence_id) g.evidence.add(s.evidence_id);
        }
      }
      for (const [pid, g] of byPolitician) {
        const p = ctx.pmap.get(pid);
        const score = Math.min(Math.round(8 + g.signals * 5), 50);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `${g.relatives.length}rel`,
          headline: `${g.relatives.length} family member(s) carry adverse links: ${g.relatives.map((r) => `${r.name} (${r.claims} adverse claim(s), ${r.struck} struck-off directorship(s))`).join("; ")}.`,
          rationale: `Relatives in the entity graph with adverse-source claims or struck-off company directorships. Assets and dealings routed through family are the standard proxy shape — each individual link needs identity verification (namesakes are common), which is exactly the investigator's job.`,
          evidence: [...g.evidence].slice(0, 6).map((eid) => evidenceRef(eid, "adverse claim / directorship source for a family member")),
          data: { statistic: "family_adverse", relatives: g.relatives, signals: g.signals },
          severityOverride: g.signals >= S.bigClaims ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "party_income_spike", label: "Party income spike", category: "party",
    desc: "A party's audited total income jumping several-fold year-on-year.",
    tunables: T({
      ratioMin: { label: "Flag ratio", type: "number", def: 2.5, min: 1.2, max: 20, step: 0.1, desc: "Flag YoY income growth ≥ this ×." },
      bigRatio: { label: "Big ratio", type: "number", def: 5, min: 2, max: 50, desc: "BIG at/above this ×." },
      absMin: { label: "Min jump (₹)", type: "number", def: 5e9, min: 0, desc: "Ignore jumps below this (₹500 Cr default — party books are big)." },
    }),
    run(ctx, S) {
      const rows = ctx.factsForEntities("party_total_income");
      const byParty = new Map();
      for (const r of rows) {
        (byParty.get(r.entity_id) ?? byParty.set(r.entity_id, { name: r.name, rows: [] }).get(r.entity_id)).rows.push(r);
      }
      const out = [];
      for (const [entity_id, g] of byParty) {
        const sorted = g.rows.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
        for (let i = 1; i < sorted.length; i++) {
          const p0 = sorted[i - 1], p1 = sorted[i];
          if (!p0.value || p0.value <= 0) continue;
          const ratio = p1.value / p0.value, jump = p1.value - p0.value;
          if (ratio < S.ratioMin || jump < S.absMin) continue;
          const score = Math.min(Math.round(10 + ratio * 3 + jump / (100 * CR)), 50);
          out.push({
            subject: { entity_id, name: g.name, kind: "party" },
            score,
            fingerprint: `${p0.as_of_date}-${p1.as_of_date}`,
            headline: `${g.name} total income grew ${ratio.toFixed(1)}× (₹${(jump / CR).toFixed(0)} Cr) from FY ${p0.as_of_date} to ${p1.as_of_date}.`,
            rationale: `Audited income ₹${(p0.value / CR).toFixed(0)} Cr → ₹${(p1.value / CR).toFixed(0)} Cr. Election years lift every party's income; a spike far beyond peers, or without a matching election, is what deserves the look.`,
            evidence: [
              evidenceRef(p0.evidence_id, `FY ${p0.as_of_date} audited income ₹${(p0.value / CR).toFixed(0)} Cr`),
              evidenceRef(p1.evidence_id, `FY ${p1.as_of_date} audited income ₹${(p1.value / CR).toFixed(0)} Cr`),
            ],
            data: { statistic: "party_income_spike", ratio, jump },
            severityOverride: ratio >= S.bigRatio ? "big" : null,
          });
        }
      }
      return out;
    },
  },
  {
    id: "party_spend_vs_donations", label: "Party spend vs declared donations", category: "party",
    desc: "A party's election expenditure far exceeding its declared donations income in the same FY — the gap is the opaque-funding share.",
    tunables: T({
      multiple: { label: "Flag multiple", type: "number", def: 2, min: 1.1, max: 20, step: 0.1, desc: "Flag when election spend ≥ this × declared donations." },
      bigMultiple: { label: "Big multiple", type: "number", def: 4, min: 2, max: 50, desc: "BIG at/above this ×." },
      absMin: { label: "Min spend (₹)", type: "number", def: 1e9, min: 0, desc: "Ignore below this spend (₹100 Cr default)." },
    }),
    run(ctx, S) {
      const spend = ctx.factsForEntities("party_election_expenditure");
      const donations = ctx.factsForEntities("party_donations_income");
      const donKey = new Map(donations.map((d) => [`${d.entity_id}|${d.as_of_date}`, d]));
      const out = [];
      for (const s of spend) {
        if (s.value < S.absMin) continue;
        const d = donKey.get(`${s.entity_id}|${s.as_of_date}`);
        if (!d || d.value <= 0) continue;
        const multiple = s.value / d.value;
        if (multiple < S.multiple) continue;
        const score = Math.min(Math.round(8 + multiple * 4), 45);
        out.push({
          subject: { entity_id: s.entity_id, name: s.name, kind: "party" },
          score,
          fingerprint: `${s.as_of_date}`,
          headline: `${s.name} spent ${multiple.toFixed(1)}× its declared donations on elections in FY ${s.as_of_date}.`,
          rationale: `Election/propaganda expenditure ₹${(s.value / CR).toFixed(0)} Cr vs declared voluntary contributions ₹${(d.value / CR).toFixed(0)} Cr (FY ${s.as_of_date}). The excess was funded from something other than declared donations — other income lines can explain part; the rest is the opacity worth mapping.`,
          evidence: [
            evidenceRef(s.evidence_id, `FY ${s.as_of_date} election expenditure ₹${(s.value / CR).toFixed(0)} Cr`),
            evidenceRef(d.evidence_id, `FY ${s.as_of_date} declared donations ₹${(d.value / CR).toFixed(0)} Cr`),
          ],
          data: { statistic: "party_spend_vs_donations", multiple, spend: s.value, donations: d.value, fy: s.as_of_date },
          severityOverride: multiple >= S.bigMultiple ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "round_numbers", label: "Round-number bias", category: "forensic",
    desc: "Declared values that are ALL exact lakh-multiples suggest estimation rather than records. Noisy (affidavits are often rounded) — OFF by default; enable to experiment.",
    tunables: T({
      enabled: { ...BASE_TUNABLES.enabled, def: false },
      pctMin: { label: "Flag at % round", type: "number", def: 90, min: 50, max: 100, desc: "Flag when ≥ this % of values are exact ₹1L multiples." },
      minN: { label: "Min values", type: "number", def: 6, min: 3, max: 50, desc: "Need at least this many values." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 }, // small-only
    }),
    run(ctx, S) {
      const out = [];
      const rows = db.prepare(`
        SELECT f.value, f.evidence_id, json_extract(e.strong_ids,'$.politician_id') pid
        FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.metric IN ('declared_assets','declared_liabilities','declared_income','election_expenditure')
          AND f.value >= 100000 AND json_extract(e.strong_ids,'$.politician_id') IS NOT NULL
      `).all();
      const byPol = new Map();
      for (const r of rows) {
        if (!ctx.pmap.has(r.pid)) continue;
        const g = byPol.get(r.pid) ?? byPol.set(r.pid, { values: [], evidence: new Set() }).get(r.pid);
        g.values.push(r.value);
        if (r.evidence_id) g.evidence.add(r.evidence_id);
      }
      for (const [pid, g] of byPol) {
        if (g.values.length < S.minN) continue;
        const round = g.values.filter((v) => v % 100000 === 0).length;
        const pct = (round / g.values.length) * 100;
        if (pct < S.pctMin) continue;
        const p = ctx.pmap.get(pid);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score: Math.min(Math.round(4 + (pct - S.pctMin)), 15),
          fingerprint: `n${g.values.length}`,
          headline: `${round} of ${g.values.length} declared financial figures are exact ₹1-lakh multiples.`,
          rationale: `${pct.toFixed(0)}% of this rep's declared values are round lakh figures — consistent with estimated (rather than documented) declarations. Weak signal; only meaningful inside a cluster.`,
          evidence: [...g.evidence].slice(0, 3).map((eid) => evidenceRef(eid, "declaration with round figures")),
          data: { statistic: "round_numbers", pct, n: g.values.length },
        });
      }
      return out;
    },
  },

  // ─────────────────────── General / unsupervised outlier ────────────────────
  {
    id: "generic_outlier", label: "General metric outlier (every metric, auto)", category: "general",
    desc: "The catch-all: instead of a hand-coded shape, this z-scores EVERY numeric metric in the ledger against the subject's cohort, both tails, using the robust median+MAD modified z-score. It surfaces anomalies nobody wrote a rule for — a value extreme for its peer group on ANY measure. New metrics are covered automatically the moment they land in the ledger.",
    tunables: T({
      zFlag: { label: "Modified-z flag", type: "number", def: 3.5, min: 2, max: 10, step: 0.1, desc: "Iglewicz-Hoaglin modified z (0.6745·(x−median)/MAD, in log space for positive metrics); 3.5 is the standard outlier line." },
      zBig: { label: "Modified-z big", type: "number", def: 8, min: 2, max: 30, step: 0.5, desc: "BIG only for a truly extreme outlier at/above this modified z — generic flags are otherwise SMALL (they earn weight in clusters)." },
      minCohort: { label: "Min cohort", type: "number", def: 12, min: 5, max: 200, desc: "Cohort size needed before outliers are meaningful." },
      maxPerMetric: { label: "Max flags/metric", type: "number", def: 15, min: 1, max: 500, desc: "Cap flags per metric×cohort so one noisy metric can't flood the queue." },
      // Score alone never promotes a generic outlier to big — only the zBig override
      // does — so the catch-all stays small-flag-dominant by design.
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      // Latest value per (entity, metric); one pass over the whole facts ledger.
      const rows = db.prepare(`
        SELECT f.metric, f.value, f.as_of_date, f.evidence_id, f.entity_id,
               e.canonical_name name, e.kind, json_extract(e.strong_ids,'$.politician_id') pid
        FROM facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.value IS NOT NULL
      `).all();
      // Keep the newest row per (entity, metric).
      const latest = new Map();
      for (const r of rows) {
        const k = `${r.entity_id}|${r.metric}`;
        const cur = latest.get(k);
        if (!cur || String(r.as_of_date ?? "") > String(cur.as_of_date ?? "")) latest.set(k, r);
      }
      // Bucket by (metric, cohort). Cohort = a person's state/party, else the kind.
      const buckets = new Map();
      for (const r of latest.values()) {
        const p = r.pid ? ctx.pmap.get(r.pid) : null;
        const cohort = p ? (p.state || p.party || "(none)") : (r.kind || "entity");
        const key = `${r.metric}|${cohort}`;
        (buckets.get(key) ?? buckets.set(key, []).get(key)).push({ ...r, cohort });
      }

      const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
      const out = [];
      for (const [key, items] of buckets) {
        if (items.length < S.minCohort) continue;
        // Monetary/size metrics are heavily skewed — a few reps hold most of the
        // wealth, and many declare near-zero (liabilities). A RAW z-score then either
        // flags the whole fat tail or blows up when the MAD collapses to ~0. A signed
        // log transform, sign(v)·log10(1+|v|), tames both: it measures "extreme
        // relative to the cohort's MULTIPLICATIVE spread" (unusually rich/indebted for
        // a peer) and handles zeros and negatives gracefully. Applied universally so
        // counts and money are treated on the same principled footing.
        const tx = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v));
        const tvals = items.map((i) => tx(i.value));
        const med = median(tvals);
        const mad = median(tvals.map((v) => Math.abs(v - med)));
        if (mad === 0) continue; // degenerate cohort (≥half identical) — no robust spread
        const metric = items[0].metric, cohort = items[0].cohort;
        const scored = [];
        for (const it of items) {
          const mz = 0.6745 * (tx(it.value) - med) / mad; // Iglewicz-Hoaglin modified z (signed-log space)
          if (Math.abs(mz) < S.zFlag) continue;
          scored.push({ ...it, mz });
        }
        // Keep the most extreme per metric×cohort (both tails), capped.
        scored.sort((a, b) => Math.abs(b.mz) - Math.abs(a.mz));
        for (const it of scored.slice(0, S.maxPerMetric)) {
          const high = it.mz > 0;
          const score = Math.min(Math.round(8 + Math.abs(it.mz) * 3), 55);
          out.push({
            subject: { politician_id: it.pid ?? null, entity_id: it.pid ? null : it.entity_id, name: it.name, kind: it.kind },
            score,
            fingerprint: `${metric}|${cohort}|${high ? "hi" : "lo"}`,
            headline: `${it.name}'s ${metric.replace(/_/g, " ")} (${fmtVal(it.value)}) is a ${high ? "high" : "low"} outlier for the ${cohort} cohort (modified z ${it.mz.toFixed(1)}).`,
            rationale: `Across ${items.length} ${cohort}-cohort values of "${metric}", the median is ${fmtVal(med)} and the robust spread (MAD) is ${fmtVal(mad)}. This subject's ${fmtVal(it.value)} sits ${it.mz.toFixed(1)} modified-z from the median — past the ${S.zFlag} outlier line. This is an UNSUPERVISED signal: no rule targets this metric; it stood out on its own. A single generic outlier is weak on its own; it earns its weight inside a cluster with shaped detectors.`,
            evidence: [evidenceRef(it.evidence_id, `${metric} = ${fmtVal(it.value)} (${it.as_of_date ?? "latest"})`)],
            data: { statistic: "generic_outlier", metric, cohort, value: it.value, median: med, mad, modified_z: it.mz, cohort_n: items.length, tail: high ? "high" : "low" },
            severityOverride: Math.abs(it.mz) >= S.zBig ? "big" : null,
          });
        }
      }
      return out;
    },
  },
  {
    id: "multivariate_outlier", label: "Multivariate profile outlier", category: "general",
    desc: "Catches a rep who is unremarkable on every SINGLE metric but whose whole PROFILE is unusual — e.g. moderate assets + low income + high spend + many directorships together. Robust Mahalanobis-style distance over each rep's full metric vector vs their office cohort. The combination is the signal; no single number has to be extreme.",
    tunables: T({
      zSqFlag: { label: "Distance flag", type: "number", def: 6, min: 1, max: 40, step: 0.5, desc: "Mean squared per-axis robust-z to flag (~avg per-axis σ²; 6 ≈ 2.4σ on every axis)." },
      zSqBig: { label: "Distance big", type: "number", def: 18, min: 2, max: 80, step: 0.5, desc: "BIG at/above this (≈4.2σ on every axis, on average)." },
      minCohort: { label: "Min cohort", type: "number", def: 12, min: 5, max: 200, desc: "Cohort size for stable per-axis stats." },
      minAxes: { label: "Min metrics", type: "number", def: 4, min: 2, max: 12, desc: "A rep needs at least this many metrics to be scored (breadth guard)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 }, // severity comes ONLY from the distance override
    }),
    run(ctx, S) {
      // The profile vector: the comparable, populated per-rep metrics. Latest value each.
      const VECTOR = [
        "declared_assets", "declared_liabilities", "declared_income", "election_expenditure",
        "criminal_cases", "questions_asked", "debates_participated",
        "mplads_utilization_pct", "mplads_works_recommended", "mplads_works_completed",
      ];
      const latestByMetric = Object.fromEntries(VECTOR.map((m) => [m, ctx.seriesByPolitician(m)]));
      const rows = [];
      const evidenceByRep = new Map();
      for (const p of ctx.politicians) {
        const metrics = {}, evids = [];
        for (const m of VECTOR) {
          const last = (latestByMetric[m].get(p.id) ?? []).at(-1);
          if (last && last.value != null) { metrics[m] = last.value; if (last.evidence_id) evids.push(last.evidence_id); }
        }
        if (Object.keys(metrics).length >= S.minAxes) {
          rows.push({ id: p.id, name: p.name, cohort: p.office || "(none)", metrics });
          evidenceByRep.set(p.id, evids);
        }
      }
      const results = mahalanobisOutliers(rows, { minCohort: S.minCohort, minAxes: S.minAxes, zSqFlag: S.zSqFlag, zSqBig: S.zSqBig });
      return results.map((r) => {
        const drivers = r.top.map((t) => `${t.metric.replace(/_/g, " ")} (${t.z > 0 ? "+" : ""}${t.z.toFixed(1)}σ)`).join(", ");
        const score = Math.min(Math.round(8 + r.score * 2), 55);
        return {
          subject: { politician_id: r.id, name: r.name, kind: "person" },
          score,
          fingerprint: `mv${r.n_axes}`,
          headline: `${r.name}'s overall profile is an outlier for the ${r.cohort} cohort across ${r.n_axes} metrics — driven by ${drivers}.`,
          rationale: `No single metric has to be extreme: this rep's COMBINATION of ${r.n_axes} declared metrics sits far from the ${r.cohort}-cohort centre (breadth-scaled robust distance ${r.score.toFixed(1)}, cohort n=${r.cohort_n}). The strongest contributors are ${drivers}. Unusual combinations — e.g. low income beside high spend and heavy assets — are exactly what a per-metric scan misses. A candidate for review, not a finding.`,
          evidence: (evidenceByRep.get(r.id) ?? []).slice(0, 6).map((eid) => evidenceRef(eid, "one of the declared metrics in this rep's profile vector")),
          data: { statistic: "multivariate_outlier", distance: r.score, axes: r.n_axes, cohort: r.cohort, drivers: r.top },
          severityOverride: r.big ? "big" : null,
        };
      });
    },
  },
  {
    id: "metric_changepoint", label: "Trajectory change-point", category: "general",
    desc: "Finds the year a subject's trajectory BROKE — a step-change in a metric's level that a consecutive-year ratio can't see. Runs on any metric time series (rep affidavits, party finances) with enough points.",
    tunables: T({
      minPoints: { label: "Min series points", type: "number", def: 4, min: 3, max: 20, desc: "Series length needed before a change-point is meaningful." },
      shiftFlag: { label: "Shift flag (σ)", type: "number", def: 2, min: 0.5, max: 10, step: 0.1, desc: "Mean shift (in whole-series std units) to flag." },
      shiftBig: { label: "Shift big (σ)", type: "number", def: 3.5, min: 1, max: 20, step: 0.1, desc: "BIG at/above this shift." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 }, // severity comes ONLY from the shift override
    }),
    run(ctx, S) {
      const out = [];
      // Politician metrics with any hope of a multi-year series, plus party finance.
      const POL_METRICS = ["declared_assets", "declared_liabilities", "declared_income"];
      const PARTY_METRICS = ["party_total_income", "party_total_expenditure", "party_total_assets", "party_donations_income"];

      const emit = (subject, metric, series) => {
        const cp = changePoint(series, { minPoints: S.minPoints, minShiftZ: S.shiftFlag });
        if (!cp) return;
        const score = Math.min(Math.round(8 + cp.shiftZ * 6), 50);
        out.push({
          subject,
          score,
          fingerprint: `${metric}|${cp.at}`,
          headline: `${subject.name}'s ${metric.replace(/_/g, " ")} ${cp.direction === "jump" ? "jumped" : "dropped"} sharply after ${cp.at} (${cp.shiftZ.toFixed(1)}σ step-change).`,
          rationale: `Across the ${series.length}-point series, the largest break is between ${cp.at} and ${cp.next}: the level ${cp.direction === "jump" ? "rose" : "fell"} from a mean of ${fmtVal(Math.pow(10, Math.abs(cp.left_mean)) - 1)}-scale (${cp.left_pts} pts) to ${fmtVal(Math.pow(10, Math.abs(cp.right_mean)) - 1)}-scale (${cp.right_pts} pts), a ${cp.shiftZ.toFixed(1)} whole-series-σ shift. A discrete break in trajectory (vs steady growth) is worth asking what changed that year.`,
          evidence: cp.evidence_ids.map((eid) => evidenceRef(eid, `series value around the ${cp.at}→${cp.next} break`)),
          data: { statistic: "changepoint", metric, at: cp.at, shift_sigma: cp.shiftZ, direction: cp.direction },
          severityOverride: cp.shiftZ >= S.shiftBig ? "big" : null,
        });
      };

      for (const metric of POL_METRICS) {
        for (const [pid, rows] of ctx.seriesByPolitician(metric)) {
          const p = ctx.pmap.get(pid);
          emit({ politician_id: pid, name: p.name, kind: "person" }, metric,
            rows.map((r) => ({ x: r.year, value: r.value, evidence_id: r.evidence_id })));
        }
      }
      for (const metric of PARTY_METRICS) {
        const byEntity = new Map();
        for (const f of ctx.factsForEntities(metric)) {
          (byEntity.get(f.entity_id) ?? byEntity.set(f.entity_id, { name: f.name, kind: f.kind, rows: [] }).get(f.entity_id))
            .rows.push({ x: String(f.as_of_date), value: f.value, evidence_id: f.evidence_id });
        }
        for (const [entity_id, g] of byEntity) {
          emit({ entity_id, name: g.name, kind: g.kind || "party" }, metric, g.rows);
        }
      }
      return out;
    },
  },
  {
    id: "nexus_triangle", label: "Politician–company–government nexus", category: "nexus",
    desc: "The core corruption shape: a politician whose OFFICE covers a sector, who has a business/ownership INTEREST touching that sector or a specific company, AND a government benefit flowing to a connected entity (a contract award, a donor link, or a struck-off company in the covered sector). Two of the three legs is a flag; all three is a big flag.",
    tunables: T({
      bigLegs: { label: "Legs for big", type: "number", def: 3, min: 2, max: 3, desc: "How many of {office-power, private-interest, government-benefit} must be present for a BIG flag." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 }, // 2-leg = small candidate; only 3 legs (override) goes big
    }),
    run(ctx, S) {
      const out = [];
      // Government-benefit entities: anyone named on a contract award event.
      const awardees = new Set();
      for (const kind of ["awarded_tender", "government_contract_mention"]) {
        for (const ev of ctx.eventsByKind(kind)) {
          const ids = (() => { try { return JSON.parse(ev.entity_ids); } catch { return []; } })();
          if (ids[0]) awardees.add(ids[0]);
        }
      }
      // Precompute ONCE (avoid a per-rep DB query + full edge re-scan): pid→self
      // entity, and holder-entity→interest-edges.
      const selfByPid = ctx.selfEntityByPolitician();
      const interestEdges = new Map(); // holder entity → edges[]
      for (const rt of ["owner_of", "director_of", "declared_business_interest"]) {
        for (const e of ctx.relationsByType(rt)) {
          if (!e.src_entity_id) continue;
          (interestEdges.get(e.src_entity_id) ?? interestEdges.set(e.src_entity_id, []).get(e.src_entity_id)).push(e);
        }
      }
      for (const p of ctx.politicians) {
        const g = gatherNexusLegs(ctx, p, awardees, selfByPid.get(p.id) ?? null, interestEdges);
        const legs = [g.power, g.interest, g.benefit].filter(Boolean).length;
        if (legs < 2) continue;
        const score = Math.min(10 + legs * 8 + g.detail.length, 55);
        const names = [g.power && "office-power", g.interest && "private interest", g.benefit && "government benefit"].filter(Boolean).join(" + ");
        out.push({
          subject: { politician_id: p.id, name: p.name, kind: "person" },
          score,
          fingerprint: `legs${legs}|${g.sectors.slice(0, 2).join(",")}`,
          headline: `${p.name}: ${legs}-leg government–business nexus (${names})${g.sectors.length ? ` in ${g.sectors.slice(0, 3).join(", ")}` : ""}.`,
          rationale: `The nexus shape needs three legs — the office covering a sector, a private interest in it, and a government benefit to a connected party. This rep shows ${legs}: ${g.detail.join("; ")}. ${legs >= 3 ? "All three present is the classic capture pattern." : "Two legs is a candidate; the third (a concrete benefit) is what the investigator should look for."} Not a finding — leg connections are name/sector matched and need verification.`,
          evidence: g.evidence.slice(0, 8),
          data: { statistic: "nexus_triangle", legs, sectors: g.sectors, has_power: !!g.power, has_interest: !!g.interest, has_benefit: !!g.benefit },
          severityOverride: legs >= S.bigLegs ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "ownership_chain", label: "Ownership chain / same-controller bidders", category: "nexus",
    desc: "Follows director/owner edges MULTIPLE hops to an ultimate controller, then flags (a) deep layering chains toward a politician-linked company, and (b) sets of companies that trace back to the SAME controller — the 'all bidders secretly one group' shape. Sparse today (few director edges); grows as director data is enriched.",
    tunables: T({
      minChain: { label: "Min chain depth", type: "number", def: 3, min: 2, max: 10, desc: "Hops of director/owner edges to flag a layering chain." },
      minSiblings: { label: "Min same-controller cos", type: "number", def: 3, min: 2, max: 20, desc: "Companies sharing one ultimate controller to flag a cluster." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 }, // severity comes ONLY from the depth/size overrides
    }),
    run(ctx, S) {
      // Build a directed control graph from owner_of / director_of / proprietor_of /
      // chairman_of edges (src = person/holder, dst = company).
      const controls = new Map();   // holder entity → Set(company entity)
      const controlledBy = new Map(); // company entity → Set(holder entity)
      for (const rt of ["owner_of", "director_of", "proprietor_of", "chairman_of"]) {
        for (const e of ctx.relationsByType(rt)) {
          if (!e.src_entity_id || !e.dst_entity_id) continue;
          (controls.get(e.src_entity_id) ?? controls.set(e.src_entity_id, new Set()).get(e.src_entity_id)).add(e.dst_entity_id);
          (controlledBy.get(e.dst_entity_id) ?? controlledBy.set(e.dst_entity_id, new Set()).get(e.dst_entity_id)).add(e.src_entity_id);
        }
      }
      const out = [];
      // (b) same ultimate controller: a holder controlling ≥ minSiblings companies.
      for (const [holder, companies] of controls) {
        if (companies.size < S.minSiblings) continue;
        const ent = ctx.entityById(holder);
        if (!ent) continue;
        const pid = (() => { try { return JSON.parse(ent.strong_ids ?? "{}").politician_id ?? null; } catch { return null; } })();
        const names = [...companies].map((c) => ctx.entityById(c)?.canonical_name).filter(Boolean);
        const score = Math.min(12 + companies.size * 4, 50);
        out.push({
          subject: { politician_id: pid, entity_id: pid ? null : holder, name: ent.canonical_name, kind: ent.kind },
          score,
          fingerprint: `ctrl${companies.size}`,
          headline: `${ent.canonical_name} controls ${companies.size} companies through director/owner links — a common-control cluster.`,
          rationale: `${companies.size} companies trace to this single controller (${names.slice(0, 6).join("; ")}${names.length > 6 ? "…" : ""}). When such companies bid on the same tender or receive related awards, the 'independent bidders' are one group — the collusive-control shape. Verifying beneficial ownership is the investigator's job (edges are name/DIN matched).`,
          evidence: [],
          data: { statistic: "ownership_common_control", companies: companies.size, company_names: names.slice(0, 20) },
          severityOverride: companies.size >= S.minSiblings * 2 ? "big" : null,
        });
      }
      // (a) deep layering chain: longest control path length ≥ minChain.
      for (const [company] of controlledBy) {
        const depth = chainDepth(company, controlledBy, new Set(), 0, S.minChain + 3);
        if (depth < S.minChain) continue;
        const ent = ctx.entityById(company);
        if (!ent) continue;
        const score = Math.min(10 + depth * 6, 45);
        out.push({
          subject: { entity_id: company, name: ent.canonical_name, kind: ent.kind },
          score,
          fingerprint: `chain${depth}`,
          headline: `${ent.canonical_name} sits at the end of a ${depth}-hop ownership chain — a layering marker.`,
          rationale: `Control passes through ${depth} intermediary holders before reaching this company. Deep layering (holding company → holding company → …) is a standard device to obscure the real beneficial owner. Candidate for the investigator to unwind.`,
          evidence: [],
          data: { statistic: "ownership_chain_depth", depth },
          severityOverride: depth >= S.minChain + 2 ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "tender_capacity_mismatch", label: "Tender vs company capacity mismatch", category: "nexus",
    desc: "A company named on a government contract whose declared PAID-UP CAPITAL is implausibly small for a government supplier — the 'tiny shell wins a big tender' shape. NOTE: tender AMOUNTS aren't in the DB yet, so this uses capital as a capacity proxy; add tender values to make it a true size-mismatch ratio.",
    tunables: T({
      capitalFloor: { label: "Capital floor (₹)", type: "number", def: 1e5, min: 0, desc: "Flag an awardee company with paid-up capital at/below this (default ₹1 L)." },
      bigFloor: { label: "Big floor (₹)", type: "number", def: 1e4, min: 0, desc: "BIG at/below this (default ₹10 k — a near-nil shell)." },
    }),
    run(ctx, S) {
      // Companies named on a government award (by name), matched to any mca_company
      // evidence carrying paid-up capital. Both are name-keyed and unverified.
      const awardNames = new Map(); // normalised name → { display, evidence:Set, orgs:Set }
      for (const kind of ["awarded_tender", "government_contract_mention"]) {
        for (const ev of ctx.eventsByKind(kind)) {
          const d = (() => { try { return JSON.parse(ev.data ?? "{}"); } catch { return {}; } })();
          const nm = d.company ?? d.awardee ?? d.name;
          if (!nm) continue;
          const k = String(nm).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
          if (k.length < 4) continue;
          const g = awardNames.get(k) ?? awardNames.set(k, { display: nm, evidence: new Set(), orgs: new Set() }).get(k);
          if (ev.evidence_id) g.evidence.add(ev.evidence_id);
          if (d.org) g.orgs.add(d.org);
        }
      }
      // Capital by company name from mca_company evidence.
      const capitalByName = new Map();
      for (const p of ctx.politicians) {
        for (const e of ctx.evidenceFor(p.id)) {
          if (e.source_type !== "mca_company" || !Array.isArray(e.numbers?.companies)) continue;
          for (const c of e.numbers.companies) {
            if (c.paidup_capital == null || !c.name) continue;
            const k = String(c.name).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
            const prev = capitalByName.get(k);
            if (!prev || c.paidup_capital < prev.capital) capitalByName.set(k, { capital: c.paidup_capital, name: c.name, url: c.source_url ?? e.url, evidence_id: e.id });
          }
        }
      }
      const out = [];
      for (const [k, g] of awardNames) {
        const cap = capitalByName.get(k);
        if (!cap || cap.capital > S.capitalFloor) continue;
        const score = Math.min(14 + Math.round((S.capitalFloor - cap.capital) / 20000), 45);
        out.push({
          subject: { entity_id: null, name: g.display, kind: "company" },
          score,
          fingerprint: `cap${Math.round(cap.capital)}`,
          headline: `${g.display} is named on a government award but declares only ${fmtVal(cap.capital)} in paid-up capital.`,
          rationale: `A company on a government contract${g.orgs.size ? ` (authority: ${[...g.orgs].slice(0, 3).join(", ")})` : ""} with paid-up capital of just ${fmtVal(cap.capital)} is the low-capacity/shell-supplier shape. Capital is a rough proxy — the real test is capital (or turnover) against the TENDER VALUE, which isn't in the ledger yet. Candidate for review; identity is name-matched.`,
          evidence: [
            evidenceRef(cap.evidence_id, `MCA record: paid-up capital ${fmtVal(cap.capital)}`),
            ...[...g.evidence].slice(0, 3).map((eid) => evidenceRef(eid, "government-award mention")),
          ],
          data: { statistic: "tender_capacity_mismatch", paidup_capital: cap.capital, authorities: [...g.orgs].slice(0, 5) },
          severityOverride: cap.capital <= S.bigFloor ? "big" : null,
        });
      }
      return out;
    },
  },

  // ─────────────────── Cross-source contradiction / integrity ─────────────────
  {
    id: "undeclared_criminal_case", label: "Undeclared criminal case", category: "contradiction",
    desc: "The sworn affidavit declares zero (or fewer) criminal cases, yet an independent court judgment or CBI action names the rep. A contradiction between a sworn declaration and an adverse legal record — the highest-stakes shape.",
    tunables: T({
      minConfidence: { label: "Min claim confidence", type: "number", def: 0.15, min: 0, max: 1, step: 0.05, desc: "Ignore adverse legal claims below this confidence. Court/CBI name-matches are inherently low-confidence (identity-unverified), so this floor is low and every flag is explicitly a lead to verify, not a finding." },
      minClaims: { label: "Min external claims", type: "number", def: 2, min: 1, max: 20, desc: "Require at least this many independent legal records before flagging a zero-declaration (suppresses lone namesakes)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      const LEGAL = ["named_in_court_judgment", "named_in_cbi_action"];
      const rows = db.prepare(`
        SELECT c.confidence, c.as_of_date, c.evidence_id, c.claim_type, json_extract(e.strong_ids,'$.politician_id') pid
        FROM claims c JOIN entities e ON e.id = c.subject_entity_id
        WHERE c.claim_type IN (${LEGAL.map(() => "?").join(",")}) AND json_extract(e.strong_ids,'$.politician_id') IS NOT NULL
      `).all(...LEGAL);
      const byPol = new Map();
      for (const r of rows) {
        if (!ctx.pmap.has(r.pid) || (r.confidence ?? 0) < S.minConfidence) continue;
        const g = byPol.get(r.pid) ?? byPol.set(r.pid, { claims: 0, evidence: [], types: new Set() }).get(r.pid);
        g.claims++; g.types.add(r.claim_type); if (r.evidence_id) g.evidence.push(r.evidence_id);
      }
      const out = [];
      for (const [pid, g] of byPol) {
        const p = ctx.pmap.get(pid);
        const declared = (ctx.seriesByPolitician("criminal_cases").get(pid) ?? []).at(-1)?.value ?? 0;
        if (g.claims <= declared) continue; // consistent or over-declared → no contradiction
        // Require a minimum concentration of independent records before calling a
        // zero-declaration a contradiction (a lone name-match is likely a namesake).
        if (declared === 0 && g.claims < S.minClaims) continue;
        const gap = g.claims - declared;
        const score = Math.min(Math.round(14 + gap * 6 + (declared === 0 ? 10 : 0)), 55);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `crim|${declared}v${g.claims}`,
          headline: declared === 0
            ? `Declares ZERO criminal cases, yet ${g.claims} independent legal record(s) (${[...g.types].join(", ")}) name this rep.`
            : `Declares ${declared} criminal case(s), but ${g.claims} independent legal records name this rep — a possible undercount.`,
          rationale: `Latest sworn affidavit: ${declared} criminal case(s). Independent adverse legal sources naming this person: ${g.claims} (${[...g.types].join(", ")}), each above the ${S.minConfidence} confidence floor. ${declared === 0 ? "A sworn 'no cases' against a court/CBI record is a direct contradiction" : "More external records than declared suggests an undercount"} — each record still needs identity verification (namesakes exist), which is exactly the investigator's job. Not a finding.`,
          evidence: g.evidence.slice(0, 6).map((eid) => evidenceRef(eid, "adverse legal record naming this rep")),
          data: { statistic: "undeclared_criminal_case", declared, external_claims: g.claims, gap, claim_types: [...g.types] },
          severityOverride: declared === 0 ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "vanishing_asset_item", label: "Asset item vanishes between affidavits", category: "contradiction",
    desc: "A specific property or business interest declared in one affidavit disappears in the next, WITHOUT a matching fall in total declared assets — a silent omission (assets moved to family/benami, or simply dropped off the form).",
    tunables: T({
      minValue: { label: "Min item value (₹)", type: "number", def: 5e6, min: 0, desc: "Only track properties worth at least this (default ₹50 L)." },
      bigValue: { label: "Big item value (₹)", type: "number", def: 1e7, min: 0, desc: "BIG when the vanished item is worth at least this (default ₹1 Cr)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      const out = [];
      const assetSeries = ctx.seriesByPolitician("declared_assets");
      for (const p of ctx.politicians) {
        // Gather per-year property lists from eci_affidavit evidence.
        const byYear = new Map();
        for (const e of ctx.evidenceFor(p.id)) {
          const n = e.numbers;
          if (!n || e.source_type !== "eci_affidavit" || n.election_year == null) continue;
          if (!Array.isArray(n.properties)) continue;
          byYear.set(n.election_year, { props: n.properties, evidence_id: e.id });
        }
        const years = [...byYear.keys()].sort((a, b) => a - b);
        if (years.length < 2) continue;
        const assets = assetSeries.get(p.id) ?? [];
        const assetAt = (yr) => assets.find((a) => a.year === yr)?.value ?? null;
        for (let i = 1; i < years.length; i++) {
          const y0 = years[i - 1], y1 = years[i];
          const prev = byYear.get(y0), cur = byYear.get(y1);
          const curKeys = new Set(cur.props.map(propKey));
          // Items in y0 (worth ≥ floor) absent in y1.
          for (const it of prev.props) {
            const val = Number(it.value_rupees) || 0;
            if (val < S.minValue || curKeys.has(propKey(it))) continue;
            const a0 = assetAt(y0), a1 = assetAt(y1);
            // If total assets fell by ≥ the item value, it plausibly sold — skip.
            if (a0 != null && a1 != null && (a0 - a1) >= val * 0.8) continue;
            const score = Math.min(Math.round(12 + val / CR * 4), 50);
            out.push({
              subject: { politician_id: p.id, name: p.name, kind: "person" },
              score,
              fingerprint: `vanish|${y0}-${y1}|${propKey(it)}`,
              headline: `${p.name}'s ${String(it.property_type ?? "property").toLowerCase()} in ${it.district ?? "?"} (₹${(val / CR).toFixed(2)} Cr, declared ${y0}) vanished by ${y1} — with no matching drop in total assets.`,
              rationale: `A ${it.owner ?? ""} ${it.property_type ?? "property"} in ${it.district ?? "?"} worth ₹${(val / CR).toFixed(2)} Cr, declared in ${y0}, is absent from the ${y1} affidavit. Total declared assets did not fall by that amount (${a0 != null && a1 != null ? `₹${(a0 / CR).toFixed(2)} Cr → ₹${(a1 / CR).toFixed(2)} Cr` : "assets unavailable"}), so it wasn't declared as sold. Assets quietly leaving the form — often to family/benami — is a concealment shape. A genuine sale or a parse difference can explain it; a candidate to check, not a finding.`,
              evidence: [evidenceRef(prev.evidence_id, `${y0} affidavit lists this property`), evidenceRef(cur.evidence_id, `${y1} affidavit omits it`)],
              data: { statistic: "vanishing_asset_item", from_year: y0, to_year: y1, item: propKey(it), value: val },
              severityOverride: val >= S.bigValue ? "big" : null,
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: "copy_paste_affidavit", label: "Copy-paste affidavit figures", category: "contradiction",
    desc: "Core declared figures (assets/liabilities/income) identical to the rupee across two different election years — real wealth never repeats exactly, so this marks a copied or fabricated declaration.",
    tunables: T({
      minValue: { label: "Min figure (₹)", type: "number", def: 1e6, min: 0, desc: "Ignore tiny/zero figures (they legitimately repeat)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      const METRICS = ["declared_assets", "declared_liabilities", "declared_income"];
      const out = [];
      for (const p of ctx.politicians) {
        const repeats = [];
        const evidence = new Set();
        for (const metric of METRICS) {
          const rows = ctx.seriesByPolitician(metric).get(p.id) ?? [];
          // Group by exact value across DISTINCT years + distinct evidence.
          const byVal = new Map();
          for (const r of rows) {
            if (!r.value || r.value < S.minValue) continue;
            (byVal.get(r.value) ?? byVal.set(r.value, new Set()).get(r.value)).add(r.year);
          }
          for (const [val, yrs] of byVal) if (yrs.size >= 2) { repeats.push({ metric, value: val, years: [...yrs] }); rows.filter((r) => r.value === val).forEach((r) => r.evidence_id && evidence.add(r.evidence_id)); }
        }
        if (!repeats.length) continue;
        const score = Math.min(10 + repeats.length * 8, 45);
        out.push({
          subject: { politician_id: p.id, name: p.name, kind: "person" },
          score,
          fingerprint: `copypaste|${repeats.map((r) => r.metric).join(",")}`,
          headline: `${p.name} declared identical ${repeats.map((r) => r.metric.replace("declared_", "")).join(" & ")} figure(s) — to the rupee — across different election years.`,
          rationale: `${repeats.map((r) => `${r.metric.replace("declared_", "")} = ${fmtVal(r.value)} in ${r.years.join(" and ")}`).join("; ")}. Declared assets/income never repeat to the exact rupee across years; identical figures point to a copied or un-refreshed affidavit. ${repeats.length >= 3 ? "All three core figures repeating is a strong copy-paste marker." : "Worth checking whether the later affidavit was genuinely re-filed."}`,
          evidence: [...evidence].slice(0, 6).map((eid) => evidenceRef(eid, "affidavit with the repeated figure")),
          data: { statistic: "copy_paste_affidavit", repeats },
          severityOverride: repeats.length >= 3 ? "big" : null,
        });
      }
      return out;
    },
  },

  // ─────────────────────── More wealth-forensics detectors ────────────────────
  {
    id: "liability_writeoff", label: "Vanishing liabilities / loan waiver", category: "wealth",
    desc: "The mirror of the liability-spike detector: declared liabilities collapse between affidavits with no matching asset sale and no plausible repayment from declared income — the loan-waiver / undisclosed-settlement shape.",
    tunables: T({
      writeoffFrac: { label: "Collapse fraction", type: "number", def: 0.25, min: 0.01, max: 0.9, step: 0.05, desc: "Flag when liabilities fall to ≤ this fraction of the prior figure." },
      absMin: { label: "Min prior debt (₹)", type: "number", def: 5e6, min: 0, desc: "Only when the prior liabilities were at least this (default ₹50 L)." },
      bigGap: { label: "Big unexplained (₹)", type: "number", def: 1e7, min: 0, desc: "BIG when the unexplained cleared debt is at least this (default ₹1 Cr)." },
      savingsRate: { label: "Savings rate", type: "number", def: 1.0, min: 0.1, max: 1.5, step: 0.1, desc: "Fraction of declared income assumed available to repay debt." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      const out = [];
      const incomes = ctx.seriesByPolitician("declared_income");
      const assets = ctx.seriesByPolitician("declared_assets");
      for (const [pid, rows] of ctx.seriesByPolitician("declared_liabilities")) {
        const p = ctx.pmap.get(pid);
        const inc = incomes.get(pid) ?? [], ast = assets.get(pid) ?? [];
        for (let i = 1; i < rows.length; i++) {
          const l0 = rows[i - 1], l1 = rows[i];
          if (!l0.value || l0.value < S.absMin) continue;
          if (l1.value > l0.value * S.writeoffFrac) continue; // not a collapse
          const cleared = l0.value - l1.value;
          const gapYears = Math.max(1, l1.year - l0.year);
          // Plausible repayment from income over the window.
          const inWindow = inc.filter((r) => r.year > l0.year && r.year <= l1.year);
          const annual = inWindow.length ? inWindow.reduce((s, r) => s + r.value, 0) / inWindow.length : (inc.at(-1)?.value ?? 0);
          const plausibleRepay = annual * gapYears * S.savingsRate;
          // Did assets fall (a sale used to repay)? If so, it's explained.
          const a0 = ast.find((a) => a.year === l0.year)?.value, a1 = ast.find((a) => a.year === l1.year)?.value;
          const assetDrop = (a0 != null && a1 != null) ? Math.max(0, a0 - a1) : 0;
          const unexplained = cleared - plausibleRepay - assetDrop * 0.5;
          if (unexplained <= 0) continue;
          const score = Math.min(Math.round(10 + unexplained / CR * 3), 52);
          out.push({
            subject: { politician_id: pid, name: p.name, kind: "person" },
            score,
            fingerprint: `writeoff|${l0.year}-${l1.year}`,
            headline: `${p.name}'s declared liabilities collapsed ₹${(cleared / CR).toFixed(2)} Cr (${l0.year}→${l1.year}) — ~₹${(unexplained / CR).toFixed(2)} Cr of it unexplained by income or an asset sale.`,
            rationale: `Liabilities fell from ₹${(l0.value / CR).toFixed(2)} Cr (${l0.year}) to ₹${(l1.value / CR).toFixed(2)} Cr (${l1.year}). Declared income over the period supports ≤ ₹${(plausibleRepay / CR).toFixed(2)} Cr of repayment${assetDrop ? `, and assets fell ₹${(assetDrop / CR).toFixed(2)} Cr` : ", and assets did not fall"} — leaving ~₹${(unexplained / CR).toFixed(2)} Cr of debt cleared with no visible source. Loan waivers and undisclosed settlements are the adverse shape; a genuine one-off gift/repayment can explain it. Candidate for review.`,
            evidence: [evidenceRef(l0.evidence_id, `${l0.year}: liabilities ₹${(l0.value / CR).toFixed(2)} Cr`), evidenceRef(l1.evidence_id, `${l1.year}: liabilities ₹${(l1.value / CR).toFixed(2)} Cr`)],
            data: { statistic: "liability_writeoff", cleared, plausible_repay: plausibleRepay, asset_drop: assetDrop, unexplained, from_year: l0.year, to_year: l1.year },
            severityOverride: unexplained >= S.bigGap ? "big" : null,
          });
        }
      }
      return out;
    },
  },
  {
    id: "net_worth_reconciliation", label: "Net-worth sources-and-uses gap", category: "wealth",
    desc: "The forensic flow-of-funds test, sharper than the DA-ratio: net worth (assets − liabilities) growth that survives after crediting declared income and debiting known campaign spend. Nets out leverage, so it doesn't false-positive on borrow-funded purchases.",
    tunables: T({
      ratio: { label: "Flag ratio", type: "number", def: 1.5, min: 0.2, max: 20, step: 0.1, desc: "Flag when the unexplained net-worth gain ≥ this × declared income over the period." },
      absMin: { label: "Min gap (₹)", type: "number", def: 1e7, min: 0, desc: "Ignore gaps below this (default ₹1 Cr)." },
      bigAbs: { label: "Big gap (₹)", type: "number", def: 5e7, min: 0, desc: "BIG at/above this unexplained gain (default ₹5 Cr)." },
      livingFloor: { label: "Living cost/yr (₹)", type: "number", def: 3e5, min: 0, desc: "Assumed annual living expense debited from income." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      const out = [];
      const liabs = ctx.seriesByPolitician("declared_liabilities");
      const incomes = ctx.seriesByPolitician("declared_income");
      const spends = ctx.seriesByPolitician("election_expenditure");
      for (const [pid, rows] of ctx.seriesByPolitician("declared_assets")) {
        const p = ctx.pmap.get(pid);
        const lz = liabs.get(pid) ?? [], inc = incomes.get(pid) ?? [], sp = spends.get(pid) ?? [];
        const liabAt = (yr) => lz.find((l) => l.year === yr)?.value ?? 0;
        for (let i = 1; i < rows.length; i++) {
          const a0 = rows[i - 1], a1 = rows[i];
          const gapYears = Math.max(1, a1.year - a0.year);
          const nw0 = a0.value - liabAt(a0.year), nw1 = a1.value - liabAt(a1.year);
          const deltaNW = nw1 - nw0;
          if (deltaNW < S.absMin) continue;
          const inWindow = inc.filter((r) => r.year > a0.year && r.year <= a1.year);
          const annual = inWindow.length ? inWindow.reduce((s, r) => s + r.value, 0) / inWindow.length : (inc.at(-1)?.value ?? 0);
          const sources = annual * gapYears;
          const spendInWindow = sp.filter((r) => r.year > a0.year && r.year <= a1.year).reduce((s, r) => s + r.value, 0);
          const uses = spendInWindow + S.livingFloor * gapYears;
          const unexplained = deltaNW - (sources - uses);
          if (unexplained < S.absMin || sources <= 0 || unexplained < S.ratio * sources) continue;
          const score = Math.min(Math.round(10 + unexplained / CR * 3), 55);
          out.push({
            subject: { politician_id: pid, name: p.name, kind: "person" },
            score,
            fingerprint: `nwrecon|${a0.year}-${a1.year}`,
            headline: `${p.name}'s net worth grew ₹${(deltaNW / CR).toFixed(2)} Cr (${a0.year}→${a1.year}) — ~₹${(unexplained / CR).toFixed(2)} Cr beyond what declared income can explain.`,
            rationale: `Net worth (assets − liabilities) rose ₹${(nw0 / CR).toFixed(2)} → ₹${(nw1 / CR).toFixed(2)} Cr. Over the same years declared income totals ≈₹${(sources / CR).toFixed(2)} Cr, against ≈₹${(uses / CR).toFixed(2)} Cr of known campaign spend + living costs — leaving ~₹${(unexplained / CR).toFixed(2)} Cr of the gain unaccounted (${(unexplained / sources).toFixed(1)}× income). Unlike a gross-asset test this nets out borrowing, so it isn't a leverage artefact. Property revaluation or undeclared legitimate income can still explain it — a candidate for review.`,
            evidence: [evidenceRef(a0.evidence_id, `${a0.year}: assets ₹${(a0.value / CR).toFixed(2)} Cr`), evidenceRef(a1.evidence_id, `${a1.year}: assets ₹${(a1.value / CR).toFixed(2)} Cr`)],
            data: { statistic: "net_worth_reconciliation", delta_nw: deltaNW, sources, uses, unexplained, from_year: a0.year, to_year: a1.year },
            severityOverride: unexplained >= S.bigAbs ? "big" : null,
          });
        }
      }
      return out;
    },
  },
  {
    id: "zero_liability_implausibility", label: "Zero debt beside large assets + businesses", category: "wealth",
    desc: "A rep declaring near-zero liabilities while holding large assets AND business interests/multiple properties — operating companies and property almost always carry debt, so a persistent zero is an under-declaration marker.",
    tunables: T({
      tinyFloor: { label: "Debt floor (₹)", type: "number", def: 1e5, min: 0, desc: "Liabilities at/below this count as 'zero'." },
      bigAssets: { label: "Min assets (₹)", type: "number", def: 1e8, min: 0, desc: "Only when assets are at least this (default ₹10 Cr)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      const out = [];
      const assets = ctx.seriesByPolitician("declared_assets");
      const biz = ctx.seriesByPolitician("declared_business_interests");
      for (const [pid, lrows] of ctx.seriesByPolitician("declared_liabilities")) {
        const p = ctx.pmap.get(pid);
        const l = lrows.at(-1), a = (assets.get(pid) ?? []).at(-1), b = (biz.get(pid) ?? []).at(-1);
        if (!l || !a || l.value > S.tinyFloor || a.value < S.bigAssets) continue;
        const interests = b?.value ?? 0;
        if (interests < 1) continue; // need at least one business interest to expect debt
        const score = Math.min(Math.round(10 + a.value / CR * 0.5 + interests * 3), 45);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `zerodebt|${l.year}`,
          headline: `${p.name} declares ~zero liabilities beside ₹${(a.value / CR).toFixed(1)} Cr in assets and ${interests} business interest(s).`,
          rationale: `Latest affidavit: liabilities ₹${Math.round(l.value)}, assets ₹${(a.value / CR).toFixed(2)} Cr, ${interests} declared business interest(s). Companies and large property portfolios almost always carry loans or payables; a genuine zero is possible (inherited/cash wealth) but is the classic net-worth-inflation / hidden-lender marker. Weak alone — earns its weight in a cluster.`,
          evidence: [evidenceRef(l.evidence_id, `affidavit: zero liabilities beside ₹${(a.value / CR).toFixed(2)} Cr assets`)],
          data: { statistic: "zero_liability_implausibility", assets: a.value, liabilities: l.value, interests },
        });
      }
      return out;
    },
  },
  {
    id: "multirole_company", label: "Company node with many adverse roles", category: "network",
    desc: "A single company that accumulates several INDEPENDENT structural roles at once — politician-owned/directed, an offshore link, a court/SEC filing, a government award. One node carrying many independent red edges is the concentration point of a network.",
    tunables: T({
      minRoles: { label: "Min distinct roles", type: "number", def: 3, min: 2, max: 8, desc: "Distinct independent role types on one company to flag." },
      bigRoles: { label: "Big at roles", type: "number", def: 4, min: 2, max: 10, desc: "BIG at/above this many." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    run(ctx, S) {
      // Accumulate role types per company entity from edges + claims + events.
      const roles = new Map(); // entity → Set(roleType), evidence
      const add = (eid, role, evidenceId) => {
        if (!eid) return;
        const g = roles.get(eid) ?? roles.set(eid, { types: new Set(), evidence: new Set() }).get(eid);
        g.types.add(role); if (evidenceId) g.evidence.add(evidenceId);
      };
      for (const rt of ["owner_of", "director_of", "proprietor_of", "chairman_of"])
        for (const e of ctx.relationsByType(rt)) add(e.dst_entity_id, "politician_control", e.evidence_id);
      for (const e of ctx.relationsByType("linked_offshore_entity")) add(e.dst_entity_id, "offshore", e.evidence_id);
      for (const e of ctx.relationsByType("named_in_filing")) add(e.dst_entity_id, "sec_filing", e.evidence_id);
      for (const e of ctx.relationsByType("donor_to")) add(e.src_entity_id, "political_donor", e.evidence_id);
      for (const kind of ["awarded_tender", "government_contract_mention"])
        for (const ev of ctx.eventsByKind(kind)) { const ids = (() => { try { return JSON.parse(ev.entity_ids); } catch { return []; } })(); add(ids[0], "govt_awardee", ev.evidence_id); }
      const out = [];
      for (const [eid, g] of roles) {
        if (g.types.size < S.minRoles) continue;
        const ent = ctx.entityById(eid);
        if (!ent || ent.kind === "person") continue; // company/org subjects only
        const score = Math.min(12 + g.types.size * 8, 52);
        out.push({
          subject: { entity_id: eid, name: ent.canonical_name, kind: ent.kind },
          score,
          fingerprint: `roles${g.types.size}`,
          headline: `${ent.canonical_name} carries ${g.types.size} independent adverse roles at once: ${[...g.types].join(", ")}.`,
          rationale: `This company node is simultaneously tagged: ${[...g.types].join(", ")}. Independent structural roles converging on one entity — politician control + a government award + an offshore link, say — is the concentration point a network investigation starts from. Large diversified firms legitimately appear in many roles; verify identity and scale.`,
          evidence: [...g.evidence].slice(0, 6).map((eid2) => evidenceRef(eid2, "one of the roles on this company")),
          data: { statistic: "multirole_company", roles: [...g.types] },
          severityOverride: g.types.size >= S.bigRoles ? "big" : null,
        });
      }
      return out;
    },
  },

  // ─────────── Source-gap solves: value the nexus, verify the registry ─────────
  {
    id: "politician_linked_award", label: "Politician's firm won government contracts", category: "nexus",
    desc: "Values the nexus: takes each company a rep is linked to (declared business interest, ownership, directorship) and looks up its ACTUAL CPPP government-award footprint by name — total value, wins, buyers, single-bid share. The 'my company quietly wins state contracts' shape, now with the rupee figure. (Reads the flattened CPPP table; indexed by bidder name, so it's fast even though it touches millions of awards. Silent when the CPPP index is absent.)",
    tunables: T({
      minValue: { label: "Min award value (₹)", type: "number", def: 1e7, min: 0, desc: "Flag when a rep's linked firms won at least this much (default ₹1 Cr)." },
      bigValue: { label: "Big value (₹)", type: "number", def: 1e8, min: 0, desc: "BIG at/above this (default ₹10 Cr)." },
      minNameLen: { label: "Min name length", type: "number", def: 8, min: 4, max: 40, desc: "Skip short/generic company names (namesake guard)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    async run(ctx, S) {
      // Associated companies per rep: declared business interests + owner/director edges.
      const selfByPid = ctx.selfEntityByPolitician();
      const companyEdges = new Map(); // pid → Map(normName → display)
      const addCo = (pid, name) => {
        if (!name || name.length < S.minNameLen) return;
        const nk = cpppNorm(name);
        if (nk.split(" ").length < 2 || nk.length < 6) return; // reliable key guard
        (companyEdges.get(pid) ?? companyEdges.set(pid, new Map()).get(pid)).set(nk, name);
      };
      const entToPid = new Map();
      for (const [pid, eid] of selfByPid) entToPid.set(eid, pid);
      for (const rt of ["declared_business_interest", "owner_of", "director_of", "proprietor_of"]) {
        for (const e of ctx.relationsByType(rt)) {
          const pid = entToPid.get(e.src_entity_id);
          if (!pid) continue;
          const d = e.data ?? {};
          addCo(pid, d.company_name ?? d.name ?? (ctx.entityById(e.dst_entity_id)?.canonical_name));
        }
      }
      const out = [];
      for (const [pid, companies] of companyEdges) {
        const p = ctx.pmap.get(pid);
        if (!p) continue;
        let totalValue = 0, totalWins = 0, single = 0; const hits = [];
        for (const [nk, display] of companies) {
          const stats = await cpppBidderStats(nk); // fast indexed lookup
          if (!stats) continue;
          totalValue += stats.value || 0; totalWins += stats.wins; single += stats.single || 0;
          hits.push({ name: stats.display ?? display, wins: stats.wins, value: stats.value, buyers: stats.buyers });
        }
        if (!hits.length || totalValue < S.minValue) continue;
        hits.sort((a, b) => b.value - a.value);
        const score = Math.min(Math.round(12 + totalValue / CR * 2 + single), 55);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `award|${totalWins}`,
          headline: `${p.name}'s linked firm(s) won ≈${fmtVal(totalValue)} in government contracts across ${totalWins} awards${single ? ` (${single} single-bid)` : ""}.`,
          rationale: `Companies this rep declares an interest in / directs / owns appear as CPPP government-award winners: ${hits.slice(0, 4).map((h) => `${h.name} (${h.wins}× ${fmtVal(h.value)})`).join("; ")}. A representative whose own firms win public contracts is the core conflict-of-interest shape — the value quantifies it. Identity is name-matched (the firm name in the affidavit vs the CPPP awardee); the investigator confirms it's the same company and checks whether the office had sway over the buyer. Not a finding.`,
          evidence: [{ note: `CPPP: ${totalWins} awards worth ≈${fmtVal(totalValue)} to this rep's linked firms`, url: "https://eprocure.gov.in/cppp/" }],
          data: { statistic: "politician_linked_award", total_value: totalValue, total_wins: totalWins, single_bid: single, firms: hits.slice(0, 10) },
          severityOverride: totalValue >= S.bigValue ? "big" : null,
        });
      }
      return out;
    },
  },
  {
    id: "declared_company_absent_from_registry", label: "Declared company absent from the registry", category: "contradiction",
    desc: "A company a rep declares under oath (as a business interest) that leaves NO trace in any COMPANY REGISTRY we hold — the MCA company evidence, the Tofler director cache, or the resolved company entity graph. A sworn company no registry knows is either a genuine unregistered proprietorship (common, so weak alone) or a name with no real entity behind it. (Uses our EXISTING corpora as the registry proxy — no new source, no network.)",
    tunables: T({
      minNameLen: { label: "Min name length", type: "number", def: 10, min: 5, max: 40, desc: "Only check reasonably specific company names (short ones falsely 'match' too easily)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    async run(ctx, S) {
      // KNOWN-company registry proxy: the ACTUAL external registries only — MCA
      // company evidence + the Tofler director cache. The resolved entity graph is
      // deliberately EXCLUDED: declaring a company creates its entity, so including
      // it would make every declared company trivially "known" (circular). CPPP
      // bidder names are also excluded (a bidder string ≠ company registration).
      const known = new Set();
      const addKnown = (n) => { const k = cpppNorm(n); if (k.length >= 6) known.add(k); };
      for (const row of db.prepare("SELECT name FROM tofler_companies WHERE name IS NOT NULL").all()) addKnown(row.name);
      // Reps who actually have MCA coverage — only for THESE is an "absent" company
      // meaningful ("we looked via MCA and it wasn't there"), not just "not yet fetched".
      const mcaCovered = new Set();
      for (const p of ctx.politicians) for (const e of ctx.evidenceFor(p.id)) {
        if (e.source_type === "mca_company" && Array.isArray(e.numbers?.companies)) {
          mcaCovered.add(p.id);
          for (const c of e.numbers.companies) if (c.name) addKnown(c.name);
        }
      }

      const out = [];
      const selfByPid = ctx.selfEntityByPolitician();
      const entToPid = new Map(); for (const [pid, eid] of selfByPid) entToPid.set(eid, pid);
      // Declared business interests (sworn) for MCA-covered reps only, grouped per rep.
      const perRep = new Map();
      for (const e of ctx.relationsByType("declared_business_interest")) {
        const pid = entToPid.get(e.src_entity_id);
        if (!pid || !mcaCovered.has(pid)) continue; // coverage gate
        const d = e.data ?? {}; const name = d.company_name ?? d.name ?? ctx.entityById(e.dst_entity_id)?.canonical_name;
        if (!name || name.length < S.minNameLen) continue;
        const nk = cpppNorm(name);
        if (nk.split(" ").length < 2 || nk.length < 6 || known.has(nk)) continue; // found → fine
        (perRep.get(pid) ?? perRep.set(pid, []).get(pid)).push({ name, evidence_id: e.evidence_id });
      }
      for (const [pid, missing] of perRep) {
        const p = ctx.pmap.get(pid);
        if (!p) continue;
        const score = Math.min(8 + missing.length * 6, 40);
        out.push({
          subject: { politician_id: pid, name: p.name, kind: "person" },
          score,
          fingerprint: `absent${missing.length}`,
          headline: `${p.name} declares ${missing.length} business interest(s) that appear in NO company registry we hold: ${missing.slice(0, 3).map((m) => m.name).join("; ")}${missing.length > 3 ? "…" : ""}.`,
          rationale: `These sworn business interests match nothing across our MCA records, the Tofler director cache, or the resolved company entity graph: ${missing.slice(0, 5).map((m) => `"${m.name}"`).join(", ")}. A declared company with no registry footprint is worth a look — it may be a genuine unregistered proprietorship (common, so this is weak alone) or a name that doesn't correspond to a real entity. Small flag by design; earns weight in a cluster.`,
          evidence: missing.slice(0, 5).map((m) => evidenceRef(m.evidence_id, `sworn interest with no registry trace: ${m.name}`)),
          data: { statistic: "declared_company_absent", companies: missing.map((m) => m.name).slice(0, 10) },
        });
      }
      return out;
    },
  },
  {
    id: "donor_ruling_party_contractor", label: "Donor to a ruling party is a govt contractor", category: "nexus",
    desc: "The electoral round-trip: a company that DONATED to a party which CONTROLS a government (central or a state, per the governance map) AND appears as a CPPP government-award winner. Pay the party in power, win the state's contracts. (Needs the CPPP index for the award leg; the donation + governance legs work without it.)",
    tunables: T({
      minAwardValue: { label: "Min award value (₹)", type: "number", def: 1e7, min: 0, desc: "Only when the donor's CPPP awards total at least this (default ₹1 Cr)." },
      bigValue: { label: "Big value (₹)", type: "number", def: 1e8, min: 0, desc: "BIG at/above this donor-award value (default ₹10 Cr)." },
      bigAt: { ...BASE_TUNABLES.bigAt, def: 100 },
    }),
    async run(ctx, S) {
      const nowYear = 2026; // governance "currently in power" reference (Date.now avoided in engine)
      const out = [];
      for (const e of ctx.relationsByType("donor_to")) {
        const donor = ctx.entityById(e.src_entity_id);
        const partyEnt = ctx.entityById(e.dst_entity_id);
        if (!donor || donor.kind === "person") continue;
        const d = e.data ?? {};
        const party = canonParty(d.party ?? partyEnt?.canonical_name ?? "");
        if (!party) continue;
        // Is this party in power somewhere (now)?
        const governs = jurisdictionsGovernedBy(party, nowYear);
        if (!governs.length) continue;
        // Does the donor win government awards?
        const stats = await cpppBidderStats(cpppNorm(donor.canonical_name));
        if (!stats || (stats.value || 0) < S.minAwardValue) continue;
        const score = Math.min(Math.round(14 + (stats.value / CR) * 2), 55);
        out.push({
          subject: { entity_id: e.src_entity_id, name: donor.canonical_name, kind: donor.kind },
          score,
          fingerprint: `roundtrip|${party}`,
          headline: `${donor.canonical_name} donated to ${party} (governs ${governs.slice(0, 2).join(", ")}${governs.length > 2 ? "…" : ""}) and won ≈${fmtVal(stats.value)} in government contracts.`,
          rationale: `${donor.canonical_name}${d.total_cr ? ` gave ≈₹${d.total_cr} Cr to` : " is a donor to"} ${party}, which controls ${governs.join(", ")} (governance map, ${nowYear}); the same firm appears as a CPPP awardee with ≈${fmtVal(stats.value)} across ${stats.wins} awards. Donating to a ruling party and winning that government's contracts is the classic pay-to-play round-trip. Large diversified firms donate and win contracts routinely, and the award identity is name-matched — the investigator confirms the specific awarding authority falls under the party's government. Not a finding.`,
          evidence: [evidenceRef(e.evidence_id, `donation to ${party}`), { note: `CPPP: ${stats.wins} awards ≈${fmtVal(stats.value)}`, url: "https://eprocure.gov.in/cppp/" }],
          data: { statistic: "donor_ruling_party_contractor", party, governs, award_value: stats.value, award_wins: stats.wins, donation_cr: d.total_cr ?? null },
          severityOverride: (stats.value || 0) >= S.bigValue ? "big" : null,
        });
      }
      return out;
    },
  },
];

// Stable identity for a declared property across affidavits: type + district +
// owner (value is intentionally excluded — a revaluation must not read as a new item).
function propKey(it) {
  return [it.property_type, it.district, it.owner].map((x) => String(x ?? "").toLowerCase().trim()).join("|");
}

// ── nexus helpers ────────────────────────────────────────────────────────────
// Assemble the three nexus legs for one politician from existing edges/events.
// selfEnt + interestEdges are precomputed by the caller (one pass, not per-rep).
function gatherNexusLegs(ctx, p, awardees, selfEnt, interestEdges) {
  const detail = [], evidence = [], sectors = new Set();
  let power = false, interest = false, benefit = false;

  // Leg 1 — office power: parliamentary question/portfolio sectors (from evidence).
  for (const e of ctx.evidenceFor(p.id)) {
    if (e.source_type === "parliament_ls" && e.numbers?.power) {
      const qs = Object.keys(e.numbers.power.question_sectors ?? {});
      if (qs.length) { power = true; qs.slice(0, 4).forEach((s) => sectors.add(s)); detail.push(`office covers ${qs.slice(0, 3).join("/")}`); evidence.push(evidenceRef(e.id, "parliamentary power sectors")); break; }
    }
  }
  // Leg 2 — private interest: the rep's entity has owner_of/director_of/business edges.
  if (selfEnt) {
    const rels = interestEdges.get(selfEnt) ?? [];
    if (rels.length) {
      interest = true; detail.push(`holds ${rels.length} business/ownership interest(s)`);
      for (const r of rels.slice(0, 3)) { const d = r.data ?? {}; if (d.sector) sectors.add(d.sector); }
    }
    // Leg 3 — government benefit: this rep's entity is itself an awardee.
    if (awardees.has(selfEnt)) { benefit = true; detail.push("named on a government contract award"); }
  }
  return { power, interest, benefit, sectors: [...sectors], detail, evidence };
}

// Longest control chain INTO a company (how many holder-hops deep), bounded.
function chainDepth(node, controlledBy, seen, depth, cap) {
  if (depth >= cap || seen.has(node)) return depth;
  seen.add(node);
  const holders = controlledBy.get(node);
  if (!holders || !holders.size) return depth;
  let best = depth;
  for (const h of holders) {
    const d = chainDepth(h, controlledBy, seen, depth + 1, cap);
    if (d > best) best = d;
  }
  seen.delete(node);
  return best;
}

// Compact value formatter for the generic detector's prose (rupee scale-aware).
function fmtVal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= CR) return `₹${(n / CR).toFixed(2)} Cr`;
  if (Math.abs(n) >= L) return `₹${(n / L).toFixed(2)} L`;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

// ── Procurement (CPPP) detectors ────────────────────────────────────────────
// Appended to the registry from cppp-detectors.js. Each is ASYNC (reads the
// flattened CPPP award table) and self-gates (returns [] when the flat DB is
// absent), so a DB-less install simply sees zero procurement flags. Their run
// already returns candidates in the flag shape; the engine wraps them exactly
// like any other detector. Thresholds come from each detector's `defaults`,
// exposed as tunables so the ops console edits them live. bigAt is 100 so the
// detector's own severityOverride (its documented big-criteria) is the sole big
// gate — matching the general/nexus detectors.
const CPPP_LABELS = {
  cppp_supplier_capture: ["Supplier captures one buyer", "One bidder wins a dominant share of a single authority's awards."],
  cppp_single_bidder: ["Single-bidder supplier", "A firm whose wins are mostly uncontested (only its own bid) — the #1 procurement red flag."],
  cppp_contract_splitting: ["Contract splitting", "Many awards to one buyer→bidder pair, values hugging just under a round approval threshold."],
  cppp_short_window: ["Short bid window", "Awards closed implausibly fast after publication — too little time for real competition."],
  cppp_benford_values: ["Benford on contract values", "A buyer whose award values deviate from Benford's first-digit law."],
  cppp_fy_end_bunching: ["Fiscal-year-end bunching", "A buyer concentrating awards in March (the year-end budget-exhaustion rush)."],
  cppp_repeat_winner: ["Entrenched incumbent", "A buyer→bidder pair recurring across many years — durable single-supplier lock-in."],
  cppp_date_integrity: ["Award date backdating", "Contracts dated before their tender was published — a chronological impossibility."],
  cppp_anonymous_winner: ["Unverifiable payee", "A materially-paid bidder that carries no address on any record."],
};
function cpppTunables(defaults) {
  const t = { ...BASE_TUNABLES, bigAt: { ...BASE_TUNABLES.bigAt, def: 100 } };
  for (const [k, def] of Object.entries(defaults))
    t[k] = { label: k, type: "number", def, min: 0, desc: `CPPP threshold ${k} (default ${def}).` };
  return t;
}
for (const cd of CPPP_DETECTORS) {
  const [label, desc] = CPPP_LABELS[cd.id] ?? [cd.id, "CPPP procurement detector."];
  DETECTORS.push({
    id: cd.id, label: `Procurement · ${label}`, category: "procurement", desc,
    tunables: { ...cpppTunables(cd.defaults), maxFlags: { label: "Max flags", type: "number", def: 150, min: 1, max: 2000, desc: "Cap on flags kept (top by score) — the CPPP corpus is huge; keep the worst offenders." } },
    async run(_ctx, S) {
      // Pass the resolved numeric settings (drop enabled/bigAt/maxFlags) to the detector.
      const params = {};
      for (const k of Object.keys(cd.defaults)) params[k] = S[k];
      const cands = await cd.run(params);
      // Keep the top-N by score so one broad category can't flood the queue.
      cands.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return cands.slice(0, S.maxFlags);
    },
  });
}

// Pseudo-groups whose tunables the ops console edits alongside detectors.
// Defined in engine-groups.js (shared with lead-synthesis.js without a cycle);
// re-exported here so engine.js remains the one import surface for the API layer.
export { ENGINE_GROUPS };

export const detectorById = (idv) =>
  DETECTORS.find((d) => d.id === idv) ?? ENGINE_GROUPS.find((g) => g.id === idv) ?? null;

// The full settings surface for the ops console: every detector + group, its
// tunables meta, resolved values, and live flag counts.
export function engineStatus() {
  const counts = flagCounts();
  const describe = (d) => ({
    id: d.id, label: d.label, desc: d.desc, category: d.category ?? "group",
    tunables: Object.fromEntries(Object.entries(d.tunables).map(([k, m]) => [k, { ...m }])),
    settings: resolveSettings(d.id, d.tunables),
    flags: counts.perDetector[d.id] ?? { small: 0, big: 0, stale: 0 },
  });
  return {
    version: ENGINE_VERSION,
    totals: { small: counts.small, big: counts.big, stale: counts.stale },
    detectors: DETECTORS.map(describe),
    groups: ENGINE_GROUPS.map(describe),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════
// opts:
//   detectors    — array of detector ids to run (default: all enabled)
//   politicianId — scope flag EMISSION to one rep (population stats still use
//                  the full cohort; stale-marking is skipped on scoped runs)
//   dryRun       — compute and report; write NOTHING (for threshold tuning)
//   synthesize   — run lead synthesis afterwards (default true, false on dryRun)
//   enrich       — override the enrichment.enabled setting for this run
//   procurement  — include the (slow, 4.9M-row) CPPP procurement detectors. OFF
//                  by default so a normal engine pass stays fast; the ops console
//                  runs them as their own step. Auto-ON when `detectors` explicitly
//                  names cppp_* ids.
export async function runEngine(opts = {}) {
  const { detectors = null, politicianId = null, dryRun = false, log = console.log } = opts;
  const wantProcurement = opts.procurement ?? (Array.isArray(detectors) && detectors.some((d) => d.startsWith("cppp_")));
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();
  const ctx = buildCtx({ log });
  const results = {};
  const allFlags = [];

  for (const det of DETECTORS) {
    if (detectors && !detectors.includes(det.id)) continue;
    if (det.category === "procurement" && !wantProcurement) continue; // opt-in only
    const S = resolveSettings(det.id, det.tunables);
    if (!S.enabled) { results[det.id] = { skipped: "disabled" }; continue; }
    const dt0 = Date.now();
    try {
      let candidates = (await det.run(ctx, S)) ?? []; // await: procurement detectors are async
      if (politicianId) candidates = candidates.filter((c) => c.subject?.politician_id === politicianId);
      let big = 0, small = 0;
      const samples = [];
      for (const c of candidates) {
        const severity = c.severityOverride === "big" || (c.score ?? 0) >= S.bigAt ? "big" : "small";
        severity === "big" ? big++ : small++;
        const flag = {
          key: `${det.id}|${c.subject?.politician_id ?? c.subject?.entity_id ?? "pop"}|${c.fingerprint ?? ""}`,
          detector: det.id, severity, score: c.score ?? 0,
          politician_id: c.subject?.politician_id ?? null,
          entity_id: c.subject?.entity_id ?? null,
          subject_name: c.subject?.name ?? null, subject_kind: c.subject?.kind ?? null,
          headline: c.headline, rationale: c.rationale,
          evidence: c.evidence ?? [], data: c.data ?? {},
          lead: c.lead ?? null,
          detector_version: `${det.id}@${ENGINE_VERSION}`, run_id: runId,
        };
        if (samples.length < 5) samples.push(`[${severity}] ${c.headline}`);
        if (!dryRun) upsertFlag(flag);
        allFlags.push(flag);
      }
      // A full-population run's silence about a previously-flagged subject means
      // the data no longer supports that flag → stale. Scoped runs skip this.
      let stale = 0;
      if (!dryRun && !politicianId) stale = markStaleExcept(det.id, runId);
      results[det.id] = { candidates: candidates.length, big, small, stale, ms: Date.now() - dt0, samples };
      log(`[engine] ${det.id}: ${candidates.length} flag(s) (${big} big, ${small} small${stale ? `, ${stale} stale` : ""}) in ${Date.now() - dt0}ms`);
    } catch (err) {
      results[det.id] = { error: err.message };
      log(`[engine] ${det.id} FAILED: ${err.message}`);
    }
  }

  // ── Enrichment (free network, evidence-recording) ──
  let enrichment = { enabled: false };
  const ES = resolveSettings("enrichment", ENGINE_GROUPS[0].tunables);
  const enrichWanted = opts.enrich ?? ES.enabled;
  if (!dryRun && enrichWanted) {
    try {
      const { enrichLeadsWithTofler } = await import("./tofler-enrich.js");
      // Company-bearing BIG flags become pseudo-leads for the existing enricher
      // (it reads beneficiary_kind + the lead body to find company targets).
      const companyFlags = allFlags.filter((f) => f.severity === "big" && f.lead && ["company", "company_cluster", "tender"].includes(f.lead.beneficiary_kind));
      const targets = companyFlags.slice(0, Math.max(0, ES.maxLookups)).map((f) => f.lead);
      enrichment = await enrichLeadsWithTofler(targets, { force: true });
      enrichment.enabled = true;
      // SEBI corporate disclosures (opt-in via SEBI_DISCLOSURES_ENABLE; the fetcher
      // returns [] unless the flag is set, so this is a near-free no-op when off).
      // For the same company-bearing BIG-flag targets, pull the listed company's
      // insider-trade / SAST / related-party filings from NSE and record them as
      // evidence. Fail-soft — a network/parse error never breaks enrichment.
      try {
        const { fetchSebiDisclosures } = await import("./fetchers/sebi-disclosures.js");
        const { companyTargetsFromLead } = await import("./fetchers/tofler.js");
        const { addEvidence } = await import("./store.js");
        let sebiRows = 0;
        for (const lead of targets) {
          if (!lead?.actor_id) continue;
          const rows = await fetchSebiDisclosures(companyTargetsFromLead(lead), lead.actor_id);
          if (rows?.length) { addEvidence(rows); sebiRows += rows.length; }
        }
        enrichment.sebi_disclosures = sebiRows;
      } catch (err) { enrichment.sebi_disclosures = { error: err.message }; }
      try {
        const { matchDirectorsToPoliticians } = await import("./director-link.js");
        const dl = matchDirectorsToPoliticians();
        enrichment.director_link = { companies: dl.companies, directors: dl.directors, leads: dl.leads };
      } catch (err) { enrichment.director_link = { error: err.message }; }
    } catch (err) { enrichment = { enabled: true, error: err.message }; }
  }

  // ── Synthesis: flags → leads (with citations) ──
  let synthesis = null;
  if (!dryRun && (opts.synthesize ?? true)) {
    const { runLeadSynthesis } = await import("./lead-synthesis.js");
    synthesis = await runLeadSynthesis({ log });
  }

  return { runId, dryRun, tookMs: Date.now() - t0, detectors: results, enrichment, synthesis };
}

// ── CLI: node server/engine.js [--dry-run] [--detector id] [--id politician] ──
const isMain = process.argv[1] && /[\\/]engine\.js$/.test(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1]?.startsWith("--") ? true : args[i + 1] ?? true) : null; };
  const res = await runEngine({
    dryRun: args.includes("--dry-run"),
    detectors: flag("detector") ? [flag("detector")] : null,
    politicianId: typeof flag("id") === "string" ? flag("id") : null,
  });
  console.log(`\n[engine] ${res.dryRun ? "DRY RUN — nothing written" : "run complete"} (${res.tookMs}ms)`);
  for (const [idv, r] of Object.entries(res.detectors)) {
    if (r.skipped) console.log(`  ${idv.padEnd(24)}: skipped (${r.skipped})`);
    else if (r.error) console.log(`  ${idv.padEnd(24)}: ERROR ${r.error}`);
    else console.log(`  ${idv.padEnd(24)}: ${r.big} big + ${r.small} small${r.stale ? ` (${r.stale} stale)` : ""}`);
  }
  if (res.synthesis) console.log(`[engine] synthesis: ${JSON.stringify(res.synthesis)}`);
}
