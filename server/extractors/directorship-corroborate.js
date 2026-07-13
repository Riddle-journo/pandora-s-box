// Directorship corroboration (Phase 3 / Plan A2). The confidence ladder for
// politician↔company directorship links, built from TWO independent, complementary
// sources:
//   • extraction  — a director_of-family edge mined from evidence TEXT (press/court/
//                    leak) by server/extractors/directorships.js.
//   • Tofler      — a DIRECTOR_LINK lead (server/director-link.js) proving the
//                    politician (or a relative) sits on a company's REGISTERED board.
// When BOTH point at the same company, the link is corroborated across an informal
// narrative source AND the authoritative registry — the strongest for-free signal —
// so we raise the extraction edge's confidence to the top tier and stamp how the two
// agreed (by CIN, the reliable key, or by normalized name). Links only one source
// has are left at their existing (lower) confidence: extraction-only = "informal/
// unregistered", Tofler-only stays a private lead.
//
// Read-only w.r.t. Tofler's leads (they are private journalist work-product); this
// only annotates the extraction edges. `leads` is injectable for offline tests.
import { listPoliticians, listLeads } from "../store.js";
import { resolveEntityIdForPolitician, getEntity } from "../entities.js";
import { relationsOf, updateRelationship } from "../relations.js";
import { normalizeCompany } from "../directorship-extract.js";
import { isCin } from "../fetchers/tofler.js";

export const CORROBORATION_VERSION = "directorship-corroborate-v1";
export const CORROBORATED_CONFIDENCE = 0.95; // top tier: two independent sources agree

const DIRECTORSHIP_REL_TYPES = new Set([
  "director_of", "promoter_of", "beneficial_owner_of", "partner_of",
  "proprietor_of", "chairman_of", "officer_of", "shareholder_of",
]);

const cinOf = (v) => (v && isCin(v) ? String(v).toUpperCase() : null);

// Corroborate one politician's extraction edges against their Tofler DIRECTOR_LINK
// leads. Returns { edges, corroborated }. Mutates matching edges in place.
export function corroborateDirectorshipsForPolitician(p, { leads } = {}) {
  const eid = resolveEntityIdForPolitician(p.id);
  if (!eid) return { edges: 0, corroborated: 0 };

  const edges = relationsOf(eid).filter((e) => DIRECTORSHIP_REL_TYPES.has(e.rel_type));
  if (!edges.length) return { edges: 0, corroborated: 0 };

  // Tofler DIRECTOR_LINK leads for THIS politician, indexed by CIN and by norm-name.
  const myLeads = (leads ?? listLeads()).filter((l) => l?.vector === "DIRECTOR_LINK" && l?.actor_id === p.id);
  const leadByCin = new Map();
  const leadByName = new Map();
  for (const l of myLeads) {
    const c = cinOf(l.beneficiary_cin);
    if (c) leadByCin.set(c, l);
    const n = normalizeCompany(l.beneficiary);
    if (n) leadByName.set(n, l);
  }
  if (!leadByCin.size && !leadByName.size) return { edges: edges.length, corroborated: 0 };

  let corroborated = 0;
  for (const e of edges) {
    const companyId = e.src_entity_id === eid ? e.dst_entity_id : e.src_entity_id;
    const ent = getEntity(companyId);
    if (!ent) continue;
    const cin = cinOf(ent.strong_ids?.cin);
    const nameNorm = e.data?.company_norm || normalizeCompany(ent.canonical_name);

    // Prefer a CIN match (identity-certain); fall back to normalized-name match.
    let lead = cin ? leadByCin.get(cin) : null;
    const basis = lead ? "cin" : (leadByName.has(nameNorm) ? "name" : null);
    if (!lead && basis === "name") lead = leadByName.get(nameNorm);
    if (!lead) continue;

    updateRelationship(e.id, {
      confidence: CORROBORATED_CONFIDENCE,
      data: {
        corroborated: true,
        corroborated_by: "tofler",
        corroboration_basis: basis,
        corroboration_match_kind: lead.match_kind ?? null, // din | self_name | relative_name
        corroboration_din: lead.director_din ?? null,
        corroboration_version: CORROBORATION_VERSION,
      },
    });
    corroborated++;
  }
  return { edges: edges.length, corroborated };
}

// Batch across the roster. Loads all leads once. Returns aggregate counts.
export function runDirectorshipCorroboration({ leads } = {}) {
  const all = leads ?? listLeads();
  const total = { politicians: 0, edges: 0, corroborated: 0 };
  for (const p of listPoliticians()) {
    const r = corroborateDirectorshipsForPolitician(p, { leads: all });
    total.politicians++; total.edges += r.edges; total.corroborated += r.corroborated;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/directorship-corroborate.js");
if (invokedDirectly) {
  console.log("[directorship-corroborate] done:", JSON.stringify(runDirectorshipCorroboration()));
  process.exit(0);
}
