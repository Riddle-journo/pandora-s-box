// Bulk import of elected representatives in India from MyNeta (ADR).
//
// Coverage available from MyNeta affidavit data:
//   • 543 Lok Sabha MPs (2024)
//   • ~4,000 MLAs across 30 state/UT assemblies (latest election each)
// Not on MyNeta (handled elsewhere / future): Rajya Sabha (staggered, no clean
//   winners page), MLCs, mayors, municipal councillors, sarpanches.
//
// Strategy:
//   Phase 1 — Scrape all pages (pure HTTP, ZERO database operations)
//   Phase 2 — ONE batch DB write for all new politicians
//   Phase 3 — Evidence ingest per politician (optional)
//
// Usage:
//   node server/bulk-import.js               — full run (scrape + save + ingest)
//   node server/bulk-import.js --no-ingest   — scrape + save only (fast, minutes)
//   node server/bulk-import.js --ls-only     — Lok Sabha only
//   node server/bulk-import.js --state-only  — state assemblies only
import "dotenv/config";
import { batchUpsertPoliticians, listPoliticians } from "./store.js";
import { ingestFor } from "./ingest.js";
import { sleep } from "./util/timing.js";
import { consoleStyle } from "./util/log.js";
const clog = consoleStyle("bulk-import");

const MYNETA_BASE = "https://www.myneta.info";
const UA = { "User-Agent": "PandorosBox/0.1 (public-accountability research)" };
const DELAY_MS = 500;

const NO_INGEST  = process.argv.includes("--no-ingest");
const LS_ONLY    = process.argv.includes("--ls-only");
const STATE_ONLY = process.argv.includes("--state-only");

