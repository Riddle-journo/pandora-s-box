// AI report generation via GLM-5.2 (OpenRouter, OpenAI-compatible API).
//
// GLM acts as an investigative journalist. From the evidence it produces:
//   • executive_summary  — plain-language overview
//   • career_timeline    — chronological roles/events
//   • categories[]       — findings grouped by theme, each with a verdict,
//                          confidence, prose body, and [n] citations
//   • red_flags[]        — concrete documented concerns, severity-ranked
//   • positive_highlights[]
//   • parameters[]       — the 5-parameter accountability scorecard
//   • data_gaps[]        — records not yet examined
//
// Built ONLY from real content (sworn affidavit snapshot + dated news
// headlines). Official-record links are listed as "records to verify",
// never invented. ONE report per politician, drawing on every source tier (1-10).
//
// Citation integrity: the model embeds [n] markers in its prose; this module
// then mechanically attaches the matching numbered source to each section,
// so every [n] in the UI is a correct, clickable, verifiable link.
import "dotenv/config";
import OpenAI from "openai";
import { listPoliticians, getPolitician, listEvidence, listTips, addReport, latestReport } from "./store.js";
import { ingestFor } from "./ingest.js";
import { computeFlags, scoreFromFlags } from "./analyzer.js";
import { buildRelations } from "./graph.js";
import { detectConflicts } from "./conflict.js";
import { upsertLead, listLeads } from "./store.js";
import { mapLimit } from "./fetchers/http.js";

const AI_BASE = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL   = process.env.AI_MODEL    || "z-ai/glm-5.2";
const AI_KEY  = process.env.AI_API_KEY  || "";

// ── Tone pass (Stage 2): a cheap/free "stylist" that re-voices the reader-
// facing prose (headline, summary, category bodies) to match the record's
// gravity. See applyTonePass below. Opt-in — off unless AI_STYLE_ENABLED or the
// --tone-pass CLI flag is set. NEVER calls a paid model: every chain entry is a
// free tier, and if all are throttled we keep GLM's original text.
export const STYLE_VERSION = 1;
let STYLE_ENABLED = /^(1|true|yes|on)$/i.test(process.env.AI_STYLE_ENABLED || "");
export function setStyleEnabled(v) { STYLE_ENABLED = !!v; }

// Ordered chain of FREE (provider, model) entries. All are OpenAI-compatible.
// Entries whose apiKey env is missing are skipped, so the chain degrades
// gracefully to whatever keys you have. Entry #1 needs no new setup (reuses the
// existing OpenRouter key). Rotation advances on any rate-limit/quota error.
// NOTE: OpenRouter's free catalogue changes over time (models get retired or move
// to paid). Verify slugs occasionally: GET https://openrouter.ai/api/v1/models and
// keep entries whose pricing.prompt/completion are "0" and id ends ":free".
const STYLE_CHAIN = [
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "openai/gpt-oss-120b:free" },
  { provider: "groq",       baseURL: "https://api.groq.com/openai/v1",                        key: process.env.GROQ_API_KEY, model: "llama-3.3-70b-versatile" },
  { provider: "google",     baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", key: process.env.GEMINI_API_KEY, model: "gemini-2.0-flash" },
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "meta-llama/llama-3.3-70b-instruct:free" },
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "qwen/qwen3-next-80b-a3b-instruct:free" },
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "google/gemma-4-31b-it:free" },
].filter((e) => e.key); // drop entries with no key

// ── Single report: one deep investigation using EVERY available source ──
// (The old Tier 1 / Tier 2 split is gone — it doubled cost for near-identical
// output. One report now draws on all source tiers 1–10.)
export const MAX_SOURCE_TIER = 10;

// ── Pipeline version (reprocess-on-change, task #11) ───────────────────
// Bump this whenever the investigation changes in a way that should re-run
// over EVERY rep — a new source/fetcher, a new analysis field/issue, or a
// material prompt change. On the next run, any rep whose last report was made
// with an older PIPELINE_VERSION is fully re-investigated (recheck mode) so the
// new capability is applied to the whole back-catalogue, not just new data.
export const PIPELINE_VERSION = 7;

// ── Suggested dossier categories (the model may add/omit as evidence warrants) ─
export const DOSSIER_CATEGORIES = [
  { key: "background",    label: "Profile & Background" },
  { key: "electoral",     label: "Electoral Journey" },
  { key: "wealth",        label: "Wealth & Assets" },
  { key: "legal",         label: "Criminal & Legal Record" },
  { key: "legislative",   label: "Legislative Performance" },
  { key: "development",   label: "Development & Public Funds" },
  { key: "promises",      label: "Promises vs Delivery" },
  { key: "affiliations",  label: "Affiliations & Networks" },
  { key: "controversies", label: "Controversies & Allegations" },
];

// ── Scorecard rubric (single source of truth) ──────────────────────────
export const PARAMETERS = [
  { key: "manifesto", label: "Manifesto delivery",
    desc: "Share of concrete manifesto/campaign promises verifiably completed, in progress, or broken — judged against official completion records, not press releases." },
  { key: "corruption", label: "Corruption indicators",
    desc: "Documented findings only: CAG audit objections, court convictions or charges framed, Lokpal/Lokayukta findings, disproportionate asset growth across sworn affidavits. Allegations without records score as 'insufficient evidence', never as guilt." },
  { key: "favoritism", label: "Favoritism / nepotism",
    desc: "Documented patterns of directing public resources, contracts, or posts to relatives or associates (traceable via MCA directorship records, procurement databases)." },
  { key: "hypocrisy", label: "Hypocrisy (says vs does)",
    desc: "Preaching one thing while practising another. Examples: telling citizens to boycott a product while personally indulging in it; campaigning against a policy while voting for it; urging austerity while declaring lavish spending. Requires a documented statement AND a documented contradicting action by the same person." },
  { key: "abuse_of_power", label: "Abuse of power",
    desc: "Documented misuse of office to unjustly benefit self or others: court strictures, tribunal findings, official inquiry reports, misuse of discretionary funds (MPLADS/MLALAD irregularities)." },
];

export const SCORING = {
  formula:
    "Overall score = simple average of every parameter that had enough evidence to score. Parameters with insufficient evidence are EXCLUDED from the average (score -1) — never guessed, never counted against the person, and NEVER given a low number.",
  scale: "Each parameter is scored 0–100, where 100 = exemplary documented conduct and 0 = serious documented wrongdoing. CRITICAL: a CLEAN record scores HIGH. Absence of documented wrongdoing = a high score (75–90), NOT a low one. A LOW score (below 40) requires SPECIFIC documented wrongdoing — a conviction, a CAG objection, a framed charge, a proven disproportionate-assets finding. 'I am unsure' or 'the case is unexamined' is NEVER a low score — it is -1 (excluded). Do not collapse everyone to F by scoring uncertainty as wrongdoing.",
  bands: [
    { min: 85, grade: "A", meaning: "Strong documented record" },
    { min: 70, grade: "B", meaning: "Good record, minor issues" },
    { min: 55, grade: "C", meaning: "Mixed record" },
    { min: 40, grade: "D", meaning: "Significant documented concerns" },
    { min: 25, grade: "E", meaning: "Serious documented concerns" },
    { min: 0,  grade: "F", meaning: "Severe documented record" },
  ],
  confidence_levels: {
    high: "Strong evidence — at least two independent official records (affidavit, CAG, court, parliamentary) point the same way.",
    medium: "Moderate evidence — one official record, or several consistent news reports awaiting an official record.",
    low: "Limited evidence — news leads only, sparse, or contradictory. Treat the score as provisional.",
  },
};

export function computeOverall(parameters) {
  const scored = parameters.filter((p) => p.score >= 0);
  if (scored.length === 0) {
    return { overall_score: -1, overall_grade: "INSUFFICIENT_DATA", calc: "No parameter had enough evidence to score." };
  }
  const overall = Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length);
  const grade = SCORING.bands.find((b) => overall >= b.min)?.grade ?? "F";
  const calc = `(${scored.map((p) => p.score).join(" + ")}) ÷ ${scored.length} = ${overall} → Grade ${grade}`;
  return { overall_score: overall, overall_grade: grade, calc };
}

// ── Citation integrity helper ──────────────────────────────────────────
// Scan [n] markers in text and return the matching registry items as
// {n,title,url,admissible}. Guarantees every UI citation resolves correctly.
function citationsFor(text, registry) {
  const seen = new Set();
  const out = [];
  for (const m of String(text ?? "").matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    const src = registry.find((r) => r.n === n);
    if (src) { out.push({ n, title: src.title, url: src.url, admissible: src.admissible }); seen.add(n); }
  }
  return out;
}

