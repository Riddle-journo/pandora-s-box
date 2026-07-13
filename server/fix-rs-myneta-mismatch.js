// One-time (re-run-safe) repair: undo the Rajya Sabha importer's wrong MyNeta URLs.
//
// server/import-rs.js finds each RS member's affidavit by a FUZZY NAME SEARCH on
// MyNeta (name similarity >= 0.65). For same-named people that grabbed the WRONG
// candidate's affidavit — e.g. the Himachal INC "Anurag Sharma" (RS) was given the
// Jhansi BJP "Anurag Sharma"'s sworn affidavit. Signature of the bug: two DISTINCT
// politician rows share one myneta_url, and one of them is the RS import.
//
// These are DIFFERENT people (already split into their own entities), so we do NOT
// merge. We clear the mis-assigned myneta_url from the RS row and delete the
// MyNeta-derived evidence it pulled in (the wrong person's affidavit + expenditure),
// which otherwise attributes one politician's assets/criminal cases to another.
// The real owner (the non-RS row that the affidavit actually belongs to) is untouched.
//
//   node server/fix-rs-myneta-mismatch.js            # dry run — prints the plan
//   node server/fix-rs-myneta-mismatch.js --apply     # back up + apply in a txn
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, listPoliticians, getPolitician, upsertPolitician } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Evidence whose provenance is the (wrong) MyNeta candidate page.
const MYNETA_SOURCES = ["eci_affidavit", "eci_expenditure"];

// Find myneta_urls held by >1 politician; in each group the RS-import row(s) carry
// the mis-assigned URL, the non-RS row is the true owner.
function findMismatches() {
  const byUrl = new Map();
  for (const p of listPoliticians()) {
    if (!p.myneta_url) continue;
    if (!byUrl.has(p.myneta_url)) byUrl.set(p.myneta_url, []);
    byUrl.get(p.myneta_url).push(p);
  }
  const groups = [];
  for (const [url, pols] of byUrl) {
    if (pols.length < 2) continue;
    const rs = pols.filter((p) => p.office === "RS");
    const owner = pols.filter((p) => p.office !== "RS");
    groups.push({ url, rs, owner, all: pols });
  }
  return groups;
}

function evidenceToDelete(pid) {
  const q = MYNETA_SOURCES.map(() => "?").join(",");
  return db.prepare(
    `SELECT id FROM evidence WHERE politician_id = ? AND json_extract(data,'$.source_type') IN (${q})`
  ).all(pid, ...MYNETA_SOURCES).map((r) => r.id);
}

function apply(groups) {
  const res = { urlsCleared: 0, evidenceDeleted: 0, ftsDeleted: 0, skipped: [] };
  const delEv = db.prepare("DELETE FROM evidence WHERE id = ?");
  const delFts = db.prepare("DELETE FROM evidence_fts WHERE evidence_id = ?");
  const txn = db.transaction(() => {
    for (const g of groups) {
      // Only auto-fix the clean shape: exactly one true owner + at least one RS row.
      if (!g.owner.length || !g.rs.length) { res.skipped.push(g.url); continue; }
      for (const p of g.rs) {
        const evIds = evidenceToDelete(p.id);
        for (const id of evIds) { delEv.run(id); res.evidenceDeleted++; try { res.ftsDeleted += delFts.run(id).changes; } catch { /* fts optional */ } }
        upsertPolitician({ ...getPolitician(p.id), myneta_url: null });
        res.urlsCleared++;
      }
    }
  });
  txn();
  return res;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("fix-rs-myneta-mismatch.js");
if (invokedDirectly) {
  const doApply = process.argv.includes("--apply");
  const groups = findMismatches();

  console.log("[fix-rs-myneta-mismatch] plan");
  console.log(`  shared-myneta groups: ${groups.length}`);
  for (const g of groups) {
    console.log(`\n  ${g.url}`);
    for (const p of g.owner) console.log(`    KEEP  (${p.office}) "${p.name}" [${p.id.slice(0, 8)}] — true owner`);
    for (const p of g.rs)    console.log(`    CLEAR (${p.office}) "${p.name}" [${p.id.slice(0, 8)}] — ${evidenceToDelete(p.id).length} MyNeta evidence row(s) to delete`);
    if (!g.owner.length || !g.rs.length) console.log("    ⚠ unusual shape (no clear owner or no RS row) — will SKIP, needs manual review");
  }

  if (!groups.length) { console.log("\n  nothing to fix — no shared myneta_urls."); process.exit(0); }
  if (!doApply) { console.log("\n  DRY RUN — no changes written. Re-run with --apply."); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbFile = process.env.PANDOROS_DB_PATH || path.join(__dirname, "..", "data", "pandoros.db");
  const backup = `${dbFile}.bak-${stamp}`;
  console.log(`\n  backing up → ${backup}`);
  await db.backup(backup);
  console.log("  backup complete.");

  const res = apply(groups);
  // Verify: no myneta_url is shared by >1 politician any more.
  const remaining = findMismatches().filter((g) => g.owner.length && g.rs.length);
  console.log("\n[fix-rs-myneta-mismatch] applied");
  console.log(`  urls cleared      : ${res.urlsCleared}`);
  console.log(`  evidence deleted  : ${res.evidenceDeleted} (+${res.ftsDeleted} FTS rows)`);
  console.log(`  groups skipped    : ${res.skipped.length}`);
  console.log(`  remaining shared-myneta mismatches: ${remaining.length} (expected 0)`);
  if (remaining.length) { console.error("  ⚠ VERIFICATION FAILED — restore from backup."); process.exit(1); }
  console.log("\n  ✓ verified: no myneta_url is shared across politicians; wrong affidavits purged.");
  process.exit(0);
}

export { findMismatches, evidenceToDelete, apply };
