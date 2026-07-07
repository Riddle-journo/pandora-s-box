// Electoral Bonds — the "follow the money" reference dataset.
//
// After the Supreme Court struck down the anonymous Electoral Bonds scheme
// (Feb 2024), the State Bank of India disclosed, on ECI order, which companies
// bought bonds and which parties encashed them (Apr 2019 – Jan 2024). This file
// captures that PUBLIC data at the level India actually discloses it: party
// totals + the largest donors with the parties they funded.
//
// ── NEUTRALITY ──────────────────────────────────────────────────────────
// This is the disclosed public record for ALL parties, not a selection. Larger
// parties received more in absolute terms; that is a fact of the data, not a
// framing. Sector tags are a neutral industry classification of each donor.
// Figures are in ₹ crore, rounded from the SBI/ECI disclosure (widely reported);
// treat as approximate. Recipient-party lists name parties where the donor→party
// encashment was publicly reported; "Multiple" where the split wasn't itemised.
//
// Individual politicians are NOT itemised in Indian disclosure — money is given
// to PARTIES. The trail this powers is therefore: donor → party → that party's
// elected representatives (a politician inherits their party's funding profile).

// Party-level totals encashed (₹ crore).
export const PARTY_TOTALS = [
  { party: "Bharatiya Janata Party",                 abbr: "BJP",   total_cr: 6060 },
  { party: "All India Trinamool Congress",           abbr: "AITC",  total_cr: 1609 },
  { party: "Indian National Congress",               abbr: "INC",   total_cr: 1422 },
  { party: "Bharat Rashtra Samithi",                 abbr: "BRS",   total_cr: 1214 },
  { party: "Biju Janata Dal",                        abbr: "BJD",   total_cr: 775 },
  { party: "Dravida Munnetra Kazhagam",              abbr: "DMK",   total_cr: 639 },
  { party: "YSR Congress Party",                     abbr: "YSRCP", total_cr: 442 },
  { party: "Telugu Desam Party",                     abbr: "TDP",   total_cr: 218 },
  { party: "Shiv Sena",                              abbr: "SHS",   total_cr: 159 },
  { party: "Rashtriya Janata Dal",                   abbr: "RJD",   total_cr: 73 },
  { party: "Aam Aadmi Party",                        abbr: "AAP",   total_cr: 66 },
  { party: "Janata Dal (Secular)",                   abbr: "JD(S)", total_cr: 89 },
  { party: "Nationalist Congress Party",             abbr: "NCP",   total_cr: 63 },
  { party: "Janata Dal (United)",                    abbr: "JD(U)", total_cr: 24 },
  { party: "Samajwadi Party",                        abbr: "SP",    total_cr: 14 },
  { party: "Jharkhand Mukti Morcha",                 abbr: "JMM",   total_cr: 13 },
  { party: "Sikkim Krantikari Morcha",               abbr: "SKM",   total_cr: 11 },
];

