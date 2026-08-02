// Import all sitting Rajya Sabha members from Digital Sansad's open API.
//
// RS members don't have a MyNeta "winners" page (they're not directly elected),
// but many were previously LS MPs or MLAs, so we attempt a MyNeta search for
// their most recent affidavit. That gives us asset/criminal data for ex-MPs.
//
// Usage:
//   node server/import-rs.js                  -- dry-run (no writes)
//   node server/import-rs.js --apply           -- write to DB
//   node server/import-rs.js --apply --no-myneta  -- skip MyNeta search (fast)
//
// After importing, run:
//   node server/report-generator.js all --tier 2 --office RS
import "dotenv/config";
import { batchUpsertPoliticians, listPoliticians } from "./store.js";
import { fetchText, fetchJson, mapLimit } from "./fetchers/http.js";
import { NORM, nameScore } from "./util/names.js";
import { consoleStyle } from "./util/log.js";
const clog = consoleStyle("import-rs");

const RS_API   = "https://sansad.in/api_rs";
const MYNETA   = "https://www.myneta.info";

const APPLY      = process.argv.includes("--apply");
const NO_MYNETA  = process.argv.includes("--no-myneta");

// Sansad RS API returns names as "Lastname, Title Firstname" — normalize to "Firstname Lastname"
// Titles can appear anywhere so strip without ^ anchor.
const TITLE_RE = /\b(shri|smt|dr|ms|mr|mrs|prof|adv|mohd|md|col|gen|capt|kumari|thiru|shrimati)\b\.?\s*/gi;
function stripTitles(s) { return s.replace(TITLE_RE, "").replace(/\s+/g, " ").trim(); }
function normalizeSansadName(raw) {
  const s = raw.replace(/^@\s*/, "").trim();
  if (!s.includes(",")) return stripTitles(s);
  // Format: "Lastname, [Title] Firstname [Middlename]"
  const commaIdx = s.indexOf(",");
  const last  = s.slice(0, commaIdx).trim();
  const first = stripTitles(s.slice(commaIdx + 1).trim());
  return first ? `${first} ${last}` : last;
}

async function fetchRsSittingMembers() {
  const url = `${RS_API}/member/sitting-members?state=&party=&gender=&page=1&size=500&mpFlag=1&ageFrom=&ageTo=&terms=&search=&locale=en`;
  const data = await fetchJson(url, { timeoutMs: 25000 });
  return data?.records ?? [];
}

// Decide which MyNeta search row (if any) is a SAFE match for a member. Guards the
// fuzzy match that used to hand same-named people each other's affidavits (repaired
// by server/fix-rs-myneta-mismatch.js): name similarity must clear a RAISED bar
// (0.8, was 0.65) AND the member's FIRST name token must appear in the candidate's
// name, so "Nitin … Patil" never matches "Makrand … Patil". Same-name + same-state
// collisions can't be told apart from a search row alone, so main() ALSO enforces
// myneta_url uniqueness across the roster as the definitive backstop. Pure +
// exported so the acceptance rule is unit-tested without hitting the network.
export function selectMynetaMatch({ name, minScore = 0.8 }, rows = []) {
  const lead = NORM(name)[0];
  if (!lead) return null;
  return rows
    .map((r) => ({ r, ns: nameScore(name, r.cname) }))
    .filter((x) => x.ns >= minScore && NORM(x.r.cname).includes(lead))
    .sort((a, b) => b.ns - a.ns || (b.r.year || 0) - (a.r.year || 0))[0]?.r ?? null;
}

// For each RS member, try to find their affidavit via MyNeta search. RS members were
// often former LS MPs or state MLAs — so search by name and pick the best recent match.
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
      rows.push({ slug: m[1], id: m[2], cname, year });
    }
    const best = selectMynetaMatch({ name }, rows);
    return best ? `${MYNETA}/${best.slug}/candidate.php?candidate_id=${best.id}` : null;
  } catch { return null; }
}

