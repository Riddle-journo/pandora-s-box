// Detector batch B — the second ~half of the DETECTORS registry, moved out of
// engine.js VERBATIM to keep the registry file manageable. Mirrors batch-a.js.
// engine.js splices these back into the DETECTORS array via  ...DETECTORS_B,  at
// the same position, so element order is unchanged. Bodies are byte-for-byte
// identical to their former engine.js form.
import { db } from "../store/store.js";
import { mahalanobisOutliers, changePoint } from "./engine-multivariate.js";
import { cpppBidderStats } from "./cppp-detectors.js";
import { normName as cpppNorm } from "../store/cppp-index.js";
import { jurisdictionsGovernedBy, canonParty } from "../data/governance-map.js";
import {
  CR, evidenceRef, propKey, gatherNexusLegs, chainDepth, fmtVal,
  BASE_TUNABLES, T,
} from "./helpers.js";

export const DETECTORS_B = [
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
        // Accepts the legacy key too — rows written before the rename still say
        // `total_cr`, and both mean the same (misleadable) national total.
        const donationCr = d.total_cr_all_parties ?? d.total_cr ?? null;
        out.push({
          subject: { entity_id: e.src_entity_id, name: donor.canonical_name, kind: donor.kind },
          score,
          fingerprint: `roundtrip|${party}`,
          headline: `${donor.canonical_name} donated to ${party} (governs ${governs.slice(0, 2).join(", ")}${governs.length > 2 ? "…" : ""}) and won ≈${fmtVal(stats.value)} in government contracts.`,
          // The bond figure is the donor's purchase across EVERY party it
          // funded — India's disclosure never itemised the per-party split, and
          // the same total is stamped on each of a donor's party edges. Saying
          // "gave ₹1,368 Cr to DMK" about a figure shared across four parties
          // is a false statement about a named company.
          rationale: `${donor.canonical_name}${donationCr ? ` bought ≈₹${donationCr} Cr of electoral bonds (its total across every party it funded — the per-party split was never disclosed) and is recorded as a donor to` : " is a donor to"} ${party}, which controls ${governs.join(", ")} (governance map, ${nowYear}); the same firm appears as a CPPP awardee with ≈${fmtVal(stats.value)} across ${stats.wins} awards. Donating to a ruling party and winning that government's contracts is the classic pay-to-play round-trip. Large diversified firms donate and win contracts routinely, and the award identity is name-matched — the investigator confirms the specific awarding authority falls under the party's government. Not a finding.`,
          evidence: [evidenceRef(e.evidence_id, `donation to ${party}`), { note: `CPPP: ${stats.wins} awards ≈${fmtVal(stats.value)}`, url: "https://eprocure.gov.in/cppp/" }],
          data: { statistic: "donor_ruling_party_contractor", party, governs, award_value: stats.value, award_wins: stats.wins, donation_cr_all_parties: donationCr },
          severityOverride: (stats.value || 0) >= S.bigValue ? "big" : null,
        });
      }
      return out;
    },
  },
];
