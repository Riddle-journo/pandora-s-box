// Official / court-admissible Indian data source connectors.
// Every evidence item carries admissible:true/false per Bharatiya Sakshya
// Adhiniyam 2023 ss.74-78. Only public records (affidavits, audit reports,
// court orders, parliamentary records) are tagged admissible:true.
//
// POINTERS vs CONTENT: items here are research-pointer links stored in evidence
// (URL + summary). Separate async fetchers in /fetchers/ add actual content for
// the sources that can be machine-read.

const UA = { "User-Agent": "PandorosBox/0.1 (public-accountability research)" };
const MYNETA = "https://www.myneta.info";

const ev = (politician_id, obj) => ({ politician_id, date: null, ...obj });

// ===================================================================
// TIER 1 — Election Commission of India
// ===================================================================
function tier1ECI(p) {
  const q = encodeURIComponent(p.name);
  return [
    ev(p.id, {
      source_type: "eci_affidavit",
      admissible: true,
      title: `ECI sworn affidavit (assets, liabilities, criminal cases) — ${p.name}`,
      url: p.myneta_url || `${MYNETA}/search_myneta.php?q=${q}`,
      summary: "Form-26 affidavit filed with the Election Commission. Primary public record of declared assets, liabilities, criminal cases, and education. Full content fetched by myneta-full.js.",
    }),
    ev(p.id, {
      source_type: "eci_affidavit",
      admissible: true,
      title: "Original signed affidavit PDFs — affidavits.eci.gov.in",
      url: "https://affidavits.eci.gov.in/",
      summary: "Scanned originals as filed with ECI — the certified primary record for court use.",
    }),
    ev(p.id, {
      source_type: "eci_expenditure",
      admissible: true,
      title: `Election expenditure statement — ${p.name}`,
      url: "https://www.eci.gov.in/candidate-election-expenditure",
      summary: "Sworn campaign expenditure accounts filed with ECI. Significant mismatches between declared spending and observed campaign activity are a corruption indicator (undeclared campaign funding). Admissible public record.",
    }),
  ];
}

// ===================================================================
// TIER 2 — Parliament & State Legislatures
// ===================================================================
function tier2Parliament(p) {
  const q = encodeURIComponent(p.name);
  const items = [];

  if (p.office === "MP") {
    items.push(
      ev(p.id, {
        source_type: "parliament_ls",
        admissible: true,
        title: `Lok Sabha member record — ${p.name}`,
        url: "https://sansad.in/ls/members",
        summary: "Digital Sansad: official Lok Sabha attendance, questions, debates, committee memberships, and career history. Content fetched by sansad-mp.js when ENABLE_PLAYWRIGHT_FETCHERS=1.",
      }),
      ev(p.id, {
        source_type: "parliament_rs",
        admissible: true,
        title: `Rajya Sabha member record — ${p.name}`,
        url: "https://sansad.in/rs/members",
        summary: "Digital Sansad: official Rajya Sabha member record. Content fetched by sansad-mp.js (falls back to RS after LS miss).",
      }),
      ev(p.id, {
        source_type: "mplads",
        admissible: true,
        title: `MPLADS fund utilization — ${p.name} — ${p.constituency ?? ""}`,
        url: "https://mplads.mospi.gov.in/digigov/landingpage.html",
        summary: "MP Local Area Development Scheme: ₹5 crore/year per MP for constituency works. Fund released vs. utilised is a direct accountability metric for the individual MP. Portal is login-walled — requires manual check or RTI.",
      })
    );
  }

  if (p.office === "MLA") {
    const stateQ = encodeURIComponent(`${p.state ?? ""} vidhan sabha proceedings ${p.name}`);
    items.push(
      ev(p.id, {
        source_type: "assembly",
        admissible: true,
        title: `${p.state ?? "State"} Legislative Assembly proceedings — ${p.name}`,
        url: `https://www.google.com/search?q=${stateQ}+site%3Agov.in`,
        summary: "State assembly debates, questions, attendance and vote records. Each state has its own portal; link is a scoped gov.in search. Cannot be uniformly automated across 28 portals.",
      }),
      ev(p.id, {
        source_type: "mlalads",
        admissible: true,
        title: `MLALAD / constituency development fund — ${p.constituency ?? ""}`,
        url: `https://www.google.com/search?q=${encodeURIComponent(`${p.state ?? ""} MLALAD utilization ${p.constituency ?? ""}`)}+site%3Agov.in`,
        summary: "State MLA Local Area Development fund utilisation. State-controlled; no central portal. Most states do not publish this publicly — RTI is the main path.",
      })
    );
  }

  return items;
}

