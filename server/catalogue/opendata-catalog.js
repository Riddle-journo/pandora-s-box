// Phase-0 discovery — turn the source MAP into concrete, ranked, ingestable dataset
// IDs. Searches the keyless CKAN portals (Open Budgets India, Justice Hub) for
// corruption-relevant government-activity datasets, scores each by how directly it
// carries a corruption signal, dedupes, and writes server/data/opendata-catalog.json
// plus a console summary. The output is the hand-off to per-dataset ingestion: each
// entry has the portal + dataset id + datastore-active resource ids you can pull
// rows from with opendata.js#ckanDatastoreSearch or #ogdResource.
//
//   node server/opendata-catalog.js            # discover + write catalog
//   node server/opendata-catalog.js --quiet     # write only, no per-dataset print
//
// Fail-soft and offline-tolerant: a blocked/unreachable portal is reported and
// skipped, never fatal. No DB writes — pure discovery, safe to run anytime.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CKAN_PORTALS, ckanPackageSearch, ogdListSearch } from "../fetchers/opendata.js";
import { sleep } from "../fetchers/http.js";
import { writeFileAtomic } from "../util/fs-atomic.js";

const OUT = path.join(process.cwd(), "server", "data", "opendata-catalog.json");

// Search terms grouped by lifecycle stage (GOVACTION-SOURCES-PLAN.md). We query
// each term against each portal's full-text package_search; the stage travels with
// every hit so the catalogue is already organised by where in the action lifecycle
// the dataset sits.
const QUERIES = [
  { stage: "procurement", terms: ["tender", "procurement", "contract award", "bid"] },
  { stage: "disbursement", terms: ["expenditure", "scheme", "subsidy", "MGNREGA", "beneficiary", "fund release", "DBT"] },
  { stage: "intent", terms: ["budget", "allocation", "grant"] },
  { stage: "allocation", terms: ["mining lease", "environmental clearance", "land", "RERA"] },
  { stage: "oversight", terms: ["audit", "CAG", "vigilance", "corruption", "debarred"] },
];

// Signal scoring: reward datasets that name WHO/WHAT/amount (the joinable stuff),
// penalise pure aggregate/definitional rows. Keyword-based, deliberately simple —
// this ranks a review queue, it doesn't decide anything.
const HIGH = /\b(tender|award|contract|bidder|vendor|supplier|beneficiary|lease|clearance|debar|blacklist|payment|transaction|expenditure|disbursement)\b/i;
const HAS_ENTITY = /\b(name|company|firm|promoter|developer|contractor|district|constituency|scheme[- ]wise|agency)\b/i;
const LOW = /\b(definition|metadata|glossary|guideline|manual|dictionary|aggregate|summary|index of)\b/i;

export function scoreDataset(d) {
  const hay = `${d.title ?? ""} ${d.notes ?? ""}`;
  let s = 0;
  if (HIGH.test(hay)) s += 3;
  if (HAS_ENTITY.test(hay)) s += 2;
  // A datastore-active resource means you can query ROWS via the API (not just
  // download a file) — that's the automatable win, so weight it.
  if (d.resources?.some((r) => r.datastore_active)) s += 2;
  if (d.resources?.some((r) => ["CSV", "JSON", "XLSX", "XLS"].includes(r.format))) s += 1;
  if (LOW.test(hay)) s -= 2;
  return s;
}

