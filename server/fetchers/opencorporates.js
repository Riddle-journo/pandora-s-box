// OpenCorporates officer search (C.6, OPTIONAL) — the adult-relative → company
// link the free MCA director index can't always give. Free tier is ~500 calls/
// month, so this is called ONLY inside investigator.js, on the handful of top-lead
// relatives, and every response is CACHED in the `meta` table so a repeated name
// never spends a second call. Population-scale use is forbidden (Rule: L2 top-N).
//
// Needs env OPENCORPORATES_API_TOKEN. Without it (or on any error) returns [].
import { getMeta, setMeta } from "../store.js";

const CACHE_PREFIX = "oc_officer:";

export async function searchOfficers(name, { timeoutMs = 12000, jurisdiction = "in" } = {}) {
  if (process.env.OPENCORPORATES_DISABLE === "1") return [];
  const token = process.env.OPENCORPORATES_API_TOKEN;
  const needle = String(name ?? "").trim();
  if (!token || needle.length < 4) return [];

  // Quota guard: serve from cache when we've looked this name up before.
  const cacheKey = CACHE_PREFIX + needle.toLowerCase();
  const cached = getMeta(cacheKey, null);
  if (cached) { try { return JSON.parse(cached); } catch { return []; } }

  const url = `https://api.opencorporates.com/v0.4/officers/search?q=${encodeURIComponent(needle)}&jurisdiction_code=${encodeURIComponent(jurisdiction)}&api_token=${encodeURIComponent(token)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "Accept": "application/json" }, signal: ac.signal });
    if (!r.ok) { setMeta(cacheKey, "[]"); return []; }
    const j = await r.json().catch(() => null);
    const officers = (j?.results?.officers ?? []).map((o) => o.officer).filter(Boolean).map((o) => ({
      name: o.name, position: o.position ?? "", company_name: o.company?.name ?? "",
      company_number: o.company?.company_number ?? "", jurisdiction: o.company?.jurisdiction_code ?? "",
      opencorporates_url: o.opencorporates_url ?? "",
    }));
    setMeta(cacheKey, JSON.stringify(officers));
    return officers;
  } catch { return []; }
  finally { clearTimeout(t); }
}