// Largest donors, with neutral sector classification and reported recipients.
export const TOP_DONORS = [
  { donor: "Future Gaming and Hotel Services",         sector: "Lottery & Gaming",        total_cr: 1368, parties: ["DMK", "AITC", "YSRCP", "INC"] },
  { donor: "Megha Engineering & Infrastructure (MEIL)", sector: "Infrastructure & Construction", total_cr: 966, parties: ["BJP", "BRS", "DMK", "YSRCP", "TDP", "INC"] },
  { donor: "Qwik Supply Chain",                        sector: "Logistics / Conglomerate", total_cr: 410, parties: ["BJP", "SHS", "NCP"] },
  { donor: "Vedanta Ltd",                              sector: "Mining & Metals",          total_cr: 400, parties: ["BJP", "INC", "AITC", "BJD"] },
  { donor: "Haldia Energy (RP-Sanjiv Goenka)",         sector: "Power & Energy",           total_cr: 377, parties: ["AITC", "INC"] },
  { donor: "Bharti Group (Airtel entities)",           sector: "Telecommunications",       total_cr: 247, parties: ["BJP", "INC"] },
  { donor: "Essel Mining & Industries (Aditya Birla)", sector: "Mining & Metals",          total_cr: 224, parties: ["BJP"] },
  { donor: "Western UP Power Transmission",            sector: "Power & Energy",           total_cr: 220, parties: ["BJP"] },
  { donor: "Keventer Foodpark Infra",                  sector: "Food & FMCG",              total_cr: 195, parties: ["AITC", "BJP"] },
  { donor: "Jindal Steel & Power",                     sector: "Steel",                    total_cr: 192, parties: ["BJP", "INC", "BJD"] },
  { donor: "Madanlal Ltd",                             sector: "Trading / Diversified",    total_cr: 185, parties: ["AITC", "BJP"] },
  { donor: "Bharti Airtel Ltd",                        sector: "Telecommunications",       total_cr: 183, parties: ["BJP"] },
  { donor: "DLF Commercial Developers",                sector: "Real Estate",              total_cr: 170, parties: ["BJP", "INC"] },
  { donor: "Piramal Enterprises (group entities)",     sector: "Pharma & Finance",         total_cr: 120, parties: ["BJP", "INC"] },
  { donor: "Torrent Power",                            sector: "Power & Energy",           total_cr: 107, parties: ["BJP", "INC", "AAP"] },
  { donor: "Birla Carbon India",                       sector: "Chemicals",                total_cr: 105, parties: ["BJP"] },
  { donor: "Rungta Sons",                              sector: "Mining & Metals",          total_cr: 100, parties: ["BJP", "BJD"] },
  { donor: "Aurobindo Pharma (group)",                 sector: "Pharmaceuticals",          total_cr: 95,  parties: ["BJP", "BRS", "TDP"] },
  { donor: "Dr. Reddy's Laboratories",                 sector: "Pharmaceuticals",          total_cr: 80,  parties: ["BJP", "BRS", "INC"] },
  { donor: "Sun Pharma (group)",                       sector: "Pharmaceuticals",          total_cr: 32,  parties: ["BJP", "INC"] },
];

const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Match a politician's free-text party to a known party record (by full name or abbr).
export function matchParty(partyText) {
  if (!partyText) return null;
  const t = norm(partyText);
  return PARTY_TOTALS.find((p) => norm(p.party) === t || norm(p.abbr) === t)
      ?? PARTY_TOTALS.find((p) => t.includes(norm(p.abbr)) || norm(p.party).includes(t) || t.includes(norm(p.party)))
      ?? null;
}

// Full funding profile for a party: its total, rank, the donors who funded it,
// and that party's funding broken down by donor sector.
export function fundingForParty(partyText) {
  const party = matchParty(partyText);
  if (!party) return null;
  const ranked = [...PARTY_TOTALS].sort((a, b) => b.total_cr - a.total_cr);
  const rank = ranked.findIndex((p) => p.abbr === party.abbr) + 1;

  const donors = TOP_DONORS
    .filter((d) => d.parties.includes(party.abbr))
    .sort((a, b) => b.total_cr - a.total_cr)
    .map((d) => ({ donor: d.donor, sector: d.sector, total_cr: d.total_cr }));

  const bySector = {};
  for (const d of donors) bySector[d.sector] = (bySector[d.sector] ?? 0) + d.total_cr;
  const sectors = Object.entries(bySector).map(([sector, cr]) => ({ sector, total_cr: cr }))
    .sort((a, b) => b.total_cr - a.total_cr);

  return { party: party.party, abbr: party.abbr, total_cr: party.total_cr, rank, total_parties: PARTY_TOTALS.length, donors, sectors };
}

// Cross-party sector view: which industries gave the most, and to whom.
export function sectorOverview() {
  const map = {};
  for (const d of TOP_DONORS) {
    const s = (map[d.sector] ??= { sector: d.sector, total_cr: 0, donors: [], parties: new Set() });
    s.total_cr += d.total_cr;
    s.donors.push(d.donor);
    d.parties.forEach((p) => s.parties.add(p));
  }
  return Object.values(map)
    .map((s) => ({ sector: s.sector, total_cr: s.total_cr, donor_count: s.donors.length, parties: [...s.parties] }))
    .sort((a, b) => b.total_cr - a.total_cr);
}

export function fundingOverview() {
  return {
    note: "Electoral Bonds disclosed by SBI on ECI order (Apr 2019 – Jan 2024) after the Supreme Court struck down the scheme. Figures in ₹ crore, approximate. Disclosure is at party level — politicians inherit their party's funding profile.",
    party_totals: [...PARTY_TOTALS].sort((a, b) => b.total_cr - a.total_cr),
    top_donors: [...TOP_DONORS].sort((a, b) => b.total_cr - a.total_cr),
    sectors: sectorOverview(),
  };
}
