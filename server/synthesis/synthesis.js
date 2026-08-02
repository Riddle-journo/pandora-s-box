// L4 Cross-Entity Synthesis — the network layer the per-politician view misses.
//
// L1–L3 investigate ONE (actor → instrument → beneficiary) triple at a time. But
// the most novel findings are HUBS: one beneficiary that recurs across MANY
// politicians — a contractor winning work tied to 5 different MPs, a registered
// address behind a dozen tender bidders, a donor that funds a party AND wins its
// government's contracts. This module joins ACROSS all leads to surface those.
//
// Output is a META-LEAD (vector "NETWORK_HUB") pushed through the SAME queue as
// every other lead: it is a candidate, gated behind L2/L3 + human approval, never
// auto-published. `synthesizeHubs({leads})` is pure/testable; `runSynthesis()`
// reads the store and upserts.
import { listLeads, upsertLead } from "../store/store.js";
import { normName } from "../entities/entities.js";

const MIN_DISTINCT_ACTORS = 3; // a hub needs ≥3 distinct politicians to be notable

// Normalise a beneficiary label so "X Ethanol Ltd" and "X ETHANOL LTD." collapse.
// Uses the ONE canonical normalizer (entities.normName) so entity resolution and
// hub-grouping agree on what counts as "the same" name.
const beneficiaryKey = (b) => normName(b);

// Group leads by beneficiary; any beneficiary spanning ≥N distinct actors is a hub.
export function synthesizeHubs({ leads = [] } = {}) {
  const groups = new Map(); // key → { label, actors:Map(actor_id→name), vectors:Set, urls:Set, kind }
  for (const l of leads) {
    // Skip meta-leads themselves and leads with no real beneficiary/actor.
    if (l.vector === "NETWORK_HUB") continue;
    const key = beneficiaryKey(l.beneficiary);
    if (!key || key.length < 4 || !l.actor_id) continue;
    const g = groups.get(key) ?? { label: l.beneficiary, actors: new Map(), vectors: new Set(), urls: new Set(), kind: l.beneficiary_kind ?? "entity" };
    g.actors.set(l.actor_id, l.actor_name ?? l.actor_id);
    g.vectors.add(l.vector);
    for (const u of l.evidence_urls ?? []) if (u) g.urls.add(u);
    groups.set(key, g);
  }

  const hubs = [];
  for (const [key, g] of groups) {
    if (g.actors.size < MIN_DISTINCT_ACTORS) continue;
    const actorNames = [...g.actors.values()];
    const signal_score = 15 + (g.actors.size - MIN_DISTINCT_ACTORS) * 8 + (g.vectors.size - 1) * 3;
    hubs.push({
      vector: "NETWORK_HUB",
      actor_id: null, actor_name: null,
      instrument: [...g.vectors].join(", "),
      beneficiary: g.label, beneficiary_kind: g.kind,
      key: `NETWORK_HUB|${key}`, // stable dedupe key across runs (upsert honours lead.key)
      signal_score,
      severity: g.actors.size >= 5 ? "SIGNIFICANT" : "NOTABLE",
      headline: `${g.label} appears in leads tied to ${g.actors.size} different representatives — a possible network hub.`,
      hub: { distinct_actors: g.actors.size, actors: actorNames, vectors: [...g.vectors] },
      evidence_urls: [...g.urls].slice(0, 12),
      detail: `The entity "${g.label}" recurs across ${g.actors.size} representatives (${actorNames.slice(0, 6).join("; ")}${actorNames.length > 6 ? "…" : ""}) via ${[...g.vectors].join(", ")}. A shared beneficiary across many offices is the network-hub shape — a LEAD for the Investigator/Referee, not a finding.`,
    });
  }
  hubs.sort((a, b) => b.signal_score - a.signal_score);
  return { hubs };
}

// Store-backed runner: read ALL leads, find hubs, upsert the meta-leads.
export function runSynthesis() {
  const leads = listLeads({});
  const { hubs } = synthesizeHubs({ leads });
  for (const h of hubs) upsertLead(h);
  return { hubs };
}