// ===================================================================
// TIER 3 — Audit & Anti-Corruption Bodies
// ===================================================================
function tier3AntiCorruption(p) {
  const q = encodeURIComponent(p.name);
  const stateQ = encodeURIComponent(`${p.state ?? ""} lokayukta ${p.name}`);
  return [
    ev(p.id, {
      source_type: "cag",
      admissible: true,
      title: `CAG audit reports — ${p.state || "India"} — ${p.name}`,
      url: `https://cag.gov.in/en/audit-report?title=&field_state_target_id=All&keys=${q}`,
      summary: "Comptroller & Auditor General audit reports laid before Parliament/state legislatures. Constitutional authority; primary admissible record for financial irregularities. Content fetched by cag-reports.js.",
    }),
    ev(p.id, {
      source_type: "lokpal",
      admissible: true,
      title: `Lokpal of India — complaints & disposal orders`,
      url: "https://lokpal.gov.in/",
      summary: "Statutory anti-corruption ombudsman for MPs and Union functionaries. Published orders are public records. Cannot be automated: no name-indexed search; orders are PDFs keyed by case number.",
    }),
    ev(p.id, {
      source_type: "ed",
      admissible: true,
      title: `Enforcement Directorate press releases — ${p.name}`,
      url: `https://enforcementdirectorate.gov.in/press-releases`,
      summary: "ED press releases on PMLA (money laundering) and FEMA cases. Content fetched by press-releases.js (listing + linked individual releases).",
    }),
    ev(p.id, {
      source_type: "cbi",
      admissible: true,
      title: `CBI press releases / cases — ${p.name}`,
      url: "https://cbi.gov.in/press.php",
      summary: "CBI press releases on corruption/criminal cases. Content fetched by press-releases.js. Corroborate with eCourts for case status.",
    }),
    ev(p.id, {
      source_type: "lokayukta",
      admissible: true,
      title: `${p.state ?? "State"} Lokayukta findings — ${p.name}`,
      url: `https://www.google.com/search?q=${stateQ}+site%3Agov.in`,
      summary: "State-level anti-corruption ombudsman orders. Admissible as a public record against MLAs and state ministers. Cannot be automated: 28 separate portals, most JS-rendered or captcha-walled.",
    }),
    ev(p.id, {
      source_type: "cic_rti",
      admissible: true,
      title: `CIC decisions / RTI disclosures — ${p.name}`,
      url: "https://ciconline.nic.in/cic_decisions/",
      summary: "Central Information Commission decisions and RTI-disclosed records. Cannot be automated: search returns case reference numbers not party names.",
    }),
  ];
}

// ===================================================================
// TIER 4 — Courts
// ===================================================================
function tier4Courts(p) {
  const q = encodeURIComponent(p.name);
  return [
    ev(p.id, {
      source_type: "ecourts",
      admissible: true,
      title: `eCourts district judgment search — ${p.name}`,
      url: `https://judgments.ecourts.gov.in/pdfsearch/?p=pdf_search/index&search_text=${q}`,
      summary: "District and sessions court judgments — full text search. Indian Kanoon API (fetched by indian-kanoon.js) covers this more reliably.",
    }),
    ev(p.id, {
      source_type: "ecourts_status",
      admissible: true,
      title: `eCourts live case status — ${p.name}`,
      url: `https://ecourts.gov.in/ecourts_home/`,
      summary: "Live pending-case status (stage, next hearing). Cannot be automated: status search requires the CNR case number, not a party name.",
    }),
    ev(p.id, {
      source_type: "supreme_court",
      admissible: true,
      title: `Supreme Court judgments — ${p.name}`,
      url: `https://main.sci.gov.in/judgments`,
      summary: "Supreme Court of India judgment portal. Covered by Indian Kanoon API.",
    }),
    ev(p.id, {
      source_type: "high_court",
      admissible: true,
      title: `High Court orders — ${p.state ?? ""} — ${p.name}`,
      url: `https://hcservices.ecourts.gov.in/ecourtindiaHC/`,
      summary: "High Court e-services portal. Covered by Indian Kanoon API.",
    }),
    ev(p.id, {
      source_type: "indian_kanoon",
      admissible: true,
      title: `Indian Kanoon full-text case search — ${p.name}`,
      url: `https://indiankanoon.org/search/?formInput=${q}`,
      summary: "Aggregated full-text search across all Indian courts. Content fetched by indian-kanoon.js (env INDIAN_KANOON_KEY).",
    }),
  ];
}

