// Prose LLM extractors — the deferred "needs a model" sources: news, fact-check,
// CBI press, and Wikipedia. Unlike the deterministic extractors, these turn free
// text into structured ledger rows with a language model. Two hard rules:
//
//   1. FREE CHAIN ONLY (server/free-chain.js). No paid model ever runs here — the
//      chain degrades to null when every free key is exhausted, and we simply skip.
//   2. MATERIALITY over volume. A news item that merely mentions India, or a
//      fact-check listing, is NOT an accountability finding. The prompt extracts
//      ONLY consequential, sourced items where the politician is the actor:
//      a concrete promise, an allegation with specifics, an official action, an
//      asset/appointment — and returns [] rather than padding with trivia.
//
// Every extracted item is a CLAIM (status unverified, model-sourced confidence),
// never a fact and never a public accusation — same guardrail as the raw-match
// extractors. Wikipedia yields low-risk biographical FACTS (birth year, term
// counts) which are safe as facts.
//
// The framework's runExtraction is synchronous, so these DON'T register through it
// (extract() there must be sync). Instead each exposes an async runner that pulls
// its evidence, calls the model, and writes through the same ledger writers. This
// keeps the LLM latency/rate-limit handling out of the deterministic pipeline.
import "dotenv/config";
import { db } from "../store/store.js";
import { resolveEntityIdForPolitician, getEntity } from "../entities/entities.js";
import { upsertClaim, upsertFact } from "../store/ledger.js";
import { upsertEvent } from "../entities/relations.js";
import { freeJson } from "../synthesis/free-chain.js";
import { getPolitician } from "../store/store.js";

export const PROSE_LLM_VERSION = "prose-llm-v1";
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// ── Per-source model contracts ───────────────────────────────────────────────
// Each returns { system, user } and a mapper turning the model's JSON into ledger
// records. The mapper is pure + exported so tests drive it without a model call.

const NEWS_SYSTEM = `You extract ACCOUNTABILITY claims about ONE Indian politician from a news excerpt.
Return STRICT JSON: {"claims":[{"type","text","stance","date"}]}.
type ∈ promise|allegation|action|statement|asset|appointment.
Only include items where THIS politician is the actor and a serious voter would care:
a concrete promise (with a number/deadline), an allegation with specifics, an official
decision/action, a declared asset/appointment. IGNORE: viral images, photo-ops, travel,
routine remarks, items about other people, and anything debunked as a hoax.
"text" ≤ 240 chars, factual, no adjectives. "date" ISO or null. If nothing material, {"claims":[]}.`;

export function mapNewsClaims(model) {
  const items = Array.isArray(model?.claims) ? model.claims : [];
  const out = [];
  for (const c of items) {
    const text = String(c?.text ?? "").trim();
    if (!text || text.length < 8) continue;
    const type = String(c?.type ?? "statement").toLowerCase();
    out.push({
      claim_type: `news_${["promise", "allegation", "action", "statement", "asset", "appointment"].includes(type) ? type : "statement"}`,
      object_text: text.slice(0, 240),
      as_of_date: /^\d{4}-\d{2}-\d{2}$/.test(String(c?.date ?? "")) ? c.date : null,
      status: "unverified",
      confidence: type === "allegation" ? 0.3 : 0.4,
      data: { stance: c?.stance ?? null, extracted_by: "free-chain", note: "Model-extracted from a news excerpt — verify against the source." },
    });
  }
  return out.slice(0, 6);
}

const FACTCHECK_SYSTEM = `You read a list of fact-check article titles about ONE Indian politician.
Return STRICT JSON: {"items":[{"claim","verdict","publisher","date"}]}.
For each fact-check, summarise the CLAIM that was checked (≤200 chars) and its verdict
(true|false|misleading|unverified) if the title makes it clear, else "unclear".
Skip generic "weekly wrap" roundups that name no specific claim. If none, {"items":[]}.`;

