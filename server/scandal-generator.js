// Scandal / policy-failure accountability engine.
//
// Given a seed describing a governance failure (scam, accident, policy failure),
// GLM-5.2 acts as an accountability journalist and produces the full picture:
//   • which minister/ministry was responsible at the time
//   • what action (if any) they or the government took — resign? inquiry? cover-up?
//   • how India handled SIMILAR failures before (historical precedent)
//   • how OTHER COUNTRIES handled similar failures (international precedent),
//     annotated with each country's freedom-of-press / democracy standing so the
//     reader knows whether resignation there is the norm or the exception.
//
// This is the "entire government accountability" layer: it judges how ministers
// performed under pressure, not just a politician's affidavit.
//
// Legal posture mirrors the politician reports: sourced facts, no bare
// accusation, "CONTRADICTED_BY_PUBLIC_RECORD" is the strongest verdict language.
//
// Usage:
//   node server/scandal-generator.js seed         # generate for all built-in seeds not yet done
//   node server/scandal-generator.js seed --force  # regenerate even if present
//   node server/scandal-generator.js <slug>        # (re)generate one seed by slug
import "dotenv/config";
import { AI_BASE, MODEL, AI_KEY, makeClient, parseModelJson, arr } from "./llm.js";
import { listScandals, getScandal, upsertScandal, listPoliticians } from "./store.js";
import { fetchNews } from "./sources/news.js";
import { freedomFor } from "./data/freedom-index.js";
import { SCANDAL_SEEDS } from "./data/scandal-seeds.js";

// Match a minister name to an existing politician dossier (token overlap). Many
// historical ministers won't be in our DB (it holds current MPs/MLAs) — that's
// fine, we just return null and the scandal shows the name without a link.
const _TITLE = /\b(shri|smt|dr|ms|mr|mrs|prof|adv|mohd|md|col|gen|capt|kumari|thiru|shrimati|sardar|late)\b\.?\s*/gi;
const _toks = (s) => (s ?? "").replace(_TITLE, " ").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3);
export function resolveMinisterPolitician(name) {
  const mt = _toks(name);
  if (mt.length < 2) return null; // need at least 2 name tokens to be safe
  const mset = new Set(mt);
  let best = null, bestScore = 0;
  for (const p of listPoliticians()) {
    if (p.is_demo) continue;
    const pt = _toks(p.name);
    if (pt.length < 2) continue;
    const hit = pt.filter((t) => mset.has(t)).length;
    const score = hit / Math.max(pt.length, mt.length);
    // require strong overlap: every politician token present AND ≥2 matches
    if (hit >= 2 && hit === pt.length && score > bestScore) { best = p; bestScore = score; }
  }
  return best?.id ?? null;
}


const ACCOUNTABILITY = ["NONE", "PARTIAL", "FULL"];
const SIGNAL = ["RED", "AMBER", "GREEN", "GREY"];

