// Engine-wide tunable GROUPS (enrichment, lead synthesis) — split into their own
// module so engine.js and lead-synthesis.js can both read them without importing
// each other. (engine.js's CLI top-level-awaits runEngine, which dynamically
// imports lead-synthesis; if lead-synthesis statically imported engine.js back,
// ESM would deadlock waiting for engine.js's still-pending evaluation.)
export const ENGINE_GROUPS = [
  {
    id: "enrichment", label: "Free enrichment (Tofler + director-link)",
    desc: "After detection, look up directors for companies named in BIG flags (free Tofler mirror), then match harvested directors back to politicians/relatives. Every lookup is persisted as evidence.",
    tunables: {
      enabled: { label: "Enabled", type: "boolean", def: true, desc: "Run enrichment after detection." },
      maxLookups: { label: "Max lookups/run", type: "number", def: 10, min: 0, max: 200, desc: "Cap on fresh Tofler fetches per engine run (cache hits are free)." },
    },
  },
  {
    id: "investigator", label: "GLM Investigator (L2/L3 budgets)",
    desc: "The paid AI layer's per-lead budgets. More steps = deeper trails = more tokens; the loop is always bounded and every step persists immediately.",
    tunables: {
      maxSteps: { label: "Max L2 steps", type: "number", def: 6, min: 1, max: 20, desc: "Max tool-decision GLM calls per lead (was hard-coded 4; 6 gives room to follow evidence trails)." },
      maxToolCalls: { label: "Max per-tool calls", type: "number", def: 2, min: 1, max: 10, desc: "Max invocations of any single tool per lead." },
      recordRelations: { label: "Record discovered relations", type: "boolean", def: true, desc: "Persist relationships the investigator's verdict names (as low-confidence, investigation-sourced edges) so the graph grows from every investigation." },
      spawnFollowups: { label: "Spawn follow-up leads", type: "boolean", def: true, desc: "When an investigation surfaces a NEW suspicious entity, open a fresh TRAIL_DISCOVERY lead for it — investigation feeds discovery, not just verdicts." },
      maxFollowups: { label: "Max follow-ups/lead", type: "number", def: 3, min: 0, max: 20, desc: "Cap on new leads spawned per investigation." },
    },
  },
  {
    id: "synthesis", label: "Lead synthesis (flags → leads)",
    desc: "How flags become investigation leads: every BIG flag is promoted; small flags only count via per-subject clusters.",
    tunables: {
      smallWeight: { label: "Small-flag weight", type: "number", def: 0.4, min: 0, max: 1, step: 0.05, desc: "A small flag contributes score × this to its subject's cluster." },
      diversityBonus: { label: "Diversity bonus", type: "number", def: 0.15, min: 0, max: 1, step: 0.05, desc: "Cluster multiplier per extra distinct detector (corroboration beats repetition)." },
      clusterMin: { label: "Cluster threshold", type: "number", def: 35, min: 5, max: 200, desc: "Composite score a subject's flags must reach to become a FLAG_CLUSTER lead." },
      minFlags: { label: "Min flags", type: "number", def: 2, min: 1, max: 10, desc: "Minimum flags in a cluster." },
      minDetectors: { label: "Min detectors", type: "number", def: 2, min: 1, max: 10, desc: "Minimum DISTINCT detectors in a cluster (one detector repeating ≠ corroboration)." },
      runHubs: { label: "Network hubs", type: "boolean", def: true, desc: "Also run the cross-entity NETWORK_HUB synthesis over all leads afterwards." },
    },
  },
];
