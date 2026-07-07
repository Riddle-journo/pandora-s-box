// The join vocabulary — one authoritative sector taxonomy that everything maps
// onto. The whole conflict-of-interest engine works by JOINING a politician's
// power-sectors (ministries, questions) against their interest-sectors
// (companies, assets, donors). That join is only possible if both sides speak
// the SAME sector words — this file is that shared dictionary.
//
// Both mappers return EXACTLY ONE sector string, or null. First keyword hit
// wins — never a partial/overlapping list.

export const SECTORS = [
  "energy", "infrastructure", "mining", "pharma", "telecom", "realestate",
  "banking_finance", "defence", "agriculture", "education", "health",
  "transport", "media", "liquor", "gaming", "fmcg", "steel", "power",
  "it", "textiles",
];

// Ordered keyword table for a MINISTRY / department name. Order matters:
// the more specific / higher-signal patterns come first so a name like
// "Ministry of Road Transport and Highways" resolves to transport, not a
// generic later hit. Covers the ~25 Union ministries plus common variants.
const MINISTRY_RULES = [
  [/road|highway|transport|railway|\brail\b|port|shipping|waterway|aviation|airport|civil aviation/, "transport"],
  [/petroleum|natural gas|coal|\bpower\b|electricity|renewable|\benergy\b|ethanol|thermal|solar|wind/, "energy"],
  [/\bmines\b|mining|mineral/, "mining"],
  [/health|pharma|medical|family welfare/, "pharma"],
  [/telecom|communication|spectrum/, "telecom"],
  [/housing|urban affairs|urban development/, "realestate"],
  [/finance|\bbank|corporate affairs|company affairs/, "banking_finance"],
  [/defence|defense/, "defence"],
  [/agricultur|farmer|fisheries|animal husbandry/, "agriculture"],
  [/education|school|skill development|higher education/, "education"],
  [/electronics|information technology|\bit\b|meity/, "it"],
  [/textile/, "textiles"],
  [/steel|heavy industr/, "steel"],
  [/broadcast|information and broadcasting/, "media"],
  [/jal shakti|water resources|drinking water/, "infrastructure"],
  [/commerce|industry|micro small|msme/, "infrastructure"],
  [/consumer affairs|\bfood\b|public distribution|food processing/, "fmcg"],
];

// Broader keyword table for FREE TEXT — question subjects, company/firm names,
// donor descriptions. Includes commodity words (sugar/ethanol → energy,
// cement → infrastructure) so a company name alone can be sector-tagged.
const TEXT_RULES = [
  [/ethanol|sugar|distiller|petroleum|\boil\b|natural gas|\bgas\b|\bcoal\b|\bpower\b|electricity|solar|wind|renewable|\benergy\b|thermal|hydro/, "energy"],
  [/liquor|alcohol|brewery|\bwine\b|spirits|\bbeer\b|imfl/, "liquor"],
  [/casino|gaming|gambling|lottery|betting|\brummy\b/, "gaming"],
  [/cement|construction|\bbridge\b|\bdam\b|\bepc\b|infrastructure/, "infrastructure"],
  [/\bmine\b|mining|\bore\b|mineral|bauxite|granite|sand mining/, "mining"],
  [/pharma|\bdrug\b|medicine|hospital|\bmedical\b|vaccine|diagnostic|healthcare/, "pharma"],
  [/telecom|spectrum|\bmobile\b|broadband|\b[45]g\b|cellular/, "telecom"],
  [/real estate|realty|\bland\b|\bproperty\b|housing|township|\bplot\b|developer|infratech|buildcon/, "realestate"],
  [/\bbank\b|finance|nbfc|\bloan\b|insurance|mutual fund|capital\b|fintech|securities/, "banking_finance"],
  [/defence|defense|\barms\b|ammunition|missile|military|ordnance/, "defence"],
  [/agri|\bfarm\b|\bcrop\b|\bseed\b|fertiliz|pesticide|dairy|poultry|agro/, "agriculture"],
  [/education|\bschool\b|college|university|edtech|coaching/, "education"],
  [/railway|highway|\broad\b|\bport\b|shipping|aviation|airline|logistics|\btravel\b|transport/, "transport"],
  [/media|broadcast|\bnews\b|television|\bfilm\b|entertainment|\bott\b|publishing/, "media"],
  [/steel|\biron\b|metallurg/, "steel"],
  [/textile|garment|apparel|\bcotton\b|\byarn\b|spinning/, "textiles"],
  [/software|\bit services\b|infotech|technology|semiconductor|data cent(er|re)|electronics/, "it"],
  [/fmcg|consumer goods|beverage|\bfood\b|snacks|confection/, "fmcg"],
];

function firstMatch(rules, text) {
  const s = String(text ?? "").toLowerCase();
  if (!s) return null;
  for (const [re, sector] of rules) if (re.test(s)) return sector;
  return null;
}

export function ministryToSector(ministryText) {
  return firstMatch(MINISTRY_RULES, ministryText);
}

export function textToSector(text) {
  return firstMatch(TEXT_RULES, text);
}