// ── Prior-context digest ───────────────────────────────────────────────
// Condense a previously-generated report into a compact, citable digest. This
// is what gets re-sent on incremental runs INSTEAD of the full source corpus,
// so "remembering" the previous investigation costs a few hundred tokens, not
// the thousands a full affidavit + news re-send would. Pull only the load-
// bearing structured findings; the model treats it as established background.
export function buildPriorContext(r) {
  const L = [];
  const when = String(r.generated_at ?? "").slice(0, 10);
  L.push(`PRIOR PANDORO'S BOX DOSSIER — generated ${when} (grade ${r.overall_grade ?? "—"}${typeof r.overall_score === "number" && r.overall_score >= 0 ? `, ${r.overall_score}/100` : ""}).`);
  if (r.headline) L.push(`Headline: ${r.headline}`);
  if (r.executive_summary) L.push(`Summary: ${r.executive_summary}`);

  if (Array.isArray(r.signals) && r.signals.length)
    L.push("Signals: " + r.signals.map((s) => `${s.key}=${s.state}${s.phrase ? ` (${s.phrase})` : ""}`).join("; "));

  if (Array.isArray(r.parameters) && r.parameters.length)
    L.push("Scorecard: " + r.parameters.map((p) => `${p.key} ${p.score}`).join(", "));

  if (Array.isArray(r.cases) && r.cases.length)
    L.push("Criminal record: " + r.cases.map((c) => `${c.case_type}${c.status ? ` (${c.status}${c.year_filed ? `, ${c.year_filed}` : ""})` : ""}`).join("; "));

  if (Array.isArray(r.assets) && r.assets.length)
    L.push("Assets by election: " + r.assets.map((a) => `${a.election_year} net ${a.net_worth || a.total_assets || "?"}`).join(" → "));

  if (Array.isArray(r.companies) && r.companies.length)
    L.push("Declared companies: " + r.companies.map((c) => `${c.name}${c.role ? ` (${c.role}${c.relation ? `, ${c.relation}` : ""})` : ""}`).join("; "));

  if (Array.isArray(r.party_switches) && r.party_switches.length)
    L.push("Party history: " + r.party_switches.map((s) => `${s.from_party || "?"}→${s.to_party || "?"}${s.year ? ` (${s.year})` : ""}`).join(", "));

  const lr = r.legislative_record ?? {};
  if (lr.attendance_pct || lr.questions_asked || lr.debates)
    L.push(`Legislative: attendance ${lr.attendance_pct || "?"}, questions ${lr.questions_asked || "?"}, debates ${lr.debates || "?"}`);

  if (Array.isArray(r.issue_positions) && r.issue_positions.length)
    L.push("Issue positions: " + r.issue_positions.map((p) => `${p.issue}=${p.stance}`).join("; "));

  if (Array.isArray(r.revolving_door) && r.revolving_door.length)
    L.push("Revolving door: " + r.revolving_door.map((x) => `${x.organization}${x.sector ? ` (${x.sector})` : ""}`).join("; "));

  const pub = (r.pattern_flags ?? []).filter((f) => f.is_published !== false);
  if (pub.length)
    L.push("Established patterns: " + pub.map((f) => `${f.flag_name} — ${f.title}`).join("; "));

  if (Array.isArray(r.data_gaps) && r.data_gaps.length)
    L.push("Open data gaps: " + r.data_gaps.slice(0, 6).join(" | "));

  return L.join("\n");
}

// A synthetic, citable evidence item wrapping the prior digest (registry #1).
function priorSourceItem(r) {
  return {
    source_type: "prior_dossier",
    title: `Prior Pandoro's Box dossier (generated ${String(r.generated_at ?? "").slice(0, 10)})`,
    url: null,
    admissible: true,
    date: r.generated_at ?? null,
    tier: 1,
    content: buildPriorContext(r),
  };
}

