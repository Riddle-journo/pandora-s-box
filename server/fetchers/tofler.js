// Tofler director enrichment — SELECTIVE, never a crawl.
//
// Tofler (tofler.in) publishes server-rendered company & director pages with NO
// login/captcha, so a plain HTTP GET + HTML parse works (unlike Zauba, which
// 403s bots). We only ever hit it for a company that a detector has already
// FLAGGED (a company-bearing lead), so this stays a targeted per-company lookup.
//
// URL shape (observed):
//   company : https://www.tofler.in/{name-slug}/company/{CIN}/directors
//   director: https://www.tofler.in/{name-slug}/director/{DIN}
// The CIN is the hard key; the name-slug is cosmetic. A director on a company
// page is an anchor whose href carries the 8-digit DIN, which is what we parse.
//
// Everything here is fail-silent (network/parse error → null / []), matching the
// other fetchers, and fetchToflerDirectors takes an injectable fetchImpl so the
// tests never touch the network.
import { fetchText } from "./http.js";
import { noteFetchFailure } from "./observe.js";

const TOFLER = "https://www.tofler.in";

// A CIN looks like L//U + 5 digits + 2 state letters + 4 year digits + ... (21 ch).
const CIN_RE = /\b([LUu]\d{5}[A-Za-z]{2}\d{4}[A-Za-z]{3}\d{6})\b/;

export const isCin = (s) => CIN_RE.test(String(s ?? ""));

// Slugify a company name the Tofler way: lowercase, non-alphanumerics → hyphens.
export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "company";
}

// Stable dedup key for a target: its CIN (uppercased) when known, else name slug.
export function companyKey({ name, cin } = {}) {
  if (cin && isCin(cin)) return String(cin).toUpperCase();
  return `name:${slugify(name)}`;
}

// The directors-tab URL for a company. Needs a CIN; the slug is cosmetic filler.
export function companyDirectorsUrl({ name, cin }) {
  if (!cin || !isCin(cin)) return null;
  return `${TOFLER}/${slugify(name || "company")}/company/${String(cin).toUpperCase()}/directors`;
}

// ── Lead → company targets ────────────────────────────────────────────────
// Map any company-bearing lead to the concrete company(ies) it points at.
// Returns [{ name, cin }] (either field may be absent, never both).
export function companyTargetsFromLead(lead) {
  if (!lead) return [];
  const out = [];
  const push = (name, cin) => {
    const n = name ? String(name).trim() : null;
    const c = cin && isCin(cin) ? String(cin).toUpperCase() : null;
    if (c || (n && n.length >= 4)) out.push({ name: n, cin: c });
  };

  switch (lead.beneficiary_kind) {
    case "company":
      // conflict.js emits beneficiary = company name; a CIN may ride alongside.
      push(lead.beneficiary, lead.beneficiary_cin ?? lead.cin);
      break;
    case "company_cluster":
      // collusion.js attaches the full cluster with per-member {name, cin}.
      for (const m of lead.cluster?.members ?? []) push(m.name, m.cin);
      break;
    case "tender":
      // anomaly.js awarded_tender: the awardee is the company that won.
      push(lead.awardee_name, isCin(lead.awardee_entity_id) ? lead.awardee_entity_id : null);
      break;
    default:
      break;
  }

  // Dedup within this lead by company key.
  const seen = new Set();
  return out.filter((t) => {
    const k = companyKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── HTML parse ─────────────────────────────────────────────────────────────
// Pull directors out of a Tofler company page. A director is any anchor linking
// to a /{slug}/director/{DIN} profile; the DIN is the 6–8 digit tail, the anchor
// text is the name. Dedup by DIN. Pure — unit-testable against a fixture string.
export function parseToflerDirectors(html) {
  if (!html) return [];
  const re = /href="\/[a-z0-9-]+\/director\/(\d{6,8})"[^>]*>([^<]{2,120})</gi;
  const byDin = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const din = m[1].padStart(8, "0");
    const name = m[2].replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (!byDin.has(din)) byDin.set(din, { name, din });
  }
  return [...byDin.values()];
}

// Resolve a company NAME → CIN via the free MCA Company Master registry
// (data.gov.in). Tofler's own name search sits behind a per-page auth token we
// won't forge; the official MCA registry is the token-free, authoritative
// name→CIN resolver, and the codebase already talks to it. Needs DATA_GOV_IN_KEY;
// returns null (gracefully) without it. Lazy-imported so tests stay offline.
export async function resolveCinByName(name) {
  if (!name || String(name).trim().length < 6) return null;
  try {
    const { verifyCompanyName } = await import("./company-registry.js");
    const rec = await verifyCompanyName(name);
    if (rec?.cin && isCin(rec.cin)) return { cin: String(rec.cin).toUpperCase(), name: rec.name ?? name };
  } catch (err) {
    noteFetchFailure("tofler", "cin_resolve", err, { name });
  }
  return null;
}

// Fetch + parse one flagged company's directors. Returns
//   { name, cin, source_url, directors:[{name,din}], resolved_by }  on success,
//   null  when the company can't be resolved to a CIN or the parse yields nothing.
// A CIN-bearing target hits Tofler directly; a name-only target is first resolved
// to a CIN via the MCA registry. Both fetchImpl and resolveCin are injectable so
// tests never touch the network.
export async function fetchToflerDirectors({ name, cin }, { fetchImpl = fetchText, resolveCin = resolveCinByName } = {}) {
  let useCin = cin && isCin(cin) ? String(cin).toUpperCase() : null;
  let useName = name ?? null;
  const via = useCin ? "cin" : "name";
  if (!useCin && name) {
    const r = await resolveCin(name);
    if (r?.cin) { useCin = r.cin; useName = r.name ?? name; }
  }
  const url = companyDirectorsUrl({ name: useName, cin: useCin });
  if (!url) return null; // no CIN (direct or resolved) → can't build a Tofler URL
  const html = await fetchImpl(url);
  const directors = parseToflerDirectors(html);
  if (!directors.length) return null;
  return { name: useName, cin: useCin, source_url: url, directors, resolved_by: via };
}
