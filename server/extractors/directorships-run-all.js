// One-command orchestration of the full directorship pipeline, in dependency order:
//   1. extraction   (local)   — mine director_of edges from evidence text
//   2. verification (network) — registry-check each discovered company (MCA) → CIN + status
//   3. corroboration(local)   — mark links both extraction AND Tofler agree on
//   4. crossfeed    (network) — pull each company's full board (Tofler) → co-directors/relatives
//
// Network steps (2, 4) hit external services (data.gov.in MCA, tofler.in) and are
// rate-limited — pass --no-network to run only the local steps (1, 3), e.g. for a fast
// clean rebuild of the extraction edges. Run: `npm run extract:directorships:all`.
import "dotenv/config";
import { runDirectorshipExtraction } from "./directorships.js";
import { runDirectorshipVerification } from "./directorship-verify.js";
import { runDirectorshipCorroboration } from "./directorship-corroborate.js";
import { runDirectorshipCrossfeed } from "./directorship-crossfeed.js";

async function main() {
  const noNetwork = process.argv.slice(2).includes("--no-network");

  console.log("[dirship] 1/4 extraction (local) — director_of edges from evidence text…");
  console.log("   →", JSON.stringify(runDirectorshipExtraction()));

  if (noNetwork) {
    console.log("[dirship] 2/4 verification — SKIPPED (--no-network)");
  } else {
    console.log("[dirship] 2/4 verification (network) — MCA registry check per company…");
    console.log("   →", JSON.stringify(await runDirectorshipVerification()));
  }

  console.log("[dirship] 3/4 corroboration (local) — extraction edges × Tofler leads…");
  console.log("   →", JSON.stringify(runDirectorshipCorroboration()));

  if (noNetwork) {
    console.log("[dirship] 4/4 crossfeed — SKIPPED (--no-network)");
  } else {
    console.log("[dirship] 4/4 crossfeed (network) — Tofler board lookup + co-director match…");
    console.log("   →", JSON.stringify(await runDirectorshipCrossfeed()));
  }

  console.log("[dirship] done.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("[dirship] fatal:", e); process.exit(1); });