// ===================================================================
// TIER 5 — Public Funds & Procurement
// ===================================================================
function tier5Funds(p) {
  return [
    ev(p.id, {
      source_type: "pfms",
      admissible: true,
      title: `PFMS — scheme fund flows — ${p.constituency ?? ""}`,
      url: `https://pfms.nic.in/`,
      summary: "Public Financial Management System — tracks fund releases under all central schemes to districts and implementing agencies. Cannot be automated: JS dashboard with no politician-name query.",
    }),
    ev(p.id, {
      source_type: "gem",
      admissible: true,
      title: `GeM — government procurement orders — ${p.state ?? ""}`,
      url: `https://gem.gov.in/`,
      summary: "Government e-Marketplace — all central procurement orders and seller names. To use: cross-reference sellers with MCA for beneficial-ownership links to the politician. Cannot be automated without MCA data as prior step.",
    }),
    ev(p.id, {
      source_type: "eprocure",
      admissible: true,
      title: `Central Public Procurement Portal — tenders — ${p.state ?? ""}`,
      url: `https://eprocure.gov.in/`,
      summary: "All central government tenders — contractor identities. Favoritism trail requires knowing the contractor company associated with the politician first.",
    }),
  ];
}

// ===================================================================
// TIER 6 — Corporate / Beneficial Ownership (Favoritism Trail)
// ===================================================================
function tier6Corporate(p) {
  const q = encodeURIComponent(p.name);
  return [
    ev(p.id, {
      source_type: "mca",
      admissible: true,
      title: `MCA company directorships — ${p.name}`,
      url: "https://www.mca.gov.in/content/mca/global/en/mca/master-data/MDS.html",
      summary: "Ministry of Corporate Affairs: company directorships, shareholding, charges. Cannot be automated: MCA21 requires user login + GSTIN verification. Paid alternatives: Probe42, SurePass, tofler.in.",
    }),
    ev(p.id, {
      source_type: "sebi",
      admissible: true,
      title: `SEBI enforcement orders — ${p.name}`,
      url: "https://www.sebi.gov.in/enforcement/orders/",
      summary: "SEBI enforcement orders: insider trading, market manipulation, promoter violations. Content fetched by sebi-orders.js.",
    }),
    ev(p.id, {
      source_type: "opencorporates",
      admissible: false,
      title: `OpenCorporates — cross-border company linkages — ${p.name}`,
      url: `https://opencorporates.com/officers?q=${q}`,
      summary: "Aggregated global company registry. India coverage is partial and delayed — useful as a lead for offshore structures only. Verify via MCA.",
    }),
    ev(p.id, {
      source_type: "icij_leaks",
      admissible: false,
      title: `ICIJ Offshore Leaks — Panama/Pandora Papers — ${p.name}`,
      url: `https://offshoreleaks.icij.org/search?q=${q}`,
      summary: "ICIJ database of offshore entities (Panama Papers, Pandora Papers, Paradise Papers). Content fetched by icij.js (free, no key).",
    }),
    ev(p.id, {
      source_type: "fcra",
      admissible: true,
      title: `FCRA — foreign contribution disclosures — ${p.name}`,
      url: "https://fcraonline.nic.in/fc_repo_qry.aspx",
      summary: "Foreign Contribution (Regulation) Act portal — political parties and associations must disclose foreign donations received. Admissible government record. Query by the politician's party name to see foreign funding. Individual politicians who head registered associations may also appear directly.",
    }),
  ];
}

