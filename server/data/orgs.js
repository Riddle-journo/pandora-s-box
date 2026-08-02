// Curated catalogue of government organizations — the org half of the entity
// system. Pure data + pure functions: this module must NOT import store.js
// (cards/scorecards import it without touching the DB, and tests rely on that).
//
// key format:  union/<slug>                    scope "union"   (ministry)
//              union/<ministry>/<dept-slug>    scope "union"   (department, parent set)
//              state/<state-slug>/<slug>       scope "<State>" (department)
//              psu/<slug>                                      (PSU / authority)
//              regulator/<slug>                                (regulator / watchdog / constitutional body)
//
// kind: ministry | department | psu | regulator
//
// Matching contract (same as the old MINISTRIES matcher): `tokens` must ALL
// appear in the normalized free text; `any` (when present) needs at least one.
// resolveOrg picks the most specific match — specificity = total words across
// matched tokens, +1 for state scope, +1 for having a parent (dept beats its
// parent ministry when both match).
//
// The 33 pre-existing MINISTRIES keys are preserved VERBATIM (names included):
// saved URLs like #/ministry/union/finance and persisted cards key off them.

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
// Word-boundary containment: "coal" must NOT match inside "coalfields".
// Both text and token are pre-normalized, so padding with spaces is exact.
const hasTok = (text, tok) => ` ${text} `.includes(` ${tok} `);

