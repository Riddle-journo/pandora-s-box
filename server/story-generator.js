// Incident-centric story generator.
//
// The platform's L1–L4 funnel already outputs exactly the right input for
// narrative journalism: verified investigation_leads (status proposed|published)
// with evidence chains, plus NETWORK_HUB meta-leads from synthesis.js. This
// module GROUPS that material into incidents (deterministically, in code),
// hands ONE assembled incident to the model for a single write-up, and stores
// the result as a status:'draft' story behind the same admin gate as leads.
//
// Citation integrity is identical to the dossier engine: the model emits only
// [n] markers; citations.js resolves them mechanically. The model never invents
// a source, and any sentence whose [n] doesn't resolve to the numbered registry
// is stripped — never guessed.
import "dotenv/config";
import OpenAI from "openai";
import {
  listLeads, listScandals, listEvidence, getPolitician, findPolitician, upsertStory,
} from "./store.js";
import { citationsFor, buildRegistry } from "./citations.js";

const AI_BASE = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL   = process.env.AI_MODEL    || "z-ai/glm-5.2";
const AI_KEY  = process.env.AI_API_KEY  || "";

// Registry cap + per-source truncation — same numbers as the dossier engine.
const SOURCE_CAP = 40;
const CONTENT_TRUNCATE = 1500;

// ── Status flow ─────────────────────────────────────────────────────────
// draft → proposed → published | rejected. Backward moves (e.g. published→draft)
// are rejected. This is the single source of truth for the admin gate.
export const STORY_STATUSES = ["draft", "proposed", "published", "rejected"];
const STORY_FLOW = {
  draft:     ["proposed", "rejected"],
  proposed:  ["published", "rejected"],
  published: [],
  rejected:  [],
};
export function canTransition(from, to) {
  return (STORY_FLOW[from] ?? []).includes(to);
}

const slugify = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "incident";

// Does a scandal row concern this actor? Scandal seeds carry no structured
// actor_id, so we match the actor's name against the scandal's free-text fields.
function scandalMentionsActor(scandal, actorName) {
  if (!actorName || actorName.length < 4) return false;
  const hay = [scandal.title, scandal.summary, scandal.government, scandal.ministry, scandal.party]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(actorName.toLowerCase());
}

// ── Incident assembly (deterministic — no model) ─────────────────────────
// Group eligible leads by actor (or, for NETWORK_HUB meta-leads which have no
// single actor, by beneficiary). Attach any scandal rows naming the same actor.
export function assembleIncidents({ leads = [], scandals = [] } = {}) {
  const eligible = leads.filter((l) => l && ["proposed", "published"].includes(l.status));
  const groups = new Map();
  for (const l of eligible) {
    let key, label, actor_id = null, actor_name = null;
    if (l.vector === "NETWORK_HUB") {
      label = l.beneficiary ?? "network hub";
      key = l.key ?? `hub:${label}`;
    } else {
      if (!l.actor_id) continue;
      actor_id = l.actor_id;
      actor_name = l.actor_name ?? l.actor_id;
      label = actor_name;
      key = `actor:${actor_id}`;
    }
    const g = groups.get(key) ?? { key, actor_id, actor_name, label, leads: [] };
    g.leads.push(l);
    groups.set(key, g);
  }

  const incidents = [];
  for (const g of groups.values()) {
    const relScandals = g.actor_name
      ? scandals.filter((s) => scandalMentionsActor(s, g.actor_name))
      : [];
    incidents.push({ ...g, scandals: relScandals, slug: slugify(g.label) });
  }
  // Deterministic order: most leads first, then by label for stable ties.
  incidents.sort((a, b) => b.leads.length - a.leads.length || a.label.localeCompare(b.label));
  return incidents;
}

// Collect the numbered source registry for an incident: every evidence row
// referenced (by URL) by the incident's leads, ranked/capped/truncated exactly
// like the dossier engine's selectSources. `evidenceRows` is passed in so this
// stays pure and testable; the store-backed path resolves it from the DB.
export function incidentRegistry(incident, evidenceRows) {
  const urls = new Set();
  for (const l of incident.leads ?? []) for (const u of l.evidence_urls ?? []) if (u) urls.add(u);
  const referenced = (evidenceRows ?? []).filter((e) => e && e.url && urls.has(e.url));
  return buildRegistry(referenced, { cap: SOURCE_CAP, truncate: CONTENT_TRUNCATE });
}

