// MPLADS extractor (Phase 2D). MP Local Area Development Scheme fund-utilisation
// snapshots. Unlike the affidavit prose, mplads evidence already carries a clean
// pre-parsed `numbers` object (472/528 rows), so this is a straight field-map — no
// fragile parsing. Six per-MP metrics land in the facts ledger:
//   mplads_allocated / mplads_spent          (inr)
//   mplads_utilization_pct / mplads_completion_pct   (pct)
//   mplads_works_recommended / mplads_works_completed (count)
//
// mplads_utilization_pct is the headline accountability signal (funds sanctioned
// but not spent) and is exactly what server/anomaly.js detectUtilizationExtremes
// consumes — so this extractor is the substrate for that detector.
//
// as_of_date = the snapshot date (MPLADS is a running term total; a later re-fetch
// yields a new dated snapshot, giving a utilisation time series for free).
import { registerExtractor, runExtraction } from "./extract.js";

export const MPLADS_VERSION = "mplads-v1";

// Pure: an mplads `numbers` object → fact records (semantic fields only).
export function mpladsFacts(numbers, { as_of_date = null } = {}) {
  if (!numbers || typeof numbers !== "object") return [];
  const out = [];
  const push = (metric, value, unit) => {
    if (value == null) return;
    const n = Number(value);
    if (Number.isFinite(n)) out.push({ metric, value: n, unit, as_of_date });
  };
  push("mplads_allocated", numbers.allocated, "inr");
  push("mplads_spent", numbers.spent, "inr");
  push("mplads_utilization_pct", numbers.utilization_pct, "pct");
  push("mplads_completion_pct", numbers.completion_pct, "pct");
  push("mplads_works_recommended", numbers.works_recommended, "count");
  push("mplads_works_completed", numbers.works_completed, "count");
  return out;
}

registerExtractor("mplads", {
  version: MPLADS_VERSION,
  extract: (ev) => ({ facts: mpladsFacts(ev.data?.numbers, { as_of_date: (ev.data?.date ?? "").slice(0, 10) || null }) }),
});

export function runMpladsExtraction() {
  return runExtraction({ sourceType: "mplads" });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/mplads.js");
if (invokedDirectly) {
  console.log("[mplads] extraction done:", JSON.stringify(runMpladsExtraction()));
  process.exit(0);
}
