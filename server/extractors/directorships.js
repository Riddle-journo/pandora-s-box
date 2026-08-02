// Directorship extractor (Phase 2). Turns the directorship triples mined by the
// pure core (server/directorship-extract.js) into persisted graph edges: a company
// ENTITY per named firm, and a RELATIONSHIP edge politician → company carrying the
// role, confidence, and evidence provenance.
//
// WHY A SELF-CONTAINED RUNNER (not the extract.js framework): the framework binds
// exactly ONE extractor per source_type, but directorships are CROSS-SOURCE — the
// same "X is a director of Y Ltd" prose shows up in ICIJ leaks, ED/CBI press
// releases, court judgments, and news, and `indian_kanoon` already owns a framework
// extractor. So this module runs its own idempotent pass over the content-bearing
// evidence of several source types and writes to the SAME stores the framework uses
// (entities + relationships), keeping the data model consistent while side-stepping
// the one-per-type limitation.
//
// CONSERVATIVE BY DESIGN: an edge is only created when the directorship is
// attributable to THE POLITICIAN — either the extracted person IS the subject, or
// the subject is named within the pairing window. A bare lead ("someone is a
// director of Y Ltd", party unclear) is deliberately dropped rather than fabricate
// a politician↔company link. Phase 3 will verify each surviving company against the
// free MCA Company Master registry (status/CIN/struck-off).
import { db, listPoliticians } from "../store/store.js";
import { ensureCompanyEntity, resolveEntityIdForPolitician, attachStrongIds } from "../entities/entities.js";
import { upsertRelationship } from "../entities/relations.js";
import { extractDirectorships } from "./directorship-extract.js";

export const DIRECTORSHIP_VERSION = "directorship-v1";

// Evidence source_types whose `content` is prose that names directors/promoters.
// (CAG/SEBI are excluded: CAG report titles carry no individuals, SEBI is WAF-dark.)
export const DIRECTORSHIP_SOURCES = ["icij_leaks", "press_releases", "indian_kanoon", "news", "news_intl"];

const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// Canonical relationship type for an extracted role string. Distinct rel_types
// (not one "linked_to") so a downstream detector can weight a Beneficial Owner /
// Promoter link differently from a plain directorship.
export function roleToRelType(role) {
  const r = String(role ?? "").toLowerCase();
  if (/beneficial owner/.test(r)) return "beneficial_owner_of";
  if (/shareholder/.test(r)) return "shareholder_of";
  if (/promoter/.test(r)) return "promoter_of";
  if (/designated partner|partner/.test(r)) return "partner_of";
  if (/proprietor/.test(r)) return "proprietor_of";
  if (/chairman|chairperson/.test(r)) return "chairman_of";
  if (/director/.test(r)) return "director_of";
  if (/officer/.test(r)) return "officer_of";
  return "linked_to";
}

// Pure filter: content + subject → the subject-attributable directorship triples
// worth persisting. Keeps only triples tied to the politician and above the floor.
export function subjectDirectorships(content, { subjectName, minConfidence = 0.6 } = {}) {
  return extractDirectorships(content, { subjectName })
    .filter((t) => t.person_is_subject || t.subject_nearby)
    .filter((t) => t.confidence >= minConfidence);
}

// Batch pass over the content-bearing evidence of DIRECTORSHIP_SOURCES. For each
// subject-attributable directorship: resolve/create the company entity, then upsert
// the politician→company edge. Idempotent (upsertRelationship's unique index +
// stable version). `limit` bounds trial runs. Wrapped in one transaction.
export function runDirectorshipExtraction({ limit = null, minConfidence = 0.6 } = {}) {
  const nameById = new Map(listPoliticians().map((p) => [p.id, p.name]));
  const lim = limit != null && Number.isFinite(Number(limit)) ? ` LIMIT ${Number(limit)}` : "";
  const placeholders = DIRECTORSHIP_SOURCES.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, politician_id, data FROM evidence WHERE json_extract(data,'$.source_type') IN (${placeholders})${lim}`
  ).all(...DIRECTORSHIP_SOURCES);

  const total = { evidence: 0, edges: 0, companies: 0, dins: 0, skipped: 0 };
  const companySeen = new Set();
  const run = db.transaction((rows) => {
    for (const raw of rows) {
      total.evidence++;
      const d = safeJson(raw.data);
      const subjectName = nameById.get(raw.politician_id);
      const subjectEntityId = subjectName ? resolveEntityIdForPolitician(raw.politician_id) : null;
      if (!subjectName || !subjectEntityId) { total.skipped++; continue; }

      for (const t of subjectDirectorships(d.content, { subjectName, minConfidence })) {
        const companyEntityId = ensureCompanyEntity({ name: t.company, source: "directorship" });
        if (!companySeen.has(companyEntityId)) { companySeen.add(companyEntityId); total.companies++; }
        // Plan A1: a DIN labelled next to the politician's OWN directorship (person is
        // confidently the subject) is that politician's DIN — fold it onto the person
        // entity so the Tofler director-matcher can match DIN-certain. Only when
        // person_is_subject (not merely subject_nearby) — a nearby DIN could be a
        // co-director's.
        if (t.din && t.person_is_subject && attachStrongIds(subjectEntityId, { din: t.din })) total.dins++;

        const r = upsertRelationship({
          src_entity_id: subjectEntityId,
          dst_entity_id: companyEntityId,
          rel_type: roleToRelType(t.role),
          confidence: t.confidence,
          evidence_id: raw.id,
          source: d.source_type,
          detector_version: DIRECTORSHIP_VERSION,
          data: {
            role: t.role, person: t.person, person_is_subject: t.person_is_subject,
            company_text: t.company, company_norm: t.company_norm, snippet: t.snippet,
            din: t.din ?? null,
          },
        });
        if (r.inserted) total.edges++;
      }
    }
  });
  run(rows);
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/directorships.js");
if (invokedDirectly) {
  console.log("[directorships] extraction done:", JSON.stringify(runDirectorshipExtraction()));
  process.exit(0);
}
