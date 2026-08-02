// Canonical ministry/department keys (Summarizer card subjects) + party
// canonicalization. Ministries exist in the corpus only as free-text strings
// on scandals ("Ministry of Finance / RBI supervision", "Karnataka Mines &
// Geology"), so cards need a stable key + alias matcher — NOT a full entity
// system. The list covers the standard union ministries plus every state
// department that actually appears in the corpus; it grows with the data.
//
// key format:  union/<slug>            scope: "union"
//              state/<state-slug>/<slug>  scope: "<State Name>"
// `tokens`: ALL must appear (word-ish match) in the normalized free text for a
// match; `any`: at least one must appear (when present). First match wins —
// order state entries before union so "Manipur Home / Union Home Affairs"
// resolves to the state entry only when listed first… we instead match the
// MOST SPECIFIC (highest token count) entry across all candidates.

import { ORGS, getOrg, resolveOrg } from "./orgs.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// Legacy list retained for reference/tests; the live catalogue is orgs.js.
// (Entries below were migrated verbatim into orgs.js — edit THERE.)
const LEGACY_MINISTRIES = [
  // ── Union ministries ───────────────────────────────────────────────────
  { key: "union/finance",          scope: "union", name: "Ministry of Finance",                sectors: ["Banking", "Taxation", "Political funding / Transparency"], tokens: ["finance"], any: ["ministry", "union", "fipb", "lic", "rbi", "sebi", "banks"] },
  { key: "union/home",             scope: "union", name: "Ministry of Home Affairs",           sectors: ["Internal security", "Policing"], tokens: ["home affairs"] },
  { key: "union/defence",          scope: "union", name: "Ministry of Defence",                sectors: ["Defence"], tokens: ["defence"] },
  { key: "union/railways",         scope: "union", name: "Ministry of Railways",               sectors: ["Railways / Public safety"], tokens: ["railways"] },
  { key: "union/education",        scope: "union", name: "Ministry of Education",              sectors: ["Education"], tokens: ["education"] },
  { key: "union/health",           scope: "union", name: "Ministry of Health & Family Welfare", sectors: ["Health"], tokens: ["health"] },
  { key: "union/agriculture",      scope: "union", name: "Ministry of Agriculture",            sectors: ["Agriculture"], tokens: ["agriculture"] },
  { key: "union/coal",             scope: "union", name: "Ministry of Coal",                   sectors: ["Mining", "Energy"], tokens: ["coal"] },
  { key: "union/communications",   scope: "union", name: "Ministry of Communications & IT",    sectors: ["Telecom"], tokens: ["communications"] },
  { key: "union/corporate-affairs", scope: "union", name: "Ministry of Corporate Affairs",     sectors: ["Corporate regulation"], tokens: ["corporate affairs"] },
  { key: "union/space",            scope: "union", name: "Department of Space",                sectors: ["Space"], tokens: ["space"] },
  { key: "union/external-affairs", scope: "union", name: "Ministry of External Affairs",       sectors: ["Foreign affairs"], tokens: ["external affairs"] },
  { key: "union/labour",           scope: "union", name: "Ministry of Labour",                 sectors: ["Labour"], tokens: ["labour"] },
  { key: "union/chemicals",        scope: "union", name: "Ministry of Chemicals & Fertilizers", sectors: ["Industry"], tokens: ["chemicals"] },
  { key: "union/urban-development", scope: "union", name: "Ministry of Urban Development",     sectors: ["Urban development"], tokens: ["urban development", "organising committee"] },

  // ── State departments seen in the corpus ───────────────────────────────
  { key: "state/manipur/home",              scope: "Manipur",        name: "Manipur Home Department",              sectors: ["Internal security"], tokens: ["manipur", "home"] },
  { key: "state/gujarat/urban-development", scope: "Gujarat",        name: "Gujarat Urban Development (municipal)", sectors: ["Urban development", "Public safety"], tokens: ["gujarat"], any: ["morbi", "municipal", "urban"] },
  { key: "state/uttar-pradesh/home",        scope: "Uttar Pradesh",  name: "Uttar Pradesh Home / Police",          sectors: ["Policing"], tokens: ["uttar pradesh"], any: ["home", "police"] },
  { key: "state/kerala/cmo",                scope: "Kerala",         name: "Kerala Chief Minister's Office",       sectors: ["Administration"], tokens: ["kerala"], any: ["cm", "chief minister"] },
  { key: "state/kerala/electricity",        scope: "Kerala",         name: "Kerala Electricity Department",        sectors: ["Energy"], tokens: ["kerala", "electricity"] },
  { key: "state/punjab/home-mining",        scope: "Punjab",         name: "Punjab Home & Mining",                 sectors: ["Mining", "Policing"], tokens: ["punjab"] },
  { key: "state/chhattisgarh/food",         scope: "Chhattisgarh",   name: "Chhattisgarh Food & Civil Supplies",   sectors: ["Food distribution"], tokens: ["chhattisgarh"] },
  { key: "state/madhya-pradesh/examinations", scope: "Madhya Pradesh", name: "MP Professional Examination Board",  sectors: ["Education"], tokens: ["vyapam"], any: [] },
  { key: "state/maharashtra/water",         scope: "Maharashtra",    name: "Maharashtra Water Resources",          sectors: ["Water"], tokens: ["maharashtra", "water"] },
  { key: "state/maharashtra/revenue",       scope: "Maharashtra",    name: "Maharashtra Revenue / Urban Development", sectors: ["Urban development"], tokens: ["maharashtra", "revenue"] },
  { key: "state/karnataka/mines",           scope: "Karnataka",      name: "Karnataka Mines & Geology",            sectors: ["Mining"], tokens: ["karnataka", "mines"] },
  { key: "state/karnataka/cmo",             scope: "Karnataka",      name: "Karnataka Chief Minister's Office",    sectors: ["Administration"], tokens: ["karnataka"], any: ["cm", "chief minister"] },
  { key: "state/jharkhand/mines-cmo",       scope: "Jharkhand",      name: "Jharkhand Mines & CM's Office",        sectors: ["Mining"], tokens: ["jharkhand"] },
  { key: "state/bihar/animal-husbandry",    scope: "Bihar",          name: "Bihar Animal Husbandry Department",    sectors: ["Agriculture"], tokens: ["bihar", "animal husbandry"] },
  { key: "state/tamil-nadu/cmo",            scope: "Tamil Nadu",     name: "Tamil Nadu Chief Minister's Office",   sectors: ["Administration"], tokens: ["tamil nadu"] },
  { key: "state/delhi/excise",              scope: "Delhi",          name: "Delhi Excise Department",              sectors: ["Excise"], tokens: ["delhi", "excise"] },
  { key: "state/delhi/licensing",           scope: "Delhi",          name: "Delhi Licensing & Fire Authorities",   sectors: ["Public safety"], tokens: ["delhi"], any: ["licensing", "fire"] },
];