async function main() {
  clog.log("=== Pandoro's Box — Rajya Sabha Import (Digital Sansad) ===\n");

  clog.log("Fetching RS sitting member list from Sansad API…");
  let members;
  try { members = await fetchRsSittingMembers(); }
  catch (err) { clog.error("Failed to fetch RS member list:", err.message); process.exit(1); }
  clog.log(`Got ${members.length} sitting RS members.\n`);

  // Dedup against existing DB
  const existing = new Set(
    listPoliticians()
      .filter((p) => p.office === "RS")
      .map((p) => p.name.toLowerCase().trim())
  );
  const newMembers = members.filter((m) => {
    const name = normalizeSansadName(m.name ?? "");
    return name.length >= 2 && !existing.has(name.toLowerCase());
  });
  clog.log(`Already in DB: ${members.length - newMembers.length}  |  New to import: ${newMembers.length}\n`);

  if (!newMembers.length) { clog.log("Nothing new. Done."); return; }

  // Build politician rows
  const politicians = [];
  let done = 0;

  await mapLimit(newMembers, 6, async (m) => {
    const name   = normalizeSansadName(m.name ?? "");
    const state  = (m.state ?? m.constituency ?? "").trim();
    const party  = (m.partyName ?? m.party ?? "").trim();

    let myneta_url = null;
    if (!NO_MYNETA) {
      myneta_url = await findMynetaUrl(name);
    }

    politicians.push({
      name,
      constituency: state,  // RS: "constituency" = the state they represent
      state,
      party,
      office: "RS",
      myneta_url,
    });

    done++;
    const tick = myneta_url ? "✓ MyNeta" : "(no affidavit found)";
    if (done % 20 === 0 || done <= 5)
      clog.log(`  [${done}/${newMembers.length}] ${name} — ${party}, ${state} — ${tick}`);
  });

  // Uniqueness backstop: never assign a myneta_url that already belongs to another
  // politician. Every wrong affidavit we've seen came from the fuzzy name search
  // grabbing an EXISTING (LS/MLA) politician's candidate page for a same-named RS
  // member — refusing the duplicate blocks the mis-attribution at the source, even
  // when name+state are identical and the search row can't disambiguate.
  const usedMyneta = new Set(listPoliticians().map((p) => p.myneta_url).filter(Boolean));
  let droppedDup = 0;
  for (const p of politicians) {
    if (!p.myneta_url) continue;
    if (usedMyneta.has(p.myneta_url)) {
      clog.warn(`  ⚠ ${p.name}: MyNeta URL already assigned to another politician — dropping (fuzzy name collision).`);
      p.myneta_url = null; droppedDup++;
    } else {
      usedMyneta.add(p.myneta_url);
    }
  }
  if (droppedDup) clog.log(`Dropped ${droppedDup} duplicate MyNeta URL(s) to prevent mis-attribution.`);

  clog.log(`\nBuilt ${politicians.length} RS politician records.`);
  const found = politicians.filter((p) => p.myneta_url).length;
  clog.log(`MyNeta affidavit found for ${found}/${politicians.length} members.`);

  if (!APPLY) {
    clog.log("\nDRY-RUN — no writes. Re-run with --apply to save.");
    clog.log("Sample of what would be added:");
    politicians.slice(0, 5).forEach((p) =>
      clog.log(`  ${p.name} (${p.party}, ${p.state}) ${p.myneta_url ? "→ " + p.myneta_url : ""}`));
    return;
  }

  const added = batchUpsertPoliticians(politicians);
  clog.log(`\nWrote ${added.length} new RS members to DB.`);
  clog.log("Total RS members in DB now:", listPoliticians().filter((p) => p.office === "RS").length);
  clog.log("\nNext steps:");
  clog.log("  node server/ingest.js all --office RS          # fetch evidence for RS members");
  clog.log("  node server/report-generator.js all --tier 2 --office RS  # generate RS reports");
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("import-rs.js");
if (invokedDirectly) {
  main().catch((err) => { clog.error("Fatal:", err); process.exit(1); }).finally(() => process.exit(0));
}
