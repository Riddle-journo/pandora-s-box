// Official / court-admissible Indian data source connectors.
// Every evidence item carries admissible:true/false per Bharatiya Sakshya
// Adhiniyam 2023 ss.74-78. Only public records (affidavits, audit reports,
// court orders, parliamentary records) are tagged admissible:true.
//
// POINTERS vs CONTENT: items here are research-pointer links stored in evidence
// (URL + summary). Separate async fetchers in /fetchers/ add actual content for
// the sources that can be machine-read.
//
// DEAD SOURCES REMOVED: pointers to sources that cannot be machine-read within
// our constraints (CAPTCHA / login / no name-indexed search — MCA21, DILRMP land
// records, PFMS, GeM, Lokpal, CIC/RTI, state-assembly & MLALAD portals) have been
// pulled out of this catalogue and recorded in sources_catalog.json →
// rejected_sources with the exact blocker, so we don't carry plumbing we can't run.

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
        summary: "MP Local Area Development Scheme: ₹5 crore/year per MP for constituency works. Fund released vs. utilised is a direct accountability metric for the individual MP. Content fetched by mplads.js (MoSPI API).",
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
  return [
    ev(p.id, {
      source_type: "cag",
      admissible: true,
      title: `CAG audit reports — ${p.state || "India"} — ${p.name}`,
      url: `https://cag.gov.in/en/audit-report?title=&field_state_target_id=All&keys=${q}`,
      summary: "Comptroller & Auditor General audit reports laid before Parliament/state legislatures. Constitutional authority; primary admissible record for financial irregularities. Content matched via the cag-audit-index / cag-bihar / cag-odisha L1 datasets (readBodies).",
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
      source_type: "eprocure",
      admissible: true,
      title: `Central Public Procurement Portal — tenders — ${p.state ?? ""}`,
      url: `https://eprocure.gov.in/`,
      summary: "All central government tenders — contractor identities. Favoritism trail requires knowing the contractor company associated with the politician first. Content fetched by cppp-procurement.js.",
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
];

// Assemble all tiers for a politician, tagging each item with its tier number.
export function officialSourceLinks(p, tier_max = 6) {
  const out = [];
  for (const { tier, fn } of TIER_INFO) {
    if (tier > tier_max) break;
    for (const item of fn(p)) out.push({ ...item, tier });
  }
  return out;
}