// ── Union ministries ────────────────────────────────────────────────────────
const UNION_MINISTRIES = [
  // The 15 legacy entries, verbatim keys/names/tokens (do not edit lightly).
  { key: "union/finance",           name: "Ministry of Finance",                             sectors: ["Banking", "Taxation", "Political funding / Transparency"], tokens: ["finance"], any: ["ministry", "union", "fipb", "lic", "rbi", "sebi", "banks"] },
  { key: "union/home",              name: "Ministry of Home Affairs",                        sectors: ["Internal security", "Policing"], tokens: ["home affairs"] },
  { key: "union/defence",           name: "Ministry of Defence",                             sectors: ["Defence"], tokens: ["defence"] },
  { key: "union/railways",          name: "Ministry of Railways",                            sectors: ["Railways / Public safety"], tokens: ["railways"] },
  { key: "union/education",         name: "Ministry of Education",                           sectors: ["Education"], tokens: ["education"] },
  { key: "union/health",            name: "Ministry of Health & Family Welfare",             sectors: ["Health"], tokens: ["health"] },
  { key: "union/agriculture",       name: "Ministry of Agriculture",                         sectors: ["Agriculture"], tokens: ["agriculture"] },
  { key: "union/coal",              name: "Ministry of Coal",                                sectors: ["Mining", "Energy"], tokens: ["coal"], any: ["ministry", "union", "department", "block", "allocation"] },
  { key: "union/communications",    name: "Ministry of Communications & IT",                 sectors: ["Telecom"], tokens: ["communications"] },
  { key: "union/corporate-affairs", name: "Ministry of Corporate Affairs",                   sectors: ["Corporate regulation"], tokens: ["corporate affairs"] },
  { key: "union/space",             name: "Department of Space",                             sectors: ["Space"], tokens: ["space"] },
  { key: "union/external-affairs",  name: "Ministry of External Affairs",                    sectors: ["Foreign affairs"], tokens: ["external affairs"] },
  { key: "union/labour",            name: "Ministry of Labour",                              sectors: ["Labour"], tokens: ["labour"] },
  { key: "union/chemicals",         name: "Ministry of Chemicals & Fertilizers",             sectors: ["Industry"], tokens: ["chemicals"] },
  { key: "union/urban-development", name: "Ministry of Urban Development",                   sectors: ["Urban development"], tokens: ["urban development", "organising committee"] },
  // New union ministries (full current set).
  { key: "union/commerce",          name: "Ministry of Commerce & Industry",                 sectors: ["Trade", "Industry"], tokens: ["commerce"] },
  { key: "union/law",               name: "Ministry of Law & Justice",                       sectors: ["Law"], tokens: ["law"], any: ["justice", "ministry", "legal"] },
  { key: "union/road-transport",    name: "Ministry of Road Transport & Highways",           sectors: ["Roads", "Infrastructure"], tokens: ["road transport"] },
  { key: "union/civil-aviation",    name: "Ministry of Civil Aviation",                      sectors: ["Aviation"], tokens: ["civil aviation"] },
  { key: "union/ports-shipping",    name: "Ministry of Ports, Shipping & Waterways",         sectors: ["Ports", "Shipping"], tokens: ["shipping"] },
  { key: "union/power",             name: "Ministry of Power",                               sectors: ["Energy"], tokens: ["power"], any: ["ministry", "union", "electricity"] },
  { key: "union/petroleum",         name: "Ministry of Petroleum & Natural Gas",             sectors: ["Energy", "Oil & gas"], tokens: ["petroleum"] },
  { key: "union/renewable-energy",  name: "Ministry of New & Renewable Energy",              sectors: ["Energy", "Climate"], tokens: ["renewable energy"] },
  { key: "union/environment",       name: "Ministry of Environment, Forest & Climate Change", sectors: ["Environment", "Climate"], tokens: ["environment"] },
  { key: "union/jal-shakti",        name: "Ministry of Jal Shakti",                          sectors: ["Water"], tokens: ["jal shakti"] },
  { key: "union/rural-development", name: "Ministry of Rural Development",                   sectors: ["Rural development"], tokens: ["rural development"], any: ["ministry", "union"] },
  { key: "union/panchayati-raj",    name: "Ministry of Panchayati Raj",                      sectors: ["Local government"], tokens: ["panchayati raj"] },
  { key: "union/social-justice",    name: "Ministry of Social Justice & Empowerment",        sectors: ["Social welfare"], tokens: ["social justice"] },
  { key: "union/tribal-affairs",    name: "Ministry of Tribal Affairs",                      sectors: ["Tribal welfare"], tokens: ["tribal affairs"] },
  { key: "union/minority-affairs",  name: "Ministry of Minority Affairs",                    sectors: ["Minority welfare"], tokens: ["minority affairs"] },
  { key: "union/women-child",       name: "Ministry of Women & Child Development",           sectors: ["Women & children"], tokens: ["child development"] },
  { key: "union/youth-sports",      name: "Ministry of Youth Affairs & Sports",              sectors: ["Sports"], tokens: ["sports"] },
  { key: "union/culture",           name: "Ministry of Culture",                             sectors: ["Culture"], tokens: ["culture"] },
  { key: "union/tourism",           name: "Ministry of Tourism",                             sectors: ["Tourism"], tokens: ["tourism"] },
  { key: "union/information-broadcasting", name: "Ministry of Information & Broadcasting",   sectors: ["Media"], tokens: ["broadcasting"] },
  { key: "union/electronics-it",    name: "Ministry of Electronics & Information Technology", sectors: ["Technology"], tokens: ["information technology"], any: ["ministry", "meity", "electronics"] },
  { key: "union/science-technology", name: "Ministry of Science & Technology",               sectors: ["Science"], tokens: ["science"] },
  { key: "union/earth-sciences",    name: "Ministry of Earth Sciences",                      sectors: ["Science"], tokens: ["earth sciences"] },
  { key: "union/heavy-industries",  name: "Ministry of Heavy Industries",                    sectors: ["Industry"], tokens: ["heavy industries"] },
  { key: "union/msme",              name: "Ministry of Micro, Small & Medium Enterprises",   sectors: ["Industry", "MSME"], tokens: ["msme"] },
  { key: "union/skill-development", name: "Ministry of Skill Development & Entrepreneurship", sectors: ["Employment"], tokens: ["skill development"] },
  { key: "union/food-processing",   name: "Ministry of Food Processing Industries",          sectors: ["Food", "Industry"], tokens: ["food processing"] },
  { key: "union/consumer-affairs",  name: "Ministry of Consumer Affairs, Food & Public Distribution", sectors: ["Food distribution", "Consumer protection"], tokens: ["consumer affairs"] },
  { key: "union/textiles",          name: "Ministry of Textiles",                            sectors: ["Industry"], tokens: ["textiles"] },
  { key: "union/steel",             name: "Ministry of Steel",                               sectors: ["Industry"], tokens: ["steel"], any: ["ministry", "union"] },
  { key: "union/mines",             name: "Ministry of Mines",                               sectors: ["Mining"], tokens: ["mines"], any: ["ministry", "union"] },
  { key: "union/ayush",             name: "Ministry of Ayush",                               sectors: ["Health"], tokens: ["ayush"] },
  { key: "union/fisheries-animal-husbandry", name: "Ministry of Fisheries, Animal Husbandry & Dairying", sectors: ["Agriculture"], tokens: ["animal husbandry"], any: ["ministry", "union", "dairying", "fisheries"] },
  { key: "union/personnel",         name: "Ministry of Personnel, Public Grievances & Pensions", sectors: ["Administration"], tokens: ["personnel"] },
  { key: "union/statistics",        name: "Ministry of Statistics & Programme Implementation", sectors: ["Statistics"], tokens: ["statistics"] },
  { key: "union/parliamentary-affairs", name: "Ministry of Parliamentary Affairs",           sectors: ["Parliament"], tokens: ["parliamentary affairs"] },
  { key: "union/cooperation",       name: "Ministry of Cooperation",                         sectors: ["Cooperatives"], tokens: ["cooperation"] },
  { key: "union/doner",             name: "Ministry of Development of North Eastern Region", sectors: ["Regional development"], tokens: ["north eastern region"] },
  { key: "union/atomic-energy",     name: "Department of Atomic Energy",                     sectors: ["Energy", "Science"], tokens: ["atomic energy"] },
].map((m) => ({ ...m, kind: "ministry", scope: "union", parent: null }));

