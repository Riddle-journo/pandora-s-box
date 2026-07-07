// The Detector (L1) — the heart of the discovery engine. It JOINS a politician's
// power-sectors (what their office/questions cover, from A2) against their
// interest-sectors (family companies + property + donors, from A3 / electoral
// bonds) and emits ranked LEADS. A lead is a CANDIDATE, never a finding: the
// wording is neutral, the score only ranks how unlikely a coincidence it is, and
// nothing here is published. The AI Investigator + Referee (Phase B) and a human
// gate decide what, if anything, is real.
//
// Pure & code-only (no network, no model). buildRelations returns early without
// touching the store when a rep has no relatives, so this stays testable.
import { textToSector, ministryToSector } from "./data/sectors.js";
import { fundingForParty } from "./data/electoral-bonds.js";
import { buildRelations } from "./graph.js";

// Detector identity — bump when any threshold/weight/vector changes.
export const DETECTOR_VERSION = "conflict-v1";

const INFRA_SECTORS = ["transport", "realestate", "infrastructure", "mining"];
const OWNER_MULT = { self: 3, dependent: 2, spouse: 1, huf: 1 };
const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");

// Pull the conflict-relevant structured data out of a rep's evidence.
function gather(evidence) {
  let power = null;
  const affidavits = [];
  const companies = [];
  const projects = [];
  for (const e of evidence) {
    const n = e.numbers;
    if (!n) continue;
    if (e.source_type === "parliament_ls" && n.power) power = { ...n.power, url: e.url };
    else if (e.source_type === "eci_affidavit") affidavits.push({ ...n, url: e.url });
    else if (e.source_type === "mca_company" && Array.isArray(n.companies)) companies.push(...n.companies);
    else if (e.source_type === "project_announcement" && Array.isArray(n.projects)) {
      for (const pr of n.projects) projects.push({ ...pr, url: e.url });
    }
  }
  affidavits.sort((a, b) => (a.election_year ?? 0) - (b.election_year ?? 0));
  const latest = affidavits.at(-1) ?? null;
  // Carry the affidavit's year onto each property: with no acquisition date in
  // the affidavit, the declaration year is our best "property existed by" bound.
  const interests = (latest?.interests ?? []).map((i) => ({ ...i, url: latest.url }));
  const properties = (latest?.properties ?? []).map((pr) => ({ ...pr, url: latest.url, declared_year: latest.election_year ?? null }));
  return { power, latest, interests, properties, companies, projects };
}