export function mapFactcheckClaims(model) {
  const items = Array.isArray(model?.items) ? model.items : [];
  const out = [];
  for (const it of items) {
    const claim = String(it?.claim ?? "").trim();
    if (!claim || claim.length < 8) continue;
    out.push({
      claim_type: "fact_checked_claim",
      object_text: claim.slice(0, 200),
      as_of_date: /^\d{4}-\d{2}-\d{2}$/.test(String(it?.date ?? "")) ? it.date : null,
      status: ["true", "false", "misleading"].includes(String(it?.verdict).toLowerCase()) ? "verified" : "unverified",
      confidence: 0.35,
      data: { verdict: it?.verdict ?? "unclear", publisher: it?.publisher ?? null, note: "Fact-check reference — read the article for the full verdict." },
    });
  }
  return out.slice(0, 8);
}

const CBI_SYSTEM = `You read a Central Bureau of Investigation press listing that MENTIONS a name.
Return STRICT JSON: {"actions":[{"text","date"}]}.
Only include lines describing an actual CBI action (case registered, chargesheet, arrest,
conviction, raid) that plausibly involves THIS person — NOT generic conference/notice items.
Most listings are namesake noise: if nothing clearly involves them, {"actions":[]}.`;

export function mapCbiClaims(model) {
  const items = Array.isArray(model?.actions) ? model.actions : [];
  return items.map((a) => {
    const text = String(a?.text ?? "").trim();
    if (!text || text.length < 8) return null;
    return {
      claim_type: "named_in_cbi_action",
      object_text: text.slice(0, 220),
      as_of_date: /^\d{4}-\d{2}-\d{2}$/.test(String(a?.date ?? "")) ? a.date : null,
      status: "unverified",
      confidence: 0.25,
      data: { note: "CBI listing name match — identity unverified, verify before use." },
    };
  }).filter(Boolean).slice(0, 5);
}

const WIKI_SYSTEM = `You read the Wikipedia biography of an Indian politician.
Return STRICT JSON: {"birth_year":<int|null>,"terms":<int|null>,"positions":[<string>],"education":<string|null>}.
"terms" = number of times elected to a legislature if stated, else null.
"positions" = up to 6 notable offices held (short titles). Only facts stated in the text.`;

export function mapWikiFacts(model) {
  const facts = [];
  // Guard null/undefined explicitly: Number(null) === 0 would sneak a spurious
  // birth_year/terms=0 past the range checks.
  if (model?.birth_year != null) {
    const by = Number(model.birth_year);
    if (Number.isInteger(by) && by > 1900 && by < 2025) facts.push({ metric: "birth_year", value: by, unit: "year", as_of_date: null, data: {} });
  }
  if (model?.terms != null) {
    const terms = Number(model.terms);
    if (Number.isInteger(terms) && terms > 0 && terms < 30) facts.push({ metric: "legislative_terms", value: terms, unit: "count", as_of_date: null, data: {} });
  }
  return facts;
}

const SOURCES = {
  news: { system: NEWS_SYSTEM, map: mapNewsClaims, kind: "claims", maxTokens: 900, event: "news_claim" },
  fact_check: { system: FACTCHECK_SYSTEM, map: mapFactcheckClaims, kind: "claims", maxTokens: 900 },
  cbi_press: { system: CBI_SYSTEM, map: mapCbiClaims, kind: "claims", maxTokens: 700 },
  wikipedia: { system: WIKI_SYSTEM, map: mapWikiFacts, kind: "facts", maxTokens: 500 },
};

// Digit-guard: the model must not invent numbers absent from the source excerpt.
// (Mirrors the Summarizer's free-chain digit-guard.) Drops any claim whose text
// contains a multi-digit number not present in the source content.
function digitGuardOk(text, source) {
  const nums = String(text).match(/\d{3,}/g) || [];
  const src = String(source);
  return nums.every((n) => src.includes(n));
}