// ── Prompt builder ─────────────────────────────────────────────────────
// `mode`: "full" (no prior context), "incremental" (prior digest [1] + new
// material only), or "recheck" (prior digest [1] + the WHOLE corpus re-scanned).
function buildPrompt(p, sources, corroboratedTips, { mode = "full", computedFlags = [], scoreBaseline = null } = {}) {
  const incremental = mode === "incremental";
  const recheck = mode === "recheck";

  // System-verified facts computed in code (analyzer.js) — the LLM must treat
  // these figures as ground truth and narrate them, not re-derive or dispute them.
  const computedBlock = computedFlags.length ? `
══════════ SYSTEM-VERIFIED COMPUTED FACTS (computed in code from structured records — treat as GROUND TRUTH) ══════════
These facts were calculated deterministically from the numeric records BEFORE you were called. Use the EXACT figures below — do not recompute, round differently, or dispute them. Weave the material ones into your prose (with their citation) and reflect them in signals/patterns. Each line: [severity] fact.
${computedFlags.map((f) => `- [${f.severity}] ${f.headline} ${f.detail}`).join("\n")}
${scoreBaseline ? `\nCODE-COMPUTED SCORE BASELINE (start here, adjust ONLY with additional cited evidence, and by no more than ±15 per parameter): ${Object.entries(scoreBaseline).map(([k, v]) => `${k}=${v}`).join(", ")}. A parameter with no relevant evidence at all is still -1 (excluded), but if a computed fact above touches it, you MUST score it near the baseline.` : ""}
` : "";
  const aff = p.affidavit ?? {};
  const affidavitBlock = [
    aff.education      ? `- Declared education: ${aff.education}` : null,
    aff.assets         ? `- Declared total assets: ${aff.assets}` : null,
    aff.liabilities    ? `- Declared total liabilities: ${aff.liabilities}` : null,
    aff.criminal_cases != null ? `- Declared criminal cases (charges, not convictions): ${aff.criminal_cases}` : null,
  ].filter(Boolean).join("\n") || "- No structured affidavit snapshot available.";

  const numbered = sources.map((e, i) => {
    const hasContent = !!e.content;
    let kind;
    if (e.source_type === "prior_dossier")               kind = "PRIOR DOSSIER (your previous report's established findings — full digest provided; treat as already-verified background, carry it forward, and UPDATE it where the new material below changes it)";
    else if (e.source_type === "eci_affidavit" && hasContent) kind = "AFFIDAVIT DOCUMENT (sworn — full contents provided, read them)";
    else if (e.source_type === "wikipedia")              kind = "BIOGRAPHY (secondary reference — contents provided)";
    else if (e.source_type === "news")                   kind = "NEWS (dated, real headline)";
    else if (hasContent)                                 kind = "DOCUMENT (real contents provided)";
    else                                                 kind = "RECORD LOCATION (pointer — contents NOT provided)";
    const item = { n: i + 1, kind, admissible: !!e.admissible, date: e.date, title: e.title, note: e.summary };
    // The prior-dossier digest is deliberately compact — never truncate it.
    if (hasContent) item.contents = e.source_type === "prior_dossier" ? String(e.content) : String(e.content).slice(0, 1800);
    return item;
  });

  const incrementalBlock = incremental ? `
══════════ INCREMENTAL UPDATE MODE ══════════
This is an UPDATE of an existing dossier, not a first build. Source [1] is the PRIOR DOSSIER — a compact digest of everything already established (to save tokens, the original full records are NOT re-sent). Every other registry item is NEW material gathered SINCE the last report.
 • Produce a COMPLETE, standalone updated report — include the carried-forward facts from the prior dossier AND fold in the new material.
 • For a fact that comes only from the prior dossier (e.g. affidavit assets/cases already analysed), cite it as [1]. For anything from the new material, cite its own [n].
 • Where new material CHANGES, advances, or contradicts a prior finding (a case progressed, an asset/news update, a pattern strengthened), update the wording and the signal/score accordingly and make the change explicit.
 • Do NOT drop prior findings just because their original source isn't re-sent — the digest IS your source for them.
` : recheck ? `
══════════ FULL RE-INVESTIGATION WITH MEMORY (RECHECK MODE) ══════════
The ENTIRE raw record set is provided again (sources [2]+). Source [1] is the PRIOR DOSSIER — a digest of what a previous pass already found. Your job is a COMPLETE fresh re-investigation:
 • RE-READ AND RE-SCAN every raw record from scratch ([2]+) as if investigating for the first time. Do NOT just copy the prior dossier — the whole point is that a fresh pass over the same data may surface something the last pass missed.
 • Use the PRIOR DOSSIER [1] only as memory: it tells you which patterns/findings were ALREADY established, so you don't burn effort re-deriving and re-explaining them. Confirm each still holds against the raw records (and revise it if the records no longer support it).
 • Spend your real effort HUNTING FOR NEW patterns, connections, and red flags the prior pass did not report. Read all dimensions simultaneously and look for cross-source links the digest doesn't mention.
 • Produce a COMPLETE standalone report. Cite raw records by their own [n]; cite a carried-forward fact as [1] only if no raw record re-establishes it. Make explicit (in pattern descriptions / red flags) what is NEWLY found in this pass versus previously known.
` : "";

  // Split into a STATIC system prompt (identical across all reps in a given
  // mode → OpenRouter/GLM caches it, ~0.25–0.5× input cost) and a per-rep USER
  // message with the subject + registry. This is the cost win (task #16):
  // keep the cacheable prefix stable, push the variable data to the end.
  const SYS = `You are the lead investigative journalist and report engine for Pandoro's Box, a public-accountability dossier on Indian elected representatives. Your output is read by ordinary voters and audited by lawyers. Accuracy and restraint are everything.

══════════ ABSOLUTE RULES ══════════
1. Use ONLY the material provided in the SUBJECT and SOURCE REGISTRY (given in the user message). Never add outside knowledge. If something is not in the material, it is not established.
2. Each registry item has a "kind". Treat them differently:
   • Items with a "contents" field (AFFIDAVIT DOCUMENT, BIOGRAPHY, DOCUMENT) → real text is provided. READ IT and summarise the actual facts in it. The affidavit document includes criminal cases with IPC sections, asset totals, and prior-election declarations — use them (e.g. compute asset growth across elections).
   • NEWS items → real, dated headlines (no body). Summarise only WHAT WAS REPORTED, always as "reported"/"alleged", never as established fact.
   • RECORD LOCATION items → only WHERE a record can be found; CONTENTS ARE NOT PROVIDED. NEVER invent their contents. Cite them as places to verify and list unexamined ones in data_gaps.
3. "Charged" ≠ "convicted". Always distinguish. Pending cases are charges only.
4. Every factual sentence must end with a citation marker like [3] (or [3][7]) referencing the numbered SOURCE REGISTRY. This is mandatory — uncited claims will be discarded.
5. Be concise and neutral. No praise, no attack — let cited facts speak.

══════════ MATERIALITY — WHAT DESERVES SPACE (this is critical; most reports fail here) ══════════
Records are NOT equal. Weigh every item by one test: "Would a serious voter deciding how to vote actually care about this?" Spend the report on what matters; drop the noise.
 • HIGH materiality — LEAD with these: concrete promises about public outcomes (welfare amounts, jobs, deadlines, projects) and whether they were kept; criminal cases and their progress; large or unexplained asset changes; CAG/audit/court findings; legislative work and votes; documented conflicts of interest; misuse of public funds.
 • LOW / ZERO materiality — DOWN-WEIGHT or DROP ENTIRELY (no section, no scored claim, at most a one-line footnote): viral images, photo-ops, who-met-whom, festival greetings, denials of internet rumours, debunked hoaxes, routine party PR, sports/celebrity tangents. A fact-check that merely DEBUNKS A VIRAL IMAGE about the person is NOT an accountability finding — never make it a headline, a category, or a checked claim.
 • Example: a documented promise like "every citizen's account will get ₹15 lakh" measured against delivery is HIGH value and belongs front-and-centre; "viral photo of X meeting Y in hospital — found false" is trivia — ignore it. A report cluttered with trivia while burying the real promises is a FAILED report.

══════════ VOICE — WRITE FOR A CITIZEN, NOT A FILING ══════════
Your reader is an intelligent, busy citizen, not a lawyer. Write like the best public-interest journalism (ProPublica, Full Fact, The Markup, OpenSecrets):
 • Lead with the single most striking VERIFIED fact — the thing a neighbour would actually repeat.
 • Plain, direct language. No jargon, no "it is pertinent to note", no throat-clearing, no hedging chains. Short concrete sentences.
 • Use real numbers and human stakes — "assets grew nine-fold, ₹3 cr to ₹27 cr, across two terms [n]" — never vague abstractions like "notable financial activity".
 • Engaging does NOT mean unsourced: every sentence still ends in its [n], and neutrality/restraint remain absolute. Strong facts, plainly told, carry the punch — you never need to editorialise.
 • BANNED as filler: "insufficient evidence to assess", "no data available", "it is difficult to say". If a dimension is genuinely thin, state in ONE honest sentence what IS known and move on. Never pad a section to look full.
 • Do NOT just restate the affidavit under five different headings. The affidavit is ONE source — ANALYSE it (growth rate, asset mix, profession-vs-wealth, spouse/dependant share) and cross-reference court/MCA/news/parliamentary records where they exist, so each section adds something new.

${incrementalBlock}
══════════ YOUR TASK ══════════
Act as an investigative journalist. Pull every concrete fact from the AFFIDAVIT and NEWS material, decide which theme each belongs to, and write it up neatly. Suggested categories (use those that fit, omit any with no real facts, do not pad): ${DOSSIER_CATEGORIES.map((c) => c.label).join(", ")}.
Then score the 5-parameter accountability rubric (0–100):
${PARAMETERS.map((pm) => `- ${pm.key}: ${pm.desc}`).join("\n")}
SCORING DIRECTION — READ CAREFULLY (this is the most common mistake): 100 = exemplary/clean, 0 = serious documented wrongdoing.
 • A CLEAN or UNREMARKABLE record scores HIGH (75–90). No documented corruption finding ⇒ corruption scores ~80, NOT low.
 • A LOW score (<40) is reserved for SPECIFIC, documented wrongdoing: a conviction, a CAG objection, a framed serious charge, a court stricture, a proven disproportionate-assets finding. Name it.
 • "Unsure", "unexamined", "nature unknown", "one case declared but not detailed" ⇒ score -1 (EXCLUDED), never 1 or 2. Scoring uncertainty as a low number is WRONG and produces a false F.
 • A merely *pending* charge (not convicted) is a yellow flag, not a 0 — reflect it as a mid score (e.g. 50–60) plus an AMBER signal, not a 1.
 Do a sanity check before finalising: if you scored a parameter below 40, you MUST be able to point to the specific documented wrongdoing that justifies it. If you cannot, raise it or set -1.

══════════ INSTITUTIONAL REPORT LAYER (in addition to the above) ══════════
Also produce the structured "report card" layer below. THREE LEGAL RULES bind this layer:
 • Every adverse statement is "[factual observation] [n]" — a sourced fact, never an accusation.
 • Never label anyone corrupt/criminal/dishonest. Present the record; the citizen concludes.
 • The strongest claim-check language is "CONTRADICTED_BY_PUBLIC_RECORD" — never "FALSE".

A) SIGNAL STATES — for each of 5 dimensions (criminal, financial, legislative, interests, promises) assign:
   • a colour: RED (a verified ADVERSE public record exists — cases filed, conviction, CAG objection, documented contradiction) | AMBER (data exists but mixed/incomplete) | GREEN (verified clean or strong positive record) | GREY (genuinely ZERO verified data on this dimension)
   • a one-line "phrase": a factual observation ending in a citation [n]. The colour reflects the RECORD, not opinion.
   • DO NOT default to GREY out of caution. The sworn affidavit ALONE is enough to colour most dimensions: pending criminal cases → criminal RED (charges are a public record, not an accusation); a sharp asset jump across elections → financial AMBER/RED; declared companies/relatives' interests → interests AMBER; a thin or absent parliamentary record → legislative AMBER. GREY is ONLY for a dimension where the material truly says nothing. A report full of GREY when the affidavit is rich is a FAILED report.

B) STRUCTURED RECORDS — pull verbatim from the material; leave an array EMPTY if the material lacks it (never invent):
   • cases (criminal/legal), assets (per election year + breakdown), companies (declared business interests),
     party_switches (party history), legislative_record (attendance/questions/debates/bills + notable moments).
   • claims — check only CONSEQUENTIAL public commitments, never noise. A claim worth checking is a promise or factual assertion about PUBLIC OUTCOMES the person is accountable for: "every account will get ₹15 lakh", "we will create 2 crore jobs a year", "this road will be finished by 2022", "crime fell 40% under us". Measure it against the delivery/record. DO NOT enter reactions to viral images, denials of rumours, ceremonial remarks, or rhetorical jabs — those are not accountability claims and clutter the report. Prefer 3 weighty, well-checked promises over 10 trivial ones; if no consequential claim is on record, leave this array empty rather than padding it with trivia.
   • issue_positions (VoteSmart-style): where the record shows where this person STANDS on a concrete public issue — from a debate speech, a question asked, a vote, a manifesto, or a quoted statement — capture it. stance = SUPPORTS | OPPOSES | MIXED | UNCLEAR. Only issues the record actually evidences; do not guess their views.
   • revolving_door: documented movement or overlap between public office and private industry — a directorship/role in a company held while in (or shortly before/after) office, especially in a sector the person legislates on or regulates. Use the affidavit's declared companies and any MCA directorship data. relation_to_office = WHILE_IN_OFFICE | BEFORE_OFFICE | AFTER_OFFICE | FAMILY. This is a factual record of the overlap, NEVER an accusation.

C) PATTERN ANALYSIS — THE MOST IMPORTANT LAYER, AND THE WHOLE POINT OF THIS REPORT.
   You are a relentless investigative journalist. Your job here is to HUNT — across every record provided — for any pattern that, taken together, suggests a possible malpractice, conflict of interest, abuse of office, or breach of public trust by this politician or their party. Read all dimensions SIMULTANEOUSLY (affidavits across years, cases, assets, companies, party financials, donations, votes/debates/questions, attendance, MPLADS works, procurement, party switches, news) and look for temporal sequences, sector overlaps, and correlations no single source reveals. Be exhaustive: surface EVERY genuine pattern you can evidence — quantity is wanted, but NEVER at the cost of evidence.

   Seed taxonomy (use the matching flag_name where one fits) — grouped by malpractice family:
     CORRUPTION/ENRICHMENT: ASSET_GROWTH_ANOMALY, DISPROPORTIONATE_ASSETS, UNDISCLOSED_INCOME_SOURCE, BENAMI_INDICATOR, SHELL_COMPANY_LINK, LOAN_WRITE_OFF_LINK, BANK_DEFAULT_LINK
     FAVORITISM/NEPOTISM: CONTRACT_TIMING_PATTERN, VOTING_INTEREST_CORRELATION, QUESTION_INTEREST_ALIGNMENT, COMPANY_REGULATORY_TIMING, FAMILY_APPOINTMENT_PATTERN, RELATIVE_BENEFICIARY_PATTERN, DISCRETIONARY_FUND_DIVERSION (MPLADS/MLALAD to connected entities)
     ELECTORAL/FUNDING: PARTY_SWITCH_TIMING, ELECTORAL_BOND_DONOR_CONTRACT_LINK, DONOR_POLICY_ALIGNMENT, EXPENDITURE_UNDER_DECLARATION, FOREIGN_FUNDING_FLAG, FREEBIE_TIMING_PATTERN
     CRIMINAL/JUSTICE: CASE_WITHDRAWAL_PATTERN, CHARGE_PROGRESSION_STALL, REPEAT_OFFENCE_PATTERN, INVESTIGATION_AFTER_DEFECTION (ED/CBI action correlated with party stance)
     CONDUCT/HYPOCRISY: MANIFESTO_RECORD_DIVERGENCE, STATED_VS_VOTED_CONTRADICTION, ATTENDANCE_INTEREST_PATTERN, ABSENCE_DURING_KEY_VOTES, COMMUNAL_OR_HATE_STATEMENT_RECORD
     OFFICE/GOVERNANCE: CAG_OBJECTION_LINK, REGULATORY_CAPTURE_INDICATOR, CROSS_CONSTITUENCY_ASSET_PATTERN, TENURE_REGULATION_BENEFIT
   • DISCOVER NEW TYPES: the list above is a SEED, not a cage. If the records reveal a malpractice pattern that none of these names fit, INVENT a new flag_name for it (UPPERCASE_SNAKE_CASE) — you are explicitly encouraged to identify new categories of wrongdoing the taxonomy doesn't cover. Novel, well-evidenced patterns are the most valuable output.
   • For EACH pattern provide:
     - flag_name (from the seed list OR your own new UPPERCASE_SNAKE_CASE name)
     - title: a short factual description of the observed pattern (e.g. "Voting record aligns with family business sector") — NEVER an accusation ("Corruption detected" is forbidden)
     - severity: SIGNIFICANT (3+ data points, official records) | NOTABLE (2+ data points, ≥1 official) | UNDER_REVIEW (detected but under-sourced)
     - supporting_data_points: MINIMUM 2 specific verifiable facts, each {fact, source, source_type, date}
     - description: ONE sentence on what the data COLLECTIVELY shows (the sequence/overlap), ending "(Sources: …)". Describe the record — NEVER allege wrongdoing or intent; the citizen draws the conclusion.
     - is_published: true ONLY if ≥2 genuinely-sourced data points exist; otherwise false (hidden).
   HARD RULES: every pattern needs ≥2 REAL sourced data points from the material — do NOT manufacture, speculate, or pad. If a pattern has only 1 source, set is_published=false.
   MINE THE AFFIDAVIT HARD — it alone supports many real patterns, so an affidavit-rich subject should rarely produce zero. Patterns evidenceable from a single rich affidavit include: ASSET_GROWTH_ANOMALY (assets across two+ election years), DISPROPORTIONATE_ASSETS (declared profession/income vs net worth), REPEAT_OFFENCE_PATTERN (same IPC section across multiple FIRs/years), CHARGE_PROGRESSION_STALL (many cases declared, none reaching charge-framing/conviction over years), PENDING_SERIOUS_CHARGES (multiple non-bailable/serious IPC sections pending), UNDISCLOSED_INCOME_SOURCE (income source vs asset class mismatch), RELATIVE_BENEFICIARY_PATTERN (spouse/dependant assets dwarfing self). When parliamentary, MPLADS, party-funding, court, or MCA data is ALSO present, hunt the cross-source patterns above them too. Only return [] when the subject genuinely has a clean, sparse affidavit AND no other adverse record — say so honestly, but do not under-report a subject who has the data.

══════════ OUTPUT — respond with ONLY this JSON, no markdown, no prose outside it ══════════
{
  "headline": "One factual sentence capturing the single most important verified fact.",
  "executive_summary": "4-6 sentence plain-language overview for a first-time voter. Cite [n].",
  "career_timeline": [
    { "year": "2024", "role": "Member of Parliament", "event": "One-sentence event with citation [n]" }
  ],
  "categories": [
    {
      "title": "Wealth & Assets",
      "verdict": "One-line takeaway for this theme.",
      "confidence": "high|medium|low",
      "confidence_reason": "short reason e.g. 'sworn affidavit'",
      "body": "2-6 sentence factual prose. Every claim ends with [n]."
    }
  ],
  "red_flags": [
    { "severity": "high|medium|low", "text": "One concrete documented concern with [n]." }
  ],
  "positive_highlights": [ "One concrete documented positive with [n]." ],
  "parameters": [
    {
      "key": "manifesto", "label": "Manifesto delivery",
      "score": -1, "confidence": "low", "confidence_reason": "short reason",
      "verdict": "One-sentence verdict.",
      "rationale": "2-4 sentences, every claim cited [n]."
    }
  ],
  "data_gaps": ["Record locations not yet examined and what each would settle, e.g. 'CAG audit [12] not yet retrieved — would confirm fund-use findings.'"],

  "assessment": {
    "signal_states": { "criminal": "GREY", "financial": "GREY", "legislative": "GREY", "interests": "GREY", "promises": "GREY" },
    "phrases": { "criminal": "sourced phrase [n]", "financial": "sourced phrase [n]", "legislative": "sourced phrase [n]", "interests": "sourced phrase [n]", "promises": "sourced phrase [n]" },
    "growth_phrase": "optional asset-growth observation with [n], or empty string"
  },
  "cases": [{ "case_type": "IPC Section 420 — Cheating", "court": "court name or empty", "status": "PENDING|CONVICTED|ACQUITTED|DISCHARGED", "year_filed": "2019", "source_citation": "specific affidavit year/court ref [n]" }],
  "assets": [{ "election_year": "2024", "total_assets": "₹X.XX Cr", "total_liabilities": "₹X.XX Cr", "net_worth": "₹X.XX Cr", "breakdown": { "immovable": "₹X Cr or empty", "movable": "₹X Cr or empty", "financial": "₹X Cr or empty" }, "source": "[n]" }],
  "companies": [{ "name": "", "cin": "CIN if known or empty", "role": "Director|Shareholder|Beneficial Owner", "relation": "Self|Spouse|Dependent", "appointment_date": "", "company_status": "Active|Struck Off|Under Investigation|empty", "source": "[n]" }],
  "party_switches": [{ "from_party": "", "to_party": "", "year": "", "source": "[n]" }],
  "claims": [{ "claim_text": "verbatim quoted claim", "claim_source": "where/when said", "claim_date": "", "verdict": "VERIFIED_TRUE|PARTIALLY_TRUE|UNVERIFIED|CONTRADICTED_BY_PUBLIC_RECORD", "evidence": "the specific evidence", "evidence_source": "[n]" }],
  "legislative_record": { "attendance_pct": "e.g. 92% or empty", "questions_asked": "number or empty", "debates": "number or empty", "bills": "number or empty", "notable_moments": [{ "description": "one factual sentence [n]", "source": "", "date": "" }] },
  "issue_positions": [{ "issue": "e.g. Farm laws / GST / Women's reservation", "stance": "SUPPORTS|OPPOSES|MIXED|UNCLEAR", "summary": "one factual sentence on their position", "evidence": "the speech/question/vote/quote showing it", "source": "[n]" }],
  "revolving_door": [{ "role": "e.g. Director", "organization": "company/body name", "sector": "e.g. Mining", "period": "years if known", "relation_to_office": "WHILE_IN_OFFICE|BEFORE_OFFICE|AFTER_OFFICE|FAMILY", "note": "one factual sentence on the office/industry overlap", "source": "[n]" }],
  "pattern_flags": [{ "flag_name": "ASSET_GROWTH_ANOMALY (or your own new UPPERCASE_SNAKE_CASE type)", "title": "Short factual description of the pattern (never an accusation)", "severity": "NOTABLE|SIGNIFICANT|UNDER_REVIEW", "description": "One factual sentence on the observed pattern (Sources: …)", "supporting_data_points": [{ "fact": "specific verifiable fact", "source": "doc name", "source_type": "affidavit|court|CAG|parliament|news|MCA|procurement", "date": "" }], "is_published": true }]
}

Include ALL ${PARAMETERS.length} scorecard parameters in this order: ${PARAMETERS.map((pm) => pm.key).join(", ")}. SCORE A PARAMETER WHENEVER THE MATERIAL GIVES ANY BASIS — but score in the CORRECT DIRECTION (clean = high). The sworn affidavit alone is a basis: if the affidavit shows NO criminal cases and no abnormal asset jump, 'corruption' scores HIGH (~80) — a clean documented record, not a low score. If it shows a framed serious charge or a CAG/court finding, score LOW and name it. 'favoritism' is HIGH when no family/company-interest conflict is documented; LOW only with a documented diversion. Reserve score = -1 for a parameter with GENUINELY no relevant evidence (e.g. 'manifesto delivery' when no promise/delivery record was provided) — NOT for "I'm unsure". Do NOT blanket every parameter to -1, and do NOT blanket everyone to F: a report where the affidavit is rich but every score is -1 or every score is <40 is a FAILED report. For the institutional layer: leave a structured array empty only when the material truly lacks it (never invent rows); colour signals from the affidavit rather than defaulting to GREY; set pattern is_published=true with ≥2 real sourced data points. Do NOT output a "citations" field anywhere — just embed [n] markers in your prose; citations are attached automatically.`;

  const USER = `══════════ SUBJECT ══════════
Name: ${p.name}
Party: ${p.party ?? "—"} | Office: ${p.office ?? "—"} | Constituency: ${p.constituency ?? "—"} | State: ${p.state ?? "—"}

VERIFIED AFFIDAVIT SNAPSHOT (sworn ECI filing via ADR/MyNeta — real facts):
${affidavitBlock}
${computedBlock}
══════════ SOURCE REGISTRY (${numbered.length} items — cite by [n]) ══════════
${JSON.stringify(numbered, null, 2)}
${corroboratedTips.length ? `
CORROBORATED CITIZEN TIPS (treat strictly as leads, not proof):
${corroboratedTips.map((t) => `- [${t.category}] ${t.text}`).join("\n")}` : ""}

Now produce the COMPLETE JSON report for this subject, following every rule and the exact output schema above.`;

  return { system: SYS, user: USER };
}