// The year an announcement date falls in ("2022-05-01" → 2022, "2022" → 2022).
function yearOf(date) {
  const m = String(date ?? "").match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

// Two districts refer to the same place (case-insensitive, tolerant of extra tokens).
function sameDistrict(a, b) {
  const x = String(a ?? "").toLowerCase().trim(), y = String(b ?? "").toLowerCase().trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export function detectConflicts(politician, evidence, roster, scandals) {
  const g = gather(evidence);
  const leads = [];
  const mk = (o) => leads.push({ actor_id: politician.id, actor_name: politician.name, evidence_urls: [], detector_version: DETECTOR_VERSION, ...o });

  // Power sectors: sectors the office covers = questioned sectors + ministerial
  // portfolios (ministers ANSWER rather than ask, so questions alone miss them).
  const qs = g.power?.question_sectors ?? {};
  const ministrySectors = new Set((g.power?.ministries ?? []).map(ministryToSector).filter(Boolean));
  const powerSectors = new Set([...Object.keys(qs), ...ministrySectors]);
  const powerWeight = (sector) => (qs[sector] ?? 0) + (ministrySectors.has(sector) ? 6 : 0);

  // ── 1. REGULATORY_SELF_DEALING — office-power sector meets a family business
  //       in that same sector (the Gadkari shape). ──────────────────────────
  const bySector = {};
  for (const it of g.interests) if (it.sector && powerSectors.has(it.sector)) (bySector[it.sector] ??= []).push(it);
  for (const [sector, its] of Object.entries(bySector)) {
    const mult = Math.max(...its.map((i) => OWNER_MULT[i.owner] ?? 1));
    const signal_score = powerWeight(sector) * mult;
    const owners = [...new Set(its.map((i) => i.owner))].join("/");
    mk({
      vector: "REGULATORY_SELF_DEALING", instrument: `${sector} sector (office attention: ${powerWeight(sector)})`,
      beneficiary: its.map((i) => i.name).slice(0, 4).join("; "), beneficiary_kind: "company",
      signal_score, severity: sev(signal_score),
      headline: `Holds ${owners} business interest(s) in the ${sector} sector while the office's parliamentary attention concentrates there.`,
      evidence_urls: [g.power?.url, its[0].url].filter(Boolean),
      detail: `Declared ${its.length} ${sector}-sector interest(s) [${owners}]: ${its.map((i) => i.name).join("; ")}. The member's questions/portfolio weight on ${sector} is ${powerWeight(sector)}. A sector overlap is a candidate for review, not a finding.`,
    });
  }

  // ── 2. PROJECT_FRONT_RUNNING (declared form) — infrastructure-power office +
  //       declared property; announcement-timing added later (C.2). ─────────
  const hasInfraPower = [...powerSectors].some((s) => INFRA_SECTORS.includes(s));
  if (hasInfraPower) {
    for (const prop of g.properties) {
      if (!prop.district) continue;
      const val = prop.value_rupees ?? 0;
      const ministerial = [...ministrySectors].some((s) => INFRA_SECTORS.includes(s));

      // C.2 timing upgrade: a project ANNOUNCED in the property's district AFTER
      // the property was declared is the front-running shape (property predates
      // the announcement). This is the strong signal — emit it and skip the weak
      // location-only lead for this property.
      const laterProjects = g.projects.filter((pj) =>
        sameDistrict(pj.district, prop.district) &&
        prop.declared_year && yearOf(pj.date) && yearOf(pj.date) > prop.declared_year);
      if (laterProjects.length) {
        const pj = laterProjects[0];
        const signal_score = 25 + Math.min(Math.round(val / 1e7), 20) + (ministerial ? 8 : 0);
        mk({
          vector: "PROJECT_FRONT_RUNNING", instrument: `infrastructure/land-affecting office`,
          beneficiary: `${prop.property_type} in ${prop.district} (${prop.owner})`, beneficiary_kind: "property",
          signal_score, severity: sev(signal_score),
          headline: `Declares ${prop.property_type.toLowerCase()} in ${prop.district} (by ${prop.declared_year}) before a government project was announced there (${pj.date}).`,
          evidence_urls: [g.power?.url, prop.url, pj.url].filter(Boolean),
          detail: `${prop.owner} property in ${prop.district}${val ? ` (~₹${(val / 1e7).toFixed(2)} Cr)` : ""} was declared by ${prop.declared_year}; a project ("${pj.title}") was announced in the same district in ${pj.date}. Property predating an announcement in the same district is the front-running shape — a LEAD for the Investigator/Referee, not a finding.`,
        });
        continue;
      }

      // No timing match → fall back to the weak location-overlap lead, and only
      // when it clears the noise floor (ministerial infra portfolio OR ≥₹1cr).
      if (!ministerial && val < 1e7) continue;
      const signal_score = Math.min(Math.round(val / 1e7), 40) + (ministerial ? 8 : 0);
      mk({
        vector: "PROJECT_FRONT_RUNNING", instrument: `infrastructure/land-affecting office`,
        beneficiary: `${prop.property_type} in ${prop.district} (${prop.owner})`, beneficiary_kind: "property",
        signal_score, severity: sev(signal_score),
        headline: `Declares ${prop.property_type.toLowerCase()} in ${prop.district} while the office influences infrastructure/land decisions.`,
        evidence_urls: [g.power?.url, prop.url].filter(Boolean),
        detail: `${prop.owner} property in ${prop.district}${val ? ` (~₹${(val / 1e7).toFixed(2)} Cr)` : ""}. Whether any project was announced there AFTER acquisition needs the announcement-timing check (C.2) — this is only a location overlap so far.`,
      });
    }
  }

  // ── 3. DYNASTY_CONCENTRATION / FAMILY_APPOINTMENT — reuse the graph. ───────
  const relations = buildRelations(politician, evidence);
  for (const link of relations.links) {
    if (link.type !== "DYNASTY") continue;
    mk({
      vector: "DYNASTY_CONCENTRATION", instrument: "elected office held by family",
      beneficiary: link.relative_name, beneficiary_kind: "politician",
      signal_score: 10, severity: "NOTABLE",
      headline: `A ${link.relation} also holds elected office (family concentration of political power).`,
      evidence_urls: [link.source_url].filter(Boolean), detail: link.note,
    });
  }

  // ── 4. DONOR_REWARD — party's electoral-bond donor sectors overlap the
  //       office's power sectors. ────────────────────────────────────────────
  const funding = fundingForParty(politician.party);
  if (funding) {
    for (const ds of funding.sectors) {
      const sector = textToSector(ds.sector) ?? String(ds.sector).toLowerCase();
      if (!powerSectors.has(sector)) continue;
      const signal_score = Math.min(Math.round(ds.total_cr / 100), 15) + powerWeight(sector);
      mk({
        vector: "DONOR_REWARD", instrument: `${sector}-sector office attention`,
        beneficiary: `${ds.sector} donors to ${funding.abbr}`, beneficiary_kind: "donor_sector",
        signal_score, severity: sev(signal_score),
        headline: `The party drew electoral-bond funding from the ${sector} sector, which the member's office also covers.`,
        evidence_urls: [g.power?.url].filter(Boolean),
        detail: `${funding.abbr} received ₹${ds.total_cr} cr in disclosed electoral bonds from ${ds.sector}; the member's office weight on ${sector} is ${powerWeight(sector)}. Party-level funding is inherited, not personal — a context flag, not an allegation.`,
      });
    }
  }

  // ── 5. SHELL_OR_STRUCK_OFF_LINK — a struck-off/dormant company in a sector
  //       the office covers (layering hallmark). ──────────────────────────────
  for (const c of g.companies) {
    if (!/struck off|strike off|dormant/i.test(c.status ?? "")) continue;
    const sector = textToSector(c.name);
    if (!sector || !powerSectors.has(sector)) continue;
    mk({
      vector: "SHELL_OR_STRUCK_OFF_LINK", instrument: `${sector}-sector office attention`,
      beneficiary: c.name, beneficiary_kind: "company",
      signal_score: 12, severity: "NOTABLE",
      headline: `A declared ${sector}-sector company linked to the member is struck-off/dormant in the MCA registry.`,
      evidence_urls: [c.source_url].filter(Boolean),
      detail: `${c.name} — MCA status: ${c.status}. Struck-off companies in a sector the office covers are worth review.`,
    });
  }

  leads.sort((a, b) => b.signal_score - a.signal_score);
  return { leads };
}