// ── Union departments (distinct public accountability surface) ─────────────
const UNION_DEPARTMENTS = [
  { key: "union/finance/dept-revenue",        parent: "union/finance",  name: "Department of Revenue",                sectors: ["Taxation"], tokens: ["department of revenue"] },
  { key: "union/finance/dept-expenditure",    parent: "union/finance",  name: "Department of Expenditure",            sectors: ["Public spending"], tokens: ["department of expenditure"] },
  { key: "union/finance/dept-economic-affairs", parent: "union/finance", name: "Department of Economic Affairs",      sectors: ["Economy"], tokens: ["economic affairs"] },
  { key: "union/finance/dept-financial-services", parent: "union/finance", name: "Department of Financial Services",  sectors: ["Banking", "Insurance"], tokens: ["financial services"] },
  { key: "union/commerce/dpiit",              parent: "union/commerce", name: "Department for Promotion of Industry & Internal Trade", sectors: ["Industry"], tokens: ["dpiit"], any: [] },
  { key: "union/communications/dot",          parent: "union/communications", name: "Department of Telecommunications", sectors: ["Telecom"], tokens: ["telecommunications"] },
  { key: "union/communications/posts",        parent: "union/communications", name: "Department of Posts",             sectors: ["Postal services"], tokens: ["department of posts"] },
  { key: "union/education/school-education",  parent: "union/education", name: "Department of School Education & Literacy", sectors: ["Education"], tokens: ["school education"] },
  { key: "union/education/higher-education",  parent: "union/education", name: "Department of Higher Education",      sectors: ["Education"], tokens: ["higher education"] },
  { key: "union/health/health-research",      parent: "union/health",   name: "Department of Health Research",        sectors: ["Health"], tokens: ["health research"] },
  { key: "union/chemicals/pharmaceuticals",   parent: "union/chemicals", name: "Department of Pharmaceuticals",       sectors: ["Health", "Industry"], tokens: ["pharmaceuticals"] },
  { key: "union/defence/defence-production",  parent: "union/defence",  name: "Department of Defence Production",     sectors: ["Defence"], tokens: ["defence production"] },
  { key: "union/personnel/dopt",              parent: "union/personnel", name: "Department of Personnel & Training",  sectors: ["Administration"], tokens: ["personnel and training"], any: ["dopt", "personnel"] },
  { key: "union/law/legal-affairs",           parent: "union/law",      name: "Department of Legal Affairs",          sectors: ["Law"], tokens: ["legal affairs"] },
  { key: "union/rural-development/land-resources", parent: "union/rural-development", name: "Department of Land Resources", sectors: ["Land"], tokens: ["land resources"] },
  { key: "union/jal-shakti/drinking-water",   parent: "union/jal-shakti", name: "Department of Drinking Water & Sanitation", sectors: ["Water", "Sanitation"], tokens: ["drinking water"] },
  { key: "union/consumer-affairs/food-distribution", parent: "union/consumer-affairs", name: "Department of Food & Public Distribution", sectors: ["Food distribution"], tokens: ["public distribution"] },
  { key: "union/science-technology/biotechnology", parent: "union/science-technology", name: "Department of Biotechnology", sectors: ["Science"], tokens: ["biotechnology"] },
  { key: "union/science-technology/csir",     parent: "union/science-technology", name: "Department of Scientific & Industrial Research", sectors: ["Science"], tokens: ["scientific and industrial research"], any: ["csir", "scientific"] },
].map((d) => ({ ...d, kind: "department", scope: "union" }));

