// Fill the Lok Sabha roster from Digital Sansad's authoritative member list.
//
// MyNeta's LokSabha2024 winners page only lists ~485 of the 543 MPs (ADR hasn't
// digitised every affidavit). Sansad's API has the full sitting roster (~540,
// the rest being current vacancies). This script imports the MPs that MyNeta
// missed, deduping by CONSTITUENCY (each LS seat has exactly one sitting MP, so
// this is robust against the name-format gap between MyNeta "Narendra Modi" and
// Sansad "Shri Narendra Modi"). For each new MP it attempts a MyNeta affidavit
// match via search.
//
// Usage:
//   node server/import-ls.js               -- dry-run (no writes)
//   node server/import-ls.js --apply        -- write the missing MPs to DB
//   node server/import-ls.js --apply --no-myneta  -- skip MyNeta search (fast)
import "dotenv/config";
import { batchUpsertPoliticians, listPoliticians } from "./store.js";
import { fetchText, fetchJson, mapLimit } from "./fetchers/http.js";
import { NORM, nameScore } from "./util/names.js";

const LS_API = "https://sansad.in/api_ls";
const MYNETA = "https://www.myneta.info";
const LOKSABHA = 18;

const APPLY     = process.argv.includes("--apply");
const NO_MYNETA = process.argv.includes("--no-myneta");

const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim();
// Constituency dedup key: strip the (SC)/(ST) reservation suffixes MyNeta appends
// (e.g. "ADILABAD (ST)" vs Sansad "Adilabad"), then keep letters only.
const consKey = (s) => clean(s).toLowerCase().replace(/\(s[ct]\)/g, "").replace(/[^a-z]/g, "");

const TITLE_RE = /\b(shri|smt|dr|ms|mr|mrs|prof|adv|mohd|md|col|gen|capt|kumari|thiru|shrimati)\b\.?\s*/gi;
const stripTitles = (s) => clean(s).replace(TITLE_RE, "").replace(/\s+/g, " ").trim();
const nameToks = (s) => new Set(NORM(stripTitles(s)));

// True if this Sansad name matches an existing DB MP (token overlap). Guards
// against constituency-spelling differences creating duplicate person records.
function nameMatchesExisting(name, dbTokenSets) {
  const mset = [...nameToks(name)];
  if (!mset.length) return false;
  const need = mset.length >= 2 ? 2 : 1;
  return dbTokenSets.some((set) => {
    const hit = mset.filter((t) => set.has(t)).length;
    return hit >= need && hit / mset.length >= 0.6;
  });
}

async function fetchLsSittingMembers() {
  const url = `${LS_API}/member?loksabha=${LOKSABHA}&state=&party=&gender=&ageFrom=&ageTo=`
    + `&noOfTerms=&page=1&size=1000&searchText=&constituency=&sitting=1&locale=en&memberStatus=s`;
  const data = await fetchJson(url, { timeoutMs: 25000 });
  return data?.membersDtoList ?? [];
}

async function findMynetaUrl(name) {
  try {
    const html = await fetchText(`${MYNETA}/search_myneta.php?q=${encodeURIComponent(name)}`, { timeoutMs: 18000 });
    const rows = [];
    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const block = tr[1];
      const m = block.match(/\/([A-Za-z0-9]+)\/candidate\.php\?candidate_id=(\d+)/);
      if (!m) continue;
      const nm = block.match(/candidate\.php\?candidate_id=\d+[^>]*>([\s\S]*?)<\/a>/);
      const cname = (nm?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
      const year = Number(m[1].match(/(\d{4})/)?.[1] ?? 0);
      // Prefer Lok Sabha affidavits for sitting MPs, but accept any.
      const isLs = /loksabha/i.test(m[1]);
      rows.push({ slug: m[1], id: m[2], cname, year, isLs });
    }
    const scored = rows
      .map((r) => ({ r, ns: nameScore(name, r.cname) }))
      .filter((x) => x.ns >= 0.65)
      .sort((a, b) => (b.r.isLs - a.r.isLs) || (b.ns - a.ns) || (b.r.year - a.r.year));
    if (!scored.length) return null;
    const best = scored[0].r;
    return `${MYNETA}/${best.slug}/candidate.php?candidate_id=${best.id}`;
  } catch { return null; }
}

async function main() {
  console.log("=== Pandoro's Box — Lok Sabha Roster Fill (Digital Sansad) ===\n");

  console.log("Fetching LS sitting member list from Sansad API…");
  let members;
  try { members = await fetchLsSittingMembers(); }
  catch (err) { console.error("Failed to fetch LS member list:", err.message); process.exit(1); }
  console.log(`Got ${members.length} sitting LS members from Sansad.\n`);

  // Existing LS MPs in DB — dedup by constituency key AND by name tokens, so a
  // constituency-spelling difference can't slip a duplicate person through.
  const dbMPs = listPoliticians().filter((p) => p.office === "MP");
  const existingByCons = new Set(dbMPs.map((p) => consKey(p.constituency)).filter(Boolean));
  const dbTokenSets = dbMPs.map((p) => nameToks(p.name));

  let consDup = 0, nameDup = 0;
  const missing = members.filter((m) => {
    const ck = consKey(m.constName);
    if (ck && existingByCons.has(ck)) { consDup++; return false; }
    const nm = m.mpFirstLastName || `${m.firstName ?? ""} ${m.lastName ?? ""}`;
    if (nameMatchesExisting(nm, dbTokenSets)) { nameDup++; return false; }
    return true;
  });
  console.log(`Already in DB: ${consDup} by constituency, ${nameDup} by name (different spelling).`);
  console.log(`Genuinely missing from DB: ${missing.length}\n`);

  if (!missing.length) { console.log("Roster already complete. Nothing to add."); return; }

  const politicians = [];
  let done = 0;

  await mapLimit(missing, 6, async (m) => {
    const name  = stripTitles(m.mpFirstLastName || `${m.firstName ?? ""} ${m.lastName ?? ""}`);
    const cons  = clean(m.constName);
    const state = clean(m.stateName);
    const party = clean(m.partyFname || m.partySname);

    let myneta_url = null;
    if (!NO_MYNETA) myneta_url = await findMynetaUrl(name);

    politicians.push({ name, constituency: cons, state, party, office: "MP", myneta_url });

    done++;
    const tick = myneta_url ? "✓ MyNeta" : "(no affidavit found)";
    console.log(`  [${done}/${missing.length}] ${name} — ${cons}, ${state} (${party}) — ${tick}`);
  });

  const found = politicians.filter((p) => p.myneta_url).length;
  console.log(`\nBuilt ${politicians.length} LS records. MyNeta affidavit found for ${found}/${politicians.length}.`);

  if (!APPLY) {
    console.log("\nDRY-RUN — no writes. Re-run with --apply to save.");
    return;
  }

  const added = batchUpsertPoliticians(politicians);
  console.log(`\nWrote ${added.length} new LS members to DB.`);
  const total = listPoliticians().filter((p) => p.office === "MP").length;
  console.log(`Total LS (MP) members in DB now: ${total}`);
  console.log("\nNext steps:");
  console.log("  node server/ingest.js --office MP                       # fetch evidence");
  console.log("  node server/report-generator.js all --tier 2 --office MP  # generate reports");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); }).finally(() => process.exit(0));
