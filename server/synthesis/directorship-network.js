// Directorship network view (Phase 6 / Plans C1 + C2). Reads the directorship edges
// the earlier phases built and assembles, for one politician, the company web around
// them: the companies they hold a seat in, and the OTHER directors on those boards
// (co-directors + relatives) that the crossfeed surfaced.
//
// ADMIN-ONLY by deliberate choice: these edges include Tofler-derived, DIN/name-matched
// links that are private journalist work-product (see server/index.js requireAdmin, the
// investigation-leads boundary), so this is exposed only behind an admin route, never in
// the public report. The `*ForGraph` adapter shapes the data to the EXISTING family-graph
// renderer's { relatives, links } contract (public/app.js renderRelationGraph) so the
// admin UI reuses that visualization unchanged.
import { resolveEntityIdForPolitician, getEntity } from "../entities/entities.js";
import { relationsOf } from "../entities/relations.js";

const DIRECTORSHIP_REL_TYPES = new Set([
  "director_of", "promoter_of", "beneficial_owner_of", "partner_of",
  "proprietor_of", "chairman_of", "officer_of", "shareholder_of",
]);
const ROLE_LABEL = {
  director_of: "director", promoter_of: "promoter", beneficial_owner_of: "beneficial owner",
  partner_of: "partner", proprietor_of: "proprietor", chairman_of: "chairman",
  officer_of: "officer", shareholder_of: "shareholder",
};

// The politician's directorship web: { center, companies[], codirectors[] }.
export function buildDirectorshipNetwork(politicianId) {
  const eid = resolveEntityIdForPolitician(politicianId);
  if (!eid) return { center: null, companies: [], codirectors: [] };
  const center = getEntity(eid);

  const myEdges = relationsOf(eid).filter((e) => DIRECTORSHIP_REL_TYPES.has(e.rel_type) && e.src_entity_id === eid);
  const companies = [];
  const codirectors = [];
  const seenCo = new Set();
  const seenCd = new Set();

  for (const e of myEdges) {
    const coId = e.dst_entity_id;
    if (seenCo.has(coId)) continue;
    const co = getEntity(coId);
    if (!co || co.kind !== "company") continue;
    seenCo.add(coId);

    const mine = myEdges.filter((x) => x.dst_entity_id === coId);
    const best = mine.reduce((a, b) => ((b.confidence ?? 0) > (a?.confidence ?? -1) ? b : a), null);
    companies.push({
      entity_id: coId, name: co.canonical_name, cin: co.strong_ids?.cin ?? null,
      roles: [...new Set(mine.map((x) => ROLE_LABEL[x.rel_type] ?? x.rel_type))],
      confidence: best?.confidence ?? null,
      corroborated: !!best?.data?.corroborated,
      sources: [...new Set(mine.map((x) => x.source).filter(Boolean))],
    });

    // Other directors on the SAME board (the crossfeed's co-director/relative discovery).
    for (const ce of relationsOf(coId).filter((x) => DIRECTORSHIP_REL_TYPES.has(x.rel_type))) {
      const otherId = ce.src_entity_id === coId ? ce.dst_entity_id : ce.src_entity_id;
      if (otherId === eid || seenCd.has(otherId + "|" + coId)) continue;
      const other = getEntity(otherId);
      if (!other || other.kind !== "person") continue;
      seenCd.add(otherId + "|" + coId);
      codirectors.push({
        entity_id: otherId, name: other.canonical_name,
        politician_id: other.strong_ids?.politician_id ?? null,
        via_company: co.canonical_name, role: ROLE_LABEL[ce.rel_type] ?? ce.rel_type,
        is_relative: !!ce.data?.is_relative,
      });
    }
  }
  return { center: center ? { entity_id: eid, name: center.canonical_name } : null, companies, codirectors };
}

// Adapt to renderRelationGraph's { relatives, links } so the admin UI reuses the family
// graph visualization: companies → "relatives"-style nodes (name + role, ✓ if
// corroborated); tracked-politician co-directors → clickable "links".
export function directorshipNetworkForGraph(politicianId) {
  const net = buildDirectorshipNetwork(politicianId);
  const relatives = net.companies.map((c) => ({
    name: c.name,
    relation: c.roles.join(", ") + (c.corroborated ? " ✓ corroborated" : ""),
  }));
  const links = [];
  const seen = new Set();
  for (const cd of net.codirectors) {
    if (seen.has(cd.entity_id)) continue;
    seen.add(cd.entity_id);
    links.push({
      type: cd.is_relative ? "DYNASTY" : "CODIRECTOR",
      target_name: cd.name,
      target_kind: cd.politician_id ? "politician" : "person",
      target_id: cd.politician_id ?? null,
      note: `${cd.is_relative ? "Relative" : "Co-director"} on ${cd.via_company}`,
    });
  }
  return { center: net.center?.name ?? null, relatives, links, companies: net.companies, codirectors: net.codirectors };
}
