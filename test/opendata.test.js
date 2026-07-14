// Phase-0 open-data plumbing tests. Pure-function coverage (URL builders, response
// normalization, catalogue scoring/merge) runs offline and deterministic. Two live
// smoke tests hit the real endpoints ONLY when OPENDATA_LIVE=1, so `npm test` never
// depends on the network.
import test from "node:test";
import assert from "node:assert/strict";

const {
  ckanUrl, normalizeCkanDatasets, ogdUrl, ogdKey, OGD_HOST,
  ckanPackageSearch, ogdResource,
  composeSubject, coerceNumber, normPeriodValue, rowToFactSpecs,
} = await import("../server/fetchers/opendata.js");
const { scoreDataset, mergeHits, discover } = await import("../server/opendata-catalog.js");

// ── CKAN URL + normalization ─────────────────────────────────────────────────
test("ckanUrl builds action path + drops null params", () => {
  const u = ckanUrl("https://justicehub.in", "package_search", { q: "tender", rows: 5, fq: null });
  assert.match(u, /\/api\/3\/action\/package_search\?/);
  assert.match(u, /q=tender/);
  assert.match(u, /rows=5/);
  assert.ok(!u.includes("fq="), "null params must be omitted");
});

test("normalizeCkanDatasets flattens results + resources, tolerates junk", () => {
  const body = {
    result: { results: [{
      id: "d1", name: "n1", title: "Tender Awards 2023",
      notes: "  multi\n  line ", organization: { title: "PWD" },
      metadata_modified: "2024-01-01", num_resources: 1,
      resources: [{ id: "r1", format: "csv", url: "u", datastore_active: true }],
    }] },
  };
  const [d] = normalizeCkanDatasets(body);
  assert.equal(d.id, "d1");
  assert.equal(d.org, "PWD");
  assert.equal(d.notes, "multi line", "whitespace collapsed");
  assert.equal(d.resources[0].format, "CSV", "format upcased");
  assert.equal(d.resources[0].datastore_active, true);
  assert.deepEqual(normalizeCkanDatasets(null), [], "null body → []");
  assert.deepEqual(normalizeCkanDatasets({ result: {} }), [], "no results → []");
});

// ── OGD URL builder ──────────────────────────────────────────────────────────
test("ogdUrl injects key/format and encodes filters + fields", () => {
  const u = new URL(ogdUrl("RID", { limit: 10, offset: 20, filters: { state: "Bihar" }, fields: ["a", "b"] }));
  assert.equal(u.origin + u.pathname, `${OGD_HOST}/resource/RID`);
  assert.equal(u.searchParams.get("api-key"), ogdKey());
  assert.equal(u.searchParams.get("format"), "json");
  assert.equal(u.searchParams.get("limit"), "10");
  assert.equal(u.searchParams.get("offset"), "20");
  assert.equal(u.searchParams.get("filters[state]"), "Bihar");
  assert.equal(u.searchParams.get("fields"), "a,b");
});

test("ogdKey prefers OGD_API_KEY when set", () => {
  const saved = process.env.OGD_API_KEY;
  process.env.OGD_API_KEY = "mykey123";
  assert.equal(ogdKey(), "mykey123");
  if (saved == null) delete process.env.OGD_API_KEY; else process.env.OGD_API_KEY = saved;
});

// ── catalogue scoring + merge ────────────────────────────────────────────────
test("scoreDataset rewards signal + entity + datastore, penalises glossary", () => {
  const rich = scoreDataset({
    title: "Contract awards by vendor", notes: "supplier name and district",
    resources: [{ format: "CSV", datastore_active: true }],
  });
  const poor = scoreDataset({ title: "Metadata dictionary", notes: "definition glossary", resources: [] });
  assert.ok(rich >= 7, `rich dataset should score high, got ${rich}`);
  assert.ok(poor < 0, `glossary should score negative, got ${poor}`);
  assert.ok(rich > poor);
});

test("mergeHits dedupes by portal:id, keeps best score, unions stages", () => {
  const merged = mergeHits([
    { portal: "p", id: "x", score: 2, stage: "procurement", stages: ["procurement"] },
    { portal: "p", id: "x", score: 5, stage: "oversight", stages: ["oversight"] },
    { portal: "p", id: "y", score: 1, stage: "intent", stages: ["intent"] },
  ]);
  assert.equal(merged.length, 2, "same portal:id collapses");
  assert.equal(merged[0].id, "x", "sorted by score desc");
  assert.equal(merged[0].score, 5, "kept the higher score");
});