// ── Validation / repair ────────────────────────────────────────────────
export function validateAndRepair(raw, politician, registry) {
  let text = raw.trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model returned no valid JSON.");
    parsed = JSON.parse(m[0]);
  }

  // Scorecard — all parameters present, clamped, citations attached from [n]
  const byKey = {};
  for (const pm of parsed.parameters ?? []) byKey[pm.key] = pm;
  parsed.parameters = PARAMETERS.map((def) => {
    const pm = byKey[def.key] ?? {};
    const rationale = pm.rationale ?? "The model did not provide a rationale for this parameter.";
    return {
      key: def.key,
      label: def.label,
      score: typeof pm.score === "number" ? Math.max(-1, Math.min(100, pm.score)) : -1,
      confidence: ["high", "medium", "low"].includes(pm.confidence) ? pm.confidence : "low",
      confidence_reason: pm.confidence_reason ?? "unspecified",
      verdict: pm.verdict ?? "Insufficient evidence.",
      rationale,
      citations: citationsFor(rationale, registry),
    };
  });

  // Categories — keep well-formed, attach citations from body [n]
  parsed.categories = (Array.isArray(parsed.categories) ? parsed.categories : [])
    .filter((c) => c && c.title && c.body)
    .map((c) => ({
      title: String(c.title),
      verdict: String(c.verdict ?? ""),
      confidence: ["high", "medium", "low"].includes(c.confidence) ? c.confidence : "low",
      confidence_reason: String(c.confidence_reason ?? ""),
      body: String(c.body),
      citations: citationsFor(c.body, registry),
    }));

  // Career timeline (newest-first)
  parsed.career_timeline = (Array.isArray(parsed.career_timeline) ? parsed.career_timeline : [])
    .filter((t) => t && (t.event || t.role))
    .map((t) => ({ year: String(t.year ?? ""), role: String(t.role ?? ""), event: String(t.event ?? "") }))
    .sort((a, b) => (b.year ?? "").localeCompare(a.year ?? ""));

  // Red flags / highlights
  parsed.red_flags = (Array.isArray(parsed.red_flags) ? parsed.red_flags : [])
    .filter((r) => r && r.text)
    .map((r) => ({ severity: ["high", "medium", "low"].includes(r.severity) ? r.severity : "medium", text: String(r.text) }));
  parsed.positive_highlights = (Array.isArray(parsed.positive_highlights) ? parsed.positive_highlights : [])
    .map((h) => (typeof h === "string" ? h : h?.text)).filter(Boolean).map(String);

  parsed.headline = parsed.headline ?? `Report for ${politician.name}`;
  parsed.executive_summary = parsed.executive_summary ?? parsed.summary ?? "Report generated with limited evidence.";
  parsed.data_gaps = Array.isArray(parsed.data_gaps) ? parsed.data_gaps : [];

  // ── Institutional report-card layer (NayaNeeta) ──────────────────────
  const arr = (x) => (Array.isArray(x) ? x : []);
  const SIGNAL = ["RED", "AMBER", "GREEN", "GREY"];
  const SIGNAL_DIMS = [
    ["criminal", "Criminal Record"], ["financial", "Financial Integrity"],
    ["legislative", "Legislative Activity"], ["interests", "Declared Interests"],
    ["promises", "Promises vs Record"],
  ];
  const a = parsed.assessment ?? {};
  const states = a.signal_states ?? {}, phrases = a.phrases ?? {};
  parsed.signals = SIGNAL_DIMS.map(([key, label]) => {
    const phrase = String(phrases[key] ?? "");
    return { key, label, state: SIGNAL.includes(states[key]) ? states[key] : "GREY", phrase, citations: citationsFor(phrase, registry) };
  });
  parsed.growth_phrase = String(a.growth_phrase ?? "");
  parsed.growth_citations = citationsFor(parsed.growth_phrase, registry);

  parsed.cases = arr(parsed.cases).filter((c) => c && (c.case_type || c.court)).map((c) => ({
    case_type: String(c.case_type ?? "Case"), court: String(c.court ?? ""),
    status: ["PENDING", "CONVICTED", "ACQUITTED", "DISCHARGED"].includes(c.status) ? c.status : "PENDING",
    year_filed: String(c.year_filed ?? ""), source_citation: String(c.source_citation ?? ""),
    citations: citationsFor(c.source_citation, registry),
  }));
  parsed.assets = arr(parsed.assets).filter((x) => x && x.election_year).map((x) => ({
    election_year: String(x.election_year), total_assets: String(x.total_assets ?? ""),
    total_liabilities: String(x.total_liabilities ?? ""), net_worth: String(x.net_worth ?? ""),
    breakdown: { immovable: String(x.breakdown?.immovable ?? ""), movable: String(x.breakdown?.movable ?? ""), financial: String(x.breakdown?.financial ?? "") },
    citations: citationsFor(x.source, registry),
  }));
  parsed.companies = arr(parsed.companies).filter((c) => c && c.name).map((c) => ({
    name: String(c.name), cin: String(c.cin ?? ""), role: String(c.role ?? ""), relation: String(c.relation ?? ""),
    appointment_date: String(c.appointment_date ?? ""), company_status: String(c.company_status ?? ""),
    citations: citationsFor(c.source, registry),
  }));
  parsed.party_switches = arr(parsed.party_switches).filter((s) => s && (s.from_party || s.to_party)).map((s) => ({
    from_party: String(s.from_party ?? ""), to_party: String(s.to_party ?? ""), year: String(s.year ?? ""),
    citations: citationsFor(s.source, registry),
  }));
  parsed.claims = arr(parsed.claims).filter((c) => c && c.claim_text).map((c) => ({
    claim_text: String(c.claim_text), claim_source: String(c.claim_source ?? ""), claim_date: String(c.claim_date ?? ""),
    verdict: ["VERIFIED_TRUE", "PARTIALLY_TRUE", "UNVERIFIED", "CONTRADICTED_BY_PUBLIC_RECORD"].includes(c.verdict) ? c.verdict : "UNVERIFIED",
    evidence: String(c.evidence ?? ""), citations: citationsFor(c.evidence_source, registry),
  }));
  const lr = parsed.legislative_record ?? {};
  parsed.legislative_record = {
    attendance_pct: String(lr.attendance_pct ?? ""), questions_asked: String(lr.questions_asked ?? ""),
    debates: String(lr.debates ?? ""), bills: String(lr.bills ?? ""),
    notable_moments: arr(lr.notable_moments).filter((m) => m && m.description).map((m) => ({
      description: String(m.description), source: String(m.source ?? ""), date: String(m.date ?? ""),
      citations: citationsFor(m.description, registry),
    })),
  };

  // Issue positions (VoteSmart-style) — only kept when evidenced.
  parsed.issue_positions = arr(parsed.issue_positions).filter((x) => x && x.issue && x.summary).map((x) => ({
    issue: String(x.issue), stance: ["SUPPORTS", "OPPOSES", "MIXED", "UNCLEAR"].includes(x.stance) ? x.stance : "UNCLEAR",
    summary: String(x.summary), evidence: String(x.evidence ?? ""),
    citations: citationsFor(x.source ?? x.evidence, registry),
  }));

  // Revolving-door — office/industry overlap, factual record.
  parsed.revolving_door = arr(parsed.revolving_door).filter((x) => x && x.organization).map((x) => ({
    role: String(x.role ?? ""), organization: String(x.organization), sector: String(x.sector ?? ""),
    period: String(x.period ?? ""),
    relation_to_office: ["WHILE_IN_OFFICE", "BEFORE_OFFICE", "AFTER_OFFICE", "FAMILY"].includes(x.relation_to_office) ? x.relation_to_office : "",
    note: String(x.note ?? ""), citations: citationsFor(x.source ?? x.note, registry),
  }));
  // Quality gate only — NOT a whitelist: any pattern (including novel flag_names
  // GLM coins itself) is kept if it is published and has ≥2 real sourced facts.
  const humanize = (s) => String(s ?? "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
  parsed.pattern_flags = arr(parsed.pattern_flags)
    .filter((f) => f && f.is_published === true
      && arr(f.supporting_data_points).filter((d) => d && d.fact).length >= 2)
    .map((f) => ({
      flag_name: String(f.flag_name ?? "OTHER_PATTERN").toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
      title: String(f.title ?? "").trim() || humanize(f.flag_name) || "Cross-record pattern",
      severity: ["SIGNIFICANT", "NOTABLE", "UNDER_REVIEW"].includes(f.severity) ? f.severity : "NOTABLE",
      description: String(f.description ?? ""),
      supporting_data_points: arr(f.supporting_data_points).filter((d) => d && d.fact).map((d) => ({
        fact: String(d.fact), source: String(d.source ?? ""), source_type: String(d.source_type ?? ""), date: String(d.date ?? ""),
      })),
      citations: citationsFor(f.description, registry),
    }));

  return parsed;
}

