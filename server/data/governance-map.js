// Governance map — which party CONTROLLED each government, by year. The missing
// reference the network agents flagged (`[GOV-MAP]`): it closes the donor→party→
// award triangle ("a firm donated to the party that governs the authority that
// then paid it"). Curated from public election records (ECI results / widely
// documented state-government histories); approximate to the year and covering the
// major governments ~2012→present. Refine in one place as needed — every detector
// that reasons about "who was in power" reads through rulingPartiesInYear().
//
// Shape: { jurisdiction: [ { from, to, party } ] }. `to: null` = still in power.
// Party labels use the same short forms the roster/party data use (BJP, INC, …).
export const GOVERNMENTS = {
  Union: [ // central government
    { from: 2004, to: 2014, party: "INC" },   // UPA
    { from: 2014, to: null, party: "BJP" },    // NDA
  ],
  "Uttar Pradesh": [
    { from: 2007, to: 2012, party: "BSP" }, { from: 2012, to: 2017, party: "SP" }, { from: 2017, to: null, party: "BJP" },
  ],
  Maharashtra: [
    { from: 2014, to: 2019, party: "BJP" }, { from: 2019, to: 2022, party: "SHS" }, { from: 2022, to: null, party: "BJP" },
  ],
  Bihar: [
    { from: 2005, to: 2015, party: "JD(U)" }, { from: 2015, to: 2017, party: "RJD" },
    { from: 2017, to: 2022, party: "JD(U)" }, { from: 2022, to: 2024, party: "RJD" }, { from: 2024, to: null, party: "JD(U)" },
  ],
  "West Bengal": [{ from: 2011, to: null, party: "AITC" }],
  "Tamil Nadu": [{ from: 2011, to: 2021, party: "AIADMK" }, { from: 2021, to: null, party: "DMK" }],
  Gujarat: [{ from: 1998, to: null, party: "BJP" }],
  Karnataka: [
    { from: 2013, to: 2018, party: "INC" }, { from: 2018, to: 2023, party: "BJP" }, { from: 2023, to: null, party: "INC" },
  ],
  Rajasthan: [
    { from: 2013, to: 2018, party: "BJP" }, { from: 2018, to: 2023, party: "INC" }, { from: 2023, to: null, party: "BJP" },
  ],
  "Madhya Pradesh": [
    { from: 2003, to: 2018, party: "BJP" }, { from: 2018, to: 2020, party: "INC" }, { from: 2020, to: null, party: "BJP" },
  ],
  Kerala: [{ from: 2011, to: 2016, party: "INC" }, { from: 2016, to: null, party: "CPI(M)" }],
  Punjab: [
    { from: 2012, to: 2017, party: "SAD" }, { from: 2017, to: 2022, party: "INC" }, { from: 2022, to: null, party: "AAP" },
  ],
  Delhi: [{ from: 2015, to: 2025, party: "AAP" }, { from: 2025, to: null, party: "BJP" }],
  Telangana: [{ from: 2014, to: 2023, party: "BRS" }, { from: 2023, to: null, party: "INC" }],
  "Andhra Pradesh": [{ from: 2014, to: 2019, party: "TDP" }, { from: 2019, to: 2024, party: "YSRCP" }, { from: 2024, to: null, party: "TDP" }],
  Odisha: [{ from: 2000, to: 2024, party: "BJD" }, { from: 2024, to: null, party: "BJP" }],
  Jharkhand: [{ from: 2014, to: 2019, party: "BJP" }, { from: 2019, to: null, party: "JMM" }],
  Assam: [{ from: 2016, to: null, party: "BJP" }],
  Haryana: [{ from: 2014, to: null, party: "BJP" }],
  Chhattisgarh: [{ from: 2003, to: 2018, party: "BJP" }, { from: 2018, to: 2023, party: "INC" }, { from: 2023, to: null, party: "BJP" }],
  Uttarakhand: [{ from: 2017, to: null, party: "BJP" }],
  "Himachal Pradesh": [{ from: 2017, to: 2022, party: "BJP" }, { from: 2022, to: null, party: "INC" }],
};

// Normalise a party label so "AITC"/"TMC", "CPI(M)"/"CPM", "SHS"/"Shiv Sena" agree.
const PARTY_ALIAS = {
  TMC: "AITC", "ALL INDIA TRINAMOOL CONGRESS": "AITC",
  CPM: "CPI(M)", "SHIV SENA": "SHS", "SHIVSENA": "SHS",
  "JDU": "JD(U)", "TELUGU DESAM": "TDP", "BIJU JANATA DAL": "BJD",
};
export const canonParty = (s) => {
  const u = String(s ?? "").toUpperCase().trim();
  return PARTY_ALIAS[u] ?? u;
};

// The ruling party of one jurisdiction in a given year (or null / unknown).
export function rulingPartyOf(jurisdiction, year) {
  const spans = GOVERNMENTS[jurisdiction];
  if (!spans || year == null) return null;
  for (const s of spans) if (year >= s.from && (s.to == null || year < s.to)) return canonParty(s.party);
  return null;
}

// Every party in power ANYWHERE (Union + all states) in a given year → Set.
export function rulingPartiesInYear(year) {
  const out = new Set();
  for (const j of Object.keys(GOVERNMENTS)) { const p = rulingPartyOf(j, year); if (p) out.add(p); }
  return out;
}

// The jurisdictions a party governs in a given year (for attributing an award's
// authority back to who was in power). Returns [] when none.
export function jurisdictionsGovernedBy(party, year) {
  const target = canonParty(party);
  return Object.keys(GOVERNMENTS).filter((j) => rulingPartyOf(j, year) === target);
}