// Merge hits across queries/portals; keep the best stage+score per unique dataset.
export function mergeHits(hits) {
  const byKey = new Map();
  for (const h of hits) {
    const key = `${h.portal}:${h.id}`;
    const prev = byKey.get(key);
    if (!prev || h.score > prev.score) byKey.set(key, h);
    else if (prev && !prev.stages.includes(h.stage)) prev.stages.push(h.stage);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

// One CKAN search with a light retry — a single dropped/rate-limited request
// (status 0) shouldn't sink a whole portal. Retries only the transient case, not a
// real 403/404, and paces between attempts.
async function searchWithRetry(baseUrl, term, rows, delayMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ckanPackageSearch(baseUrl, { q: term, rows });
    if (res.status !== 0) return res;         // reached the server (200/403/…): done
    await sleep(delayMs * 3);                  // transient/network: back off then retry
  }
  return ckanPackageSearch(baseUrl, { q: term, rows });
}

export async function discover({ log = console.log, rowsPerTerm = 20, delayMs = 400 } = {}) {
  const hits = [];
  const portalStatus = {};
  for (const [portalName, baseUrl] of Object.entries(CKAN_PORTALS)) {
    let reached = false, blocked = false, found = 0;
    for (const { stage, terms } of QUERIES) {
      for (const term of terms) {
        const { datasets, blocked: b, status } = await searchWithRetry(baseUrl, term, rowsPerTerm, delayMs);
        await sleep(delayMs);                  // polite pacing so we don't get rate-limited
        if (b) blocked = true;
        if (status === 200) reached = true;
        for (const d of datasets) {
          found++;
          hits.push({
            portal: portalName, baseUrl, stage, score: scoreDataset(d), stages: [stage],
            id: d.id, name: d.name, title: d.title, org: d.org, modified: d.modified,
            notes: (d.notes ?? "").slice(0, 300),
            resources: d.resources.filter((r) => r.datastore_active || ["CSV", "JSON", "XLSX", "XLS"].includes(r.format))
              .map((r) => ({ id: r.id, format: r.format, datastore_active: r.datastore_active })),
          });
        }
      }
    }
    portalStatus[portalName] = { reached, blocked, rawHits: found };
    log(`  ${portalName}: ${blocked ? "BLOCKED (WAF/403 — run from an India/residential route)" : reached ? `${found} raw hits` : "unreachable"}`);
  }
  // OGD arm — data.gov.in catalog via /lists?filters[title]=. Reachable where the
  // CKAN portals WAF-block datacenter IPs, and each hit carries its field schema so
  // a ledger mapping can be built directly. Scored the same way (fields count as
  // datastore-active — every OGD resource is API-queryable).
  let ogdReached = false, ogdHits = 0;
  for (const { stage, terms } of QUERIES) {
    for (const term of terms) {
      const { total, resources } = await ogdListSearch(term, { limit: rowsPerTerm });
      await sleep(delayMs);
      if (total > 0 || resources.length) ogdReached = true;
      for (const r of resources) {
        if (!r.id) continue;
        ogdHits++;
        const d = { title: r.title, notes: `${r.sector ?? ""} ${(r.fields ?? []).join(" ")}`, resources: [{ datastore_active: true, format: "JSON" }] };
        hits.push({
          portal: "data.gov.in", baseUrl: "https://api.data.gov.in", stage,
          score: scoreDataset(d) + 1, stages: [stage],
          id: r.id, name: r.id, title: r.title, org: r.org, modified: r.updated,
          notes: (r.sector ?? "").slice(0, 120),
          resources: [{ id: r.id, format: "JSON", datastore_active: true }],
          fields: r.fields ?? [],
        });
      }
    }
  }
  portalStatus["data.gov.in"] = { reached: ogdReached, blocked: false, rawHits: ogdHits };
  log(`  data.gov.in: ${ogdReached ? `${ogdHits} raw hits` : "unreachable"}`);

  const datasets = mergeHits(hits);
  return { datasets, portalStatus };
}

async function main() {
  const quiet = process.argv.includes("--quiet");
  console.log("[opendata-catalog] discovering Phase-0 datasets across CKAN portals…");
  const { datasets, portalStatus } = await discover();
  const catalog = {
    generated_at: new Date().toISOString(),
    portals: portalStatus,
    count: datasets.length,
    datasets,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileAtomic(OUT, JSON.stringify(catalog, null, 2));
  console.log(`\n[opendata-catalog] ${datasets.length} unique datasets → ${path.relative(process.cwd(), OUT)}`);

  if (!quiet) {
    const top = datasets.slice(0, 25);
    console.log(`\nTop ${top.length} by corruption-signal score:\n`);
    for (const d of top) {
      const ds = d.resources.some((r) => r.datastore_active) ? " [datastore]" : "";
      console.log(`  [${d.score}] ${d.stages.join("/")} · ${d.portal}${ds}`);
      console.log(`        ${(d.title ?? d.name ?? "").slice(0, 90)}${d.org ? `  — ${d.org}` : ""}`);
    }
  }
}

// Run only when invoked directly (not on import from tests). pathToFileURL handles
// the Windows-path + %20-space encoding that a naive string compare gets wrong.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error("[opendata-catalog] fatal:", e.message); process.exit(1); });
}
