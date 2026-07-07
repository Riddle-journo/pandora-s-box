// Reference data for international comparison: how free is a country, so that
// when we say "in country X the minister resigned", the reader knows whether X
// is a place where accountability is the norm or the exception.
//
// Sources (update annually):
//   • RSF World Press Freedom Index 2024  — rank (1 = freest of 180) + score 0–100
//   • Freedom House "Freedom in the World" 2024 — aggregate score 0–100 + status
//
// Used by the scandal/minister accountability layer to contextualise foreign
// precedents (e.g. "Germany — Free, press-freedom rank 10 — minister resigned").

export const FREEDOM_INDEX = {
  // country (lowercase key) : { name, rsf_rank, rsf_score, fh_score, fh_status }
  india:          { name: "India",          rsf_rank: 159, rsf_score: 31.3, fh_score: 66, fh_status: "Partly Free" },
  norway:         { name: "Norway",         rsf_rank: 1,   rsf_score: 91.9, fh_score: 100, fh_status: "Free" },
  denmark:        { name: "Denmark",        rsf_rank: 2,   rsf_score: 89.6, fh_score: 97, fh_status: "Free" },
  sweden:         { name: "Sweden",         rsf_rank: 3,   rsf_score: 88.3, fh_score: 100, fh_status: "Free" },
  netherlands:    { name: "Netherlands",    rsf_rank: 4,   rsf_score: 87.7, fh_score: 97, fh_status: "Free" },
  finland:        { name: "Finland",        rsf_rank: 5,   rsf_score: 87.2, fh_score: 100, fh_status: "Free" },
  ireland:        { name: "Ireland",        rsf_rank: 8,   rsf_score: 86.9, fh_score: 97, fh_status: "Free" },
  germany:        { name: "Germany",        rsf_rank: 10,  rsf_score: 83.8, fh_score: 94, fh_status: "Free" },
  newzealand:     { name: "New Zealand",    rsf_rank: 19,  rsf_score: 79.7, fh_score: 99, fh_status: "Free" },
  canada:         { name: "Canada",         rsf_rank: 14,  rsf_score: 81.7, fh_score: 97, fh_status: "Free" },
  australia:      { name: "Australia",      rsf_rank: 39,  rsf_score: 73.4, fh_score: 95, fh_status: "Free" },
  uk:             { name: "United Kingdom", rsf_rank: 23,  rsf_score: 77.5, fh_score: 91, fh_status: "Free" },
  france:         { name: "France",         rsf_rank: 21,  rsf_score: 78.7, fh_score: 89, fh_status: "Free" },
  usa:            { name: "United States",  rsf_rank: 55,  rsf_score: 66.6, fh_score: 83, fh_status: "Free" },
  japan:          { name: "Japan",          rsf_rank: 70,  rsf_score: 63.9, fh_score: 96, fh_status: "Free" },
  southkorea:     { name: "South Korea",    rsf_rank: 62,  rsf_score: 64.9, fh_score: 83, fh_status: "Free" },
  taiwan:         { name: "Taiwan",         rsf_rank: 27,  rsf_score: 75.5, fh_score: 94, fh_status: "Free" },
  italy:          { name: "Italy",          rsf_rank: 46,  rsf_score: 70.0, fh_score: 90, fh_status: "Free" },
  spain:          { name: "Spain",          rsf_rank: 30,  rsf_score: 75.0, fh_score: 90, fh_status: "Free" },
  israel:         { name: "Israel",         rsf_rank: 101, rsf_score: 53.2, fh_score: 74, fh_status: "Free" },
  southafrica:    { name: "South Africa",   rsf_rank: 38,  rsf_score: 73.5, fh_score: 79, fh_status: "Free" },
  brazil:         { name: "Brazil",         rsf_rank: 82,  rsf_score: 58.5, fh_score: 72, fh_status: "Free" },
  indonesia:      { name: "Indonesia",      rsf_rank: 111, rsf_score: 51.2, fh_score: 58, fh_status: "Partly Free" },
  srilanka:       { name: "Sri Lanka",      rsf_rank: 150, rsf_score: 36.0, fh_score: 55, fh_status: "Partly Free" },
  bangladesh:     { name: "Bangladesh",     rsf_rank: 165, rsf_score: 27.6, fh_score: 40, fh_status: "Partly Free" },
  pakistan:       { name: "Pakistan",       rsf_rank: 152, rsf_score: 33.9, fh_score: 35, fh_status: "Partly Free" },
  singapore:      { name: "Singapore",      rsf_rank: 126, rsf_score: 45.7, fh_score: 47, fh_status: "Partly Free" },
  malaysia:       { name: "Malaysia",       rsf_rank: 107, rsf_score: 52.1, fh_score: 53, fh_status: "Partly Free" },
  turkey:         { name: "Turkey",         rsf_rank: 158, rsf_score: 31.6, fh_score: 33, fh_status: "Not Free" },
  russia:         { name: "Russia",         rsf_rank: 162, rsf_score: 29.9, fh_score: 13, fh_status: "Not Free" },
  china:          { name: "China",          rsf_rank: 172, rsf_score: 23.4, fh_score: 9,  fh_status: "Not Free" },
  nepal:          { name: "Nepal",          rsf_rank: 74,  rsf_score: 63.5, fh_score: 63, fh_status: "Partly Free" },
};

const ALIASES = {
  "united states": "usa", "america": "usa", "u.s.": "usa", "u.s.a.": "usa", "united states of america": "usa",
  "united kingdom": "uk", "britain": "uk", "great britain": "uk", "england": "uk",
  "south korea": "southkorea", "korea": "southkorea", "republic of korea": "southkorea",
  "new zealand": "newzealand", "south africa": "southafrica", "sri lanka": "srilanka",
};

const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");

// Look up a country by name (handles common aliases). Returns the record or null.
export function freedomFor(country) {
  if (!country) return null;
  const raw = country.toLowerCase().trim();
  if (ALIASES[raw]) return FREEDOM_INDEX[ALIASES[raw]];
  const key = norm(country);
  return FREEDOM_INDEX[key] ?? null;
}

// A short human label for UI: "Free · press-freedom rank 10/180"
export function freedomLabel(country) {
  const f = freedomFor(country);
  if (!f) return null;
  return `${f.fh_status} · press-freedom rank ${f.rsf_rank}/180`;
}
