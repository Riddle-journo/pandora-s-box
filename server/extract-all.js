// Unified extraction + detection orchestrator — the single entry point that turns
// the whole evidence corpus into the analysis ledgers (facts / claims / events /
// relationships) and then runs the ledger-native detectors over them.
//
// Each extractor module self-registers on import and exposes a run*Extraction()
// runner that encapsulates its correct scan semantics (evidence-table sweep,
// politician-blob sweep, or representative-row-per-party). We import them all here
// so the deterministic pipeline is one call — and so the Ops Console "extract_all"
// job can rebuild the ledgers on demand.
//
// The PROSE LLM extractors (news/fact-check/cbi/wikipedia) are intentionally NOT
// run here: they cost model calls and rate-limit, so they live behind their own
// "extract_prose" job (server/extractors/prose-llm.js) with an explicit limit.
// Directorship extraction has its own multi-stage runner (directorships-run-all.js)
// and is likewise left to its dedicated job.
import "dotenv/config";
import { startTimer } from "./util/timing.js";

import { runAffidavitExtraction } from "./extractors/affidavit.js";
import { runExpenditureExtraction } from "./extractors/expenditure.js";
import { runIndianKanoonExtraction } from "./extractors/indian-kanoon.js";
import { runMpladsExtraction } from "./extractors/mplads.js";
import { runParliamentExtraction } from "./extractors/parliament.js";
import { runPartyFinanceExtraction } from "./extractors/party-finance.js";
import { runWikidataExtraction } from "./extractors/wikidata.js";
import { runFinancialLinkExtraction, registerDynamicProcurement } from "./extractors/financial-links.js";
// Batch 2 — extractors that close the ledger gap for the bulk L1/mega sources that
// were fetched-but-never-typed (vigilance/audit/insolvency/property/treasury). Each
// emits low-confidence, identity-unverified, citation-bearing claims/relationships
// for EVERY named party (universal subjects — see server/extractors/financial-links.js).
import { runVigilanceCasesExtraction } from "./extractors/vigilance-cases.js";
import { runAuditRegulatoryExtraction } from "./extractors/audit-regulatory.js";
import { runInsolvencyDefaulterExtraction } from "./extractors/insolvency-defaulters.js";
import { runPropertyLeaseExtraction } from "./extractors/property-leases.js";
import { runTreasuryExtraction } from "./extractors/treasury-payments.js";
// Batch 3 — new content sources: parliamentary standing-committee reports (PRS mirror)
// and SEBI corporate disclosures (opt-in, relationship-triggered enrichment).
import { runParliamentCommitteeExtraction } from "./extractors/parliament-committee.js";
import { runSebiDisclosuresExtraction } from "./extractors/sebi-disclosures.js";
import { db } from "./store.js";
import { runLedgerDetectors } from "./ledger-detectors.js";
import { runDenominatorDetectors } from "./denominator-detectors.js";

// Pick up any tender/procurement-shaped source_types present in this DB that aren't
// in the static list (mega corpora differ between installs).
function registerDbProcurement() {
  const sts = db.prepare("SELECT DISTINCT json_extract(data,'$.source_type') st FROM evidence").all().map((r) => r.st).filter(Boolean);
  return registerDynamicProcurement(sts);
}

const STEPS = [
  ["affidavit", runAffidavitExtraction],
  ["expenditure", runExpenditureExtraction],
  ["parliament", runParliamentExtraction],
  ["mplads", runMpladsExtraction],
  ["indian_kanoon", runIndianKanoonExtraction],
  ["party_finance", runPartyFinanceExtraction],
  ["wikidata", runWikidataExtraction],
  ["financial_links", runFinancialLinkExtraction],
  ["vigilance_cases", runVigilanceCasesExtraction],
  ["audit_regulatory", runAuditRegulatoryExtraction],
  ["insolvency_defaulters", runInsolvencyDefaulterExtraction],
  ["property_leases", runPropertyLeaseExtraction],
  ["treasury_payments", runTreasuryExtraction],
  ["parliament_committee", runParliamentCommitteeExtraction],
  ["sebi_disclosures", runSebiDisclosuresExtraction],
];

export function runAllExtractors({ log = console.log } = {}) {
  const extra = registerDbProcurement();
  if (extra.length) log(`[extract-all] +${extra.length} dynamic procurement source(s): ${extra.join(", ")}`);
  const totals = { facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 };
  const per = {};
  for (const [name, fn] of STEPS) {
    try {
      const r = fn() ?? {};
      per[name] = r;
      for (const k of Object.keys(totals)) totals[k] += r[k] ?? 0;
      log(`[extract-all] ${name}: ${JSON.stringify({ facts: r.facts ?? 0, claims: r.claims ?? 0, events: r.events ?? 0, relationships: r.relationships ?? 0 })}`);
    } catch (e) { log(`[extract-all] ${name} FAILED: ${e.message}`); per[name] = { error: e.message }; }
  }
  return { totals, per };
}

// Full pipeline: extract everything deterministic, then run the ledger detectors so
// new/updated facts+claims immediately produce candidate leads.
export function runExtractAndDetect({ log = console.log } = {}) {
  const done = startTimer("extract-all");
  const ext = runAllExtractors({ log });
  log(`[extract-all] extraction totals: ${JSON.stringify(ext.totals)}`);
  let detectors = null;
  try {
    detectors = runLedgerDetectors({ log });
    log(`[extract-all] ledger detectors: ${JSON.stringify(detectors.counts)} (${detectors.upserted} leads upserted)`);
  } catch (e) { log(`[extract-all] ledger detectors FAILED: ${e.message}`); }
  // Denominator detectors run over the open-data baseline facts (district/scheme
  // subjects) — independent of the politician-keyed ledger detectors above.
  let denominators = null;
  try {
    denominators = runDenominatorDetectors({ log });
    log(`[extract-all] denominator detectors: ${JSON.stringify(denominators.counts)} (${denominators.upserted} leads upserted)`);
  } catch (e) { log(`[extract-all] denominator detectors FAILED: ${e.message}`); }
  done();
  return { extraction: ext, detectors, denominators };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("server/extract-all.js");
if (invokedDirectly) {
  const noDetect = process.argv.includes("--no-detect");
  if (noDetect) runAllExtractors();
  else runExtractAndDetect();
  process.exit(0);
}