// Resolve, from the store, the evidence rows an incident could cite. For an
// actor incident that's the actor's evidence; for a NETWORK_HUB it's the
// evidence of every representative the hub names (resolved by name).
function resolveEvidenceRows(incident) {
  const ids = new Set();
  if (incident.actor_id) ids.add(incident.actor_id);
  for (const l of incident.leads ?? []) {
    for (const name of l.hub?.actors ?? []) {
      const p = findPolitician(name);
      if (p) ids.add(p.id);
    }
  }
  const rows = [];
  for (const pid of ids) rows.push(...listEvidence(pid));
  return rows;
}

// ── Prompt builder ──────────────────────────────────────────────────────
function buildStoryPrompt(incident, registry) {
  const leadLines = (incident.leads ?? []).map((l, i) =>
    `${i + 1}. [${l.vector}] ${l.headline ?? l.detail ?? ""}${l.beneficiary ? ` (beneficiary: ${l.beneficiary})` : ""}`).join("\n");
  const scandalLines = (incident.scandals ?? []).map((s) => `- ${s.title}: ${s.summary}`).join("\n") || "(none)";
  const numbered = registry.map((r) => ({
    n: r.n, title: r.title, date: r.date, admissible: r.admissible,
    kind: r.content ? "DOCUMENT/NEWS (contents provided)" : "RECORD LOCATION (no contents)",
    contents: r.content || undefined,
  }));

  const SYS = `You are the lead investigative journalist for Pandoro's Box, writing an INCIDENT-CENTRIC narrative story for ordinary voters. Unlike a per-politician dossier, this is ONE story about ONE incident/network, built strictly from the verified leads and numbered sources given to you.

══════════ ABSOLUTE RULES ══════════
1. Use ONLY the leads and the SOURCE REGISTRY provided. Never add outside knowledge.
2. Every factual sentence in body_markdown MUST end with a citation marker like [3] (or [3][7]) referencing the numbered SOURCE REGISTRY. Uncited factual sentences will be STRIPPED.
3. Do NOT invent sources or [n] numbers. A marker must reference a real registry entry, or the sentence is discarded.
4. Neutral, factual, restrained. Present the record; never label anyone corrupt/criminal/dishonest — the citizen concludes. "Charged" ≠ "convicted".
5. Do NOT output a "citations" field — just embed [n] markers; citations are attached automatically in code.

══════════ OUTPUT — respond with ONLY this JSON, no markdown, no prose outside it ══════════
{
  "headline": "One factual sentence — the core of the incident.",
  "dek": "One- or two-sentence standfirst summarising what the record shows. Cite [n].",
  "body_markdown": "3–8 short paragraphs of markdown. Every factual sentence ends in its [n].",
  "timeline": [ { "date": "2019", "event": "One factual event with a citation.", "marker": "[n]" } ],
  "entities": ["Names of the people/companies/bodies central to the story"],
  "caveats": ["What the record does NOT establish; open questions; charges-not-convictions notes."]
}`;

  const USER = `══════════ INCIDENT ══════════
Focus: ${incident.label}
Verified leads (already survived the L1–L4 funnel + human review):
${leadLines || "(none)"}

Related documented scandals sharing this actor:
${scandalLines}

══════════ SOURCE REGISTRY (${numbered.length} items — cite by [n]) ══════════
${JSON.stringify(numbered, null, 2)}

Now write the COMPLETE JSON story for this incident, following every rule and the exact schema above.`;

  return { system: SYS, user: USER };
}