// ── State departments ───────────────────────────────────────────────────────
// The 18 corpus-seen legacy entries, verbatim.
const STATE_DEPARTMENTS_LEGACY = [
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
].map((d) => ({ ...d, kind: "department", parent: null }));

// Standard-department template for the states the corpus/roster covers.
// Generated, so the catalogue stays maintainable; legacy keys take precedence.
const TEMPLATE_STATES = [
  ["uttar-pradesh", "Uttar Pradesh"], ["maharashtra", "Maharashtra"], ["karnataka", "Karnataka"],
  ["tamil-nadu", "Tamil Nadu"], ["gujarat", "Gujarat"], ["madhya-pradesh", "Madhya Pradesh"],
  ["bihar", "Bihar"], ["west-bengal", "West Bengal"], ["delhi", "Delhi"], ["kerala", "Kerala"],
  ["punjab", "Punjab"], ["rajasthan", "Rajasthan"], ["chhattisgarh", "Chhattisgarh"],
  ["jharkhand", "Jharkhand"], ["odisha", "Odisha"], ["assam", "Assam"],
];
const TEMPLATE_DEPARTMENTS = [
  ["home",              "Home / Police Department",        ["Internal security", "Policing"], ["home", "police"]],
  ["revenue",           "Revenue Department",              ["Land", "Administration"],        ["revenue"]],
  ["pwd",               "Public Works Department",         ["Infrastructure"],                ["public works", "pwd"]],
  ["health",            "Health Department",               ["Health"],                        ["health"]],
  ["education",         "Education Department",            ["Education"],                     ["education"]],
  ["excise",            "Excise Department",               ["Excise"],                        ["excise"]],
  ["mines",             "Mines & Geology Department",      ["Mining"],                        ["mines", "mining"]],
  ["urban-development", "Urban Development Department",    ["Urban development"],             ["urban", "municipal"]],
];
const legacyKeys = new Set(STATE_DEPARTMENTS_LEGACY.map((d) => d.key));
const STATE_DEPARTMENTS_TEMPLATE = [];
for (const [slug, stateName] of TEMPLATE_STATES) {
  for (const [dslug, dname, sectors, anyToks] of TEMPLATE_DEPARTMENTS) {
    const key = `state/${slug}/${dslug}`;
    if (legacyKeys.has(key)) continue; // legacy corpus-tuned entry wins
    STATE_DEPARTMENTS_TEMPLATE.push({
      key, kind: "department", scope: stateName, parent: null,
      name: `${stateName} ${dname}`, sectors,
      tokens: [stateName.toLowerCase()], any: anyToks,
    });
  }
}