// Run one prose extractor over its evidence. limit caps rows (sample runs); when
// limit is null it processes ALL rows with content (the bulk Ops job). Writes are
// idempotent through the ledger writers. Returns counts + a small sample for logs.
export async function runProseExtractor(sourceType, { limit = null, log = () => {} } = {}) {
  const def = SOURCES[sourceType];
  if (!def) throw new Error(`prose-llm: no extractor for ${sourceType}`);
  const lim = limit != null ? ` LIMIT ${Number(limit)}` : "";
  const rows = db.prepare(
    `SELECT id, politician_id, data FROM evidence WHERE json_extract(data,'$.source_type') = ? AND has_content = 1${lim}`
  ).all(sourceType);

  const out = { source_type: sourceType, evidence: 0, written: 0, skipped_empty: 0, model_null: 0, sample: [] };
  for (const raw of rows) {
    out.evidence++;
    const d = safeJson(raw.data);
    const content = String(d.content ?? "").slice(0, 6000);
    if (content.length < 40) { out.skipped_empty++; continue; }
    const entity_id = resolveEntityIdForPolitician(raw.politician_id);
    if (!entity_id) { out.skipped_empty++; continue; }
    const subject_kind = getEntity(entity_id)?.kind ?? "person";
    const name = getPolitician(raw.politician_id)?.name ?? "the politician";

    let model;
    try {
      const res = await freeJson({ system: def.system, user: `Politician: ${name}\n\nSOURCE:\n${content}`, maxTokens: def.maxTokens, temperature: 0.2, tag: `prose:${sourceType}` });
      if (!res) { out.model_null++; continue; }
      model = res.data;
    } catch (e) { out.model_null++; log(`  ${name}: ${e.message}`); continue; }

    const records = def.map(model).filter((r) => (def.kind === "facts") || digitGuardOk(r.object_text, content));
    for (const r of records) {
      if (def.kind === "facts") {
        const res = upsertFact({ ...r, entity_id, subject_kind, source_type: sourceType, tier: d.tier ?? null, evidence_id: raw.id, extractor_version: PROSE_LLM_VERSION });
        if (res.inserted) out.written++;
      } else {
        const res = upsertClaim({ ...r, subject_entity_id: entity_id, subject_kind, source_type: sourceType, tier: d.tier ?? null, evidence_id: raw.id, extractor_version: PROSE_LLM_VERSION });
        if (res.inserted) { out.written++; if (def.event && r.as_of_date) upsertEvent({ kind: def.event, at: r.as_of_date, entity_ids: [entity_id], evidence_id: raw.id, source: sourceType, data: { text: r.object_text, extractor_version: PROSE_LLM_VERSION } }); }
      }
    }
    if (out.sample.length < 3 && records.length) out.sample.push({ name, first: records[0].object_text ?? records[0].metric });
  }
  return out;
}

export const PROSE_SOURCE_TYPES = Object.keys(SOURCES);

// Bulk runner over every prose source (the Ops "extract_prose" job). Sample runs
// pass a small limit; the full backfill passes limit=null.
export async function runAllProseExtractors({ limit = null, log = console.log } = {}) {
  const results = [];
  for (const st of PROSE_SOURCE_TYPES) {
    log(`[prose-llm] ${st}${limit ? ` (limit ${limit})` : ""}…`);
    const r = await runProseExtractor(st, { limit, log });
    log(`[prose-llm]   ${st}: ${r.written} written over ${r.evidence} row(s) (${r.model_null} model-null, ${r.skipped_empty} skipped)`);
    results.push(r);
  }
  return results;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/prose-llm.js");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const limIdx = args.indexOf("--limit");
  const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : 5; // default: small sample
  const only = args.find((a) => PROSE_SOURCE_TYPES.includes(a));
  (async () => {
    if (only) { const r = await runProseExtractor(only, { limit }); console.log(JSON.stringify(r, null, 2)); }
    else { const r = await runAllProseExtractors({ limit }); console.log("[prose-llm] done:", JSON.stringify(r.map(({ source_type, written, evidence, model_null }) => ({ source_type, written, evidence, model_null })))); }
    process.exit(0);
  })();
}
