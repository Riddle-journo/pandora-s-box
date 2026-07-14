// One-time data-repair: validate every politician's stored myneta_url and fix
// the broken ones. A "broken" URL is one where the affidavit fetcher gets no
// content (the stored slug/candidate_id points at MyNeta's "not found" template
// instead of the real candidate page — e.g. the legacy `ls2024` slug).
//
// For each broken rep it re-derives the correct URL via MyNeta's search, matched
// by name + office/state + constituency + recency, then VERIFIES the new URL
// actually yields affidavit content before writing it.
//
// Usage (run from project root):
//   node server/repair-myneta.js                 # dry-run, ALL reps
//   node server/repair-myneta.js --limit 50      # dry-run, first 50
//   node server/repair-myneta.js --only-suspect  # only check non-CamelCase slugs (fast)
//   node server/repair-myneta.js --apply         # write fixes to the DB
import "dotenv/config";
import { listPoliticians, upsertPolitician } from "./store.js";
import { fetchText, mapLimit } from "./fetchers/http.js";
import { fetchMyNetaProfile } from "./sources/myneta-full.js";
import { NORM, nameScore } from "./util/names.js";

const SEARCH = "https://www.myneta.info/search_myneta.php?q=";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY_SUSPECT = args.includes("--only-suspect");
const LIMIT = (() => { const i = args.indexOf("--limit"); return i >= 0 ? Number(args[i + 1]) : Infinity; })();
const slugOf = (u) => (u ?? "").match(/myneta\.info\/([^/]+)\//)?.[1] ?? "";
// Proper import slugs are CamelCase StateYear or LokSabhaYYYY; anything else (e.g. ls2014, gujarat2012) is legacy/suspect.
const isSuspectSlug = (s) => !/^[A-Z][A-Za-z]+\d{4}$/.test(s);

// Ground truth: the affidavit fetcher returns real content only for a valid URL.
async function hasContent(rep) {
  const out = await fetchMyNetaProfile(rep).catch(() => []);
  return !!(out[0]?.content && out[0].content.length > 150);
}

function parseRows(html) {
  const rows = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const block = tr[1];
    const m = block.match(/\/([A-Za-z0-9]+)\/candidate\.php\?candidate_id=(\d+)/);
    if (!m) continue;
    const nm = block.match(/candidate\.php\?candidate_id=\d+[^>]*>([\s\S]*?)<\/a>/);
    const cells = [...block.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    rows.push({ slug: m[1], id: m[2], name: (nm?.[1] ?? "").replace(/<[^>]+>/g, "").trim(), cells });
  }
  return rows;
}

function bestMatch(rep, rows) {
  const isMP = rep.office === "MP";
  const stateTok = (rep.state ?? "").toLowerCase().replace(/\s+/g, "");
  const cons = (rep.constituency ?? "").toLowerCase().trim();
  const yearOf = (s) => Number(s.match(/(\d{4})/)?.[1] ?? 0);
  return rows
    .map((r) => {
      const slugLc = r.slug.toLowerCase();
      const officeOk = isMP ? slugLc.includes("loksabha") : (stateTok && slugLc.startsWith(stateTok));
      return { r, officeOk, ns: nameScore(rep.name, r.name), consHit: !!(cons && r.cells.some((c) => c.toLowerCase().includes(cons))), year: yearOf(r.slug) };
    })
    .filter((x) => x.officeOk && x.ns >= 0.6)
    .sort((a, b) => (b.consHit - a.consHit) || (b.ns - a.ns) || (b.year - a.year))[0]?.r ?? null;
}

async function repairOne(rep) {
  if (await hasContent(rep)) return { status: "ok" };
  const html = await fetchText(SEARCH + encodeURIComponent(rep.name), { timeoutMs: 20000 });
  const best = bestMatch(rep, parseRows(html));
  if (!best) return { status: "unresolved" };
  const newUrl = `https://www.myneta.info/${best.slug}/candidate.php?candidate_id=${best.id}`;
  if (!(await hasContent({ ...rep, myneta_url: newUrl }))) return { status: "unverified", newUrl };
  if (APPLY) upsertPolitician({ id: rep.id, myneta_url: newUrl });
  return { status: "repaired", oldUrl: rep.myneta_url, newUrl };
}

(async function main() {
  let reps = listPoliticians().filter((p) => !p.is_demo && p.myneta_url);
  if (ONLY_SUSPECT) reps = reps.filter((p) => isSuspectSlug(slugOf(p.myneta_url)));
  reps = reps.slice(0, LIMIT);

  console.log(`Checking ${reps.length} reps · ${APPLY ? "APPLY (writing fixes)" : "DRY-RUN (no writes)"}${ONLY_SUSPECT ? " · suspect slugs only" : ""}`);
  const tally = { ok: 0, repaired: 0, unresolved: 0, unverified: 0 };
  let done = 0;

  await mapLimit(reps, 8, async (rep) => {
    const res = await repairOne(rep);
    tally[res.status] = (tally[res.status] ?? 0) + 1;
    if (res.status !== "ok") console.log(`  [${res.status}] ${rep.name} (${rep.office}, ${rep.state ?? ""})${res.newUrl ? `\n      → ${res.newUrl}` : ""}`);
    if (++done % 250 === 0) console.log(`… ${done}/${reps.length} (ok:${tally.ok} repaired:${tally.repaired} unresolved:${tally.unresolved})`);
  });

  console.log(`\nDone. ok:${tally.ok} repaired:${tally.repaired} unverified:${tally.unverified} unresolved:${tally.unresolved}`);
  if (!APPLY && tally.repaired + tally.unverified > 0) console.log("Re-run with --apply to write the repaired URLs.");
  process.exit(0);
})();
