// Issue analyzer (task #5) — "Where India Stands" on the issues YOU choose.
//
// For each policy issue, GLM-5.2 acts as a non-partisan policy analyst and
// produces: what the issue means in the Indian context, India's current state,
// India vs the world (rank + best-performing countries), and what successive
// PARTIES and GOVERNMENTS have actually done — stance, measures, record —
// judged on the public record with STRICT political neutrality.
//
// Usage:
//   node server/issue-analyzer.js seed          # generate all issues not yet done
//   node server/issue-analyzer.js seed --force   # regenerate all
//   node server/issue-analyzer.js <slug>         # one issue
import "dotenv/config";
import OpenAI from "openai";
import { listIssues, getIssue, upsertIssue } from "./store.js";
import { fetchNews } from "./sources/news.js";
import { freedomFor } from "./data/freedom-index.js";
import { ISSUE_SEEDS } from "./data/issues.js";

const AI_BASE = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL   = process.env.AI_MODEL    || "z-ai/glm-5.2";
const AI_KEY  = process.env.AI_API_KEY  || "";

const ASSESS = ["STRONG", "MIXED", "WEAK", "UNCLEAR"];

function buildPrompt(seed, newsLines) {
  return `You are a non-partisan policy analyst for Pandoro's Box, a public-record platform on Indian governance. Analyse where INDIA stands on one policy issue and what successive governments and parties have actually done about it. Read by voters of every persuasion, audited by lawyers — sourced facts, no partisan spin.

══════════ THE ISSUE ══════════
Issue: ${seed.title}
What it covers: ${seed.description}
Metrics that matter: ${seed.metrics_hint ?? "—"}

${newsLines.length ? `══════════ RECENT NEWS CONTEXT (real headlines — treat as "reported") ══════════\n${newsLines.join("\n")}\n` : ""}
══════════ ABSOLUTE RULES ══════════
1. STRICT POLITICAL NEUTRALITY. Apply the SAME standard to every party and government (Congress/UPA, BJP/NDA, regional, Left, coalitions). Credit real achievements and record real failures evenly. Judge the policy record, never the colour. A reader of any politics must find this fair.
2. State facts with numbers where you can; attribute contested claims as "reported". Never invent a statistic, rank, or source — leave a field empty instead.
3. For international comparison, NAME countries accurately so their democratic standing can be annotated.
4. Be concrete and India-specific, not generic.

══════════ YOUR TASK — respond with ONLY this JSON, no prose, no markdown ══════════
{
  "what_it_means": "2-4 sentences: what this issue specifically means in India's context and why it matters here.",
  "india_state": "4-6 sentences on India's CURRENT state on this issue, with concrete numbers/indicators where known.",
  "india_vs_world": {
    "summary": "2-3 sentences comparing India to the world.",
    "rank_note": "India's standing on a relevant global index, with the number if known (e.g. 'RSF Press Freedom: 159/180').",
    "best_performers": [ { "country": "Norway", "what_they_do": "what makes them a leader on this issue" } ]
  },
  "by_government": [
    { "period": "e.g. 2004–2014", "government": "e.g. UPA (Congress-led)", "stance": "their stated position", "key_measures": ["concrete law/scheme/action"], "record": "what actually happened on the ground — achievements AND shortfalls", "assessment": "STRONG|MIXED|WEAK|UNCLEAR" }
  ],
  "by_party": [
    { "party": "e.g. BJP", "stance": "the party's stated position on this issue", "notable_actions": ["concrete things done when in power, central or state"] }
  ],
  "key_facts": [ "specific, checkable fact with a number and (source)" ],
  "sources": [ "named, verifiable sources (govt data, index name + year, named report)" ]
}

Cover the major governments of the last ~25 years in by_government (at least UPA-I/II and the post-2014 NDA, plus earlier or state examples where relevant). Cover the main national parties in by_party. Give at least 2 international best_performers where the issue allows. Keep every item factual and balanced.`;
}

