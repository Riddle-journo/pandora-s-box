// Phase-0 open-data plumbing — the low-friction entry points that need no scraping.
// Three primitives, one house style (fail-soft: null/[] on any error, never throw
// on network). These are the EASIEST government-activity feeds in the country:
//
//   • CKAN Action API  — Open Budgets India, Justice Hub. Standard, keyless reads.
//   • OGD resource API — api.data.gov.in/resource/{id}. Free key, JSON/CSV, filters.
//
// Corruption use is baseline/denominator data (budget-vs-actual, per-district
// spend, scheme allocation vs beneficiary counts) — mostly match:"none" facts that
// give the anomaly engine a ratio to flag outliers against, not per-politician
// evidence. See GOVACTION-SOURCES-PLAN.md Phase 0.
//
// CAVEAT baked in: an OGD "resource" is an uploaded SNAPSHOT, not a live feed — its
// updated_date varies wildly per dataset. Callers should read the meta timestamp
// (ogdResourceMeta) and schedule freshness checks per-resource, not assume live.

import { UA } from "./http.js";
import { dataGovKey } from "../config.js";

// ── known portals ────────────────────────────────────────────────────────────
// CKAN portals we target. Same code path works for any CKAN host; these are the
// two verified high-value Indian ones. (Open Budgets India sits behind a WAF that
// 403s datacenter IPs — the connector is correct; run it from a residential/India
// route. Justice Hub answers cleanly.)
export const CKAN_PORTALS = {
  openbudgetsindia: "https://openbudgetsindia.org",
  justicehub: "https://justicehub.in",
};

// data.gov.in ships a public, rate-limited SAMPLE key that every doc uses; it works
// for real reads. Prefer a private key via OGD_API_KEY (higher limits) when set.
export const OGD_HOST = "https://api.data.gov.in";
const OGD_SAMPLE_KEY = "579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b";
export const ogdKey = () => process.env.OGD_API_KEY || dataGovKey() || OGD_SAMPLE_KEY;