// ── ledger mapping (row → fact) ──────────────────────────────────────────────
test("composeSubject joins composite key fields, drops blanks, null when empty", () => {
  const row = { state: "Bihar", district: "Khagaria", market: "", commodity: "Onion" };
  assert.equal(composeSubject(row, { fields: ["state", "district", "market", "commodity"] }), "Bihar / Khagaria / Onion");
  assert.equal(composeSubject(row, { field: "district" }), "Khagaria");
  assert.equal(composeSubject(row, { fields: ["market"] }), null, "all-blank → null");
  assert.equal(composeSubject({}, { fields: ["x"] }), null);
});

test("coerceNumber strips commas/currency/units, rejects junk", () => {
  assert.equal(coerceNumber("1,23,456"), 123456);
  assert.equal(coerceNumber("₹ 45.5"), 45.5);
  assert.equal(coerceNumber("12%"), 12);
  assert.equal(coerceNumber(1633.33), 1633.33);
  for (const junk of ["", "-", "NA", "N/A", null, undefined, "abc"]) assert.equal(coerceNumber(junk), null, `${junk} → null`);
});

test("normPeriodValue converts DD/MM/YYYY to ISO, passes others through", () => {
  assert.equal(normPeriodValue("14/07/2026", "dmy"), "2026-07-14");
  assert.equal(normPeriodValue("1-2-2025", "dmy"), "2025-02-01");
  assert.equal(normPeriodValue("2023-24", null), "2023-24", "financial-year label untouched");
  assert.equal(normPeriodValue("", "dmy"), null);
});

test("rowToFactSpecs yields one spec per numeric metric, skips missing", () => {
  const ledger = {
    subject: { fields: ["market", "commodity"], kind: "market_commodity" },
    periodField: "arrival_date", periodFormat: "dmy",
    metrics: [
      { field: "modal_price", metric: "mandi_modal_price", unit: "INR/quintal" },
      { field: "min_price", metric: "mandi_min_price", unit: "INR/quintal" },
      { field: "max_price", metric: "mandi_max_price", unit: "INR/quintal" }, // missing in row
    ],
  };
  const specs = rowToFactSpecs({ market: "Khagaria APMC", commodity: "Onion", arrival_date: "14/07/2026", modal_price: "1,633", min_price: 1533 }, ledger);
  assert.equal(specs.length, 2, "only the two present numeric metrics");
  assert.deepEqual(specs[0], { name: "Khagaria APMC / Onion", kind: "market_commodity", metric: "mandi_modal_price", value: 1633, unit: "INR/quintal", period: "2026-07-14" });
  assert.deepEqual(rowToFactSpecs({ commodity: "Onion" }, ledger), [], "no subject key → []");
});

// ── live smoke (opt-in) ──────────────────────────────────────────────────────
const live = process.env.OPENDATA_LIVE === "1";
test("LIVE: Justice Hub CKAN returns datasets", { skip: !live }, async () => {
  const { count, datasets, blocked } = await ckanPackageSearch("https://justicehub.in", { q: "police", rows: 3 });
  assert.equal(blocked, false);
  assert.ok(count > 0 && datasets.length > 0, "expected live CKAN hits");
});

test("LIVE: data.gov.in OGD resource returns rows", { skip: !live }, async () => {
  const { records, updated } = await ogdResource("9ef84268-d588-465a-a308-a864a43d0070", { limit: 2 });
  assert.ok(Array.isArray(records) && records.length > 0, "expected live OGD rows");
  assert.ok(updated, "expected a freshness timestamp");
});

test("LIVE: discover() reaches at least one portal", { skip: !live }, async () => {
  const { datasets, portalStatus } = await discover({ log: () => {}, rowsPerTerm: 5 });
  const anyReached = Object.values(portalStatus).some((p) => p.reached);
  assert.ok(anyReached, "at least one CKAN portal should be reachable");
  assert.ok(Array.isArray(datasets));
});
