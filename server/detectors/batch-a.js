// Detector batch A — the first ~half of the DETECTORS registry, moved out of
// engine.js VERBATIM to keep the registry file manageable. Mirrors the pattern
// of cppp-detectors.js (detectors living outside engine.js). engine.js splices
// these back into the DETECTORS array via  ...DETECTORS_A,  at the same position,
// so element order is unchanged. Bodies are byte-for-byte identical to their
// former engine.js form.
import { db } from "../store/store.js";
import { detectConflicts, CONFLICT_DEFAULTS } from "./conflict.js";
import {
  detectAssetGrowthOutliers, detectUtilizationExtremes, detectTimingCorrelation, ANOMALY_DEFAULTS,
} from "./anomaly.js";
import {
  detectIncomeGrowthOutliers, detectSpendVsIncome, detectMultiSourceAdverse, LEDGER_DEFAULTS,
} from "./ledger-detectors.js";
import { detectCollusion } from "./collusion.js";
import {
  CR, L, meanStd, benfordStats, evidenceRef, legacyOverrides, fromLegacy,
  BASE_TUNABLES, T, legacyTunables,
} from "./helpers.js";

export const DETECTORS_A = [
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
    // Base rate: measured at 128 of 472 members (27.1%) under-utilising, which
    // is a fact about how MPLADS runs, not about 128 individuals. The two tails
    // are judged separately — they are opposite conditions with opposite rates.
    cohort: {
      metric: "mplads_utilization_pct",
      subjectKind: "programme",
      subjectName: "MPLADS (Members of Parliament Local Area Development Scheme)",
      unit: "% of allocation utilised",
      stat: (c) => c.data?.utilization_pct ?? null,
      groupBy: (c) => c.data?.extreme ?? null,
      directionFor: (key) => (key === "fully-drawn" ? "high" : "low"),
      subjectNameFor: (key) => (key === "fully-drawn"
        ? "MPLADS spend-to-the-rupee reporting"
        : "MPLADS (Members of Parliament Local Area Development Scheme)"),
    },
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
    // Same reasoning as fund_utilization: chronic non-completion is mostly an
    // administrative property of the scheme. Only the worst few are about a
    // person; the rate itself is the story.
    cohort: {
      metric: "mplads_works_recommended",
      subjectKind: "programme",
      subjectName: "MPLADS works completion",
      unit: "% of recommended works completed",
      stat: (c) => c.data?.pct ?? null,
      direction: "low",
    },
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
];