// Real-content items first (full affidavit, biography, then news leads), so the
// model's budget goes to substance. Content-less "pointer" links (generic
// "search portal X" URLs GLM can't read) are EXCLUDED entirely — they only
// bloated the prompt and tempted citing unread sources. News/fact-check leads
// are kept: their headline is readable content.
function selectSources(evidence, limit) {
  const rank = (e) =>
    e.content && e.source_type === "eci_affidavit" ? 0 :  // richest: full affidavit
    e.content ? 1 :                                         // other real document text
    2;                                                      // news / fact-check leads
  const usable = evidence.filter((e) =>
    e.content || e.source_type === "news" || e.source_type === "fact_check" || e.source_type === "prior_dossier");
  return usable.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

// ── Tone pass (Stage 2) ────────────────────────────────────────────────
// Re-voice ONLY the reader-facing prose so its WEIGHT matches the record's
// gravity. The stylist never sees raw sources (it can't invent facts) and its
// output is policed by a [n]-multiset gate, so citation integrity is guaranteed
// by CODE, not by trusting the model. Worst case is a no-op (GLM's own text).

// Map the already-computed grade to a 7-point tone register. A SIGNIFICANT
// computed flag forces the band up to at least SERIOUS so a documented finding
// never reads as merely "concerning" because the average lifted the grade.
export function narrativeGravity(overallGrade, computedFlags = []) {
  const byGrade = { A: "COMMENDABLE", B: "CLEAN", C: "MIXED", D: "CONCERNING", E: "SERIOUS", F: "SEVERE" };
  let band = byGrade[overallGrade] || "THIN"; // INSUFFICIENT_DATA / unknown → THIN
  const hasSignificant = (computedFlags ?? []).some((f) => f.severity === "SIGNIFICANT");
  if (hasSignificant) {
    const order = ["THIN", "COMMENDABLE", "CLEAN", "MIXED", "CONCERNING", "SERIOUS", "SEVERE"];
    if (order.indexOf(band) < order.indexOf("SERIOUS")) band = "SERIOUS";
  }
  return band;
}

// Multiset of [n] citation markers in a string, as a sorted signature. The gate
// keeps a rewrite only when its signature is IDENTICAL to the original's.
function citationSignature(text) {
  return String(text ?? "").match(/\[\d+\]/g)?.sort().join(",") ?? "";
}

// One OpenAI client per distinct (baseURL,key), built lazily and reused.
const _styleClients = new Map();
function styleClient(entry) {
  const id = `${entry.baseURL}::${entry.key}`;
  if (!_styleClients.has(id)) {
    _styleClients.set(id, new OpenAI({
      baseURL: entry.baseURL, apiKey: entry.key,
      defaultHeaders: entry.baseURL.includes("openrouter")
        ? { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" } : {},
    }));
  }
  return _styleClients.get(id);
}

const _styleCooldownUntil = new Map(); // chain index → epoch ms until which it's skipped
function isRateLimit(err) {
  const s = err?.status ?? err?.code;
  return s === 429 || /rate.?limit|quota|resource_exhausted|too many requests/i.test(err?.message ?? "");
}

// Try the chain in order, skipping cooling-down entries, rotating on rate-limit.
// Returns { text, model } on success, or null when every entry is unavailable
// (all cooling down / all errored) — the caller then keeps GLM's original text.
async function styleComplete(system, user) {
  const now = Date.now();
  const order = STYLE_CHAIN
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => (_styleCooldownUntil.get(i) ?? 0) <= now);
  for (const { e, i } of order) {
    try {
      const res = await styleClient(e).chat.completions.create({
        model: e.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.5,
        max_tokens: 4000,
      });
      const text = res.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("empty stylist response");
      return { text, model: `${e.provider}:${e.model}` };
    } catch (err) {
      if (isRateLimit(err)) {
        _styleCooldownUntil.set(i, Date.now() + 60_000); // 60s cooldown, then re-enters rotation
        console.warn(`[tone]   ${e.provider}:${e.model} rate-limited → rotating`);
        continue;
      }
      console.warn(`[tone]   ${e.provider}:${e.model} failed (${err.message}) → rotating`);
      continue; // non-rate-limit errors: try the next free entry too
    }
  }
  return null; // nothing available right now
}

const TONE_REGISTER = `══════════ TONE REGISTER — MATCH THE GRAVITY TO THE RECORD ══════════
A flat, identical voice for every subject is what makes accountability writing feel robotic.
Vary the WEIGHT of the prose along a SPECTRUM to fit what the record shows — but ONLY through
fact selection, sentence length and rhythm, never through loaded words or moral labels. You are
given an overall gravity band for the headline & summary; pick each category body's register
from THAT category's confidence + verdict. The spectrum, warm → grave:
 • COMMENDABLE (grade A) → warm and appreciative. A rep who kept promises / has a strong clean
   record deserves prose that says so, no grudging hedges.
 • CLEAN (B) → measured, fair, lightly positive. An unremarkable, honest record, stated plainly.
 • MIXED (C) → even and balanced. Hold the good and the concerning in the same steady hand.
 • CONCERNING (D) → sober and direct, a little more weight; name what the record shows and why it matters.
 • SERIOUS (E) → grave, spare. Shorter sentences; let each documented fact stand.
 • SEVERE (F) → gravest, weightiest. Let a single fact land alone — the fact is heavier than any
   epithet. NEVER cross into accusation, sarcasm, or a verdict of guilt; the citizen concludes.
 • THIN (insufficient data) → plain, honest, brief. One or two sentences on what IS known and what
   the record simply doesn't yet show. No padding, no ominous vagueness — an absence of data is not a shadow.
Move smoothly between adjacent registers — this is a dial, not seven boxes.

HUMAN TEXTURE (apply to headline, summary and category bodies):
 • Open the summary on a concrete, specific image from the record — a number, a date, a place,
   a single telling fact — not a generic "This report examines…".
 • Vary sentence length. Let one short sentence carry the punch after a longer one.
 • Use light connective narration so facts read as a story, not a list — every such sentence STILL ends in [n].
 • You may address the reader as "you" / "a voter" sparingly to bring stakes home.

STILL ABSOLUTE (unchanged): every sentence ends in its [n]; no praise-as-spin and no attack;
never label anyone corrupt/criminal/dishonest; strict party-blind neutrality.

══════════ HARD CONSTRAINTS — YOU ARE A COPY EDITOR, NOT AN INVESTIGATOR ══════════
1. Preserve every [n] citation marker VERBATIM — add none, drop none, move none. The exact set of
   [n] markers in each field's output MUST equal the set in its input.
2. Add NO new fact, name, number, date, place, or claim. You may only re-voice text already present.
3. Keep strict neutrality; never label anyone corrupt/criminal/dishonest; no sarcasm, no accusation,
   no partisan framing.
4. Do not merge, split, reorder, add, or drop categories. Same array, same order, same "id"s.

══════════ OUTPUT — respond with ONLY this JSON, no markdown, no prose outside it ══════════
{ "headline": "...", "executive_summary": "...", "categories": [ { "id": 0, "body": "..." } ] }`;

// Re-voice report.headline / executive_summary / categories[].body in place.
// Returns the (possibly mutated) report; on any failure the report is unchanged.
export async function applyTonePass(report, registry) {
  const gravity = narrativeGravity(report.overall_grade, report.computed_flags);
  const cats = Array.isArray(report.categories) ? report.categories : [];
  const payload = {
    OVERALL_GRAVITY_BAND: gravity,
    headline: report.headline ?? "",
    executive_summary: report.executive_summary ?? "",
    categories: cats.map((c, id) => ({ id, confidence: c.confidence, verdict: c.verdict, body: c.body })),
  };
  const user = `Overall gravity band for the headline & summary: ${gravity}.
Re-voice the fields below per the TONE REGISTER, obeying every HARD CONSTRAINT. Return the exact JSON schema.

${JSON.stringify(payload, null, 2)}`;

  const out = await styleComplete(TONE_REGISTER, user);
  report.narrative_gravity = gravity;
  report.styled = false;
  report.style_version = STYLE_VERSION;
  if (!out) { console.log(`[tone]   no free stylist available — kept original text`); return report; }

  let parsed;
  try {
    let t = out.text.trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
    parsed = JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] ?? t);
  } catch (err) {
    console.warn(`[tone]   unparseable stylist JSON — kept original (${err.message})`);
    return report;
  }

  // ── The gate: accept a field ONLY if its [n] signature is unchanged and it
  // didn't balloon. Otherwise keep GLM's original for that field. ──
  const keep = (orig, next, cap = 1.6) =>
    typeof next === "string" && next.trim()
    && citationSignature(orig) === citationSignature(next)
    && next.length <= Math.max(120, orig.length * cap)
      ? next.trim() : null;

  let kept = 0, rejected = 0;
  const h = keep(report.headline, parsed.headline);        if (h) { report.headline = h; kept++; } else if (parsed.headline) rejected++;
  const s = keep(report.executive_summary, parsed.executive_summary);
  if (s) { report.executive_summary = s; kept++; } else if (parsed.executive_summary) rejected++;

  const byId = new Map((Array.isArray(parsed.categories) ? parsed.categories : []).map((c) => [c.id, c]));
  for (let id = 0; id < cats.length; id++) {
    const next = keep(cats[id].body, byId.get(id)?.body);
    if (next) {
      cats[id].body = next;
      cats[id].citations = citationsFor(next, registry); // re-attach (signature identical, so same set)
      kept++;
    } else if (byId.get(id)?.body) rejected++;
  }

  report.styled = kept > 0;
  report.style_model = out.model;
  console.log(`[tone]   ${out.model} · ${gravity} · ${kept} field(s) styled, ${rejected} rejected by gate`);
  return report;
}

