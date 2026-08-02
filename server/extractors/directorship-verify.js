// Directorship verification (Phase 3). Closes the loop opened by Phase 2: takes the
// company entities discovered from court/leak/press evidence (the politician→company
// directorship edges) and cross-checks each against the FREE MCA Company Master
// registry (data.gov.in). A confirmed company gets its CIN folded into the entity,
// and all confirmed companies for a politician are emitted as ONE `mca_company`
// evidence row.
//
// WHY emit an mca_company evidence row instead of touching report generation:
// server/analyzer.js already harvests companies from evidence rows of source_type
// "mca_company" (numbers.companies[]) and fires the deterministic
// STRUCK_OFF_COMPANY_LINK flag; cards.js and conflict.js read the same shape. So by
// speaking that existing vocabulary, directorship-discovered companies flow into the
// scorecard, the report card, and the struck-off flag with ZERO changes to report
// generation — the affidavit-declared path and this discovered path converge on one
// surface. Every such company is stamped discovered_via:"directorship_extraction" so
// its provenance stays distinct from affidavit-declared companies.
//
// The MCA lookup is INJECTABLE (verify) so this is unit-testable without network.
// Identity caveat carried through: a directorship mention is a lead; the registry
// check confirms the COMPANY exists and its status, not that this politician is truly
// its director — the confidence from Phase 2 rides along on the edge for weighting.
import { listPoliticians, listEvidence, addEvidence } from "../store/store.js";
import { resolveEntityIdForPolitician, getEntity, ensureCompanyEntity } from "../entities/entities.js";
import { relationsOf } from "../entities/relations.js";
import { verifyCompanyName } from "../fetchers/company-registry.js";

// The rel_types Phase 2 writes for a person→company directorship link.
const DIRECTORSHIP_REL_TYPES = new Set([
  "director_of", "promoter_of", "beneficial_owner_of", "partner_of",
  "proprietor_of", "chairman_of", "officer_of", "shareholder_of",
]);

// Verify one politician's directorship-linked companies. Returns counts; writes an
// mca_company evidence row (and folds CINs into the company entities) as a side
// effect when at least one company is confirmed. Idempotent: the evidence row has a
// stable id/url, and re-runs re-confirm the same set without duplicating.
export async function verifyDirectorshipCompanies(p, { verify = verifyCompanyName } = {}) {
  const eid = resolveEntityIdForPolitician(p.id);
  if (!eid) return { checked: 0, verified: 0, struck: 0 };

  const edges = relationsOf(eid).filter((e) => DIRECTORSHIP_REL_TYPES.has(e.rel_type));
  if (!edges.length) return { checked: 0, verified: 0, struck: 0 };

  // One representative edge per company (first-seen role wins for the label).
  const byCompany = new Map();
  for (const e of edges) {
    const cid = e.src_entity_id === eid ? e.dst_entity_id : e.src_entity_id;
    if (!byCompany.has(cid)) byCompany.set(cid, e);
  }

  const verified = [];
  for (const [cid, edge] of byCompany) {
    const ent = getEntity(cid);
    if (!ent || ent.kind !== "company") continue;
    const rec = await verify(ent.canonical_name);
    if (!rec) continue;
    // Fold the CIN into the company entity (strong id) so the graph gains identity,
    // and register the official MCA spelling (rec.name) as an alias — so a later
    // lookup by CIN OR by the official name (e.g. from the Tofler path) converges here.
    if (rec.cin) ensureCompanyEntity({ name: ent.canonical_name, names: [rec.name], cin: rec.cin, source: "directorship_verify" });
    verified.push({
      name: rec.name, cin: rec.cin, status: rec.status,
      paidup_capital: rec.paidup_capital ?? null,
      discovered_role: edge.data?.role ?? null,
      discovered_via: "directorship_extraction",
      discovered_source: edge.source ?? null,
      link_confidence: edge.confidence ?? null,
      source_url: rec.source_url,
    });
  }
  if (!verified.length) return { checked: byCompany.size, verified: 0, struck: 0 };

  const struck = verified.filter((v) => /struck off|strike off|dormant/i.test(v.status || ""));
  addEvidence([{
    id: `dirverify:${p.id}`,
    politician_id: p.id,
    source_type: "mca_company",
    tier: 6,
    admissible: true,
    // Distinct URL (fragment) so this row never collides with the affidavit-declared
    // mca_company row — both coexist and both feed the analyzer.
    url: `https://www.mca.gov.in/mcafoportal/viewCompanyMasterData.do#dirverify-${p.id}`,
    date: null,
    title: `MCA verification of directorship-linked companies — ${p.name}`,
    summary: `${verified.length} compan${verified.length > 1 ? "ies" : "y"} the member is linked to via directorship mentions in litigation/leaks/press, verified against the official MCA registry${struck.length ? `; ${struck.length} recorded struck off/dormant` : ""} (verify identity — a directorship mention is a lead, not proof).`,
    content: [
      `Directorship-linked companies verified against MCA Company Master (discovered from court/leak/press evidence, then registry-checked):`,
      ...verified.map((v) => `• ${v.name} (CIN ${v.cin}) — STATUS: ${v.status}${v.discovered_role ? `; role: ${v.discovered_role}` : ""}${v.paidup_capital ? `; paid-up ₹${(v.paidup_capital / 1e7).toFixed(2)} Cr` : ""}`),
    ].join("\n"),
    numbers: { companies: verified },
  }]);
  return { checked: byCompany.size, verified: verified.length, struck: struck.length };
}

// Batch over the whole roster. Returns aggregate counts. `verify` injectable for tests.
export async function runDirectorshipVerification({ verify = verifyCompanyName } = {}) {
  const total = { politicians: 0, checked: 0, verified: 0, struck: 0 };
  for (const p of listPoliticians()) {
    const r = await verifyDirectorshipCompanies(p, { verify });
    total.politicians++; total.checked += r.checked; total.verified += r.verified; total.struck += r.struck;
  }
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/directorship-verify.js");
if (invokedDirectly) {
  runDirectorshipVerification().then((c) => {
    console.log("[directorship-verify] done:", JSON.stringify(c));
    process.exit(0);
  });
}