// ── PSUs & public authorities ───────────────────────────────────────────────
// No CINs are recorded here: assigning a wrong identity key is worse than
// assigning none — CINs can be attached later via attachStrongIds when a
// registry source confirms them.
const PSUS = [
  { key: "psu/ongc",            name: "Oil & Natural Gas Corporation",         short: "ONGC",   parent: "union/petroleum",       sectors: ["Oil & gas"], tokens: ["ongc"], any: [] },
  { key: "psu/indian-oil",      name: "Indian Oil Corporation",                short: "IOCL",   parent: "union/petroleum",       sectors: ["Oil & gas"], tokens: ["indian oil"], aliases: ["IndianOil"] },
  { key: "psu/hpcl",            name: "Hindustan Petroleum Corporation",       short: "HPCL",   parent: "union/petroleum",       sectors: ["Oil & gas"], tokens: ["hindustan petroleum"] },
  { key: "psu/bpcl",            name: "Bharat Petroleum Corporation",          short: "BPCL",   parent: "union/petroleum",       sectors: ["Oil & gas"], tokens: ["bharat petroleum"] },
  { key: "psu/gail",            name: "GAIL (India)",                          short: "GAIL",   parent: "union/petroleum",       sectors: ["Oil & gas"], tokens: ["gail"], any: [] },
  { key: "psu/oil-india",       name: "Oil India Limited",                     short: "OIL",    parent: "union/petroleum",       sectors: ["Oil & gas"], tokens: ["oil india"] },
  { key: "psu/ntpc",            name: "NTPC Limited",                          short: "NTPC",   parent: "union/power",           sectors: ["Energy"], tokens: ["ntpc"], any: [] },
  { key: "psu/powergrid",       name: "Power Grid Corporation of India",       short: "POWERGRID", parent: "union/power",        sectors: ["Energy"], tokens: ["power grid"] },
  { key: "psu/nhpc",            name: "NHPC Limited",                          short: "NHPC",   parent: "union/power",           sectors: ["Energy", "Hydropower"], tokens: ["nhpc"], any: [] },
  { key: "psu/sjvn",            name: "SJVN Limited",                          short: "SJVN",   parent: "union/power",           sectors: ["Energy", "Hydropower"], tokens: ["sjvn"], any: [] },
  { key: "psu/rec",             name: "REC Limited",                           short: "REC",    parent: "union/power",           sectors: ["Energy finance"], tokens: ["rural electrification"], any: ["rec", "rural electrification"] },
  { key: "psu/pfc",             name: "Power Finance Corporation",             short: "PFC",    parent: "union/power",           sectors: ["Energy finance"], tokens: ["power finance"] },
  { key: "psu/coal-india",      name: "Coal India Limited",                    short: "CIL",    parent: "union/coal",            sectors: ["Mining", "Energy"], tokens: ["coal india"] },
  { key: "psu/sail",            name: "Steel Authority of India",              short: "SAIL",   parent: "union/steel",           sectors: ["Industry", "Steel"], tokens: ["steel authority"] },
  { key: "psu/nmdc",            name: "NMDC Limited",                          short: "NMDC",   parent: "union/steel",           sectors: ["Mining"], tokens: ["nmdc"], any: [] },
  { key: "psu/nalco",           name: "National Aluminium Company",            short: "NALCO",  parent: "union/mines",           sectors: ["Mining", "Metals"], tokens: ["national aluminium"] },
  { key: "psu/bhel",            name: "Bharat Heavy Electricals",              short: "BHEL",   parent: "union/heavy-industries", sectors: ["Industry"], tokens: ["bhel"], any: [], aliases: ["Bharat Heavy Electricals Limited"] },
  { key: "psu/hal",             name: "Hindustan Aeronautics Limited",         short: "HAL",    parent: "union/defence",         sectors: ["Defence"], tokens: ["hindustan aeronautics"] },
  { key: "psu/bel",             name: "Bharat Electronics Limited",            short: "BEL",    parent: "union/defence",         sectors: ["Defence"], tokens: ["bharat electronics"] },
  { key: "psu/mazagon-dock",    name: "Mazagon Dock Shipbuilders",             short: "MDL",    parent: "union/defence",         sectors: ["Defence", "Shipbuilding"], tokens: ["mazagon dock"] },
  { key: "psu/grse",            name: "Garden Reach Shipbuilders & Engineers", short: "GRSE",   parent: "union/defence",         sectors: ["Defence", "Shipbuilding"], tokens: ["garden reach"] },
  { key: "psu/drdo",            name: "Defence Research & Development Organisation", short: "DRDO", parent: "union/defence",    sectors: ["Defence", "Science"], tokens: ["drdo"], any: [] },
  { key: "psu/isro",            name: "Indian Space Research Organisation",    short: "ISRO",   parent: "union/space",           sectors: ["Space"], tokens: ["isro"], any: [] },
  { key: "psu/nhai",            name: "National Highways Authority of India",  short: "NHAI",   parent: "union/road-transport",  sectors: ["Roads", "Infrastructure"], tokens: ["highways authority"], any: ["nhai", "highways"] },
  { key: "psu/nbcc",            name: "NBCC (India)",                          short: "NBCC",   parent: "union/urban-development", sectors: ["Construction"], tokens: ["nbcc"], any: [] },
  { key: "psu/fci",             name: "Food Corporation of India",             short: "FCI",    parent: "union/consumer-affairs", sectors: ["Food distribution"], tokens: ["food corporation"] },
  { key: "psu/aai",             name: "Airports Authority of India",           short: "AAI",    parent: "union/civil-aviation",  sectors: ["Aviation"], tokens: ["airports authority"] },
  { key: "psu/irctc",           name: "Indian Railway Catering & Tourism Corporation", short: "IRCTC", parent: "union/railways", sectors: ["Railways"], tokens: ["irctc"], any: [] },
  { key: "psu/ircon",           name: "IRCON International",                   short: "IRCON",  parent: "union/railways",        sectors: ["Railways", "Construction"], tokens: ["ircon"], any: [] },
  { key: "psu/rvnl",            name: "Rail Vikas Nigam Limited",              short: "RVNL",   parent: "union/railways",        sectors: ["Railways", "Construction"], tokens: ["rail vikas"] },
  { key: "psu/railtel",         name: "RailTel Corporation of India",          short: "RailTel", parent: "union/railways",       sectors: ["Railways", "Telecom"], tokens: ["railtel"], any: [] },
  { key: "psu/concor",          name: "Container Corporation of India",        short: "CONCOR", parent: "union/railways",        sectors: ["Logistics"], tokens: ["container corporation"] },
  { key: "psu/shipping-corp",   name: "Shipping Corporation of India",         short: "SCI",    parent: "union/ports-shipping",  sectors: ["Shipping"], tokens: ["shipping corporation"] },
  { key: "psu/bsnl",            name: "Bharat Sanchar Nigam Limited",          short: "BSNL",   parent: "union/communications",  sectors: ["Telecom"], tokens: ["bsnl"], any: ["bsnl", "bharat sanchar"] },
  { key: "psu/mtnl",            name: "Mahanagar Telephone Nigam Limited",     short: "MTNL",   parent: "union/communications",  sectors: ["Telecom"], tokens: ["mtnl"], any: ["mtnl", "mahanagar telephone"] },
  { key: "psu/lic",             name: "Life Insurance Corporation of India",   short: "LIC",    parent: "union/finance",         sectors: ["Insurance"], tokens: ["life insurance corporation"] },
  { key: "psu/sbi",             name: "State Bank of India",                   short: "SBI",    parent: "union/finance",         sectors: ["Banking"], tokens: ["state bank of india"] },
  { key: "psu/ecil",            name: "Electronics Corporation of India",      short: "ECIL",   parent: "union/atomic-energy",   sectors: ["Electronics"], tokens: ["electronics corporation"] },
  { key: "psu/midhani",         name: "Mishra Dhatu Nigam",                    short: "MIDHANI", parent: "union/defence",        sectors: ["Defence", "Metals"], tokens: ["mishra dhatu"] },
  { key: "psu/neepco",          name: "North Eastern Electric Power Corporation", short: "NEEPCO", parent: "union/power",        sectors: ["Energy"], tokens: ["neepco"], any: ["neepco", "north eastern electric"] },
  { key: "psu/thdc",            name: "THDC India",                            short: "THDC",   parent: "union/power",           sectors: ["Energy", "Hydropower"], tokens: ["thdc"], any: [] },
  { key: "psu/dvc",             name: "Damodar Valley Corporation",            short: "DVC",    parent: "union/power",           sectors: ["Energy"], tokens: ["damodar valley"] },
  { key: "psu/hll",             name: "HLL Lifecare",                          short: "HLL",    parent: "union/health",          sectors: ["Health"], tokens: ["hll lifecare"] },
  { key: "psu/itdc",            name: "India Tourism Development Corporation", short: "ITDC",   parent: "union/tourism",         sectors: ["Tourism"], tokens: ["tourism development corporation"] },
  { key: "psu/nha",             name: "National Health Authority",             short: "NHA",    parent: "union/health",          sectors: ["Health"], tokens: ["national health authority"] },
  { key: "psu/ndma",            name: "National Disaster Management Authority", short: "NDMA",  parent: "union/home",            sectors: ["Disaster management"], tokens: ["disaster management authority"] },
].map((p) => ({ ...p, kind: "psu", scope: "union" }));