// Three explicit modes (you choose — nothing is forced):
//   "incremental" — send ONLY evidence gathered since the last report of this
//                   tier + a cheap prior-findings digest. Skips if nothing new.
//                   (Cheapest. Falls back to "full" if there's no prior report.)
//   "full"        — re-send the ENTIRE raw corpus, with NO prior context. A
//                   clean-slate re-investigation that remembers nothing.
//   "recheck"     — re-send the ENTIRE raw corpus AGAIN (so GLM re-scans every
//                   record from scratch and may find something new) WHILE also
//                   carrying the prior-findings digest, so it doesn't waste
//                   effort re-deriving patterns it already found and instead
//                   confirms them + hunts for NEW ones.
// ONE report per politician, drawing on every source. You choose the mode:
//   "incremental" — send ONLY evidence gathered since the last report + a cheap
//                   prior-findings digest. Skips if nothing new. (Cheapest.)
//   "full"        — re-send the ENTIRE raw corpus, with NO prior context.
//   "recheck"     — re-send the ENTIRE raw corpus AGAIN (re-scan from scratch,
//                   may find something new) WHILE carrying the prior digest, so
//                   it confirms known patterns cheaply and hunts for NEW ones.
// `force` — in incremental mode, regenerate even when no new evidence arrived.
export async function generateReport(politicianId, { mode = "incremental", force = false } = {}) {
  const p = getPolitician(politicianId);
  if (!p) throw new Error(`Unknown politician: ${politicianId}`);
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");
  if (!["incremental", "full", "recheck"].includes(mode)) mode = "incremental";

  const prior = mode === "full" ? null : latestReport(p.id);
  const cutoff = prior?.generated_at ?? null;
  let effMode = prior ? mode : "full";

  // Reprocess-on-change (task #11): if the investigation pipeline advanced since
  // this rep's last report (new source/field/prompt → PIPELINE_VERSION bumped),
  // force a full re-investigation WITH memory so the whole back-catalogue gets
  // the new capability — nothing is left behind on the next run.
  const stale = prior && (prior.pipeline_version ?? 0) !== PIPELINE_VERSION;
  if (stale && effMode === "incremental") effMode = "recheck";

  // Re-ingest. Storage dedupes on URL, so only genuinely-new rows are added
  // (each stamped fetched_at=now) — which is exactly our incremental delta.
  await ingestFor(p).catch(() => {});

  let all = listEvidence(p.id).filter((e) => (e.tier ?? 1) <= MAX_SOURCE_TIER);

  // ── Deterministic research desk (runs in CODE, before the LLM writes) ──
  // Compute named, reproducible facts/flags from structured numbers, and a
  // per-parameter score baseline. The LLM narrates these; it does not decide
  // whether they are true. This is what makes the report reproducible.
  const { flags: computedFlags, facts: computedFacts } = computeFlags(all);
  // Relationship graph: named relatives (Wikidata) → dynasty / scandal ties.
  const relations = buildRelations(p, all);
  // Notable relationship links become computed flags too (so they score + show).
  for (const link of relations.links) {
    if (link.type === "DYNASTY")
      computedFlags.push({ code: "DYNASTY_LINK", param: "favoritism", weight: -6, severity: "NOTABLE",
        headline: `Family political dynasty: ${link.relation} ${link.relative_name} is also an elected representative.`,
        detail: link.note, sources: [link.source_url].filter(Boolean) });
    if (link.type === "RELATIVE_IN_SCANDAL")
      computedFlags.push({ code: "RELATIVE_IN_SCANDAL", param: "favoritism", weight: -10, severity: "SIGNIFICANT",
        headline: `A relative is connected to a documented governance failure.`,
        detail: link.note, sources: [link.source_url].filter(Boolean) });
  }
  const { baseline: scoreBaseline, contributions: scoreContributions } = scoreFromFlags(computedFlags);

  // ── L1 Detector (conflict-of-interest engine) — code only, no model ────
  // Writes candidate leads to the SEPARATE investigation_leads table with
  // status:"detected". This NEVER touches the public report object — leads
  // only reach the public via the gated L2/L3/admin-approval path (Phase B).
  try {
    const { leads } = detectConflicts(p, all);
    for (const lead of leads) upsertLead(lead);
  } catch (err) { console.warn(`[conflict] detector failed for ${p.name}: ${err.message}`); }

  let newEvidence = all;
  if (effMode === "incremental") {
    newEvidence = all.filter((e) => String(e.fetched_at ?? "") > cutoff);
    if (newEvidence.length === 0 && !force) {
      console.log(`[generate] ${p.name} — no new evidence since ${String(cutoff).slice(0, 10)}; keeping existing report (use --mode recheck/full or --force to rebuild).`);
      return { ...prior, skipped_no_new: true };
    }
  }

  // "incremental" → prior digest [1] + new-only.  "recheck" → prior digest [1]
  // + the WHOLE corpus re-scanned.  "full" → whole corpus, no digest.
  const usePrior = effMode === "incremental" || effMode === "recheck";
  const corpus = effMode === "incremental" ? newEvidence : all;
  let sources = selectSources(corpus, usePrior ? 59 : 60);
  if (usePrior) sources = [priorSourceItem(prior), ...sources];

  // Numbered registry the [n] citations resolve against.
  const registry = sources.map((e, i) => ({
    n: i + 1, title: e.title, url: e.url, admissible: !!e.admissible,
    tier: e.tier ?? null, date: e.date ?? null, source_type: e.source_type,
  }));

  const corroboratedTips = listTips({ politician_id: p.id, status: "approved" })
    .filter((t) => t.corroborated);

  const client = new OpenAI({
    baseURL: AI_BASE, apiKey: AI_KEY,
    defaultHeaders: AI_BASE.includes("openrouter")
      ? { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" } : {},
  });

  const { system, user } = buildPrompt(p, sources, corroboratedTips, { mode: effMode, computedFlags, scoreBaseline });
  const srcDesc = effMode === "incremental" ? `INCREMENTAL: prior digest + ${newEvidence.length} new`
    : effMode === "recheck" ? `RECHECK${stale ? "(pipeline upgraded)" : ""}: prior digest + full ${sources.length - 1} re-scan`
    : `FULL: ${sources.length}/${all.length}`;
  console.log(`[generate] ${p.name} — ${srcDesc} sources → ${MODEL}`);

  // Up to 2 attempts: the model occasionally returns malformed/truncated JSON.
  // A failed parse should never silently skip a politician in a big batch.
  let report = null, lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw = "";
    try {
      const response = await client.chat.completions.create({
        model: MODEL,
        // Static system prefix is identical across reps → cached by OpenRouter
        // at ~0.25–0.5× input cost (task #16). Per-rep data is the user message.
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: attempt === 1 ? 0.15 : 0.1, // tighten on retry
        max_tokens: 20000,                         // task #15: room for a deep report
        // task #15: ask the model for maximum reasoning effort. OpenRouter
        // normalises this and ignores it for models that don't support it.
        reasoning: { effort: "high" },
        usage: { include: true }, // surface cache hit metrics in the response
      });
      const msg = response.choices?.[0]?.message;
      raw = msg?.content ?? msg?.reasoning ?? "";
      if (!raw) throw new Error("Model returned empty content.");
      const u = response.usage ?? {};
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      console.log(`[generate]   attempt ${attempt}: ${raw.length} chars · in ${u.prompt_tokens ?? "?"} (cached ${cached}) / out ${u.completion_tokens ?? "?"}`);
    } catch (err) {
      if (err.status) {
        console.error(`[generate]   HTTP ${err.status}: ${err.message}`);
        console.error("    Body:", JSON.stringify(err.error ?? {}, null, 2));
        lastErr = new Error(`API error ${err.status}: ${err.message}`);
      } else {
        lastErr = err;
      }
      continue; // retry the API call
    }

    try {
      report = validateAndRepair(raw, p, registry);
      break; // parsed OK
    } catch (err) {
      console.warn(`[generate]   attempt ${attempt} parse failed: ${err.message}`);
      lastErr = err;
    }
  }
  if (!report) throw lastErr ?? new Error("Report generation failed.");

  // ENFORCE the score baseline in code (the prompt asks for ±15, but a prompt
  // is not a guarantee — reproducibility must not depend on model obedience).
  // For any parameter that computed flags actually touched: a -1 becomes the
  // baseline, and any score is clamped to baseline ±15.
  for (const pm of report.parameters ?? []) {
    const contribs = scoreContributions?.[pm.key] ?? [];
    if (!contribs.length) continue;
    const base = scoreBaseline[pm.key];
    const clamped = pm.score < 0 ? base : Math.max(base - 15, Math.min(base + 15, pm.score));
    if (clamped !== pm.score) {
      pm.score = clamped;
      pm.confidence_reason = `${pm.confidence_reason ?? ""} [anchored to code-computed baseline ${base}]`.trim();
    }
  }

  const overall = computeOverall(report.parameters);

  // ── Stage 2: tone pass (opt-in) ──────────────────────────────────────
  // Re-voice the reader-facing prose to match the record's gravity. The
  // [n]-multiset gate inside guarantees citation integrity; a failure or a
  // fully-throttled free chain is a safe no-op (GLM's original text is kept).
  if (STYLE_ENABLED) {
    report.overall_grade = overall.overall_grade; // narrativeGravity reads this
    report.computed_flags = computedFlags;         // …and this for the SIGNIFICANT bump
    try { await applyTonePass(report, registry); }
    catch (err) { console.warn(`[tone]   pass failed for ${p.name}: ${err.message} — kept original`); }
  }

  return addReport({
    // Model output first — every deterministic key AFTER it, so a model that
    // echoes fields like "computed_flags" or "politician_id" in its JSON can
    // never overwrite the code-computed truth.
    ...report,
    ...overall,
    politician_id: p.id,
    model: MODEL,
    pipeline_version: PIPELINE_VERSION,
    evidence_count: sources.length,
    update_mode: effMode,
    based_on_report: usePrior ? prior?.id ?? null : null,
    new_evidence_count: effMode === "incremental" ? newEvidence.length : (usePrior ? sources.length - 1 : sources.length),
    sources: registry,
    // Deterministic, reproducible layer — the frontend shows the itemised,
    // weighted breakdown so the score is never a black box.
    computed_flags: computedFlags,
    computed_facts: computedFacts,
    score_baseline: scoreBaseline,
    score_contributions: scoreContributions,
    relations,
  });
}


