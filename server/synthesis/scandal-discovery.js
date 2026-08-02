// Scandal auto-discovery — scans recent news for governance failures and
// PROPOSES new scandal seeds for HUMAN REVIEW. It never auto-publishes: every
// proposal lands in a review queue (status "proposed") and only enters the
// public corpus when a human approves it. That human gate is what keeps the
// corpus neutral and accurate — the engine casts a wide, non-partisan net; a
// person decides what is real and well-documented enough to publish.
//
// Pipeline:  GDELT news (failure keywords, all parties)  →  GLM clusters the
// headlines into distinct incidents and drafts seed objects  →  store as
// proposals  →  review via the admin API / CLI  →  approve runs the normal
// scandal-generator on it.
//
// Usage:
//   node server/scandal-discovery.js               # discover, queue proposals
//   node server/scandal-discovery.js --days 30      # widen the news window
//   node server/scandal-discovery.js --list         # show the current queue
import "dotenv/config";
import { AI_BASE, MODEL, AI_KEY, makeClient, callWithRetry } from "./llm.js";
import { upsertScandal, listProposals, listScandals, getMeta, setMeta } from "./store.js";
import { SCANDAL_SEEDS } from "./data/scandal-seeds.js";
import { gdeltJson } from "./sources/gdelt-fetch.js";

// Newly-surfaced ECONOMIC scandals (not already well-known named ones) must
// clear this loss/theft threshold to be proposed. Named scandals already in the
// news, and non-economic failures (accidents, exam leaks, etc.), are exempt.
const MIN_ECONOMIC_LOSS_CR = 5;

const GDELT   = "https://api.gdeltproject.org/api/v2/doc/doc";

// Neutral, broad net — failure vocabulary, not party names.
const QUERIES = [
  '(scam OR corruption OR "CAG report" OR irregularities) (minister OR ministry OR government) India',
  '(accident OR collapse OR "killed" OR negligence) (government OR municipal OR state) India',
  '("paper leak" OR "exam leak" OR recruitment scam) India',
  '(CBI OR "Enforcement Directorate" OR Lokayukta) (probe OR chargesheet OR arrest) minister India',
  '("policy failure" OR "fund diversion" OR "scheme fraud" OR embezzlement) India government',
];

async function gdelt(query, days) {
  const url = `${GDELT}?query=${encodeURIComponent(query)}&mode=artlist&format=json`
    + `&maxrecords=60&timespan=${days}d&sort=hybridrel`;
  const data = await gdeltJson(url, { headers: { "User-Agent": "PandorosBox/0.1" } });
  return (data?.articles ?? []).map((a) => ({ title: a.title, date: a.seendate, domain: a.domain }));
}