// ── Regulators, watchdogs & constitutional bodies ───────────────────────────
const REGULATORS = [
  { key: "regulator/rbi",     name: "Reserve Bank of India",                       short: "RBI",   sectors: ["Banking"], tokens: ["reserve bank"] },
  { key: "regulator/sebi",    name: "Securities & Exchange Board of India",        short: "SEBI",  sectors: ["Markets"], tokens: ["sebi"], any: [] },
  { key: "regulator/trai",    name: "Telecom Regulatory Authority of India",       short: "TRAI",  sectors: ["Telecom"], tokens: ["trai"], any: ["trai", "telecom regulatory"] },
  { key: "regulator/irdai",   name: "Insurance Regulatory & Development Authority", short: "IRDAI", sectors: ["Insurance"], tokens: ["irdai"], any: ["irdai", "insurance regulatory"] },
  { key: "regulator/pfrda",   name: "Pension Fund Regulatory & Development Authority", short: "PFRDA", sectors: ["Pensions"], tokens: ["pfrda"], any: ["pfrda", "pension fund regulatory"] },
  { key: "regulator/cci",     name: "Competition Commission of India",             short: "CCI",   sectors: ["Competition"], tokens: ["competition commission"] },
  { key: "regulator/fssai",   name: "Food Safety & Standards Authority of India",  short: "FSSAI", sectors: ["Food safety"], tokens: ["fssai"], any: ["fssai", "food safety"] },
  { key: "regulator/cpcb",    name: "Central Pollution Control Board",             short: "CPCB",  sectors: ["Environment"], tokens: ["pollution control board"] },
  { key: "regulator/cerc",    name: "Central Electricity Regulatory Commission",   short: "CERC",  sectors: ["Energy"], tokens: ["electricity regulatory"] },
  { key: "regulator/cdsco",   name: "Central Drugs Standard Control Organisation", short: "CDSCO", sectors: ["Health", "Pharma"], tokens: ["cdsco"], any: ["cdsco", "drugs standard"] },
  { key: "regulator/ugc",     name: "University Grants Commission",                short: "UGC",   sectors: ["Education"], tokens: ["university grants"] },
  { key: "regulator/aicte",   name: "All India Council for Technical Education",   short: "AICTE", sectors: ["Education"], tokens: ["aicte"], any: ["aicte", "technical education"] },
  { key: "regulator/nmc",     name: "National Medical Commission",                 short: "NMC",   sectors: ["Health", "Education"], tokens: ["medical commission"] },
  { key: "regulator/ibbi",    name: "Insolvency & Bankruptcy Board of India",      short: "IBBI",  sectors: ["Insolvency"], tokens: ["ibbi"], any: ["ibbi", "insolvency and bankruptcy board"] },
  { key: "regulator/epfo",    name: "Employees' Provident Fund Organisation",      short: "EPFO",  sectors: ["Labour", "Pensions"], tokens: ["provident fund"] },
  { key: "regulator/cag",     name: "Comptroller & Auditor General of India",      short: "CAG",   sectors: ["Audit", "Oversight"], tokens: ["comptroller and auditor"], any: ["cag", "comptroller"] },
  { key: "regulator/cvc",     name: "Central Vigilance Commission",                short: "CVC",   sectors: ["Anti-corruption", "Oversight"], tokens: ["vigilance commission"] },
  { key: "regulator/cbi",     name: "Central Bureau of Investigation",             short: "CBI",   sectors: ["Investigation"], tokens: ["bureau of investigation"], any: ["cbi", "central bureau"] },
  { key: "regulator/ed",      name: "Directorate of Enforcement",                  short: "ED",    sectors: ["Investigation", "Money laundering"], tokens: ["enforcement directorate"] },
  { key: "regulator/nia",     name: "National Investigation Agency",               short: "NIA",   sectors: ["Investigation"], tokens: ["investigation agency"] },
  { key: "regulator/eci",     name: "Election Commission of India",                short: "ECI",   sectors: ["Elections", "Oversight"], tokens: ["election commission"] },
  { key: "regulator/nhrc",    name: "National Human Rights Commission",            short: "NHRC",  sectors: ["Human rights"], tokens: ["human rights commission"] },
  { key: "regulator/ngt",     name: "National Green Tribunal",                     short: "NGT",   sectors: ["Environment"], tokens: ["green tribunal"] },
  { key: "regulator/lokpal",  name: "Lokpal of India",                             short: "Lokpal", sectors: ["Anti-corruption", "Oversight"], tokens: ["lokpal"], any: [] },
  { key: "regulator/cic",     name: "Central Information Commission",              short: "CIC",   sectors: ["Transparency", "RTI"], tokens: ["information commission"] },
  { key: "regulator/uidai",   name: "Unique Identification Authority of India",    short: "UIDAI", sectors: ["Identity", "Technology"], tokens: ["uidai"], any: ["uidai", "unique identification"] },
  { key: "regulator/niti",    name: "NITI Aayog",                                  short: "NITI",  sectors: ["Policy"], tokens: ["niti aayog"] },
].map((r) => ({ ...r, kind: "regulator", scope: "union", parent: null }));

