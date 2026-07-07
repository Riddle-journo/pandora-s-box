// One-off maintenance: wipe generated reports and/or remove the fictional demo
// politicians, so the corpus can be regenerated cleanly from real reps only.
//
// SAFETY: dry-run by default — prints what WOULD change. Pass --apply to write.
//
// Usage:
//   node server/reset-data.js                      # preview (no writes)
//   node server/reset-data.js --all --apply        # FRESH START: wipe reports + ALL evidence (+ demo)
//   node server/reset-data.js --reports --apply    # only wipe reports
//   node server/reset-data.js --evidence --apply   # only wipe evidence (for a clean re-ingest)
//   node server/reset-data.js --demo --apply       # only remove demo reps (+ their data)
import "dotenv/config";
import { listPoliticians, listScandals, deleteAllReports, deleteAllEvidence, removeDemoPoliticians, counts } from "./store.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");
const onlyReports = args.includes("--reports");
const onlyEvidence = args.includes("--evidence");
const onlyDemo = args.includes("--demo");
// With no sub-flag (and not --all): default to reports + demo (back-compat).
const anySub = onlyReports || onlyEvidence || onlyDemo;
const doReports  = all || onlyReports || !anySub;
const doEvidence = all || onlyEvidence;
const doDemo     = all || onlyDemo || !anySub;

const c = counts();
const pols = listPoliticians();
const demo = pols.filter((p) => p.is_demo);

console.log("Pandoro's Box — data reset");
console.log("──────────────────────────");
console.log(`Politicians: ${c.politicians} (demo: ${demo.length}) · Evidence: ${c.evidence} · Reports: ${c.reports} · Scandals: ${c.scandals} (kept)`);
if (doReports)  console.log(`Will DELETE: every generated report (${c.reports}).`);
if (doEvidence) console.log(`Will DELETE: ALL ingested evidence (${c.evidence}) — you'll re-ingest from scratch.`);
if (doDemo)     console.log(`Will REMOVE demo reps: ${demo.map((p) => p.name).join(", ") || "(none)"}.`);
console.log("");

if (!apply) {
  console.log("DRY RUN — nothing was changed. Re-run with --apply to perform the reset.");
  process.exit(0);
}

if (doReports)  console.log(`✓ Deleted ${deleteAllReports()} report(s).`);
if (doEvidence) console.log(`✓ Deleted ${deleteAllEvidence()} evidence row(s).`);
if (doDemo) {
  const r = removeDemoPoliticians();
  console.log(`✓ Removed ${r.politicians} demo politician(s).`);
}
console.log("\nDone. Politicians (the roster) are intact. Fresh start:");
console.log("  node server/report-generator.js \"Narendra Modi\"            # test ONE rep (ingests + generates)");
console.log("  node server/report-generator.js all --office MP --limit 5  # test the first 5 MPs");
console.log("  node server/ingest.js --mps                                # ingest all MPs (LS+RS), no GLM cost");
