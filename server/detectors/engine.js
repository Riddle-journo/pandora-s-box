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
import { db, listPoliticians, listEvidence } from "../store/store.js";
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
import { CPPP_DETECTORS } from "./cppp-detectors.js";
// Detector run()-body helpers, extracted to detectors/helpers.js. Imported here
// for local use and re-exported below so external consumers of engine.js keep
// working (meanStd/benfordStats/evidenceRef were part of engine.js's surface).
import {
  meanStd, benfordStats, evidenceRef,
  BASE_TUNABLES,
} from "./helpers.js";
export { meanStd, benfordStats, evidenceRef } from "./helpers.js";
import { DETECTORS_A } from "./batch-a.js";
import { DETECTORS_B } from "./batch-b.js";
import { guardDetector, populationForMetric, COHORT_DEFAULTS } from "./cohort-guard.js";

export const ENGINE_VERSION = "engine-v1";

// Base-rate guard thresholds. Live in the DB like every other threshold
// (architectural rule: judgement calls are tunable from the ops console without
// a deployment), under the pseudo-detector id `cohort_guard`.
export const COHORT_TUNABLES = {
  systemicAt: {
    label: "Systemic above", type: "number", def: COHORT_DEFAULTS.systemicAt, min: 0.02, max: 0.9,
    desc: "Fire rate (0–1) above which a finding is treated as a property of the cohort, not of its members.",
  },
  tailPct: {
    label: "Keep tail", type: "number", def: COHORT_DEFAULTS.tailPct, min: 0.005, max: 0.5,
    desc: "Share of the cohort still reported individually once a finding is systemic.",
  },
  minPopulation: {
    label: "Min cohort", type: "number", def: COHORT_DEFAULTS.minPopulation, min: 5, max: 5000,
    desc: "Below this many eligible subjects, no base rate is computed and nothing is suppressed.",
  },
  minKeep: {
    label: "Always keep", type: "number", def: COHORT_DEFAULTS.minKeep, min: 1, max: 50,
    desc: "Most extreme cases always retained individually, whatever the base rate.",
  },
};

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

// ═══════════════════════════════════════════════════════════════════════════
// THE DETECTOR REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
// The registry is heterogeneous by design: every detector carries id/label/desc
// plus its own `tunables` shape (the CPPP entries append a `maxFlags` knob that
// the hand-written ones do not have), so the element type is deliberately open.
// Stated as prose rather than a JSDoc type annotation: this file is excluded
// from tsconfig.json (its import closure carries pre-existing type errors), so
// any type written here would be unchecked — see the tsconfig exclude comment.
export const DETECTORS = [
  ...DETECTORS_A,
  ...DETECTORS_B,
];

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
// defaults: { [threshold]: number } → tunable metadata, extended per detector.
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

      // Base-rate guard. A detector that fires on a quarter of its cohort is
      // describing the norm, so above the ceiling only the tail stays an
      // individual finding and the pattern itself becomes one lead about the
      // programme. Scoped single-politician runs skip it — you cannot measure a
      // base rate from a population of one.
      let systemicFindings = [];
      let cohortStats = null;
      if (det.cohort && !politicianId) {
        const population = det.cohort.population
          ? det.cohort.population(ctx)
          : populationForMetric(ctx, det.cohort.metric);
        const guarded = guardDetector(candidates, { ...det.cohort, population }, resolveSettings("cohort_guard", COHORT_TUNABLES));
        candidates = guarded.candidates;
        systemicFindings = guarded.systemic;
        cohortStats = guarded.stats;
      }

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
      // The systemic counterpart: one finding about the programme, carrying the
      // arithmetic. Written under the same runId as the individual flags so the
      // staleness sweep below does not immediately retire it.
      for (const sf of systemicFindings) {
        const flag = {
          key: `${det.id}|systemic|${sf.group ?? "all"}`,
          detector: det.id, severity: "big", score: sf.signal_score,
          politician_id: null, entity_id: sf.entity_id ?? null,
          subject_name: sf.subject_name, subject_kind: sf.subject_kind,
          headline: sf.headline, rationale: sf.detail,
          evidence: [], data: sf.data,
          lead: {
            actor_id: null, actor_name: sf.subject_name,
            vector: "SYSTEMIC_PATTERN", instrument: sf.subject_name,
            beneficiary: sf.subject_name, beneficiary_kind: sf.subject_kind,
            signal_score: sf.signal_score, severity: sf.severity,
            headline: sf.headline, detail: sf.detail,
            detector_version: `${det.id}@${ENGINE_VERSION}`, evidence_urls: [], data: sf.data,
          },
          detector_version: `${det.id}@${ENGINE_VERSION}`, run_id: runId,
        };
        if (!dryRun) upsertFlag(flag);
        allFlags.push(flag);
        big++;
        log(`[engine] ${det.id}: SYSTEMIC — ${sf.headline}`);
      }

      // A full-population run's silence about a previously-flagged subject means
      // the data no longer supports that flag → stale. Scoped runs skip this.
      let stale = 0;
      if (!dryRun && !politicianId) stale = markStaleExcept(det.id, runId);
      results[det.id] = {
        candidates: candidates.length, big, small, stale, ms: Date.now() - dt0, samples,
        ...(cohortStats ? { cohort: cohortStats, systemic: systemicFindings.length } : {}),
      };
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
      const { enrichLeadsWithTofler } = await import("../enrichment/tofler-enrich.js");
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
        const { fetchSebiDisclosures } = await import("../fetchers/sebi-disclosures.js");
        const { companyTargetsFromLead } = await import("../fetchers/tofler.js");
        const { addEvidence } = await import("../store/store.js");
        let sebiRows = 0;
        for (const lead of targets) {
          if (!lead?.actor_id) continue;
          const rows = await fetchSebiDisclosures(companyTargetsFromLead(lead), lead.actor_id);
          if (rows?.length) { addEvidence(rows); sebiRows += rows.length; }
        }
        enrichment.sebi_disclosures = sebiRows;
      } catch (err) { enrichment.sebi_disclosures = { error: err.message }; }
      try {
        const { matchDirectorsToPoliticians } = await import("../enrichment/director-link.js");
        const dl = matchDirectorsToPoliticians();
        enrichment.director_link = { companies: dl.companies, directors: dl.directors, leads: dl.leads };
      } catch (err) { enrichment.director_link = { error: err.message }; }
    } catch (err) { enrichment = { enabled: true, error: err.message }; }
  }

  // ── Synthesis: flags → leads (with citations) ──
  let synthesis = null;
  if (!dryRun && (opts.synthesize ?? true)) {
    const { runLeadSynthesis } = await import("../synthesis/lead-synthesis.js");
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