export const ORGS = [
  ...UNION_MINISTRIES,
  ...UNION_DEPARTMENTS,
  ...STATE_DEPARTMENTS_LEGACY,
  ...STATE_DEPARTMENTS_TEMPLATE,
  ...PSUS,
  ...REGULATORS,
];

// ── Indexes (built once) ────────────────────────────────────────────────────
const byKey = new Map(ORGS.map((o) => [o.key, o]));
const childIndex = new Map();
for (const o of ORGS) {
  if (!o.parent) continue;
  if (!childIndex.has(o.parent)) childIndex.set(o.parent, []);
  childIndex.get(o.parent).push(o);
}

export function getOrg(key) { return byKey.get(key) ?? null; }
export function orgChildren(key) { return childIndex.get(key) ?? []; }

// ── Exact-identity matching ─────────────────────────────────────────────────
// Company-suffix-insensitive EXACT name match, for counterparty names that
// arrive with a non-org kind (audit parties, treasury payees, lease holders).
// A PSU named as a contract counterparty IS the catalogue PSU — but only when
// the whole name matches: "NTPC Ltd." → psu/ntpc, while "Coal India Traders
// Pvt Ltd" must NOT collapse onto Coal India. Token scoring is far too loose
// for that call, so this is deliberately strict.
const SUFFIXES = /\b(limited|ltd|private|pvt|corporation|corp|company|co|incorporated|inc|india|of india)\b/g;
const exactKey = (s) => norm(s).replace(SUFFIXES, " ").replace(/\s+/g, " ").trim();
const exactIndex = new Map();
for (const o of ORGS) {
  for (const spelling of [o.name, o.short, ...(o.aliases ?? [])]) {
    const k = exactKey(spelling);
    // First writer wins; a collision means two orgs share a suffix-stripped
    // name, in which case neither is safe to auto-resolve.
    if (!k) continue;
    if (exactIndex.has(k) && exactIndex.get(k) !== o.key) { exactIndex.set(k, null); continue; }
    exactIndex.set(k, o.key);
  }
}