function stripHtml(s) {
  return (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

// Big assemblies (UP has 403 seats) serve very large, slow pages — allow a
// generous timeout and retry once before giving up.
async function fetchHtml(url, { tries = 2, timeoutMs = 90000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await sleep(1500);
    }
  }
  throw lastErr;
}

// Parse a MyNeta winners page. MyNeta's HTML quirks handled here:
//   • hrefs are UNQUOTED:  href=/candidate.php?candidate_id=5395
//   • candidate name is wrapped in nested <a><a>…</a></a> tags
//   • columns: Sno | Name | Constituency | Party | CriminalCases | Education | Assets | Liabilities
async function scrapePage(slug, state, office) {
  let html;
  try { html = await fetchHtml(`${MYNETA_BASE}/${slug}/index.php?action=show_winners`); }
  catch (err) { return { results: [], error: err.message }; }

  const results = [];
  for (const [, rowHtml] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (!rowHtml.includes("candidate.php")) continue;

    const idMatch = rowHtml.match(/candidate\.php\?candidate_id=(\d+)/);
    if (!idMatch) continue;
    const candidateId = idMatch[1];

    const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(([, c]) => stripHtml(c));
    if (cells.length < 4) continue;

    const name = cells[1];
    if (!name || name.length < 2 || /^(s\.?\s?no|candidate)/i.test(name)) continue;

    const criminalRaw = cells[4] ?? "";
    results.push({
      name,
      constituency: cells[2] || "—",
      state,
      party: cells[3] || "Unknown",
      office,
      myneta_url: `${MYNETA_BASE}/${slug}/candidate.php?candidate_id=${candidateId}`,
      // Bonus facts scraped directly from the winners table — powers the
      // career/history page without an extra request per candidate.
      affidavit: {
        criminal_cases: /^\d+$/.test(criminalRaw) ? Number(criminalRaw) : null,
        education: cells[5] || null,
        assets: cells[6] || null,
        liabilities: cells[7] || null,
      },
    });
  }
  return { results, error: null };
}

// All assembly slugs verified against MyNeta (latest election per state/UT).
// [slug, displayState]
const ASSEMBLIES = [
  ["UttarPradesh2022",     "Uttar Pradesh"],
  ["Maharashtra2024",      "Maharashtra"],
  ["Bihar2020",            "Bihar"],
  ["WestBengal2021",       "West Bengal"],
  ["MadhyaPradesh2023",    "Madhya Pradesh"],
  ["TamilNadu2021",        "Tamil Nadu"],
  ["Rajasthan2023",        "Rajasthan"],
  ["Karnataka2023",        "Karnataka"],
  ["Gujarat2022",          "Gujarat"],
  ["AndhraPradesh2024",    "Andhra Pradesh"],
  ["Odisha2024",           "Odisha"],
  ["Telangana2023",        "Telangana"],
  ["Kerala2021",           "Kerala"],
  ["Jharkhand2024",        "Jharkhand"],
  ["Assam2021",            "Assam"],
  ["Punjab2022",           "Punjab"],
  ["Chhattisgarh2023",     "Chhattisgarh"],
  ["Haryana2024",          "Haryana"],
  ["Delhi2025",            "Delhi"],
  ["JammuKashmir2024",     "Jammu & Kashmir"],
  ["Uttarakhand2022",      "Uttarakhand"],
  ["HimachalPradesh2022",  "Himachal Pradesh"],
  ["Goa2022",              "Goa"],
  ["Manipur2022",          "Manipur"],
  ["Tripura2023",          "Tripura"],
  ["Meghalaya2023",        "Meghalaya"],
  ["Nagaland2023",         "Nagaland"],
  ["Mizoram2023",          "Mizoram"],
  ["Sikkim2024",           "Sikkim"],
  ["ArunachalPradesh2024", "Arunachal Pradesh"],
  ["Puducherry2021",       "Puducherry"],
];

async function main() {
  clog.log("=== Pandoro's Box — Bulk Representative Import ===\n");

  // ── PHASE 1: scrape (no DB) ──────────────────────────────────────────
  clog.log("Phase 1 — Scraping MyNeta (no DB writes yet)\n");
  const all = [];

  if (!STATE_ONLY) {
    process.stdout.write("Lok Sabha 2024… ");
    const { results, error } = await scrapePage("LokSabha2024", "Lok Sabha (Parliament)", "MP");
    clog.log(error ? `FAILED: ${error}` : `${results.length} MPs`);
    all.push(...results);
    await sleep(DELAY_MS);
  }

  if (!LS_ONLY) {
    clog.log("\nState assemblies:");
    for (const [slug, state] of ASSEMBLIES) {
      process.stdout.write(`  ${state.padEnd(20)} `);
      const { results, error } = await scrapePage(slug, state, "MLA");
      clog.log(error ? `skipped (${error})` : `${results.length} MLAs`);
      all.push(...results);
      await sleep(DELAY_MS);
    }
  }

  clog.log(`\nScraped ${all.length} candidates total.`);

  // ── PHASE 2: single batch write ──────────────────────────────────────
  clog.log("\nPhase 2 — Writing to database (one operation)…");
  const added = batchUpsertPoliticians(all);
  clog.log(`  Added: ${added.length}  |  Skipped (already in DB): ${all.length - added.length}`);
  clog.log(`  Total real representatives in DB: ${listPoliticians().filter(p => !p.is_demo).length}\n`);

  if (!added.length) { clog.log("Nothing new. Done."); return; }
  if (NO_INGEST) {
    clog.log("--no-ingest set. Skipping evidence fetch.");
    clog.log("Run `node server/ingest.js` later, or generate reports directly.");
    return;
  }

  // ── PHASE 3: evidence ingest ─────────────────────────────────────────
  clog.log(`Phase 3 — Ingesting evidence for ${added.length} new politicians`);
  clog.log("(Ctrl+C is safe — saved politicians are not lost)\n");

  let done = 0, failed = 0;
  for (const p of added) {
    done++;
    process.stdout.write(`[${done}/${added.length}] ${p.name} (${p.constituency})… `);
    try {
      const n = await ingestFor(p);
      clog.log(`${n} items`);
    } catch (err) { clog.log(`failed: ${err.message}`); failed++; }
    await sleep(DELAY_MS);
  }

  clog.log(`\nDone. Ingested ${done - failed}, failed ${failed}.`);
  clog.log(`Next: node server/report-generator.js all --tier 2`);
}

main().catch((err) => { clog.error("Fatal:", err); process.exit(1); }).finally(() => process.exit(0));