// ── low-level JSON GET (own copy so we can vary timeout + tolerate non-2xx) ────
// http.js#fetchJson is fine but fixes a 15s timeout and swallows the status; CKAN
// and OGD both need a longer budget and we want to distinguish "blocked" (403/503)
// from "empty" for the caller's logs. Returns {ok, status, json} — json null on any
// parse/network failure.
async function getJson(url, { timeoutMs = 25000, headers = {} } = {}) {
  try {
    const res = await fetch(url, {
      headers: { ...UA, Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch { /* html error page etc. */ }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

// ── CKAN ─────────────────────────────────────────────────────────────────────

// PURE. Build a CKAN Action API URL. `action` e.g. "package_search"; params is a
// flat object → query string (arrays joined, undefined dropped).
export function ckanUrl(baseUrl, action, params = {}) {
  const u = new URL(`/api/3/action/${action}`, baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return u.href;
}

// PURE. Normalize a CKAN package_search result into flat dataset records. CKAN
// nests the real payload under result.results; each dataset's downloadable files
// live in .resources[] (id is the datastore/OGD-style resource id). Never throws.
export function normalizeCkanDatasets(body) {
  const results = body?.result?.results;
  if (!Array.isArray(results)) return [];
  return results.map((d) => ({
    id: d.id ?? null,
    name: d.name ?? null,
    title: d.title ?? d.name ?? null,
    notes: (d.notes ?? "").replace(/\s+/g, " ").trim(),
    org: d.organization?.title ?? d.organization?.name ?? null,
    modified: d.metadata_modified ?? null,
    num_resources: d.num_resources ?? (d.resources?.length ?? 0),
    resources: (d.resources ?? []).map((r) => ({
      id: r.id ?? null,
      name: r.name ?? null,
      format: (r.format ?? "").toUpperCase(),
      url: r.url ?? null,
      datastore_active: !!r.datastore_active,
    })),
  }));
}

// Search a CKAN portal's dataset catalogue. Returns {count, datasets, blocked}.
// blocked:true flags a WAF/permission wall (403/503) so the caller can report it
// distinctly from "0 results".
export async function ckanPackageSearch(baseUrl, { q = "", rows = 50, start = 0, fq = null } = {}) {
  const url = ckanUrl(baseUrl, "package_search", { q, rows, start, fq });
  const { ok, status, json } = await getJson(url);
  if (!ok || json?.success !== true) {
    return { count: 0, datasets: [], blocked: status === 403 || status === 503, status };
  }
  return { count: json.result?.count ?? 0, datasets: normalizeCkanDatasets(json), blocked: false, status };
}

// Pull actual ROWS from a CKAN datastore-backed resource (resource.datastore_active).
// Returns {total, records, fields} or nulls on failure. `filters` is a plain object
// {col:value}; CKAN wants it JSON-encoded.
export async function ckanDatastoreSearch(baseUrl, { resourceId, q = null, limit = 100, offset = 0, filters = null } = {}) {
  const params = { resource_id: resourceId, limit, offset, q };
  if (filters) params.filters = JSON.stringify(filters);
  const url = ckanUrl(baseUrl, "datastore_search", params);
  const { ok, json } = await getJson(url);
  if (!ok || json?.success !== true) return { total: 0, records: [], fields: [] };
  const r = json.result ?? {};
  return { total: r.total ?? 0, records: r.records ?? [], fields: (r.fields ?? []).map((f) => f.id) };
}

// ── OGD (api.data.gov.in) ─────────────────────────────────────────────────────

// PURE. Build an OGD resource URL. `filters` {field:value} → filters[field]=value;
// `fields` array → comma list. Injects the api-key + json format.
export function ogdUrl(resourceId, { limit = 100, offset = 0, filters = null, fields = null, apiKey = null } = {}) {
  const u = new URL(`/resource/${resourceId}`, OGD_HOST);
  u.searchParams.set("api-key", apiKey || ogdKey());
  u.searchParams.set("format", "json");
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  if (fields?.length) u.searchParams.set("fields", fields.join(","));
  if (filters) for (const [k, v] of Object.entries(filters)) u.searchParams.set(`filters[${k}]`, String(v));
  return u.href;
}

// One page of an OGD resource. Returns {total, records, updated, active} — records
// [] on failure. `updated` is the snapshot's updated_date (the freshness signal).
export async function ogdResource(resourceId, opts = {}) {
  const { ok, json } = await getJson(ogdUrl(resourceId, opts));
  if (!ok || !json) return { total: 0, records: [], updated: null, active: null };
  return {
    total: Number(json.total ?? json.count ?? 0),
    records: json.records ?? [],
    updated: json.updated_date ?? null,
    active: json.active ?? null,
    title: json.title ?? null,
    org: json.org ?? null,
  };
}

// Metadata-only probe (limit=0-ish): title/org/total/updated without pulling rows.
// Use to check freshness + row count before deciding to ingest.
export async function ogdResourceMeta(resourceId) {
  const { total, updated, active, title, org } = await ogdResource(resourceId, { limit: 1 });
  return { resourceId, total, updated, active, title, org };
}

// Page through an entire OGD resource (bounded by maxRows to stay polite). Yields a
// flat records[] array. Advances the offset by the ACTUAL rows returned, not the
// requested pageSize — the OGD API caps a page well below the asked limit (the
// public sample key returns only 10/request; a private OGD_API_KEY raises it), so a
// fixed-stride loop would silently skip rows. Stops on an empty page or maxRows.
export async function ogdResourceAll(resourceId, { pageSize = 1000, maxRows = 20000, filters = null, fields = null } = {}) {
  const out = [];
  let offset = 0;
  // Guard against a pathological all-empty loop: cap iterations relative to maxRows.
  for (let iter = 0; out.length < maxRows && iter < maxRows + 10; iter++) {
    const limit = Math.min(pageSize, maxRows - out.length);
    const { records, total } = await ogdResource(resourceId, { limit, offset, filters, fields });
    if (!records.length) break;
    out.push(...records);
    offset += records.length;
    if (out.length >= (total || Infinity)) break;
  }
  return out.slice(0, maxRows);
}

// Discover OGD resources by TITLE keyword via the catalog `/lists` endpoint (the
// only working search: filters[title]=). Returns [{id, title, org, sector, source,
// updated, fields}] — `fields` is the column schema, so a ledger mapping can be
// built without pulling rows. id (index_name) plugs straight into ogdResource.
export async function ogdListSearch(titleQuery, { limit = 20, apiKey = null } = {}) {
  const u = new URL("/lists", OGD_HOST);
  u.searchParams.set("api-key", apiKey || ogdKey());
  u.searchParams.set("format", "json");
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("filters[title]", titleQuery);
  const { ok, json } = await getJson(u.href);
  if (!ok || !json?.records) return { total: 0, resources: [] };
  return {
    total: Number(json.total ?? 0),
    resources: json.records.map((r) => ({
      id: r.index_name ?? null,
      title: r.title ?? null,
      org: Array.isArray(r.org) ? r.org.join(" / ") : (r.org ?? null),
      sector: Array.isArray(r.sector) ? r.sector.join(" / ") : (r.sector ?? null),
      source: r.source ?? null,
      updated: r.updated_date ?? null,
      active: r.active ?? null,
      fields: (r.field ?? []).map((f) => (typeof f === "string" ? f : (f.id ?? f.name ?? null))).filter(Boolean),
    })),
  };
}

// ── ledger-mapping helpers (row → fact) ──────────────────────────────────────
// PURE. Build the subject-entity NAME for a row from a mapping. `subject.field`
// (single) or `subject.fields` (composite, joined by sep) → the entity name whose
// facts these become. Composite keys matter: a denominator's natural grain is often
// (state,district,market,commodity), and each distinct tuple must be its own entity
// so per-period values don't collide. Returns null when no key part is present.
export function composeSubject(row, subject = {}) {
  const fields = subject.fields ?? (subject.field ? [subject.field] : []);
  const parts = fields.map((f) => String(row?.[f] ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(subject.sep ?? " / ") : null;
}

// PURE. Coerce a messy cell ("1,23,456", "₹ 45.5", "12%", "", "-", "NA") into a
// finite number or null. Government CSV/JSON numbers arrive as strings with commas,
// currency marks, and stray units; a denominator fact needs a real number or none.
export function coerceNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s₹]/g, "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === "." || s === "-.") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// PURE. Normalize a period value. format:"dmy" turns DD/MM/YYYY (or DD-MM-YYYY),
// the common Indian government date form, into ISO YYYY-MM-DD so it sorts and
// dedupes correctly as a fact's as_of_date. Anything else passes through trimmed.
export function normPeriodValue(v, format) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (format === "dmy") {
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return s;
}

// PURE. The core row→fact mapping: given one fetched row and a source's `ledger`
// mapping, return the fact specs it yields — one per numeric metric present. No DB,
// no side effects, so it's fully unit-testable; mega-ingest resolves the subject to
// an entity id and upserts each spec. Returns [] when the row has no subject key or
// no usable numeric metric (both are normal — skip, don't error).
//   ledger = { subject:{fields|field, kind, sep}, periodField|period, periodFormat,
//              metrics:[{field, metric, unit}] }
export function rowToFactSpecs(row, ledger = {}) {
  const name = composeSubject(row, ledger.subject);
  if (!name) return [];
  const kind = ledger.subject?.kind ?? "place";
  // Period: static `period`, a single `periodField`, or a composite `periodFields`
  // (e.g. [fin_year, month] → "2024-2025-Dec") joined so a monthly series doesn't
  // collapse per year. periodFormat applies to each part.
  let period;
  if (ledger.periodFields) {
    const parts = ledger.periodFields.map((f) => normPeriodValue(row[f], ledger.periodFormat)).filter(Boolean);
    period = parts.length ? parts.join("-") : null;
  } else if (ledger.periodField) {
    period = normPeriodValue(row[ledger.periodField], ledger.periodFormat);
  } else {
    period = ledger.period ?? null;
  }
  const specs = [];
  for (const m of ledger.metrics ?? []) {
    const value = coerceNumber(row[m.field]);
    if (value == null) continue;
    specs.push({ name, kind, metric: m.metric, value, unit: m.unit ?? null, period });
  }
  return specs;
}
