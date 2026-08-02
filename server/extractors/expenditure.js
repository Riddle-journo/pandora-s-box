// Election-expenditure extractor (Phase 2G). The eci_expenditure content is a
// flattened multi-column ECI form. It contains TWO grand totals — expenditure
// incurred (first) and funds received (later) — so we deliberately take only the
// FIRST "Grand Total", which is the expenditure figure, and skip anything we can't
// match cleanly (no fact rather than a wrong one). Value uses the exact Indian
// comma-grouped figure (the "N Lacs+" approximation is ignored, like the affidavit).
//
// election_expenditure pairs with declared_assets for the cross-check that matters:
// a candidate whose declared campaign spend is implausible against their wealth.
import { registerExtractor, runExtraction } from "./extract.js";

export const EXPENDITURE_VERSION = "eci-expenditure-v1";

export function expenditureFacts(content) {
  const t = String(content ?? "");
  const m = t.match(/Grand\s*Total[^0-9]{0,25}([\d,]{4,})/i);
  if (!m) return [];
  const value = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return [];
  const y = t.match(/Lok\s+Sabha\s+(\d{4})/i);
  return [{ metric: "election_expenditure", value, unit: "inr", as_of_date: y ? y[1] : null, period: y ? `LS${y[1]}` : null }];
}

registerExtractor("eci_expenditure", { version: EXPENDITURE_VERSION, extract: (ev) => ({ facts: expenditureFacts(ev.data?.content) }) });

export function runExpenditureExtraction() {
  return runExtraction({ sourceType: "eci_expenditure" });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/expenditure.js");
if (invokedDirectly) {
  console.log("[expenditure] extraction done:", JSON.stringify(runExpenditureExtraction()));
  process.exit(0);
}