// ── Validation / repair ─────────────────────────────────────────────────
// Split prose into sentences; keep a sentence only if every [n] marker in it
// resolves to a registry entry (a sentence with no marker is kept — the model
// is asked to cite, but stripping uncited connective prose would gut the story;
// a sentence with an UNRESOLVED marker is dropped, never guessed).
function markersResolve(text, registry) {
  const nums = [...String(text ?? "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  return nums.every((n) => registry.some((r) => r.n === n));
}

function stripUnresolvedSentences(body, registry) {
  const parts = String(body ?? "").split(/(?<=[.!?])\s+/);
  return parts.filter((s) => s.trim() && markersResolve(s, registry)).join(" ").trim();
}

export function validateAndRepairStory(raw, incident, registry) {
  let text = String(raw ?? "").trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model returned no valid JSON.");
    parsed = JSON.parse(m[0]);
  }

  const arr = (x) => (Array.isArray(x) ? x : []);
  const headline = String(parsed.headline ?? "").trim() || `Incident: ${incident.label}`;
  const dek = String(parsed.dek ?? "").trim() || "This story is drawn from verified investigation leads.";
  const body_markdown = stripUnresolvedSentences(parsed.body_markdown, registry);

  const timeline = arr(parsed.timeline)
    .filter((t) => t && (t.event || t.date))
    .map((t) => ({ date: String(t.date ?? ""), event: String(t.event ?? ""), marker: String(t.marker ?? "") }))
    .filter((t) => markersResolve(`${t.event} ${t.marker}`, registry))
    .map((t) => ({ ...t, citations: citationsFor(`${t.event} ${t.marker}`, registry) }));

  const entities = arr(parsed.entities).map((e) => (typeof e === "string" ? e : e?.name)).filter(Boolean).map(String);
  const caveats = arr(parsed.caveats).map((c) => (typeof c === "string" ? c : c?.text)).filter(Boolean).map(String);

  return {
    headline, dek, body_markdown, timeline, entities, caveats,
    // Citations attached mechanically from the body's [n] markers.
    citations: citationsFor(`${dek} ${body_markdown}`, registry),
  };
}

// ── Generate one story (store-backed) ────────────────────────────────────
// Assembles the registry, calls the model once, validates, and stores a draft.
// `dryRun` assembles everything and returns the prompt + registry WITHOUT the
// API call, so you can inspect exactly what would be sent.
export async function generateStory(incident, { dryRun = false } = {}) {
  const evidenceRows = resolveEvidenceRows(incident);
  const registry = incidentRegistry(incident, evidenceRows);
  const { system, user } = buildStoryPrompt(incident, registry);

  if (dryRun) return { dryRun: true, incident, registry, prompt: { system, user } };
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");

  const client = new OpenAI({
    baseURL: AI_BASE, apiKey: AI_KEY,
    defaultHeaders: AI_BASE.includes("openrouter")
      ? { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" } : {},
  });

  let story = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = "";
    try {
      const res = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: attempt === 1 ? 0.15 : 0.1,
        max_tokens: 12000,
        reasoning: { effort: "high" },
      });
      const msg = res.choices?.[0]?.message;
      raw = msg?.content ?? msg?.reasoning ?? "";
      if (!raw) throw new Error("Model returned empty content.");
    } catch (err) {
      lastErr = err;
      continue;
    }
    try { story = validateAndRepairStory(raw, incident, registry); break; }
    catch (err) { lastErr = err; }
  }
  if (!story) throw lastErr ?? new Error("Story generation failed.");

  return upsertStory({
    ...story,
    slug: incident.slug,
    status: "draft",
    generated_at: Date.now(),
    model: MODEL,
    lead_ids: (incident.leads ?? []).map((l) => l.id).filter(Boolean),
    actor_id: incident.actor_id ?? null,
    actor_name: incident.actor_name ?? null,
    sources: registry.map(({ content, ...meta }) => meta),
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────
// node server/story-generator.js [--actor name] [--dry-run]
const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("story-generator.js");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--actor") flags.actor = args[++i];
    else if (args[i].startsWith("--")) flags[args[i].slice(2)] = true;
  }

  const leads = listLeads({});
  const scandals = listScandals();
  let incidents = assembleIncidents({ leads, scandals });
  if (flags.actor) {
    const q = String(flags.actor).toLowerCase();
    incidents = incidents.filter((inc) => (inc.actor_name ?? inc.label).toLowerCase().includes(q));
  }

  console.log(`Eligible incidents: ${incidents.length}${flags.actor ? ` (filtered by actor "${flags.actor}")` : ""}`);
  if (!incidents.length) {
    console.log("No eligible incidents (need investigation_leads with status proposed|published).");
    process.exit(0);
  }

  if (flags["dry-run"]) {
    const inc = incidents[0];
    const { registry, prompt } = await generateStory(inc, { dryRun: true });
    console.log(`\n=== DRY RUN — incident "${inc.label}" (${inc.leads.length} lead(s), ${registry.length} source(s)) ===\n`);
    console.log("----- SYSTEM -----\n" + prompt.system);
    console.log("\n----- USER -----\n" + prompt.user);
    console.log("\n(Dry run: exited before the API call.)");
    process.exit(0);
  }

  let ok = 0, fail = 0;
  for (const inc of incidents) {
    process.stdout.write(`• ${inc.label}… `);
    try { const s = await generateStory(inc); console.log(`draft "${s.slug}" (${s.timeline.length} timeline, ${s.citations.length} cites)`); ok++; }
    catch (err) { console.log(`✗ ${err.message}`); fail++; }
  }
  console.log(`\nDone. ${ok} draft(s) generated, ${fail} failed.`);
}
