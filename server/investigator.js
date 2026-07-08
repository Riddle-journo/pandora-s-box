// L2 Investigator + L3 Referee — the false-positive firewall.
//
// A code Detector (conflict.js) emits cheap LEADS, most of which are innocent
// coincidence. This module takes ONE lead and runs it past TWO independent GLM
// passes:
//   L2 Investigator — a skeptical COI analyst that must be willing to DISMISS.
//     Real investigations are not single-shot: they form a hypothesis, pull a
//     targeted record, and revise. So L2 is a BOUNDED AGENTIC TOOL-LOOP: each
//     turn the model either asks for ONE tool (registry / market / court lookup)
//     or returns a verdict (mechanism, evidence FOR/AGAINST, timeline, verdict,
//     confidence, the one record that would settle it). The loop is capped, every
//     step is persisted immediately (crash-safe + resumable), and the tool budget
//     is bounded so a lead can never spend the network without limit.
//   L3 Referee — a SEPARATE call playing the politician's defence lawyer: give
//     the innocent explanation and say whether it fully explains the facts. If it
//     does, the lead is downgraded to COINCIDENCE.
//
// A lead is promoted to the human queue (status 'proposed') ONLY if it survives
// both. Nothing is published here — this only sets status. Two independent
// adversarial passes are what make surfacing an unproven claim defensible.
import "dotenv/config";
import OpenAI from "openai";
import { listEvidence, upsertLead, addEvidence } from "./store.js";
import { searchDeals } from "./fetchers/nse-deals.js";
import { lookupDirectorCompanies } from "./mca-index.js";
import { searchOfficers } from "./fetchers/opencorporates.js";
import { fetchIndianKanoon } from "./fetchers/indian-kanoon.js";
import { fetchCompanyRegistry } from "./fetchers/company-registry.js";

const AI_BASE = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL   = process.env.AI_MODEL    || "z-ai/glm-5.2";
const AI_KEY  = process.env.AI_API_KEY  || "";

// ---- Budget constants (constant at top so the bound is auditable at a glance) ----
const MAX_STEPS      = 4;    // max L2 tool-decision LLM calls per lead
const MAX_TOOL_CALLS = 2;    // max invocations of any single tool per lead
const TRUNC          = 1200; // char cap on any tool summary/content fed back to L2

// Strip a code fence, then fall back to the first {...} run. Same repair shape as
// report-generator's validateAndRepair. Returns parsed object or null.
function parseJson(raw) {
  const t = String(raw ?? "").trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
  try { return JSON.parse(t); }
  catch { const m = t.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } }
}