export function resolveOrgExact(freeText) {
  const k = exactKey(freeText);
  if (!k) return null;
  const key = exactIndex.get(k);
  return key ? getOrg(key) : null;
}

// Resolve free text to the most specific catalogue entry, or null.
// Specificity = total WORDS across required tokens (so "coal india" beats
// "coal"), +1 for state scope, +1 for having a parent (a department beats
// the ministry it belongs to when both match).
// Acronyms too short or too word-like to match safely on their own ("OIL",
// "REC", "SAIL" — an audit line saying "sail" is not Steel Authority).
const UNSAFE_SHORT = new Set(["sail", "oil", "rec", "sci", "cil", "bel", "nha", "mdl", "hll", "post", "niti"]);
const safeShort = (s) => {
  const k = norm(s);
  return /^[a-z]{4,}$/.test(k) && !UNSAFE_SHORT.has(k) ? k : null;
};
// Distinctive whole phrases (acronym + alias spellings) that identify an org on
// their own, so "tender floated by NHAI" resolves even though the entry's
// tokens spell out the full name.
for (const o of ORGS) {
  const phrases = new Set();
  const short = safeShort(o.short ?? "");
  if (short) phrases.add(short);
  for (const a of o.aliases ?? []) { const k = norm(a); if (k.split(" ").length >= 2) phrases.add(k); }
  o._phrases = [...phrases];
}

export function resolveOrg(freeText, { kinds = null } = {}) {
  const t = norm(freeText);
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const o of ORGS) {
    if (kinds && !kinds.includes(o.kind)) continue;
    // Two ways to match: the token rule, or a distinctive whole phrase.
    let words = 0;
    const tokensOk = o.tokens.every((tok) => hasTok(t, tok)) &&
      !(o.any && o.any.length && !o.any.some((tok) => hasTok(t, tok)));
    if (tokensOk) words = o.tokens.reduce((n, tok) => n + tok.split(" ").length, 0);
    for (const p of o._phrases) {
      if (hasTok(t, p)) words = Math.max(words, p.split(" ").length + 1); // a named identity beats a token pileup
    }
    if (!words) continue;
    const score = words + (o.scope !== "union" ? 1 : 0) + (o.parent ? 1 : 0);
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return best;
}