// ===================================================================
// TIER 7 — Land & Property Records
// ===================================================================
function tier7Land(p) {
  const state = p.state ?? "";
  const stateQ = encodeURIComponent(`${state} land registration property records`);
  return [
    ev(p.id, {
      source_type: "land_records",
      admissible: true,
      title: `State land registration records — ${state}`,
      url: `https://dilrmp.gov.in/`,
      summary: "Digital India Land Records Modernisation Programme — land ownership and mutation records. Cross-match with declared assets in ECI affidavit. Cannot be automated: 28 separate state portals, captcha-walled.",
    }),
    ev(p.id, {
      source_type: "state_land_portal",
      admissible: true,
      title: `${state} property registration portal`,
      url: `https://www.google.com/search?q=${stateQ}+site%3Agov.in`,
      summary: "State-specific land/property registration portal (Bhoomi/Karnataka, Dharani/Telangana, IGR/Maharashtra, Bhulekh/UP, etc.).",
    }),
  ];
}

// ===================================================================
// Tier registry — single source of truth. Add a tier here and it flows
// through ingestion, tier-filtering, and the methodology UI automatically.
// ===================================================================
export const TIER_INFO = [
  { tier: 1, name: "Election Commission",           fn: tier1ECI },
  { tier: 2, name: "Parliament & Legislatures",     fn: tier2Parliament },
  { tier: 3, name: "Audit & Anti-Corruption",       fn: tier3AntiCorruption },
  { tier: 4, name: "Courts",                         fn: tier4Courts },
  { tier: 5, name: "Public Funds & Procurement",    fn: tier5Funds },
  { tier: 6, name: "Corporate & Ownership",         fn: tier6Corporate },
  { tier: 7, name: "Land & Property",               fn: tier7Land },
];

// Assemble all tiers for a politician, tagging each item with its tier number.
export function officialSourceLinks(p, tier_max = 7) {
  const out = [];
  for (const { tier, fn } of TIER_INFO) {
    if (tier > tier_max) break;
    for (const item of fn(p)) out.push({ ...item, tier });
  }
  return out;
}

// ===================================================================
// MyNeta scrape: extract headline facts from a candidate's affidavit page.
// Used by the report generator for quick summary stats separate from
// the full-content fetch in myneta-full.js.
// ===================================================================
export async function fetchMyNetaFacts(p) {
  if (!p.myneta_url) return [];
  try {
    const res = await fetch(p.myneta_url, { headers: UA });
    if (!res.ok) return [];
    const html = await res.text();

    const grab = (re) => html.match(re)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? null;

    const cases  = grab(/Criminal Cases[^:]*:\s*<\/b>\s*([^<]+)/i)
                ?? grab(/criminal_cases?[^>]*>([^<]+)/i);
    const assets  = grab(/Total Assets[^:]*:?\s*<\/(?:b|td)>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const liabs   = grab(/Total Liabilities[^:]*:?\s*<\/(?:b|td)>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    const edu     = grab(/Education[^:]*:\s*<\/b>\s*([^<]+)/i);

    const out = [];
    if (cases)
      out.push({ politician_id: p.id, source_type: "eci_affidavit", tier: 1, admissible: true,
        title: `Self-declared criminal cases: ${cases}`, url: p.myneta_url, date: null,
        summary: `Candidate's sworn ECI affidavit (via ADR/MyNeta): criminal cases declared = ${cases}. Note: charges, not convictions.` });
    if (assets)
      out.push({ politician_id: p.id, source_type: "eci_affidavit", tier: 1, admissible: true,
        title: `Declared total assets: ${assets}`, url: p.myneta_url, date: null,
        summary: "Total declared assets per sworn ECI affidavit (via ADR/MyNeta)." });
    if (liabs)
      out.push({ politician_id: p.id, source_type: "eci_affidavit", tier: 1, admissible: true,
        title: `Declared total liabilities: ${liabs}`, url: p.myneta_url, date: null,
        summary: "Total declared liabilities per sworn ECI affidavit." });
    if (edu)
      out.push({ politician_id: p.id, source_type: "eci_affidavit", tier: 1, admissible: true,
        title: `Declared education: ${edu}`, url: p.myneta_url, date: null,
        summary: "Declared educational qualification from sworn ECI affidavit." });

    return out;
  } catch { return []; }
}
