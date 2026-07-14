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
import { AI_BASE, MODEL, AI_KEY, makeClient, callWithRetry } from "./llm.js";
import { db, listEvidence, upsertLead, addEvidence } from "./store.js";
import { searchDeals } from "./fetchers/nse-deals.js";
import { lookupDirectorCompaniesByName as lookupDirectorCompanies } from "./store.js";
import { searchOfficers } from "./fetchers/opencorporates.js";
import { fetchIndianKanoon } from "./fetchers/indian-kanoon.js";
import { fetchCompanyRegistry } from "./fetchers/company-registry.js";
import { resolveSettings } from "./engine-settings.js";
import { ENGINE_GROUPS } from "./engine-groups.js";

// ---- Budgets — DB-tunable from the ops console (engine.investigator.*), with
// the historical constants as defaults so behaviour is unchanged out of the box.
// Resolved per-investigation so a tuning change applies to the very next lead.
const investigatorSettings = () =>
  resolveSettings("investigator", ENGINE_GROUPS.find((g) => g.id === "investigator").tunables);
const TRUNC = 1200; // char cap on any tool summary/content fed back to L2

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
  const client = makeClient();
  // Transport retries + usage ledger in callWithRetry; askJson layers its own
  // lower-temperature retry for malformed JSON on top.
  const r = await callWithRetry(client, {
    model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature, max_tokens: maxTokens, reasoning: { effort: "high" },
  }, { module: "investigator", attempts: 2 });
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
  ["mca_directors", "opencorporates", "nse_deals", "indian_kanoon", "company_registry",
   "read_evidence", "related_flags", "entity_relations", "search_corpus"].map((k) => [k, {
    describe: `mock ${k}`,
    run: ({ name }) => ({ found: 1, summary: `mock ${k} result for "${name ?? ""}"`, url: `https://mock.local/${k}`, title: `mock ${k}`, content: `mock ${k} content` }),
  }])
);

// ---- Trail-following helpers (read the DB the engine already populated). These
// power the internal tools below so the investigator can walk the evidence trail
// a flag cited — pull the exact record, find sibling flags on the same subject,
// expand the entity's relationship graph, or full-text search the whole corpus —
// WITHOUT any network call. The engine's structured citations are the entry point.
function readEvidenceRow(evidenceId) {
  const row = db.prepare("SELECT data FROM evidence WHERE id = ? LIMIT 1").get(evidenceId);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}