function buildPrompt(seed, newsLines) {
  return `You are the accountability-analysis engine for Pandoro's Box, a public-record dossier on Indian governance. You analyse a documented governance FAILURE and the official response to it. Your output is read by voters and audited by lawyers — sourced facts only, no bare accusation.

══════════ THE INCIDENT ══════════
Title: ${seed.title}
Date / period: ${seed.date ?? "—"}
Sector: ${seed.sector ?? "—"}
Level: ${seed.govt_level ?? "—"}${seed.state ? ` (state: ${seed.state})` : ""}
Ministry/department reportedly responsible: ${seed.ministry ?? "—"}
Governing party/coalition at the time: ${seed.party ?? "—"} (${seed.government ?? "—"})
Known summary: ${seed.summary ?? "—"}

${newsLines.length ? `══════════ DATED NEWS CONTEXT (real headlines — treat as "reported", verify) ══════════\n${newsLines.join("\n")}\n` : ""}
══════════ ABSOLUTE RULES ══════════
1. State facts; attribute reported claims as "reported". Distinguish "charged" from "convicted".
2. Never call anyone corrupt/guilty. Present the record; the citizen concludes.
3. If you do not know a fact, leave the field empty — NEVER invent a name, date, or source.
4. For international precedents you MUST name the country accurately so its freedom ranking can be attached.
5. STRICT POLITICAL NEUTRALITY — this is non-negotiable. Apply the SAME accountability standard regardless of which party (Congress, BJP, a regional party, a Left front, a coalition) was in power. Do NOT soften a failure because of who governed, and do NOT sharpen it either. No partisan framing, no editorialising, no whataboutery. If a government took genuine corrective action, record it plainly (a GREEN/FULL verdict for any party is correct when earned); if it did not, record that plainly too. Judge the conduct, never the party. Your credibility depends on a reader of any political view trusting this is fair.

══════════ YOUR TASK — respond with ONLY this JSON, no prose, no markdown ══════════
{
  "headline": "One factual sentence: what failed and who was responsible.",
  "what_happened": "3-5 sentence factual account of the failure and its documented impact.",
  "minister_in_charge": { "name": "minister at the time or empty", "portfolio": "e.g. Minister of Railways", "party": "", "tenure": "e.g. 2014–2017 or empty" },
  "accountability": {
    "action_taken": "What the minister/government actually did in response (factual). If nothing, say so.",
    "resigned": true,
    "inquiry_ordered": true,
    "prosecution": "none|charges_filed|convicted|empty",
    "compensation_or_remedy": "what remedy reached victims/public, or empty",
    "status": "Open|Inquiry pending|Closed — no action|Closed — action taken|empty",
    "verdict": "NONE|PARTIAL|FULL",
    "verdict_reason": "one factual sentence justifying the accountability verdict"
  },
  "indian_precedents": [
    { "incident": "earlier comparable Indian failure", "year": "", "minister": "", "what_they_did": "did they resign / order inquiry / nothing", "source_hint": "where this is on record" }
  ],
  "international_precedents": [
    { "country": "Germany", "incident": "comparable failure abroad", "year": "", "official": "name/role", "what_they_did": "resigned within days / criminal charges / etc.", "source_hint": "" }
  ],
  "signal": "RED|AMBER|GREEN|GREY",
  "pattern_note": "Optional: if this fits a wider pattern of (non-)accountability by this minister/ministry/government, one factual sentence; else empty.",
  "sources": [ "specific verifiable source (CAG report no., court case, commission report, named news org + date)" ]
}

Guidance: signal RED = documented failure with NO meaningful accountability; AMBER = partial (inquiry but no consequence, or delayed); GREEN = full accountability (resignation/prosecution/remedy); GREY = facts too thin to judge. Give at least 1 Indian precedent and at least 1 international precedent where history offers one. Keep every list element factual and sourced.`;
}

function validate(raw, seed) {
  const p = parseModelJson(raw);

  const acc = p.accountability ?? {};

  // Attach freedom-index context to each international precedent.
  const intl = arr(p.international_precedents).map((x) => {
    const f = freedomFor(x.country);
    return {
      country: String(x.country ?? ""),
      incident: String(x.incident ?? ""),
      year: String(x.year ?? ""),
      official: String(x.official ?? ""),
      what_they_did: String(x.what_they_did ?? ""),
      source_hint: String(x.source_hint ?? ""),
      freedom: f ? { status: f.fh_status, rsf_rank: f.rsf_rank, rsf_score: f.rsf_score, fh_score: f.fh_score } : null,
    };
  });

  return {
    headline: String(p.headline ?? seed.title),
    what_happened: String(p.what_happened ?? seed.summary ?? ""),
    minister_in_charge: {
      name: String(p.minister_in_charge?.name ?? ""),
      portfolio: String(p.minister_in_charge?.portfolio ?? ""),
      party: String(p.minister_in_charge?.party ?? ""),
      tenure: String(p.minister_in_charge?.tenure ?? ""),
    },
    accountability: {
      action_taken: String(acc.action_taken ?? ""),
      resigned: !!acc.resigned,
      inquiry_ordered: !!acc.inquiry_ordered,
      prosecution: String(acc.prosecution ?? ""),
      compensation_or_remedy: String(acc.compensation_or_remedy ?? ""),
      status: String(acc.status ?? ""),
      verdict: ACCOUNTABILITY.includes(acc.verdict) ? acc.verdict : "NONE",
      verdict_reason: String(acc.verdict_reason ?? ""),
    },
    indian_precedents: arr(p.indian_precedents).map((x) => ({
      incident: String(x.incident ?? ""), year: String(x.year ?? ""),
      minister: String(x.minister ?? ""), what_they_did: String(x.what_they_did ?? ""),
      source_hint: String(x.source_hint ?? ""),
    })),
    international_precedents: intl,
    signal: SIGNAL.includes(p.signal) ? p.signal : "GREY",
    pattern_note: String(p.pattern_note ?? ""),
    sources: arr(p.sources).map(String),
  };
}

