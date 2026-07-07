// Government accountability scorecards — pure aggregation over the generated
// scandal corpus (no AI). Rolls failures up by ministry, party, government term
// and sector, and computes an "accountability rate": of the documented failures
// on a given watch, what share saw real accountability (resignation, prosecution,
// remedy) versus none.
//
// NEUTRALITY: this is arithmetic. Every party/government is scored by the same
// formula on the same corpus. The numbers are only as balanced as the corpus —
// which is why scandal-seeds.js is deliberately balanced across parties/eras.

import { listScandals } from "./store.js";

// FULL accountability = 1.0, PARTIAL = 0.5, NONE = 0.0 → averaged to 0–100.
const VERDICT_WEIGHT = { FULL: 1, PARTIAL: 0.5, NONE: 0 };

function blankBucket(label) {
  return {
    label, total: 0,
    verdict: { NONE: 0, PARTIAL: 0, FULL: 0 },
    signal: { RED: 0, AMBER: 0, GREEN: 0, GREY: 0 },
    resignations: 0, inquiries: 0, prosecutions: 0,
    accountability_rate: null, // 0–100, computed at the end
    scandals: [],              // [{slug, title, verdict, signal, date}]
  };
}

function addToBucket(b, s) {
  b.total++;
  const v = s.accountability?.verdict ?? "NONE";
  if (b.verdict[v] != null) b.verdict[v]++;
  const sig = s.signal ?? "GREY";
  if (b.signal[sig] != null) b.signal[sig]++;
  if (s.accountability?.resigned) b.resignations++;
  if (s.accountability?.inquiry_ordered) b.inquiries++;
  if (["charges_filed", "convicted"].includes(s.accountability?.prosecution)) b.prosecutions++;
  b.scandals.push({ slug: s.slug, title: s.title, verdict: v, signal: sig, date: s.date, minister: s.minister_in_charge?.name ?? "" });
}

function finalize(bucketMap) {
  const out = Object.values(bucketMap);
  for (const b of out) {
    const scored = b.verdict.NONE + b.verdict.PARTIAL + b.verdict.FULL;
    const weighted = b.verdict.FULL * VERDICT_WEIGHT.FULL + b.verdict.PARTIAL * VERDICT_WEIGHT.PARTIAL;
    b.accountability_rate = scored ? Math.round((weighted / scored) * 100) : null;
    b.scandals.sort((a, c) => String(c.date ?? "").localeCompare(String(a.date ?? "")));
  }
  // Most failures first, then weakest accountability first.
  return out.sort((a, b) => b.total - a.total || (a.accountability_rate ?? 101) - (b.accountability_rate ?? 101));
}

export function buildScorecards() {
  const scandals = listScandals();
  const byMinistry = {}, byParty = {}, byGovernment = {}, bySector = {};

  for (const s of scandals) {
    const mk = (map, key) => { const k = (key ?? "Unattributed").trim(); (map[k] ??= blankBucket(k)); return map[k]; };
    addToBucket(mk(byMinistry, s.ministry), s);
    addToBucket(mk(byParty, s.party), s);
    addToBucket(mk(byGovernment, s.government), s);
    addToBucket(mk(bySector, s.sector), s);
  }

  const totalsVerdict = { NONE: 0, PARTIAL: 0, FULL: 0 };
  for (const s of scandals) { const v = s.accountability?.verdict ?? "NONE"; if (totalsVerdict[v] != null) totalsVerdict[v]++; }

  return {
    generated_at: new Date().toISOString(),
    total_scandals: scandals.length,
    totals: totalsVerdict,
    byMinistry: finalize(byMinistry),
    byParty: finalize(byParty),
    byGovernment: finalize(byGovernment),
    bySector: finalize(bySector),
  };
}