// CLI. One report per politician (no more T1/T2). Examples:
//   node server/report-generator.js all --office MP                 (all MPs)
//   node server/report-generator.js all --state Maharashtra
//   node server/report-generator.js all --limit 100 --mode recheck  (re-scan w/ memory)
//   node server/report-generator.js <id>                            (single politician)
//
// You CHOOSE the update mode (default incremental):
//   --mode incremental  only new evidence since the last report + a cheap prior
//                       digest; skips if nothing new
//   --mode full         re-investigate the whole corpus with NO prior memory
//   --mode recheck      re-scan the whole corpus AGAIN but carry the prior
//                       findings, to confirm them and hunt for NEW patterns
//   --full              alias for --mode full
// Other flags: --new-only (only reps with no report yet, pure resume),
//   --force (regen even if incremental finds nothing new), --no-scandals
//   (skip the GLM scandal step). The scandal generator + auto-discovery now run
//   as PART of report generation (task #14) — not in the ingester.
const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("report-generator.js");
if (invokedDirectly) {
  const { startTimer } = await import("./util/timing.js");
  const stop = startTimer("Report generation");
  const args = process.argv.slice(2);
  const valFlags = ["--office", "--state", "--limit", "--mode"];
  const flags = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (valFlags.includes(args[i])) flags[args[i].slice(2)] = args[++i];
      else flags[args[i].slice(2)] = true;
    } else positional.push(args[i]);
  }
  const runMode = flags.full ? "full" : (["incremental", "full", "recheck"].includes(flags.mode) ? flags.mode : "incremental");
  // --tone-pass turns on the Stage-2 stylist for this run (also honours AI_STYLE_ENABLED env).
  if (flags["tone-pass"]) { setStyleEnabled(true); console.log(`[tone] Stage-2 tone pass ENABLED (chain: ${STYLE_CHAIN.map((e) => e.provider + ":" + e.model).join(", ") || "no free keys found!"})`); }
  const target = positional[0];

  let list;
  if (target && target !== "all") {
    // Accept an id OR a name, and allow several comma-separated (test runs):
    //   node server/report-generator.js "Narendra Modi,Rahul Gandhi"
    const { findPolitician } = await import("./store.js");
    list = target.split(",").map((t) => findPolitician(t.trim())).filter(Boolean);
    if (!list.length) { console.error(`No politician matched "${target}". Use a full/partial name or an id.`); process.exit(1); }
  } else {
    list = listPoliticians().filter((p) => !p.is_demo);
    // --mps groups BOTH houses of Parliament (Lok Sabha office=MP + Rajya Sabha
    // office=RS) into one run, so you never run two commands for "all MPs".
    if (flags.mps)         list = list.filter((p) => p.office === "MP" || p.office === "RS");
    else if (flags.office) list = list.filter((p) => p.office === flags.office);
    if (flags.state)  list = list.filter((p) => (p.state ?? "").toLowerCase() === flags.state.toLowerCase());
    if (flags["new-only"]) list = list.filter((p) => !latestReport(p.id)); // pure resume
    if (flags.limit)  list = list.slice(0, Number(flags.limit));
  }

  console.log(`Generating reports for ${list.length} politician(s)`
    + `${flags.office ? ` · office=${flags.office}` : ""}${flags.state ? ` · state=${flags.state}` : ""} · mode=${runMode}${flags["new-only"] ? " · new-only" : ""} · pipeline v${PIPELINE_VERSION}\n`);

  // Scandal layer (task #14): GLM-driven, part of report generation — NOT the
  // ingester. Runs once per batch: (1) generate analyses for any built-in seeds
  // not yet done; (2) auto-discover NEW scandals from the news (human-gated
  // proposals, rate-limited). Skipped with --no-scandals.
  if (!flags["no-scandals"]) {
    try {
      const { generateScandal } = await import("./scandal-generator.js");
      const { maybeDiscover } = await import("./scandal-discovery.js");
      const { SCANDAL_SEEDS } = await import("./data/scandal-seeds.js");
      const { getScandal } = await import("./store.js");
      let made = 0;
      for (const seed of SCANDAL_SEEDS) {
        if (getScandal(seed.slug)) continue;
        try { await generateScandal(seed); made++; } catch (e) { console.warn(`[scandal] ${seed.slug}: ${e.message}`); }
      }
      if (made) console.log(`[scandal] generated ${made} new seed analysis(es).`);
      const d = await maybeDiscover({ force: !!flags.force });
      if (d.queued != null) console.log(`[scandal] discovery queued ${d.queued} new proposal(s) for your admin review.`);
      else console.log(`[scandal] discovery: ${d.skipped}.`);
    } catch (err) { console.warn(`[scandal] step skipped: ${err.message}`); }
  }

  // Issues layer (task #5): generate any policy-issue analyses not yet done, so
  // adding an issue to data/issues.js automatically gets it analysed next run.
  if (!flags["no-issues"]) {
    try {
      const { generateIssue } = await import("./issue-analyzer.js");
      const { ISSUE_SEEDS } = await import("./data/issues.js");
      const { getIssue } = await import("./store.js");
      let made = 0;
      for (const seed of ISSUE_SEEDS) {
        if (getIssue(seed.slug)) continue;
        try { await generateIssue(seed); made++; } catch (e) { console.warn(`[issue] ${seed.slug}: ${e.message}`); }
      }
      if (made) console.log(`[issue] generated ${made} new issue analysis(es).`);
    } catch (err) { console.warn(`[issue] step skipped: ${err.message}`); }
  }

  // --conflicts-only skips report generation entirely and just runs the
  // L2/L3 conflict-investigation step below on whatever's already 'detected'
  // for the target politician(s) — e.g. `report-generator.js "Some MP" --conflicts-only`.
  if (!flags["conflicts-only"]) {
    let ok = 0, fail = 0, skip = 0, i = 0;
    for (const p of list) {
      i++;
      process.stdout.write(`[${i}/${list.length}] ${p.name}… `);
      try {
        const r = await generateReport(p.id, { mode: runMode, force: !!flags.force });
        if (r.skipped_no_new) { console.log("· no new evidence, kept existing"); skip++; }
        else { console.log(`${r.overall_grade} (${r.overall_score}/100), ${r.categories.length} cats, ${r.red_flags.length} flags [${r.update_mode}]`); ok++; }
      } catch (err) { console.log(`✗ ${err.message}`); fail++; }
    }
    console.log(`\nDone. ${ok} generated, ${skip} unchanged, ${fail} failed.`);
  }

  // ── Conflict-of-interest investigation (L2 Investigator + L3 Referee) ──
  // The Detector (L1) already wrote candidate leads with status:"detected"
  // during generateReport, above. Here we take the TOP-SCORED leads among the
  // politicians in THIS run and put them through the expensive AI layers —
  // never the whole population at once. Nothing is published; leads only move
  // to status:"proposed"/"dismissed", awaiting admin approval (Phase B4).
  if (!flags["no-conflicts"]) {
    try {
      const { investigateLead } = await import("./investigator.js");
      const targetIds = new Set(list.map((p) => p.id));

      // C2: population-level collusion detection (shared-address clusters +
      // collusive bidding) — pure code, emits 'detected' leads into the queue.
      try {
        const { runCollusion } = await import("./collusion.js");
        const { clusters, leads: colLeads } = runCollusion({});
        if (colLeads.length) console.log(`[collusion] ${clusters.length} address cluster(s), ${colLeads.length} lead(s) detected.`);
      } catch (e) { console.warn(`[collusion] step skipped: ${e.message}`); }

      const topN = Number(process.env.CONFLICT_TOP_N) || 50;
      const detected = listLeads({ status: "detected" })
        .filter((l) => targetIds.has(l.actor_id))
        .sort((a, b) => b.signal_score - a.signal_score)
        .slice(0, topN);
      if (detected.length) {
        console.log(`\n[conflict] investigating top ${detected.length} lead(s) (of the population detected this run)…`);
        let inv = 0, dis = 0, err = 0;
        await mapLimit(detected, 2, async (lead) => {
          try {
            const r = await investigateLead(lead);
            if (r.status === "proposed") inv++; else dis++;
          } catch (e) { err++; console.warn(`[conflict]   ${lead.actor_name} · ${lead.vector}: ${e.message}`); }
        });
        console.log(`[conflict] done. ${inv} promoted to admin review, ${dis} dismissed, ${err} failed.`);
      } else {
        console.log(`\n[conflict] no detected leads for this run's politicians.`);
      }

      // D (L4): cross-entity synthesis — after investigating, look ACROSS all
      // leads for beneficiaries that recur over many politicians (network hubs).
      try {
        const { runSynthesis } = await import("./synthesis.js");
        const { hubs } = runSynthesis();
        if (hubs.length) console.log(`[synthesis] ${hubs.length} network-hub meta-lead(s) detected.`);
      } catch (e) { console.warn(`[synthesis] step skipped: ${e.message}`); }
    } catch (err) { console.warn(`[conflict] step skipped: ${err.message}`); }
  }

  stop();
  // Let the process exit naturally so buffered stdout is fully flushed.
}