export async function generateScandal(seed) {
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");

  // Pull dated news context for the incident (graceful if none).
  let newsLines = [];
  try {
    const news = await fetchNews({ name: seed.title, id: "scandal", party: "", state: seed.state });
    newsLines = (news ?? []).slice(0, 12).flatMap((n) =>
      (n.content ? String(n.content).split("\n") : [n.title]).filter(Boolean)).slice(0, 30);
  } catch { /* news is optional context */ }

  const client = makeClient();

  const prompt = buildPrompt(seed, newsLines);
  console.log(`[scandal] ${seed.slug} — "${seed.title}" → ${MODEL}`);

  let analysis = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await client.chat.completions.create({
        model: MODEL, messages: [{ role: "user", content: prompt }],
        temperature: attempt === 1 ? 0.3 : 0.15, max_tokens: 9000,
        reasoning: { effort: "high" }, // task #15: max GLM effort
      });
      const raw = r.choices?.[0]?.message?.content ?? r.choices?.[0]?.message?.reasoning ?? "";
      if (!raw) throw new Error("empty content");
      analysis = validate(raw, seed);
      break;
    } catch (err) { lastErr = err; console.warn(`[scandal]   attempt ${attempt} failed: ${err.message}`); }
  }
  if (!analysis) throw lastErr ?? new Error("scandal generation failed");

  // Resolve the minister to an existing politician dossier where one matches.
  const minister_politician_id = resolveMinisterPolitician(analysis.minister_in_charge?.name);

  return upsertScandal({
    slug: seed.slug, status: "published", // clears any "proposed" review flag
    title: seed.title, date: seed.date, sector: seed.sector,
    govt_level: seed.govt_level, state: seed.state, ministry: seed.ministry,
    party: seed.party, government: seed.government, summary: seed.summary,
    model: MODEL, generated_at: new Date().toISOString(),
    minister_politician_id,
    ...analysis,
  });
}

// ── CLI ────────────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("scandal-generator.js");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const target = args.find((a) => !a.startsWith("--"));

  (async () => {
    let seeds;
    if (target === "seed" || !target) {
      seeds = SCANDAL_SEEDS;
    } else {
      seeds = SCANDAL_SEEDS.filter((s) => s.slug === target);
      if (!seeds.length) { console.error(`No seed with slug "${target}". Available: ${SCANDAL_SEEDS.map((s) => s.slug).join(", ")}`); process.exit(1); }
    }

    let done = 0, skipped = 0, failed = 0;
    for (const seed of seeds) {
      if (!force && getScandal(seed.slug)) { skipped++; continue; }
      try { const s = await generateScandal(seed); console.log(`  ✓ ${s.slug} — verdict ${s.accountability.verdict}, signal ${s.signal}`); done++; }
      catch (err) { console.error(`  ✗ ${seed.slug}: ${err.message}`); failed++; }
    }
    console.log(`\nDone. Generated ${done}, skipped ${skipped} (already present), failed ${failed}. Total scandals in DB: ${listScandals().length}`);
    process.exit(0);
  })();
}
