// L2 Investigator + L3 Referee — the false-positive firewall.
//
// A code Detector (conflict.js) emits cheap LEADS, most of which are innocent
// coincidence. This module takes ONE lead and runs it past TWO independent GLM
// passes:
//   L2 Investigator — a skeptical COI analyst that must be willing to DISMISS:
//     mechanism, evidence FOR/AGAINST, timeline, verdict, confidence, and the one
//     record that would settle it.
//   L3 Referee — a SEPARATE call playing the politician's defence lawyer: give
//     the innocent explanation and say whether it fully explains the facts. If it
//     does, the lead is downgraded to COINCIDENCE.
//
// A lead is promoted to the human queue (status 'proposed') ONLY if it survives
// both. Nothing is published here — this only sets status. Two independent
// adversarial passes are what make surfacing an unproven claim defensible.
import "dotenv/config";
import OpenAI from "openai";
import { listEvidence, upsertLead } from "./store.js";
import { searchDeals } from "./fetchers/nse-deals.js";
import { lookupDirectorCompanies } from "./mca-index.js";
import { searchOfficers } from "./fetchers/opencorporates.js";

const AI_BASE = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1";
const MODEL   = process.env.AI_MODEL    || "z-ai/glm-5.2";
const AI_KEY  = process.env.AI_API_KEY  || "";

function parseJson(raw) {
  const t = String(raw ?? "").trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
  try { return JSON.parse(t); }
  catch { const m = t.match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } }
}