function validate(raw, seed) {
  let text = raw.trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
  let p;
  try { p = JSON.parse(text); }
  catch { const m = text.match(/\{[\s\S]*\}/); if (!m) throw new Error("no JSON"); p = JSON.parse(m[0]); }
  const arr = (x) => (Array.isArray(x) ? x : []);
  const ivw = p.india_vs_world ?? {};
  return {
    what_it_means: String(p.what_it_means ?? seed.description ?? ""),
    india_state: String(p.india_state ?? ""),
    india_vs_world: {
      summary: String(ivw.summary ?? ""),
      rank_note: String(ivw.rank_note ?? ""),
      best_performers: arr(ivw.best_performers).map((x) => {
        const f = freedomFor(x.country);
        return { country: String(x.country ?? ""), what_they_do: String(x.what_they_do ?? ""),
          freedom: f ? { status: f.fh_status, rsf_rank: f.rsf_rank } : null };
      }),
    },
    by_government: arr(p.by_government).map((g) => ({
      period: String(g.period ?? ""), government: String(g.government ?? ""), stance: String(g.stance ?? ""),
      key_measures: arr(g.key_measures).map(String), record: String(g.record ?? ""),
      assessment: ASSESS.includes(g.assessment) ? g.assessment : "UNCLEAR",
    })),
    by_party: arr(p.by_party).map((x) => ({
      party: String(x.party ?? ""), stance: String(x.stance ?? ""), notable_actions: arr(x.notable_actions).map(String),
    })),
    key_facts: arr(p.key_facts).map(String),
    sources: arr(p.sources).map(String),
  };
}

export async function generateIssue(seed) {
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");
  let newsLines = [];
  try {
    const news = await fetchNews({ name: `India ${seed.title}`, id: "issue", party: "", state: "" });
    newsLines = (news ?? []).slice(0, 12).flatMap((n) => (n.content ? String(n.content).split("\n") : [n.title]).filter(Boolean)).slice(0, 25);
  } catch { /* optional */ }

  const client = new OpenAI({
    baseURL: AI_BASE, apiKey: AI_KEY,
    defaultHeaders: AI_BASE.includes("openrouter") ? { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" } : {},
  });
  const prompt = buildPrompt(seed, newsLines);
  console.log(`[issue] ${seed.slug} — "${seed.title}" → ${MODEL}`);

  let analysis = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await client.chat.completions.create({
        model: MODEL, messages: [{ role: "user", content: prompt }],
        temperature: attempt === 1 ? 0.3 : 0.15, max_tokens: 12000, reasoning: { effort: "high" },
      });
      const out = r.choices?.[0]?.message?.content ?? r.choices?.[0]?.message?.reasoning ?? "";
      if (!out) throw new Error("empty content");
      analysis = validate(out, seed);
      break;
    } catch (err) { lastErr = err; console.warn(`[issue]   attempt ${attempt} failed: ${err.message}`); }
  }
  if (!analysis) throw lastErr ?? new Error("issue generation failed");

  return upsertIssue({
    slug: seed.slug, title: seed.title, icon: seed.icon ?? "", description: seed.description,
    model: MODEL, generated_at: new Date().toISOString(), ...analysis,
  });
}

// ── CLI ────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("issue-analyzer.js");
if (invokedDirectly) {
  const { startTimer } = await import("./util/timing.js");
  const stop = startTimer("Issue analysis");
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const target = args.find((a) => !a.startsWith("--"));
  const seeds = (target && target !== "seed") ? ISSUE_SEEDS.filter((s) => s.slug === target) : ISSUE_SEEDS;
  if (!seeds.length) { console.error(`No issue seed "${target}". Available: ${ISSUE_SEEDS.map((s) => s.slug).join(", ")}`); process.exit(1); }
  let done = 0, skip = 0, fail = 0;
  for (const seed of seeds) {
    if (!force && getIssue(seed.slug)) { skip++; continue; }
    try { await generateIssue(seed); console.log(`  ✓ ${seed.slug}`); done++; }
    catch (e) { console.error(`  ✗ ${seed.slug}: ${e.message}`); fail++; }
  }
  console.log(`\nDone. ${done} generated, ${skip} skipped, ${fail} failed. Total issues: ${listIssues().length}`);
  stop();
}
