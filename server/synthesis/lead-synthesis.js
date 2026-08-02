// Lead synthesis — the bridge from the engine's FLAGS to investigation LEADS.
//
// Two promotion paths, both carrying evidence citations ("why this is a lead"):
//   1. Every active BIG flag → one lead. Wrapped-legacy flags promote their
//      original candidate verbatim (same vector, same dedupe key — so engine
//      runs and the old direct paths can coexist without duplicate leads).
//   2. Small flags never lead alone: per-subject CLUSTERS of flags whose
//      weighted composite clears the threshold → one FLAG_CLUSTER lead that
//      cites every contributing flag and its evidence.
// Leads land as status 'detected' in the SAME queue as always: GLM L2/L3
// investigates, the referee filters, and the admin gate decides. upsertLead
// preserves any human-advanced status, so re-synthesis never regresses a lead.
import { upsertLead, retireLeadsWithoutActiveFlags } from "../store/store.js";
import { activeFlagsBySubject, listFlags } from "../detectors/flags.js";
import { resolveSettings } from "../detectors/engine-settings.js";
import { ENGINE_GROUPS } from "../detectors/engine-groups.js";

const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");

// Render a flag's evidence array into citable text lines.
function citeLines(evidence = []) {
  return evidence
    .filter((e) => e && (e.url || e.evidence_id || e.note))
    .map((e) => `  – ${e.note ?? "source"}${e.title ? ` — "${e.title}"` : ""}${e.url ? ` <${e.url}>` : e.evidence_id ? ` [evidence:${e.evidence_id}]` : ""}`);
}

const urlsOf = (evidence = []) => [...new Set(evidence.map((e) => e?.url).filter(Boolean))];

// ── Path 1: big flags → leads ────────────────────────────────────────────────
export function promoteBigFlags({ log = () => {} } = {}) {
  const { rows } = listFlags({ severity: "big", status: "active", limit: 100000 });
  let promoted = 0;
  for (const f of rows) {
    if (f.lead) {
      // Legacy candidate: promote verbatim (keeps vector + key), attach citations.
      upsertLead({
        ...f.lead,
        data: { ...(f.lead.data ?? {}), engine_flag_key: f.key, evidence: f.evidence },
      });
    } else {
      const why = citeLines(f.evidence);
      upsertLead({
        vector: f.detector.toUpperCase(),
        actor_id: f.politician_id ?? f.entity_id ?? null,
        actor_name: f.subject_name ?? null,
        instrument: f.data?.statistic ?? f.detector,
        beneficiary: `${f.subject_name ?? "?"} · ${f.data?.statistic ?? f.detector}${f.key.split("|")[2] ? ` · ${f.key.split("|")[2]}` : ""}`,
        beneficiary_kind: f.subject_kind ?? "person",
        key: `${f.detector.toUpperCase()}|${f.politician_id ?? f.entity_id ?? ""}|${f.key.split("|")[2] ?? ""}`,
        signal_score: f.score, severity: sev(f.score),
        headline: f.headline,
        detail: `${f.rationale}${why.length ? `\n\nWhy this is a lead (evidence):\n${why.join("\n")}` : ""}`,
        evidence_urls: urlsOf(f.evidence),
        detector_version: f.detector_version,
        data: { engine_flag_key: f.key, statistic: f.data?.statistic, evidence: f.evidence, ...f.data },
      });
    }
    promoted++;
  }
  log(`[synthesis] promoted ${promoted} big flag(s) to leads`);
  return promoted;
}

// ── Path 2: per-subject flag clusters → FLAG_CLUSTER leads ───────────────────
export function clusterFlags({ log = () => {} } = {}) {
  const S = resolveSettings("synthesis", ENGINE_GROUPS.find((g) => g.id === "synthesis").tunables);
  const bySubject = activeFlagsBySubject();
  let clusters = 0;
  for (const [subjectKey, flags] of bySubject) {
    if (flags.length < S.minFlags) continue;
    const detectors = new Set(flags.map((f) => f.detector));
    if (detectors.size < S.minDetectors) continue;
    const base = flags.reduce((s, f) => s + f.score * (f.severity === "big" ? 1 : S.smallWeight), 0);
    const composite = base * (1 + S.diversityBonus * (detectors.size - 1));
    if (composite < S.clusterMin) continue;

    const name = flags[0].subject_name ?? subjectKey;
    const isPol = subjectKey.startsWith("pol:");
    const bullets = flags
      .sort((a, b) => b.score - a.score)
      .map((f) => {
        const cites = citeLines(f.evidence);
        return `• [${f.severity.toUpperCase()} · ${f.detector} · score ${Math.round(f.score)}] ${f.headline}\n${cites.join("\n")}`;
      });
    clusters++;
    upsertLead({
      vector: "FLAG_CLUSTER",
      key: `FLAG_CLUSTER|${subjectKey}`,
      actor_id: subjectKey.slice(4), actor_name: name,
      instrument: `${flags.length} corroborating flags across ${detectors.size} detectors`,
      beneficiary: name, beneficiary_kind: isPol ? "politician" : "entity",
      signal_score: Math.min(Math.round(composite), 70), severity: sev(composite),
      headline: `${name}: ${flags.length} anomaly flags across ${detectors.size} independent detectors (${[...detectors].join(", ")}).`,
      detail: [
        `Independent detectors corroborate on this subject — the cluster shape is stronger than any single flag (composite ${Math.round(composite)}: big flags full weight, small × ${S.smallWeight}, +${Math.round(S.diversityBonus * 100)}%/extra detector).`,
        ``,
        `Why this is a lead (each flag with its evidence):`,
        ...bullets,
        ``,
        `Every flag above is a statistical or structural candidate, not a finding. The AI Investigator + Referee + human gate decide what is real.`,
      ].join("\n"),
      evidence_urls: [...new Set(flags.flatMap((f) => urlsOf(f.evidence)))].slice(0, 12),
      detector_version: "flag-cluster@engine-v1",
      data: {
        composite, detectors: [...detectors],
        flags: flags.map((f) => ({
          key: f.key, detector: f.detector, severity: f.severity, score: f.score,
          headline: f.headline, rationale: f.rationale, evidence: f.evidence,
        })),
      },
    });
  }
  log(`[synthesis] ${clusters} flag-cluster lead(s)`);
  return clusters;
}

// ── Full pass: promote, cluster, then (optionally) network hubs ──────────────
export async function runLeadSynthesis({ log = console.log } = {}) {
  const S = resolveSettings("synthesis", ENGINE_GROUPS.find((g) => g.id === "synthesis").tunables);
  const promoted = promoteBigFlags({ log });
  const clusters = clusterFlags({ log });
  let hubs = 0;
  if (S.runHubs) {
    try {
      // Lazy import: synthesis.js reads all leads (including what we just wrote).
      const { runSynthesis } = await import("./synthesis.js");
      hubs = runSynthesis().hubs.length;
      log(`[synthesis] ${hubs} network-hub meta-lead(s)`);
    } catch (err) { log(`[synthesis] hubs skipped: ${err.message}`); }
  }
  // Retire leads whose flag no longer exists. Flags have had a staleness sweep
  // since the engine was written; leads never did, so every false positive a
  // detector fix removed stayed on the page regardless. Soft, and only for
  // leads no human has ruled on.
  const retired = retireLeadsWithoutActiveFlags();
  if (retired.retired) log(`[synthesis] ${retired.retired} lead(s) retired — their flag is no longer active`);

  return { promoted, clusters, hubs, retired: retired.retired };
}