// Live ministry/department view over the orgs.js catalogue — same shape the
// scorecard/card consumers always had (key, scope, name, sectors, tokens, any).
export const MINISTRIES = ORGS.filter((o) => o.kind === "ministry" || o.kind === "department");
void LEGACY_MINISTRIES; // kept for reference only

// Resolve free ministry text ("Ministry of Finance / RBI supervision") to the
// most specific canonical entry, or null. Delegates to the org catalogue,
// restricted to ministry/department kinds so PSUs and regulators can't steal
// scandal ministry strings.
export function resolveMinistry(freeText) {
  return resolveOrg(freeText, { kinds: ["ministry", "department"] });
}

export function getMinistry(key) {
  return getOrg(key);
}

// ── Party canonicalization ────────────────────────────────────────────────
// Roster uses abbreviations (BJP, INC, AITC…) AND full names; scandals use
// full names with qualifiers ("Bharatiya Janata Party (NDA)"). One canonical
// slug per real party; coalition/cross-party strings resolve to null.
export const PARTIES = [
  { key: "bjp",    name: "Bharatiya Janata Party",          aliases: ["bjp", "bharatiya janata party"] },
  { key: "inc",    name: "Indian National Congress",        aliases: ["inc", "indian national congress"] }, // no bare "congress" — would swallow Trinamool Congress
  { key: "aitc",   name: "All India Trinamool Congress",    aliases: ["aitc", "trinamool"] },
  { key: "aap",    name: "Aam Aadmi Party",                 aliases: ["aap", "aam aadmi"] },
  { key: "cpim",   name: "Communist Party of India (Marxist)", aliases: ["cpi m", "cpim", "communist party of india marxist"] },
  { key: "cpi",    name: "Communist Party of India",        aliases: ["cpi"] },
  { key: "ncp",    name: "Nationalist Congress Party",      aliases: ["ncp", "nationalist congress"] },
  { key: "dmk",    name: "Dravida Munnetra Kazhagam",       aliases: ["dmk", "dravida munnetra"] },
  { key: "aiadmk", name: "AIADMK",                          aliases: ["aiadmk", "anna dravida"] },
  { key: "rjd",    name: "Rashtriya Janata Dal",            aliases: ["rjd", "rashtriya janata dal"] },
  { key: "sp",     name: "Samajwadi Party",                 aliases: ["sp", "samajwadi"] },
  { key: "tdp",    name: "Telugu Desam Party",              aliases: ["tdp", "telugu desam"] },
  { key: "jdu",    name: "Janata Dal (United)",             aliases: ["jd u", "jdu", "janata dal united"] },
  { key: "sad",    name: "Shiromani Akali Dal",             aliases: ["sad", "shiromani akali dal"] },
  { key: "bjd",    name: "Biju Janata Dal",                 aliases: ["bjd", "biju janata dal"] },
  { key: "ysrcp",  name: "YSR Congress Party",              aliases: ["ysrcp", "ysr congress"] },
  { key: "shs",    name: "Shiv Sena",                       aliases: ["shs", "shiv sena"] },
  { key: "brs",    name: "Bharat Rashtra Samithi",          aliases: ["brs", "bharat rashtra samithi", "trs", "telangana rashtra samithi"] },
];

export function resolveParty(freeText) {
  const t = norm(freeText);
  if (!t || /cross|multiple|coalition|regulatory|local administration/.test(t)) return null;
  // Exact-ish alias match first (word boundaries via token set), then substring.
  const words = new Set(t.split(" "));
  for (const p of PARTIES) {
    for (const a of p.aliases) {
      if (a.includes(" ") ? t.includes(a) : words.has(a)) return p;
    }
  }
  return null;
}

export function getParty(key) {
  return PARTIES.find((p) => p.key === key) ?? null;
}
