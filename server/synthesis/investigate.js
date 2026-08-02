// AI Investigator CLI (Branch 2) — PRIVATE, admin-only output. This is where
// the entire GLM budget lives. Finds leads worth a real journalist's follow-up:
//
//   L1  the Anomaly Engine (engine.js): 23 detectors → small/big flags →
//       leads with evidence citations. Pure code + free enrichment only.
//   L2  investigator.js agentic tool-loop           (GLM)
//   L3  skeptical referee                           (GLM)
//   L4  synthesis.js network hubs                   (pure code, part of L1 synthesis)
//   L5  story drafts for journalist handoff         (GLM)
//
// Nothing here is ever published to the site. Leads land in investigation_leads
// (detected → proposed → cleared/dismissed) and are reviewed at #/admin.
//
//   node server/investigate.js                    L1 for all reps + L2/L3 top leads
//   node server/investigate.js --id <politician>  one rep
//   node server/investigate.js --l1-only          detectors only (free, no GLM)
//   node server/investigate.js --synthesis        also run L4 network-hub synthesis
//   node server/investigate.js --stories          also draft stories from cleared leads
//   node server/investigate.js --top 20           cap the L2/L3 spend (default 50)
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { listPoliticians, getPolitician, listEvidence, listLeads, upsertLead, listScandals } from "../store/store.js";
import { detectConflicts } from "../detectors/conflict.js";
import { mapLimit } from "../fetchers/http.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return flags;
}

// L1 for one politician: run the conflict detector over existing evidence and
// upsert 'detected' leads. Pure code — no network, no LLM.
export function detectFor(p) {
  const evidence = listEvidence(p.id);
  const { leads } = detectConflicts(p, evidence);
  let n = 0;
  for (const lead of leads) { upsertLead({ ...lead, status: "detected" }); n++; }
  return n;
}

// L2/L3 over the top-scored detected leads (optionally restricted to a set of
// politician ids). The expensive layer — never the whole population at once.
export async function investigateTop({ targetIds = null, topN = 50 } = {}) {
  const { investigateLead } = await import("./investigator.js");
  const detected = listLeads({ status: "detected" })
    .filter((l) => !targetIds || targetIds.has(l.actor_id))
    .sort((a, b) => b.signal_score - a.signal_score)
    .slice(0, topN);
  if (!detected.length) { console.log("[investigate] no detected leads to investigate."); return { proposed: 0, dismissed: 0, failed: 0 }; }
  console.log(`[investigate] L2/L3 on top ${detected.length} lead(s)…`);
  let proposed = 0, dismissed = 0, failed = 0;
  await mapLimit(detected, 2, async (lead) => {
    try {
      const r = await investigateLead(lead);
      if (r.status === "proposed") proposed++; else dismissed++;
    } catch (e) { failed++; console.warn(`[investigate]   ${lead.actor_name} · ${lead.vector}: ${e.message}`); }
  });
  console.log(`[investigate] L2/L3 done: ${proposed} proposed for review, ${dismissed} dismissed, ${failed} failed.`);
  return { proposed, dismissed, failed };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  // Target set
  let reps;
  if (flags.id) {
    const p = getPolitician(String(flags.id));
    if (!p) throw new Error(`no politician ${flags.id}`);
    reps = [p];
  } else {
    reps = listPoliticians().filter((p) => !p.is_demo);
    if (flags.office) reps = reps.filter((p) => (p.office ?? "").toLowerCase() === String(flags.office).toLowerCase());
    if (flags.state) reps = reps.filter((p) => (p.state ?? "").toLowerCase() === String(flags.state).toLowerCase());
    if (flags.limit) reps = reps.slice(0, Number(flags.limit));
  }

  // ── L1: the Anomaly Engine (pure code + free enrichment) ──
  // One entry point now runs every detector (legacy vectors, statistical
  // outliers, DA-ratio, Benford, network markers, …), writes small/big FLAGS,
  // enriches company-bearing big flags (Tofler + director-link, both free and
  // evidence-recording), and synthesises leads with citations.
  try {
    const { runEngine } = await import("../detectors/engine.js");
    const r = await runEngine({ politicianId: flags.id ? reps[0].id : null });
    const totals = Object.values(r.detectors).reduce(
      (a, d) => ({ big: a.big + (d.big ?? 0), small: a.small + (d.small ?? 0) }), { big: 0, small: 0 });
    console.log(`[investigate] engine: ${totals.big} big + ${totals.small} small flag(s); synthesis ${JSON.stringify(r.synthesis)}`);
  } catch (e) { console.warn(`[investigate] engine failed: ${e.message}`); }

  // ── L2/L3: the paid AI layers ──
  if (!flags["l1-only"]) {
    const targetIds = flags.id ? new Set(reps.map((p) => p.id)) : null;
    await investigateTop({ targetIds, topN: Number(flags.top) || Number(process.env.CONFLICT_TOP_N) || 50 });
  }

  // ── L4: cross-entity synthesis (pure code) ──
  if (flags.synthesis || !flags["l1-only"]) {
    try {
      const { runSynthesis } = await import("./synthesis.js");
      const { hubs } = runSynthesis();
      if (hubs.length) console.log(`[investigate] synthesis: ${hubs.length} network-hub meta-lead(s).`);
    } catch (e) { console.warn(`[investigate] synthesis skipped: ${e.message}`); }
  }

  // ── L5: story drafts for journalist handoff (GLM) ──
  if (flags.stories) {
    try {
      const { assembleIncidents, generateStory } = await import("../publishing/story-generator.js");
      const incidents = assembleIncidents({ leads: listLeads({}), scandals: listScandals() });
      console.log(`[investigate] drafting ${incidents.length} story incident(s)…`);
      let ok = 0, fail = 0;
      for (const inc of incidents) {
        try { const s = await generateStory(inc); console.log(`[investigate]   draft "${s.slug}"`); ok++; }
        catch (e) { console.warn(`[investigate]   ${inc.label}: ${e.message}`); fail++; }
      }
      console.log(`[investigate] stories: ${ok} drafted, ${fail} failed.`);
    } catch (e) { console.warn(`[investigate] stories skipped: ${e.message}`); }
  }

  console.log(`[investigate] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
