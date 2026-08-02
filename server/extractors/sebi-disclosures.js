// SEBI corporate-DISCLOSURES extractor (Phase 2, the deferred "links" pass).
//
// Companion to server/fetchers/sebi-disclosures.js. Those evidence rows are routine
// stock-exchange filings (insider trades / SAST acquisitions / related-party txns)
// for a LISTED company that is ALREADY linked to a politician. The identity link
// between the politician and the disclosed COUNTERPARTY (the insider/acquirer named
// in the filing) is UNVERIFIED — common names collide — so, exactly like
// financial-links.js, the honest home is the EVENTS ledger at LOW confidence with
// identity_unverified flagged (never a hard fact, never a public accusation).
//
// The real value is the RELATIONSHIPS ledger: each disclosure grows an edge from the
// politician's linked listed COMPANY to the disclosed counterparty, so a later
// cross-entity detector can spot the SAME counterparty transacting in SEVERAL
// politician-linked companies — a previously-unconnected pattern a journalist chases.
//
// Keep-all / universal-subject: every disclosure row that carries a counterparty or
// company yields a record; nothing is filtered to "politician-name matches".
import { registerExtractor, runExtraction } from "./extract.js";
import { ensureEntity } from "../entities/entities.js";

export const SEBI_DISCLOSURES_VERSION = "sebi-disclosures-v1";

const IDENTITY_NOTE =
  "Routine exchange disclosure for a politician-linked company; the tie to the disclosed counterparty is UNVERIFIED (common names collide).";

// disclosure.type → (event kind, base confidence). All low-confidence signals.
const EVENT = {
  insider_trade: { kind: "insider_trade", confidence: 0.22 },
  sast_acquisition: { kind: "sast_acquisition", confidence: 0.24 },
  related_party_txn: { kind: "related_party_txn", confidence: 0.2 },
  announcement: { kind: "corporate_announcement", confidence: 0.15 },
};

// Pure record builder — turns ONE evidence row's `data` into { events, relationships }.
// No DB access; unit-testable against inline fixtures. The relationship carries a
// `src_company` hint that the registered extract() resolves to a src entity_id.
export function sebiRecords(data = {}) {
  const d = data.disclosure ?? null;
  if (!d) return {};
  const spec = EVENT[d.type] ?? EVENT.announcement;
  const company = d.company || d.symbol || null;

  const events = [{
    kind: spec.kind,
    at: d.date ?? null,
    data: {
      company, symbol: d.symbol ?? null, counterparty: d.counterparty ?? null,
      mode: d.mode ?? null, security: d.security ?? null,
      quantity: d.quantity ?? null, value: d.value ?? null,
      identity_unverified: true, confidence: spec.confidence, note: IDENTITY_NOTE,
    },
  }];

  // Grow an edge from the linked listed company → the disclosed counterparty. Only
  // when BOTH the company and a named counterparty are known (an announcement with
  // no counterparty yields the event only).
  const relationships = [];
  if (company && d.counterparty) {
    relationships.push({
      rel_type: d.type === "sast_acquisition" ? "sast_counterparty" : "sebi_disclosed_counterparty",
      dst_name: d.counterparty,
      dst_kind: "person",
      valid_from: d.date ?? null,
      confidence: spec.confidence,
      // Consumed by extract() below to set src = the listed company, not the politician.
      src_company: { name: company, symbol: d.symbol ?? null },
      data: {
        source: "sebi_disclosures", disclosure_type: d.type, symbol: d.symbol ?? null,
        quantity: d.quantity ?? null, value: d.value ?? null,
        identity_unverified: true, note: IDENTITY_NOTE,
      },
    });
  }
  return { events, relationships };
}

// Registered extractor. Resolves each relationship's `src_company` hint to the
// listed-company entity (best-effort; falls back to the default politician subject
// if resolution fails), so the edge runs company → counterparty as intended.
function extract(evidence) {
  const out = sebiRecords(evidence.data ?? {});
  for (const rel of out.relationships ?? []) {
    const hint = rel.src_company;
    delete rel.src_company;
    if (!hint?.name) continue;
    try {
      rel.src_entity_id = ensureEntity({ kind: "company", name: hint.name, strongIds: {}, source: "sebi_disclosures" });
    } catch { /* fall back to the politician subject in extract.js */ }
  }
  return out;
}

registerExtractor("sebi_disclosures", { version: SEBI_DISCLOSURES_VERSION, extract });

export function runSebiDisclosuresExtraction() {
  return runExtraction({ sourceType: "sebi_disclosures" });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/sebi-disclosures.js");
if (invokedDirectly) {
  console.log("[sebi-disclosures] extraction done:", JSON.stringify(runSebiDisclosuresExtraction()));
  process.exit(0);
}