function siblingFlags(politicianId, entityId) {
  const rows = politicianId
    ? db.prepare("SELECT data FROM flags WHERE politician_id = ? AND status = 'active' ORDER BY score DESC").all(politicianId)
    : entityId
      ? db.prepare("SELECT data FROM flags WHERE entity_id = ? AND status = 'active' ORDER BY score DESC").all(entityId)
      : [];
  return rows.map((r) => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}

// ---- Tool registry: each wraps an existing fetcher behind the SAME {name, extra?}
// shape and returns a compact summary object (summary/content truncated to TRUNC).
// The rate-limit/degrade-to-[] behaviour lives in the fetchers themselves. ----
export const TOOLS = {
  // Director lookup backed by the FREE Tofler cache (no MCA bulk dataset exists
  // freely). Tool key stays "mca_directors" for continuity; the data is Tofler.
  mca_directors: {
    describe: "look up company directorships (free Tofler director cache) by person name",
    run: ({ name }) => {
      const rows = lookupDirectorCompanies(name) || [];
      const summary = rows.length
        ? `Directorships for "${name}" (Tofler): ` + rows.slice(0, 10).map((x) => `${x.company_name}${x.cin ? ` [${x.cin}]` : ""}`).join("; ")
        : `No cached directorships found for "${name}".`;
      return { found: rows.length, summary: summary.slice(0, TRUNC), url: rows[0]?.source_url ?? "https://www.tofler.in/", title: `Directorships — ${name}`, content: summary.slice(0, TRUNC) };
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

  // ── Trail-following tools (internal, free — walk the engine's own citations) ──
  read_evidence: {
    describe: "read the FULL text of a specific cited record by its evidence id (from the flag's citations) — the source behind a number",
    run: ({ evidence_id }) => {
      const e = readEvidenceRow(evidence_id);
      if (!e) return { found: 0, summary: `No evidence row with id "${evidence_id}".` };
      const body = String(e.content ?? e.summary ?? "");
      return {
        found: 1,
        summary: `[${e.source_type}] ${e.title ?? ""}: ${body.slice(0, 400)}`.slice(0, TRUNC),
        url: e.url ?? "", title: e.title ?? `evidence ${evidence_id}`, content: body.slice(0, TRUNC),
      };
    },
  },
  related_flags: {
    describe: "list the OTHER anomaly flags the engine raised on this same subject — corroborating shapes across detectors (call with no args to use the lead's subject)",
    run: ({ actor_id }) => {
      const flags = siblingFlags(actor_id, null);
      if (!flags.length) return { found: 0, summary: "No other active flags on this subject." };
      const lines = flags.slice(0, 12).map((f) => `[${f.severity} · ${f.detector} · ${Math.round(f.score)}] ${f.headline}`);
      return { found: flags.length, summary: `${flags.length} flag(s) on this subject: ` + lines.join(" | ").slice(0, TRUNC), title: "related flags", content: lines.join("\n").slice(0, TRUNC) };
    },
  },
  entity_relations: {
    describe: "expand this person's relationship graph — directorships, family, ownership, donations the ledger records (follow the network from the subject)",
    run: async ({ actor_id }) => {
      try {
        const { findEntityByStrongId } = await import("./entities.js");
        const { relationsOf } = await import("./relations.js");
        const ent = findEntityByStrongId("person", { politician_id: actor_id });
        if (!ent) return { found: 0, summary: "No resolved entity for this subject yet." };
        const rels = relationsOf(ent.id, {});
        if (!rels.length) return { found: 0, summary: "No recorded relationships for this subject." };
        const lines = rels.slice(0, 15).map((r) => {
          const d = r.data ?? {};
          const other = d.company_name ?? d.name ?? (r.src_entity_id === ent.id ? r.dst_entity_id : r.src_entity_id);
          return `${r.rel_type} → ${other}${d.status ? ` [${d.status}]` : ""}`;
        });
        return { found: rels.length, summary: `${rels.length} relationship(s): ` + lines.join("; ").slice(0, TRUNC), title: "entity relations", content: lines.join("\n").slice(0, TRUNC) };
      } catch (err) { return { found: 0, summary: `relations unavailable: ${err.message}` }; }
    },
  },
  search_corpus: {
    describe: "full-text search ALL ingested records for a term (person, company, place) — find documents that co-mention two things across the whole corpus",
    run: ({ query, name }) => {
      const q = String(query ?? name ?? "").trim();
      if (q.length < 3) return { found: 0, summary: "search term too short." };
      try {
        // FTS5 MATCH; quote the term so multi-word/punctuated queries are literal.
        const rows = db.prepare(
          "SELECT evidence_id, source_type, title, snippet(evidence_fts, 4, '«', '»', '…', 12) snip FROM evidence_fts WHERE evidence_fts MATCH ? LIMIT 8"
        ).all(`"${q.replace(/"/g, '')}"`);
        if (!rows.length) return { found: 0, summary: `No records mention "${q}".` };
        const lines = rows.map((r) => `[${r.source_type}] ${r.title ?? ""}: …${r.snip}…`);
        return { found: rows.length, summary: `${rows.length} record(s) mention "${q}": ` + lines.join(" | ").slice(0, TRUNC), title: `corpus search — ${q}`, content: lines.join("\n").slice(0, TRUNC) };
      } catch (err) { return { found: 0, summary: `search unavailable (index may be unbuilt): ${err.message}` }; }
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

// The engine's structured citations, rendered for the prompt. A cluster lead
// carries data.flags[] (each with its own evidence[]); a single big flag carries
// data.evidence[]. Each line names WHY the engine flagged it and the evidence id
// the investigator can pull with read_evidence to see the source itself.
function buildCitations(lead) {
  const d = lead.data ?? {};
  const out = [];
  const renderEv = (evidence = [], indent = "  ") =>
    evidence.filter(Boolean).slice(0, 6).map((e) =>
      `${indent}- ${e.note ?? "source"}${e.title ? ` — "${e.title}"` : ""}${e.evidence_id ? ` (evidence_id: ${e.evidence_id})` : ""}${e.url ? ` <${e.url}>` : ""}`);
  if (Array.isArray(d.flags) && d.flags.length) {
    out.push(`This lead is a CLUSTER of ${d.flags.length} flags across ${(d.detectors ?? []).length || "several"} independent detectors:`);
    for (const f of d.flags.slice(0, 10)) {
      out.push(`• [${f.severity} · ${f.detector} · score ${Math.round(f.score)}] ${f.headline}`);
      if (f.rationale) out.push(`  reasoning: ${String(f.rationale).slice(0, 500)}`);
      out.push(...renderEv(f.evidence));
    }
  } else if (Array.isArray(d.evidence) && d.evidence.length) {
    out.push(`This lead's flag cited ${d.evidence.length} piece(s) of evidence:`);
    out.push(...renderEv(d.evidence, "- "));
  }
  return out.join("\n");
}

// Persist relationships the verdict explicitly names, as low-confidence,
// investigation-sourced edges — so every trail the investigator walks GROWS the
// graph the next engine run reads. Best-effort: never breaks the verdict.
async function recordDiscoveredRelations(lead, verdictObj) {
  const rels = Array.isArray(verdictObj?.discovered_relations) ? verdictObj.discovered_relations : [];
  if (!rels.length) return 0;
  try {
    const { ensureEntity, findEntityByStrongId } = await import("./entities.js");
    const { upsertRelationship } = await import("./relations.js");
    const self = findEntityByStrongId("person", { politician_id: lead.actor_id });
    if (!self) return 0;
    let n = 0;
    for (const r of rels.slice(0, 8)) {
      const otherName = String(r.entity ?? r.name ?? "").trim();
      const relType = String(r.rel_type ?? "linked_to").trim().toLowerCase().replace(/\s+/g, "_");
      if (otherName.length < 3 || !relType) continue;
      const otherId = ensureEntity({ kind: r.kind === "company" ? "company" : "person", name: otherName, source: "investigation" });
      upsertRelationship({
        src_entity_id: self.id, dst_entity_id: otherId, rel_type: relType,
        confidence: 0.3, source: "investigation", detector_version: "glm-investigator",
        data: { note: r.note ?? "named by the GLM investigator", from_lead: lead.key ?? lead.id },
      });
      n++;
    }
    return n;
  } catch { return 0; }
}

const L2_SYSTEM = `You are a meticulous, SKEPTICAL conflict-of-interest investigator for a public-record platform on Indian politics. You are handed ONE candidate lead — a coincidence a code detector flagged — plus the underlying records. Working like a real investigator, you may pull ADDITIONAL targeted records with tools before deciding. Decide whether the public record actually supports a conflict of interest. You MUST be willing to DISMISS: most flagged coincidences are innocent.

RULES
- Reason ONLY from the records provided or the tools return. Never invent facts, dates, companies, or amounts.
- A sector overlap ALONE is not a conflict — many people hold shares and MPs question many sectors. Look for a MECHANISM: does the office actually affect the specific beneficiary? Is there timing, magnitude, or specificity that makes innocent coincidence unlikely?
- "Declared and legal" is not "improper". Holding a disclosed company is legal; the question is misuse of office.
- Never assert guilt. This is an assessment for a human reviewer and a second (defence) reviewer.
- Prefer to VERIFY a hypothesis with a tool before you commit to a verdict, but do not fish endlessly — stop as soon as the record is clear enough to judge.

FOLLOW THE TRAIL. The lead comes with the engine's own CITATIONS — the exact records and the reasoning behind each flag. Start there: use read_evidence to open a cited record by its evidence_id and see the real source behind a number; use related_flags to see what OTHER anomalies the engine independently found on this same person (corroboration across detectors is a strong signal); use entity_relations to walk their directorship/family/ownership graph; use search_corpus to find documents that co-mention the person and a company/place across the WHOLE corpus. These internal tools are free and precise — prefer them to fish for the mechanism before spending a network tool. A single flag is weak; a person the engine flagged five different ways, whose relations lead to a struck-off company that appears in a court record, is a real trail.

When your verdict names concrete links you established (person ↔ company, person ↔ person), report them in discovered_relations so the platform's graph remembers them.

Each turn respond with ONLY ONE of these JSON objects (no prose outside the JSON):
  ACTION: {"action":{"tool":"<tool name>","args":{"name":"<person or company>","evidence_id":"<for read_evidence>","query":"<for search_corpus>"}},"reason":"why this record would move the assessment"}
  VERDICT: {"verdict":{"mechanism":"how the alleged benefit would actually work, or 'none evident'","evidence_for":["..."],"evidence_against":["..."],"timeline":"any dated sequence, or 'not established'","verdict":"SUBSTANTIATED|SUGGESTIVE|COINCIDENCE","confidence":0,"confirming_record":"the single record that would confirm or kill this","discovered_relations":[{"entity":"name","kind":"person|company","rel_type":"director_of|linked_to|...","note":"what established it"}],"summary":"one neutral sentence"}}
SUBSTANTIATED = records show a concrete mechanism + specificity/timing. SUGGESTIVE = a real overlap worth a human look but no proven mechanism. COINCIDENCE = generic overlap explainable innocently.`;

const L3_SYSTEM = `You are the DEFENCE COUNSEL for the person named in a conflict-of-interest allegation an investigator thought worth pursuing. Your only job: give the most reasonable INNOCENT explanation from the records, and judge whether the allegation is FULLY explained away by ordinary, lawful conduct. Be honest — if it genuinely cannot be fully explained, say so.

Respond with ONLY this JSON:
{"innocent_explanation":"...","fully_explainable":true,"why":"one sentence"}
"fully_explainable": true ONLY if an ordinary, lawful account fully accounts for the facts with nothing left suspicious.`;

const nowIso = () => new Date().toISOString();
const stepKey = (tool, args) => `${tool}|${JSON.stringify(args ?? {})}`;

// Build the L2 turn prompt from the lead facts, the engine's citations, and every
// prior step summary.
function buildL2Prompt(lead, dossier, citations, steps, forceVerdict) {
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

ENGINE CITATIONS (why this was flagged — your starting trail):
${citations || "(none — reason from the underlying records)"}

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
  const citations = buildCitations(lead);
  const S = investigatorSettings();
  const MAX_STEPS = S.maxSteps;
  const MAX_TOOL_CALLS = S.maxToolCalls;

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
    const resp = await askJson(ask, L2_SYSTEM, buildL2Prompt(lead, dossier, citations, state.steps, false));
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
    const resp = await askJson(ask, L2_SYSTEM, buildL2Prompt(lead, dossier, citations, state.steps, true));
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

  // Grow the graph from the trail: persist any concrete links the verdict named.
  if (S.recordRelations && verdict !== "COINCIDENCE") {
    try { state.relations_recorded = await recordDiscoveredRelations(lead, verdictObj); } catch { /* best-effort */ }
  }

  state.status = "done";
  state.verdict = verdict;
  state.discovered_relations = Array.isArray(verdictObj?.discovered_relations) ? verdictObj.discovered_relations : [];
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

  // Expanding discovery: a surviving investigation that uncovered a NEW suspicious
  // entity spawns a fresh lead for that entity — so investigation feeds discovery,
  // not just verdicts. Capped + tunable; each spawned lead cites the investigation
  // that produced it and enters the queue as a normal 'detected' lead.
  if (S.spawnFollowups && verdict !== "COINCIDENCE") {
    try { state.spawned = spawnFollowupLeads(lead, verdictObj, S.maxFollowups); }
    catch { /* best-effort; never breaks the verdict */ }
  }

  // Feedback signal: the GLM's own verdict is a (cheap, automatic) label on this
  // lead's detector — proposed vs dismissed feeds the precision report alongside
  // the human decisions. Best-effort; never breaks the verdict.
  try {
    const { recordLeadFeedback } = await import("./store.js");
    recordLeadFeedback(lead, verdict === "COINCIDENCE" ? "glm_dismissed" : "glm_proposed", { source: "glm" });
  } catch { /* logging must never break the loop */ }

  // Spread lead FIRST so the AI's `investigation` can never overwrite the
  // deterministic detector fields (vector, signal_score, headline, …).
  return upsertLead({ ...lead, status: verdict === "COINCIDENCE" ? "dismissed" : "proposed", investigation: state });
}

// Turn the verdict's discovered_relations into new candidate leads. Each names a
// concrete entity (a shell company, a co-director) the trail surfaced; the lead is
// keyed on that entity so re-investigation dedupes, and points back at the parent.
function spawnFollowupLeads(parent, verdictObj, cap) {
  const rels = Array.isArray(verdictObj?.discovered_relations) ? verdictObj.discovered_relations : [];
  const spawned = [];
  for (const r of rels.slice(0, Math.max(0, cap))) {
    const name = String(r.entity ?? r.name ?? "").trim();
    if (name.length < 3) continue;
    const kind = r.kind === "company" ? "company" : "person";
    const key = `TRAIL_DISCOVERY|${name.toUpperCase()}`;
    upsertLead({
      key,
      vector: "TRAIL_DISCOVERY",
      actor_id: null, actor_name: name,
      instrument: `surfaced while investigating ${parent.actor_name ?? parent.beneficiary ?? "a lead"}`,
      beneficiary: name, beneficiary_kind: kind,
      signal_score: 14,
      severity: "NOTABLE",
      status: "detected",
      headline: `${name} surfaced as a ${r.rel_type ?? "linked entity"} while investigating ${parent.actor_name ?? "a lead"} — worth its own look.`,
      detail: `The AI investigator, following the trail on "${parent.headline ?? parent.actor_name}", established a link to ${name} (${r.rel_type ?? "linked"}${r.note ? `: ${r.note}` : ""}). This is a NEW candidate the detectors did not raise — expanding discovery from an investigation. Verify the identity and check for a mechanism.`,
      evidence_urls: [],
      detector_version: "glm-investigator-followup",
      data: { spawned_from: parent.key ?? parent.id, parent_headline: parent.headline, relation: r },
    });
    spawned.push({ name, key, rel_type: r.rel_type });
  }
  return spawned;
}