function slugify(s) {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function buildPrompt(headlines, existingTitles) {
  return `You are a non-partisan accountability researcher for Pandoro's Box. Below are recent Indian news HEADLINES (no bodies) about possible governance failures. Cluster them into DISTINCT incidents and draft a structured "scandal seed" for each one that is (a) a genuine governance failure — a scam, accident, policy failure, or documented misconduct involving a minister/ministry/government — and (b) NOT already in our corpus.

ALREADY IN CORPUS (do not duplicate these): ${existingTitles.slice(0, 80).join(" | ")}

ABSOLUTE RULES:
1. STRICT NEUTRALITY. Cast the net across ALL parties and governments equally. Do not favour or target any party. Judge the failure, never the colour.
2. Propose ONLY incidents the headlines actually evidence. If headlines are thin/ambiguous, set a low confidence — do NOT invent details.
3. These are PROPOSALS for human review, so err toward flagging a real-looking failure with low confidence rather than fabricating specifics.
4. Each "summary" must be a neutral one-liner; do not assert guilt.
5. ECONOMIC THRESHOLD. Classify each incident: set "economic": true if it centres on money — theft, fraud, embezzlement, scam, fund diversion, kickbacks, or quantifiable financial loss to the public. Set "is_named": true only if it is ALREADY a well-known, named scandal widely covered in the news (those are always allowed). For an economic incident that is NOT already a well-known named scandal, you MUST estimate "est_value_cr" (the loss/theft in ₹ crore, your best read from the headlines) and ONLY propose it if that value EXCEEDS ₹${MIN_ECONOMIC_LOSS_CR} crore. If an unnamed economic incident's value is below ₹${MIN_ECONOMIC_LOSS_CR} crore, or cannot be estimated from the headlines, DO NOT propose it. Non-economic failures (accidents, deaths from negligence, exam-paper leaks, collapses, policy failures without quantified theft) are NOT subject to this threshold — set "economic": false for them.

HEADLINES:
${headlines.map((h, i) => `${i + 1}. ${h.title} (${h.domain})`).join("\n")}

Respond with ONLY this JSON (no prose):
{ "proposals": [
  { "title": "Concise incident title", "date": "YYYY or YYYY-MM if known", "sector": "e.g. Railways / Education / Health",
    "govt_level": "union|state", "state": "state name if state-level else empty",
    "ministry": "ministry/department reportedly responsible or empty",
    "party": "governing party/coalition at the time if identifiable, else empty",
    "government": "term/government if identifiable, else empty",
    "summary": "neutral one-sentence description of the failure",
    "economic": true, "is_named": false, "est_value_cr": 0,
    "confidence": "high|medium|low", "why": "which headlines support this (numbers)" }
] }`;
}

async function discover(days) {
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");

  // Gather + dedupe headlines across all queries.
  const seen = new Set(); const headlines = [];
  for (const q of QUERIES) {
    for (const h of await gdelt(q, days)) {
      const k = (h.title ?? "").toLowerCase().slice(0, 80);
      if (h.title && !seen.has(k)) { seen.add(k); headlines.push(h); }
    }
  }
  console.log(`[discovery] gathered ${headlines.length} unique headlines over ${days} days`);
  if (!headlines.length) { console.log("No headlines — nothing to propose."); return []; }

  const existingTitles = [...SCANDAL_SEEDS.map((s) => s.title), ...listScandals().map((s) => s.title), ...listProposals().map((s) => s.title)];

  const client = makeClient();

  const r = await callWithRetry(client, {
    model: MODEL, messages: [{ role: "user", content: buildPrompt(headlines.slice(0, 120), existingTitles) }],
    temperature: 0.3, max_tokens: 6000, reasoning: { effort: "high" }, // task #15
  }, { module: "scandal-discovery" });
  let raw = r.choices?.[0]?.message?.content ?? "";
  raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let parsed; try { parsed = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { proposals: [] }; }

  const existSlugs = new Set([...SCANDAL_SEEDS.map((s) => s.slug), ...listScandals().map((s) => s.slug), ...listProposals().map((s) => s.slug)]);
  const queued = [];
  let droppedLowValue = 0;
  for (const p of parsed.proposals ?? []) {
    if (!p.title) continue;
    if (!passesEconomicThreshold(p)) { droppedLowValue++; continue; }
    let slug = slugify(p.title); if (!slug || existSlugs.has(slug)) { if (existSlugs.has(slug)) continue; slug = `proposed-${Date.now()}-${queued.length}`; }
    existSlugs.add(slug);
    const estValue = Number(p.est_value_cr);
    queued.push(upsertScandal({
      slug, status: "proposed", discovered_at: new Date().toISOString(),
      title: p.title, date: p.date ?? "", sector: p.sector ?? "", govt_level: p.govt_level ?? "",
      state: p.state ?? "", ministry: p.ministry ?? "", party: p.party ?? "", government: p.government ?? "",
      summary: p.summary ?? "", confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "low",
      economic: !!p.economic, is_named: !!p.is_named,
      est_value_cr: Number.isFinite(estValue) ? estValue : null,
      why: p.why ?? "",
    }));
  }
  if (droppedLowValue) console.log(`[discovery] dropped ${droppedLowValue} unnamed economic proposal(s) under ₹${MIN_ECONOMIC_LOSS_CR} cr.`);
  return queued;
}

// Belt-and-suspenders enforcement of the ₹5cr rule on top of the prompt:
// a newly-surfaced economic scandal that isn't already a well-known named one
// must show a loss/theft above the threshold. Everything else passes.
function passesEconomicThreshold(p) {
  if (p.is_named) return true;       // known named scandals always allowed
  if (!p.economic) return true;      // non-economic failures aren't gated by value
  const v = Number(p.est_value_cr);
  return Number.isFinite(v) && v > MIN_ECONOMIC_LOSS_CR;
}

// Incremental, rate-limited entry point folded into ingest / report batches.
// Sizes the news window from the last run and won't re-run if it ran recently.
export async function maybeDiscover({ force = false, minHours = 12 } = {}) {
  if (!AI_KEY) return { skipped: "AI_API_KEY not set" };
  const last = getMeta("last_discovery_at");
  const now = Date.now();
  if (!force && last) {
    const ageH = (now - new Date(last).getTime()) / 3600000;
    if (ageH < minHours) return { skipped: `discovery ran ${ageH.toFixed(1)}h ago (min ${minHours}h)` };
  }
  // Only look at news since the last sweep (default 14d the first time).
  let days = 14;
  if (last) days = Math.min(30, Math.max(2, Math.ceil((now - new Date(last).getTime()) / 86400000) + 1));
  const queued = await discover(days);
  setMeta("last_discovery_at", new Date().toISOString());
  return { queued: queued.length, days };
}

// ── CLI ────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("scandal-discovery.js");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    const props = listProposals();
    console.log(`${props.length} proposal(s) awaiting review:\n`);
    props.forEach((p) => console.log(`  [${p.confidence ?? "?"}] ${p.slug}\n     ${p.title} — ${p.sector || "?"}, ${p.govt_level || "?"} ${p.party ? "("+p.party+")" : ""}\n     ${p.summary}\n`));
    console.log("Approve: POST /api/admin/scandal-proposals/<slug>/approve  (generates the full analysis)");
    process.exit(0);
  }
  const days = (() => { const i = args.indexOf("--days"); return i >= 0 ? Number(args[i + 1]) : 14; })();
  discover(days).then((q) => {
    console.log(`\nQueued ${q.length} new proposal(s) for review.`);
    q.forEach((p) => console.log(`  [${p.confidence}] ${p.title} (${p.sector || "?"})`));
    console.log(`\nReview: node server/scandal-discovery.js --list`);
    console.log(`Approve via admin API, or add good ones to server/data/scandal-seeds.js for permanence.`);
    process.exit(0);
  }).catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}

export { discover };