// Real GLM call (system+user split, max reasoning). Returns parsed JSON or null.
async function callJson(system, user, maxTokens = 6000) {
  if (!AI_KEY) throw new Error("AI_API_KEY is not set in your .env file.");
  const client = new OpenAI({
    baseURL: AI_BASE, apiKey: AI_KEY,
    defaultHeaders: AI_BASE.includes("openrouter") ? { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" } : {},
  });
  const r = await client.chat.completions.create({
    model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.15, max_tokens: maxTokens, reasoning: { effort: "high" },
  });
  const msg = r.choices?.[0]?.message;
  return parseJson(msg?.content ?? msg?.reasoning ?? "");
}

// Assemble a focused dossier: ONLY the records tied to this lead, falling back to
// the rep's summary rows so the investigator always has context.
function buildDossier(lead) {
  const ev = listEvidence(lead.actor_id);
  const urls = new Set((lead.evidence_urls ?? []).filter(Boolean));
  let rows = ev.filter((e) => urls.has(e.url));
  if (!rows.length) rows = ev.filter((e) => ["parliament_ls", "eci_affidavit", "mca_company", "party_finance"].includes(e.source_type)).slice(0, 4);
  return rows.map((e) => `[${e.source_type}] ${e.title}\n${String(e.content ?? "").slice(0, 2500)}`).join("\n\n---\n\n");
}

// C4 (L2-only, top-lead-only): enrich the dossier with the pay-per-call / rate-
// limited sources we deliberately keep OUT of the population loop — NSE bulk/block
// deals, the MCA director index, and (optional) OpenCorporates officers — for the
// actor and any named beneficiary. Injectable so tests never hit the network.
async function externalContext(lead, {
  deals = searchDeals, directors = lookupDirectorCompanies, officers = searchOfficers,
} = {}) {
  const names = [lead.actor_name, ...String(lead.beneficiary ?? "").split(/[;,/]/)]
    .map((s) => String(s ?? "").trim()).filter((s) => s.length >= 4);
  const seen = new Set(); const uniq = names.filter((n) => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);

  const blocks = [];
  for (const name of uniq) {
    let d = [], dir = [], off = [];
    try { d = await deals(name); } catch {}
    try { dir = directors(name); } catch {}
    try { off = await officers(name); } catch {}
    const lines = [];
    if (d.length) lines.push(`NSE bulk/block deals naming "${name}": ` + d.slice(0, 8).map((x) => `${x.symbol} ${x.type} ${x.quantity} (${x.date})`).join("; "));
    if (dir.length) lines.push(`MCA directorships for "${name}": ` + dir.slice(0, 10).map((x) => `${x.company_name} [${x.designation}${x.active ? ", active" : ", ceased"}]`).join("; "));
    if (off.length) lines.push(`OpenCorporates officer roles for "${name}": ` + off.slice(0, 8).map((x) => `${x.company_name} (${x.position})`).join("; "));
    if (lines.length) blocks.push(`— ${name} —\n` + lines.join("\n"));
  }
  return blocks.length ? `EXTERNAL REGISTRY / MARKET LOOKUPS (verify identity — name match only):\n${blocks.join("\n\n")}` : "";
}

const L2_SYSTEM = `You are a meticulous, SKEPTICAL conflict-of-interest investigator for a public-record platform on Indian politics. You are handed ONE candidate lead — a coincidence a code detector flagged — plus the underlying records. Decide whether the public record actually supports a conflict of interest. You MUST be willing to DISMISS: most flagged coincidences are innocent.

RULES
- Reason ONLY from the records provided. Never invent facts, dates, companies, or amounts.
- A sector overlap ALONE is not a conflict — many people hold shares and MPs question many sectors. Look for a MECHANISM: does the office actually affect the specific beneficiary? Is there timing, magnitude, or specificity that makes innocent coincidence unlikely?
- "Declared and legal" is not "improper". Holding a disclosed company is legal; the question is misuse of office.
- Never assert guilt. This is an assessment for a human reviewer and a second (defence) reviewer.

Respond with ONLY this JSON:
{"mechanism":"how the alleged benefit would actually work, or 'none evident'","evidence_for":["..."],"evidence_against":["..."],"timeline":"any dated sequence, or 'not established'","verdict":"SUBSTANTIATED|SUGGESTIVE|COINCIDENCE","confidence":0,"confirming_record":"the single record that would confirm or kill this","summary":"one neutral sentence"}
SUBSTANTIATED = records show a concrete mechanism + specificity/timing. SUGGESTIVE = a real overlap worth a human look but no proven mechanism. COINCIDENCE = generic overlap explainable innocently.`;

const L3_SYSTEM = `You are the DEFENCE COUNSEL for the person named in a conflict-of-interest allegation an investigator thought worth pursuing. Your only job: give the most reasonable INNOCENT explanation from the records, and judge whether the allegation is FULLY explained away by ordinary, lawful conduct. Be honest — if it genuinely cannot be fully explained, say so.

Respond with ONLY this JSON:
{"innocent_explanation":"...","fully_explainable":true,"why":"one sentence"}
"fully_explainable": true ONLY if an ordinary, lawful account fully accounts for the facts with nothing left suspicious.`;

// `ask` is injectable so the verdict→status logic is unit-testable without GLM.
export async function investigateLead(lead, { ask = callJson, external = externalContext } = {}) {
  const dossier = buildDossier(lead);
  // Top-lead-only external enrichment (NSE deals, MCA directors, OpenCorporates).
  let extra = "";
  try { extra = await external(lead); } catch { extra = ""; }

  const l2user = `CANDIDATE LEAD
Vector: ${lead.vector}
Person: ${lead.actor_name}
Instrument of office: ${lead.instrument}
Beneficiary: ${lead.beneficiary}
Detector note: ${lead.detail}

UNDERLYING RECORDS:
${dossier || "(no additional records available)"}
${extra ? `\n${extra}\n` : ""}
Assess it.`;

  const l2 = await ask(L2_SYSTEM, l2user, 6000);
  let verdict = String(l2?.verdict ?? "COINCIDENCE").toUpperCase();
  if (!["SUBSTANTIATED", "SUGGESTIVE", "COINCIDENCE"].includes(verdict)) verdict = "COINCIDENCE";

  // L3 referee — only worth running if L2 didn't already dismiss it.
  let referee = null;
  if (verdict !== "COINCIDENCE") {
    const l3user = `ALLEGATION
${lead.headline}
Investigator's reasoning: ${l2?.summary ?? ""}
Evidence cited for concern: ${(l2?.evidence_for ?? []).join("; ")}

RECORDS:
${dossier || "(none)"}

Give the innocent explanation and judge whether it is fully explainable.`;
    referee = await ask(L3_SYSTEM, l3user, 3000);
    if (referee?.fully_explainable === true) verdict = "COINCIDENCE";
  }

  const investigation = {
    verdict,
    confidence: typeof l2?.confidence === "number" ? l2.confidence : null,
    mechanism: l2?.mechanism ?? "",
    evidence_for: Array.isArray(l2?.evidence_for) ? l2.evidence_for : [],
    evidence_against: Array.isArray(l2?.evidence_against) ? l2.evidence_against : [],
    timeline: l2?.timeline ?? "",
    confirming_record: l2?.confirming_record ?? "",
    summary: l2?.summary ?? "",
    referee,
    investigated_at: new Date().toISOString(),
    model: MODEL,
  };

  // Spread lead FIRST so the AI's `investigation` can never overwrite the
  // deterministic detector fields (vector, signal_score, headline, …).
  return upsertLead({ ...lead, status: verdict === "COINCIDENCE" ? "dismissed" : "proposed", investigation });
}
