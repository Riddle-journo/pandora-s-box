// Unified roster updater (task #2) — refreshes the sitting list of MPs (Lok
// Sabha + Rajya Sabha) from the official Sansad API, and optionally MLAs from
// MyNeta. One command instead of remembering each importer.
//
// Usage:
//   node server/update-roster.js                 # MPs only (LS + RS), DRY RUN
//   node server/update-roster.js --apply         # MPs (LS + RS), write changes
//   node server/update-roster.js --apply --mla   # also refresh MLAs (slow, per-state)
//
// Sources of truth:
//   • Lok Sabha / Rajya Sabha sitting members → sansad.in API (import-ls/rs.js)
//   • MLAs → MyNeta state winners pages (bulk-import.js)
//   • MLCs → no clean automatable national source exists (state councils publish
//     PDFs only); these must be added manually for now. Flagged, not silently skipped.
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTimer } from "./util/timing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");
const WITH_MLA = process.argv.includes("--mla");

function run(script, args) {
  return new Promise((resolve) => {
    console.log(`\n▶ node server/${script} ${args.join(" ")}`);
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { stdio: "inherit" });
    child.on("close", (code) => { console.log(`  (${script} exited ${code})`); resolve(code); });
    child.on("error", (e) => { console.warn(`  (${script} failed: ${e.message})`); resolve(1); });
  });
}

(async () => {
  const stop = startTimer("Roster update");
  const applyArg = APPLY ? ["--apply"] : [];
  if (!APPLY) console.log("DRY RUN — pass --apply to write changes.\n");

  console.log("=== Lok Sabha (sitting MPs) ===");
  await run("import-ls.js", applyArg);

  console.log("\n=== Rajya Sabha (sitting MPs) ===");
  await run("import-rs.js", applyArg);

  if (WITH_MLA) {
    console.log("\n=== MLAs (per-state, MyNeta — this is slow) ===");
    await run("bulk-import.js", APPLY ? [] : ["--dry-run"]);
  } else {
    console.log("\n(Skipping MLAs — pass --mla to refresh them too.)");
  }

  console.log("\n⚠ MLCs: no clean automatable national source. State Legislative Council");
  console.log("  members are published as PDFs only and must be added manually.");
  stop();
  process.exit(0);
})();
