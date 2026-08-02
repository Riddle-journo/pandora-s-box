// MCA Company Master registry cross-check (data.gov.in, free with key).
//
// The RUBLI lesson: the strongest signals come from cross-referencing names
// against OFFICIAL registries. This fetcher takes the companies a politician
// declared (extracted into the latest report's `companies[]`) and verifies each
// against the Ministry of Corporate Affairs Company Master Data — 3.67M
// companies, live-queryable by exact name. It returns each company's CIN,
// registrar STATUS (Active / Strike Off / Dormant…), and paid-up capital.
//
// A "Strike Off" hit becomes the deterministic STRUCK_OFF_COMPANY_LINK flag in
// analyzer.js. Exact-name matching keeps false positives near zero — a fuzzy
// match against 3.67M companies would be noise, which this project can't afford.
//
// Bootstrap note: company names come from the politician's LATEST REPORT, so the
// first-ever report for a rep has no registry check; the next run (incremental/
// recheck) verifies what that report extracted. This is by design — names are
// extracted once by the LLM from the affidavit, then verified forever in code.
import { latestReport } from "../store/store.js";
import { fetchJson } from "./http.js";
import { dataGovKey } from "../platform/config.js";
import { noteFetchFailure } from "./observe.js";

const RESOURCE = "4dbe5667-7b6b-41d7-82af-211562424d9a"; // RoC-wise Company Master Data
const API = `https://api.data.gov.in/resource/${RESOURCE}`;

// Normalise a declared name toward registry style: uppercase, collapse spaces,
// expand the near-universal "PVT LTD" abbreviations.
function registryName(name) {
  return String(name ?? "").toUpperCase().replace(/\./g, " ")
    .replace(/\(P\)/g, "PRIVATE")
    .replace(/\bPVT\b/g, "PRIVATE").replace(/\bLTD\b/g, "LIMITED")
    .replace(/\s+/g, " ").trim();
}

// The MCA Company Master resource is not 100% consistent about field casing
// across mirrors; pick the first non-empty among the plausible keys.
function pick(rec, ...keys) {
  for (const k of keys) {
    const v = rec?.[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// A registered-office address ends in a 6-digit PIN; take the LAST such group
// (the PIN is at the tail, after the state — earlier 6-digit runs would be noise).
function pincodeFrom(addr) {
  const m = String(addr ?? "").match(/\d{6}/g);
  return m ? m[m.length - 1] : "";
}

// Affidavits and the registry disagree on small things ("&" vs "AND"); try a
// couple of spellings — the API is exact-match, so a wrong variant just misses.
function nameVariants(name) {
  const base = registryName(name);
  const out = new Set([base]);
  if (base.includes("&")) out.add(base.replace(/&/g, "AND").replace(/\s+/g, " ").trim());
  if (/\bAND\b/.test(base)) out.add(base.replace(/\bAND\b/g, "&").replace(/\s+/g, " ").trim());
  return [...out];
}

// Verify ONE company name against the MCA Company Master registry. Tries the
// spelling variants, exact-match-validates each returned record (never trusting
// the API's own matching), and returns the first confirmed record — or null.
// Exported (Phase 3): the directorship graph reuses this to registry-check the
// companies discovered from court/leak/press evidence, so the "declared-company"
// path (this fetcher) and the "discovered-company" path share ONE MCA lookup.
export async function verifyCompanyName(name, { key = dataGovKey(), timeoutMs = 15000 } = {}) {
  if (!key || !name || String(name).trim().length < 6) return null;
  const seen = new Set();
  for (const q of nameVariants(name)) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    let d;
    try {
      d = await fetchJson(`${API}?api-key=${key}&format=json&limit=3&filters%5BCompanyName%5D=${encodeURIComponent(q)}`, { timeoutMs, source: "company_registry" });
    } catch (err) {
      // Skipping one name variant is fine; skipping ALL of them and returning
      // null reads downstream as "this company is not registered".
      noteFetchFailure("company_registry", "mca_lookup", err, { query: q });
      continue;
    }
    for (const r of d?.records ?? []) {
      // Belt-and-braces: only accept a record whose name really IS the one we
      // asked for — never trust the API's matching semantics blindly.
      if (registryName(r.CompanyName) !== q) continue;
      const registered_address = pick(r, "Registered_Office_Address", "registered_office_address", "RegisteredOfficeAddress", "Registered_Office");
      return {
        name: r.CompanyName, cin: r.CIN, status: r.CompanyStatus ?? "",
        paidup_capital: Number(r.PaidupCapital) || null,
        state: r.CompanyStateCode ?? "", registered: r.CompanyRegistrationdate_date ?? "",
        registered_address,
        pincode: pincodeFrom(registered_address),
        industrial_classification: pick(r, "CompanyIndustrialClassification", "industrial_classification", "PrincipalBusinessActivityasperCIN", "nic_code"),
        source_url: `https://www.mca.gov.in/mcafoportal/viewCompanyMasterData.do`,
      };
    }
  }
  return null;
}

export async function fetchCompanyRegistry(p) {
  const key = dataGovKey();
  if (!key || process.env.COMPANY_REGISTRY_DISABLE === "1") return [];

  // Company names the last investigation extracted from the sworn affidavit.
  const declared = (latestReport(p.id)?.companies ?? [])
    .map((c) => ({ name: c.name, relation: c.relation ?? "" }))
    .filter((c) => c.name && c.name.length >= 6);
  if (!declared.length) return [];

  const verified = [];
  for (const c of declared.slice(0, 8)) {
    const rec = await verifyCompanyName(c.name, { key });
    if (rec) verified.push({ ...rec, declared_relation: c.relation });
  }
  if (!verified.length) return [];

  const lines = [
    `MCA COMPANY REGISTRY VERIFICATION — ${verified.length} declared compan${verified.length > 1 ? "ies" : "y"} matched in the official Ministry of Corporate Affairs master data:`,
    ...verified.map((v) => `• ${v.name} (CIN ${v.cin}) — STATUS: ${v.status}${v.paidup_capital ? `; paid-up capital ₹${(v.paidup_capital / 1e7).toFixed(2)} Cr` : ""}${v.registered ? `; registered ${v.registered}` : ""}${v.declared_relation ? `; declared relation: ${v.declared_relation}` : ""}`),
  ];

  return [{
    politician_id: p.id,
    source_type: "mca_company",
    tier: 6,
    admissible: true,
    title: `MCA registry verification of declared companies — ${p.name}`,
    url: `https://www.data.gov.in/resource/registrars-companies-roc-wise-company-master-data`,
    date: null,
    summary: `${verified.length} declared company(ies) verified against the official MCA Company Master registry (status, CIN, capital).`,
    content: lines.join("\n"),
    numbers: { companies: verified },
  }];
}