// Real GLM call. Returns the RAW assistant text (the loop parses/repairs it, so
// it needs the string, not pre-parsed JSON). `ask` is injected here so tests can
// script the sequence without a network call.
async function callRaw(system, user, { maxTokens = 6000, temperature = 0.15 } = {}) {
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");
  const client = new OpenAI({
    baseURL: AI_BASE, apiKey: AI_KEY,
    defaultHeaders: AI_BASE.includes("openrouter") ? { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" } : {},
  });
  const r = await client.chat.completions.create({
    model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature, max_tokens: maxTokens, reasoning: { effort: "high" },
  });
  const msg = r.choices?.[0]?.message;
  return String(msg?.content ?? msg?.reasoning ?? "");
}

// One L2/L3 turn with malformed-JSON tolerance: parse; on failure retry ONCE at a
// lower temperature; return parsed object or null (loop degrades to status:error).
async function askJson(ask, system, user, maxTokens = 6000) {
  let parsed = parseJson(await ask(system, user, { maxTokens, temperature: 0.15 }));
  if (parsed) return parsed;
  parsed = parseJson(await ask(system, user, { maxTokens, temperature: 0.1 }));
  return parsed; // may be null
}

// ---- Mock plumbing (INVESTIGATOR_MOCK=1) — scripted responses + stub tools so the
// loop, persistence, resume, and error paths are unit-testable with no LLM/network. ----
let _mock = null, _mockIdx = 0;
export function setMockResponses(list) { _mock = Array.isArray(list) ? list.slice() : null; _mockIdx = 0; }
function mockRaw() {
  if (!_mock || _mockIdx >= _mock.length) throw new Error("INVESTIGATOR_MOCK: scripted responses exhausted");
  const item = _mock[_mockIdx++];
  return typeof item === "string" ? item : JSON.stringify(item);
}
const MOCK_TOOLS = Object.fromEntries(
  ["mca_directors", "opencorporates", "nse_deals", "indian_kanoon", "company_registry"].map((k) => [k, {
    describe: `mock ${k}`,
    run: ({ name }) => ({ found: 1, summary: `mock ${k} result for "${name ?? ""}"`, url: `https://mock.local/${k}`, title: `mock ${k}`, content: `mock ${k} content` }),
  }])
);

// ---- Tool registry: each wraps an existing fetcher behind the SAME {name, extra?}
// shape and returns a compact summary object (summary/content truncated to TRUNC).
// The rate-limit/degrade-to-[] behaviour lives in the fetchers themselves. ----
export const TOOLS = {
  mca_directors: {
    describe: "look up company directorships (MCA21 director index) by person name",
    run: ({ name }) => {
      const rows = lookupDirectorCompanies(name) || [];
      const summary = rows.length
        ? `MCA directorships for "${name}": ` + rows.slice(0, 10).map((x) => `${x.company_name} [${x.designation}${x.active ? ", active" : ", ceased"}]`).join("; ")
        : `No MCA directorships found for "${name}".`;
      return { found: rows.length, summary: summary.slice(0, TRUNC), url: "https://www.mca.gov.in/mca/html/searchDir.html", title: `MCA directorships — ${name}`, content: summary.slice(0, TRUNC) };
    },
  },
  opencorporates: {
    describe: "look up company officer roles (OpenCorporates, India) by person name",
    run: async ({ name }) => {
      const off = (await searchOfficers(name)) || [];
      const summary = off.length
        ? `OpenCorporates officer roles for "${name}": ` + off.slice(0, 8).map((x) => `${x.company_name} (${x.position})`).join("; ")
        : `No OpenCorporates officer roles found for "${name}".`;
      return { found: off.length, summary: summary.slice(0, TRUNC), url: off[0]?.opencorporates_url || "https://opencorporates.com/officers", title: `OpenCorporates officers — ${name}`, content: summary.slice(0, TRUNC) };
    },
  },
  nse_deals: {
    describe: "search recent NSE bulk/block deals for a client name (large-trade signal)",
    run: async ({ name }) => {
      const d = (await searchDeals(name)) || [];
      const summary = d.length
        ? `NSE bulk/block deals naming "${name}": ` + d.slice(0, 8).map((x) => `${x.symbol} ${x.type} ${x.quantity} (${x.date})`).join("; ")
        : `No NSE bulk/block deals found naming "${name}".`;
      return { found: d.length, summary: summary.slice(0, TRUNC), url: d.length ? "https://www.nseindia.com/report-detail/display-bulk-and-block-deals" : "", title: `NSE deals — ${name}`, content: summary.slice(0, TRUNC) };
    },
  },
  indian_kanoon: {
    describe: "search Indian court judgments (Indian Kanoon) mentioning a person name",
    run: async ({ name, actor_id }) => {
      const res = (await fetchIndianKanoon({ id: actor_id, name })) || [];
      const r = res[0];
      return { found: res.length, summary: String(r?.summary ?? `No court judgments found for "${name}".`).slice(0, TRUNC), url: r?.url ?? "", title: r?.title ?? `Indian Kanoon — ${name}`, content: String(r?.content ?? "").slice(0, TRUNC) };
    },
  },
  company_registry: {
    describe: "verify declared companies against the MCA Company Master registry (status/CIN/capital)",
    run: async ({ name, actor_id }) => {
      const res = (await fetchCompanyRegistry({ id: actor_id, name })) || [];
      const r = res[0];
      return { found: res.length, summary: String(r?.summary ?? `No declared companies verified in the MCA registry.`).slice(0, TRUNC), url: r?.url ?? "", title: r?.title ?? `MCA registry — ${name}`, content: String(r?.content ?? "").slice(0, TRUNC) };
    },
  },
};

// Assemble a focused dossier: ONLY the records tied to this lead, falling back to
// the rep's summary rows so the investigator always has context.
function buildDossier(lead) {
  const ev = listEvidence(lead.actor_id);
  const urls = new Set((lead.evidence_urls ?? []).filter(Boolean));
  let rows = ev.filter((e) => urls.has(e.url));
  if (!rows.length) rows = ev.filter((e) => ["parliament_ls", "eci_affidavit", "mca_company", "party_finance"].includes(e.source_type)).slice(0, 4);
  return rows.map((e) => `[${e.source_type}] ${e.title}\n${String(e.content ?? "").slice(0, 2500)}`).join("\n\n---\n\n");
}

const L2_SYSTEM = `You are a meticulous, SKEPTICAL conflict-of-interest investigator for a public-record platform on Indian politics. You are handed ONE candidate lead — a coincidence a code detector flagged — plus the underlying records. Working like a real investigator, you may pull ADDITIONAL targeted records with tools before deciding. Decide whether the public record actually supports a conflict of interest. You MUST be willing to DISMISS: most flagged coincidences are innocent.

RULES
- Reason ONLY from the records provided or the tools return. Never invent facts, dates, companies, or amounts.
- A sector overlap ALONE is not a conflict — many people hold shares and MPs question many sectors. Look for a MECHANISM: does the office actually affect the specific beneficiary? Is there timing, magnitude, or specificity that makes innocent coincidence unlikely?
- "Declared and legal" is not "improper". Holding a disclosed company is legal; the question is misuse of office.
- Never assert guilt. This is an assessment for a human reviewer and a second (defence) reviewer.
- Prefer to VERIFY a hypothesis with a tool before you commit to a verdict, but do not fish endlessly — stop as soon as the record is clear enough to judge.

Each turn respond with ONLY ONE of these JSON objects (no prose outside the JSON):
  ACTION: {"action":{"tool":"<tool name>","args":{"name":"<person or company>","extra":"<optional>"}},"reason":"why this record would move the assessment"}
  VERDICT: {"verdict":{"mechanism":"how the alleged benefit would actually work, or 'none evident'","evidence_for":["..."],"evidence_against":["..."],"timeline":"any dated sequence, or 'not established'","verdict":"SUBSTANTIATED|SUGGESTIVE|COINCIDENCE","confidence":0,"confirming_record":"the single record that would confirm or kill this","summary":"one neutral sentence"}}
SUBSTANTIATED = records show a concrete mechanism + specificity/timing. SUGGESTIVE = a real overlap worth a human look but no proven mechanism. COINCIDENCE = generic overlap explainable innocently.`;

const L3_SYSTEM = `You are the DEFENCE COUNSEL for the person named in a conflict-of-interest allegation an investigator thought worth pursuing. Your only job: give the most reasonable INNOCENT explanation from the records, and judge whether the allegation is FULLY explained away by ordinary, lawful conduct. Be honest — if it genuinely cannot be fully explained, say so.

Respond with ONLY this JSON:
{"innocent_explanation":"...","fully_explainable":true,"why":"one sentence"}
"fully_explainable": true ONLY if an ordinary, lawful account fully accounts for the facts with nothing left suspicious.`;

const nowIso = () => new Date().toISOString();
const stepKey = (tool, args) => `${tool}|${JSON.stringify(args ?? {})}`;

// Build the L2 turn prompt from the lead facts + every prior step summary.
function buildL2Prompt(lead, dossier, steps, forceVerdict) {
  const toolList = Object.entries(TOOLS).map(([k, t]) => `  - ${k}: ${t.describe}`).join("\n");
  const stepsBlock = steps.length
    ? steps.map((s, i) => `${i + 1}. [${s.tool}] args=${JSON.stringify(s.args ?? {})} → ${s.summary}`).join("\n")
    : "(none yet)";
  return `CANDIDATE LEAD
Vector: ${lead.vector}
Person: ${lead.actor_name}
Instrument of office: ${lead.instrument}
Beneficiary: ${lead.beneficiary}
Detector note: ${lead.detail}

UNDERLYING RECORDS:
${dossier || "(no additional records available)"}

TOOLS YOU MAY CALL:
${toolList}

STEPS TAKEN SO FAR (${steps.length}):
${stepsBlock}
${forceVerdict ? "\nYou have reached the investigation step budget. Return your final VERDICT now — do NOT request another action." : ""}
Respond with a single ACTION or VERDICT JSON object.`;
}

// `ask`/`tools` are injectable so the loop is unit-testable without GLM or network.
// In INVESTIGATOR_MOCK mode they default to the scripted caller + stub tools.
export async function investigateLead(lead, {
  ask = process.env.INVESTIGATOR_MOCK === "1" ? mockRaw : callRaw,
  tools = process.env.INVESTIGATOR_MOCK === "1" ? MOCK_TOOLS : TOOLS,
} = {}) {
  const dossier = buildDossier(lead);

  // Resume from any persisted state (idempotent restart); rebuild the budget
  // bookkeeping from the steps already taken.
  const state = lead.data?.investigation ?? lead.investigation ?? { steps: [], status: "running" };
  if (!Array.isArray(state.steps)) state.steps = [];
  state.status = "running";
  const toolCounts = {};
  const doneKeys = new Set();
  for (const s of state.steps) {
    if (s.ran) toolCounts[s.tool] = (toolCounts[s.tool] ?? 0) + 1;
    doneKeys.add(stepKey(s.tool, s.args));
  }

  // Persist the running state onto the lead immediately after every step so a
  // crash mid-investigation never loses progress and a restart resumes cleanly.
  const persist = () => upsertLead({ ...lead, investigation: state });
  const fail = () => { state.status = "error"; persist(); return upsertLead({ ...lead, status: "detected", investigation: state }); };

  let verdictObj = null;

  for (let call = 0; call < MAX_STEPS; call++) {
    const resp = await askJson(ask, L2_SYSTEM, buildL2Prompt(lead, dossier, state.steps, false));
    if (!resp) return fail();                       // malformed after retry
    if (resp.verdict) { verdictObj = resp.verdict; break; }
    if (!resp.action || !resp.action.tool) return fail(); // neither shape → error

    const { tool, args = {} } = resp.action;
    const key = stepKey(tool, args);
    if (!tools[tool]) {
      state.steps.push({ tool, args, ran: false, summary: `unknown tool "${tool}" — ignored`, at: nowIso() });
      persist(); continue;
    }
    if (doneKeys.has(key)) {
      state.steps.push({ tool, args, ran: false, summary: "skipped: identical tool+args already run", at: nowIso() });
      persist(); continue;
    }
    if ((toolCounts[tool] ?? 0) >= MAX_TOOL_CALLS) {
      state.steps.push({ tool, args, ran: false, summary: `skipped: ${tool} already invoked ${MAX_TOOL_CALLS}× (budget)`, at: nowIso() });
      persist(); continue;
    }

    let result;
    try { result = await tools[tool].run({ ...args, actor_id: lead.actor_id }); }
    catch (err) { result = { summary: `tool error: ${String(err?.message ?? err)}` }; }

    // Record anything with a URL as evidence (provenance: investigation).
    if (result?.url) {
      try {
        addEvidence([{
          politician_id: lead.actor_id, source_type: "investigation", tool,
          url: result.url, title: result.title ?? `${tool} lookup`,
          content: String(result.content ?? result.summary ?? "").slice(0, TRUNC),
          admissible: true, date: null,
        }]);
      } catch { /* evidence recording must never break the loop */ }
    }

    toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
    doneKeys.add(key);
    state.steps.push({ tool, args, ran: true, summary: String(result?.summary ?? "").slice(0, TRUNC), at: nowIso() });
    persist();
  }

  // Step cap hit without a verdict → force ONE final verdict-only call.
  if (!verdictObj) {
    const resp = await askJson(ask, L2_SYSTEM, buildL2Prompt(lead, dossier, state.steps, true));
    if (!resp || !resp.verdict) return fail();
    verdictObj = resp.verdict;
  }

  let verdict = String(verdictObj?.verdict ?? "COINCIDENCE").toUpperCase();
  if (!["SUBSTANTIATED", "SUGGESTIVE", "COINCIDENCE"].includes(verdict)) verdict = "COINCIDENCE";

  // L3 referee — EXACTLY as before, over the final L2 verdict, plus a one-paragraph
  // digest of the steps taken. Only worth running if L2 didn't already dismiss.
  let referee = null;
  if (verdict !== "COINCIDENCE") {
    const digest = state.steps.length
      ? "Investigation steps: " + state.steps.map((s) => `${s.tool}(${JSON.stringify(s.args ?? {})}) → ${s.summary}`).join(" | ")
      : "No additional records were pulled.";
    const l3user = `ALLEGATION
${lead.headline}
Investigator's reasoning: ${verdictObj?.summary ?? ""}
Evidence cited for concern: ${(verdictObj?.evidence_for ?? []).join("; ")}

RECORDS:
${dossier || "(none)"}

${digest}

Give the innocent explanation and judge whether it is fully explainable.`;
    referee = await askJson(ask, L3_SYSTEM, l3user, 3000);
    if (referee?.fully_explainable === true) verdict = "COINCIDENCE";
  }

  state.status = "done";
  state.verdict = verdict;
  state.confidence = typeof verdictObj?.confidence === "number" ? verdictObj.confidence : null;
  state.mechanism = verdictObj?.mechanism ?? "";
  state.evidence_for = Array.isArray(verdictObj?.evidence_for) ? verdictObj.evidence_for : [];
  state.evidence_against = Array.isArray(verdictObj?.evidence_against) ? verdictObj.evidence_against : [];
  state.timeline = verdictObj?.timeline ?? "";
  state.confirming_record = verdictObj?.confirming_record ?? "";
  state.summary = verdictObj?.summary ?? "";
  state.referee = referee;
  state.investigated_at = nowIso();
  state.model = MODEL;

  // Spread lead FIRST so the AI's `investigation` can never overwrite the
  // deterministic detector fields (vector, signal_score, headline, …).
  return upsertLead({ ...lead, status: verdict === "COINCIDENCE" ? "dismissed" : "proposed", investigation: state });
}
