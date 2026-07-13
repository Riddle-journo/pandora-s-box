// Procurement forensics detectors over the flattened CPPP award table (built by
// cppp-index.js). These are the Open Contracting / DIGIWHIST red-flag family:
// single-bidding, supplier→buyer capture, contract splitting, short bid windows,
// repeat-winner streaks, value/Benford outliers, fiscal-year-end bunching. They
// operate on the 4.9M-award procurement SYSTEM, not on politicians — each flag's
// subject is a COMPANY (bidder) or a BUYER org. Those names then link to
// politicians downstream: the investigator's Tofler tool expands a flagged bidder
// to its directors, and NETWORK_HUB synthesis connects recurring beneficiaries.
//
// Every detector returns flag-candidates in the engine's shape
// ({ subject, score, fingerprint, headline, rationale, evidence, data,
// severityOverride }); engine.js's CPPP category wraps them, resolves per-run
// settings, and writes flags. Read-only over cppp_flat.db; gated on its presence.
import { flatPath, reliableKey } from "./cppp-index.js";

let _db = null, _tried = false;
async function cpppDb() {
  if (_tried) return _db;
  _tried = true;
  const p = flatPath();
  if (!p) return null;
  try {
    const Database = (await import("better-sqlite3")).default;
    const fs = await import("node:fs");
    if (!fs.existsSync(p)) return null;
    _db = new Database(p, { readonly: true, fileMustExist: true });
    // Confirm the table exists (index may not have been built yet).
    _db.prepare("SELECT 1 FROM cppp_awards LIMIT 1").get();
  } catch { _db = null; }
  return _db;
}

export async function cpppAvailable() { return !!(await cpppDb()); }

// Fast INDEXED lookup (idx_cppp_bidder) of one firm's total CPPP award footprint —
// value, win count, distinct buyers, single-bid count. Milliseconds per call, so a
// detector can resolve hundreds of politician-linked companies without a full scan.
// Returns null when the flat DB is absent, or when the win count is 0.
export async function cpppBidderStats(bidderNorm) {
  const db = await cpppDb(); if (!db || !bidderNorm) return null;
  const r = db.prepare(`SELECT COUNT(*) wins, SUM(COALESCE(value,0)) value,
      COUNT(DISTINCT buyer_norm) buyers, SUM(CASE WHEN bids=1 THEN 1 ELSE 0 END) single,
      MAX(bidder) display, MIN(year) first_year, MAX(year) last_year
    FROM cppp_awards WHERE bidder_norm = ?`).get(bidderNorm);
  return (r && r.wins > 0) ? r : null;
}

const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (v) => { const n = Number(v) || 0; if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`; if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`; return `₹${Math.round(n)}`; };
const ev = (note, url) => ({ note, url: url ?? "https://eprocure.gov.in/cppp/" });
// Synthetic, STABLE entity id per procurement subject so multiple CPPP detectors
// on the SAME bidder/buyer cluster together in flag synthesis (a supplier tripping
// single-bidder + capture + splitting becomes one big evidence-stacked lead) — the
// stacking layer the procurement methodology calls for. Not a resolved entity; the
// investigator's Tofler tool resolves the real firm + directors downstream.
const sub = (kind, norm, name) => ({ entity_id: `cppp:${kind}:${norm}`, name, kind });

// ── a. supplier_buyer_capture — one bidder wins a dominant share of ONE buyer ──
// The clearest capture signal: supplier S wins ≥captureShare of buyer B's award
// COUNT (and a material number of awards). Groups by (buyer_norm, bidder_norm).
export async function detectSupplierCapture(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT buyer_norm, bidder_norm,
           MAX(buyer) buyer, MAX(bidder) bidder,
           COUNT(*) wins, SUM(COALESCE(value,0)) val
    FROM cppp_awards
    WHERE bidder_norm != '' AND buyer_norm != ''
    GROUP BY buyer_norm, bidder_norm
    HAVING wins >= ?`).all(S.minWins);
  // Buyer totals to compute share.
  const buyerTotals = new Map();
  for (const r of db.prepare(`SELECT buyer_norm, COUNT(*) n FROM cppp_awards WHERE buyer_norm!='' GROUP BY buyer_norm`).all())
    buyerTotals.set(r.buyer_norm, r.n);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.bidder_norm)) continue;
    const total = buyerTotals.get(r.buyer_norm) ?? r.wins;
    if (total < S.minBuyerAwards) continue;
    const share = r.wins / total;
    if (share < S.captureShare) continue;
    const score = Math.min(Math.round(12 + share * 30 + r.wins / 5), 55);
    out.push({
      subject: sub("company", r.bidder_norm, r.bidder),
      score,
      fingerprint: `capture|${r.buyer_norm.slice(0, 24)}`,
      headline: `${r.bidder} won ${r.wins} awards (${Math.round(share * 100)}% of them) from ${r.buyer} — supplier capture of one buyer.`,
      rationale: `Of ${total} awards this buyer (${r.buyer}) made, ${r.wins} (${Math.round(share * 100)}%) went to ${r.bidder}, worth ${fmt(r.val)}. A single supplier winning a dominant share of one authority's contracts is a core Open-Contracting capture red flag — merit (a specialist incumbent) is possible; paired with a shared director or donation it is the favouritism shape. Identity is name-matched; expand the bidder's directors to check for a political link.`,
      evidence: [ev(`CPPP: ${r.wins} awards from ${r.buyer} to this bidder`)],
      data: { statistic: "supplier_capture", wins: r.wins, buyer_total: total, share, value: r.val, buyer: r.buyer },
      severityOverride: (share >= S.bigShare && r.wins >= S.bigWins) ? "big" : null,
    });
  }
  return out;
}

// ── b. single_bidder_supplier — a bidder whose wins are mostly UNCONTESTED ──────
// Aggregated to the supplier: a firm winning many awards where only 1 bid was
// received. Single-bidding in a competitive market is THE canonical proxy for
// undetected favouritism (European Court of Auditors / DIGIWHIST).
export async function detectSingleBidder(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT bidder_norm, MAX(bidder) bidder,
           COUNT(*) total,
           SUM(CASE WHEN bids = 1 THEN 1 ELSE 0 END) single,
           SUM(CASE WHEN bids = 1 THEN COALESCE(value,0) ELSE 0 END) single_val
    FROM cppp_awards WHERE bidder_norm != '' AND bids IS NOT NULL
    GROUP BY bidder_norm HAVING single >= ?`).all(S.minSingle);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.bidder_norm)) continue;
    const rate = r.single / r.total;
    if (rate < S.singleRate || r.total < S.minTotal) continue;
    const score = Math.min(Math.round(10 + rate * 25 + r.single / 4), 50);
    out.push({
      subject: sub("company", r.bidder_norm, r.bidder),
      score,
      fingerprint: `single|${r.bidder_norm.slice(0, 24)}`,
      headline: `${r.bidder} won ${r.single} of ${r.total} awards as the ONLY bidder (${Math.round(rate * 100)}% uncontested, ${fmt(r.single_val)}).`,
      rationale: `${r.single} of this firm's ${r.total} CPPP awards received a single bid — its own. Single-bidding in an otherwise competitive category is the strongest objective proxy for tender favouritism. Some categories are legitimately sole-source (proprietary goods, emergencies); a high uncontested rate across many awards is what raises this. Expand directors to check for a political link.`,
      evidence: [ev(`CPPP: ${r.single} single-bid awards to this firm`)],
      data: { statistic: "single_bidder_supplier", single: r.single, total: r.total, rate, single_value: r.single_val },
      severityOverride: (rate >= S.bigRate && r.single >= S.bigSingle) ? "big" : null,
    });
  }
  return out;
}

// ── c. contract_splitting — many small awards, same buyer→bidder, clustered in
// time, whose values hug just under a round threshold (splitting one big contract
// to stay under an approval/tender limit). ──────────────────────────────────────
export async function detectContractSplitting(S) {
  const db = await cpppDb(); if (!db) return [];
  // Candidate pairs with several awards; then inspect their value clustering.
  const pairs = db.prepare(`
    SELECT buyer_norm, bidder_norm, MAX(buyer) buyer, MAX(bidder) bidder, COUNT(*) n
    FROM cppp_awards WHERE bidder_norm!='' AND buyer_norm!='' AND value IS NOT NULL
    GROUP BY buyer_norm, bidder_norm HAVING n >= ?`).all(S.minAwards);
  const getVals = db.prepare(`SELECT value, contract_date FROM cppp_awards WHERE buyer_norm=? AND bidder_norm=? AND value IS NOT NULL ORDER BY contract_date`);
  const out = [];
  for (const p of pairs) {
    if (!reliableKey(p.bidder_norm)) continue;
    const rows = getVals.all(p.buyer_norm, p.bidder_norm);
    const vals = rows.map((r) => r.value).filter((v) => v > 0);
    if (vals.length < S.minAwards) continue;
    // "Just under a round threshold": a big share of values fall in a narrow band
    // just below a power-of-ten-ish threshold (e.g. 90-100% of ₹1L/₹10L/₹1Cr).
    const near = vals.filter((v) => isJustUnderThreshold(v)).length;
    const nearRate = near / vals.length;
    if (nearRate < S.nearRate) continue;
    const med = median(vals);
    const score = Math.min(Math.round(10 + nearRate * 25 + vals.length / 3), 50);
    out.push({
      subject: sub("company", p.bidder_norm, p.bidder),
      score,
      fingerprint: `split|${p.buyer_norm.slice(0, 24)}`,
      headline: `${p.bidder} received ${vals.length} awards from ${p.buyer}, ${Math.round(nearRate * 100)}% of them valued just under a round threshold — possible contract splitting.`,
      rationale: `${vals.length} awards from ${p.buyer} to ${p.bidder} (median ${fmt(med)}), with ${near} sitting just below a round approval threshold. Splitting one large requirement into several just-under-limit contracts is a classic device to dodge higher-tier tendering/approval. Could be genuinely small recurring works; the threshold-hugging pattern is what flags it.`,
      evidence: [ev(`CPPP: ${vals.length} threshold-hugging awards, one buyer→bidder pair`)],
      data: { statistic: "contract_splitting", awards: vals.length, near_threshold: near, near_rate: nearRate, median: med, buyer: p.buyer },
      severityOverride: (nearRate >= S.bigNearRate && vals.length >= S.bigAwards) ? "big" : null,
    });
  }
  return out;
}
// A value is "just under a round threshold" if it's within [band,1.0) of one of
// the common Indian procurement limits.
const THRESHOLDS = [1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 2.5e7, 5e7, 1e8];
function isJustUnderThreshold(v, band = 0.9) {
  for (const t of THRESHOLDS) if (v >= t * band && v < t) return true;
  return false;
}

// ── d. short_bid_window — award published→contract in an implausibly short time
// (or contract dated BEFORE publication) — too little time for real competition.
export async function detectShortWindow(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT bidder_norm, MAX(bidder) bidder, MAX(buyer) buyer,
           COUNT(*) n,
           SUM(CASE WHEN julianday(contract_date) - julianday(published_date) < ? THEN 1 ELSE 0 END) fast
    FROM cppp_awards
    WHERE bidder_norm!='' AND contract_date IS NOT NULL AND published_date IS NOT NULL
    GROUP BY bidder_norm HAVING fast >= ?`).all(S.minDays, S.minFast);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.bidder_norm)) continue;
    if (r.fast / r.n < S.fastRate) continue;
    const score = Math.min(Math.round(10 + (r.fast / r.n) * 20 + r.fast / 3), 45);
    out.push({
      subject: sub("company", r.bidder_norm, r.bidder),
      score,
      fingerprint: `window|${r.bidder_norm.slice(0, 24)}`,
      headline: `${r.bidder} won ${r.fast} awards with under ${S.minDays} days between publication and contract — implausibly short competition windows.`,
      rationale: `${r.fast} of ${r.n} awards to ${r.bidder} closed within ${S.minDays} days of publication (or were dated before it). Too little time for genuine open competition suggests a pre-arranged award. Some framework/repeat contracts legitimately move fast; a pattern across many awards is the flag.`,
      evidence: [ev(`CPPP: ${r.fast} short-window awards to this firm`)],
      data: { statistic: "short_bid_window", fast: r.fast, total: r.n, min_days: S.minDays },
      severityOverride: r.fast >= S.bigFast ? "big" : null,
    });
  }
  return out;
}

// ── e. benford_contract_values — a buyer whose contract values deviate from
// Benford's first-digit law (invented/steered numbers). ─────────────────────────
const BEN = Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)));
export async function detectBenfordValues(S) {
  const db = await cpppDb(); if (!db) return [];
  const buyers = db.prepare(`SELECT buyer_norm, MAX(buyer) buyer, COUNT(*) n FROM cppp_awards WHERE buyer_norm!='' AND value IS NOT NULL AND value>=1000 GROUP BY buyer_norm HAVING n >= ?`).all(S.minN);
  const getDigits = db.prepare(`SELECT value FROM cppp_awards WHERE buyer_norm=? AND value>=1000`);
  const out = [];
  for (const b of buyers) {
    if (!reliableKey(b.buyer_norm)) continue;
    const counts = Array(9).fill(0); let tot = 0;
    for (const r of getDigits.all(b.buyer_norm)) {
      const s = String(Math.abs(r.value)).replace(/[^1-9]/, "").match(/[1-9]/);
      if (s) { counts[Number(s[0]) - 1]++; tot++; }
    }
    if (tot < S.minN) continue;
    let chi2 = 0, mad = 0;
    for (let i = 0; i < 9; i++) { const e = BEN[i] * tot; chi2 += (counts[i] - e) ** 2 / e; mad += Math.abs(counts[i] / tot - BEN[i]); }
    mad /= 9;
    if (chi2 < S.chi2Flag || mad < S.madFlag) continue;
    const score = Math.min(Math.round(8 + (chi2 - S.chi2Flag) / 3 + mad * 800), 45);
    out.push({
      subject: sub("buyer_org", b.buyer_norm, b.buyer),
      score,
      fingerprint: `benford|${b.buyer_norm.slice(0, 24)}`,
      headline: `${b.buyer}'s ${tot} contract values deviate from Benford's law (χ²=${chi2.toFixed(0)}, MAD=${mad.toFixed(4)}) — possible steered pricing.`,
      rationale: `First-digit test over ${tot} award values from this buyer: chi-square ${chi2.toFixed(0)} (flag ≥ ${S.chi2Flag}), Nigrini MAD ${mad.toFixed(4)}. Contract amounts that don't follow the natural first-digit distribution can indicate values set to hit targets or split limits rather than arising from genuine estimation. A screening signal, not proof.`,
      evidence: [ev(`CPPP: ${tot} award values, one buyer`)],
      data: { statistic: "benford_contract_values", n: tot, chi2, mad, buyer: b.buyer },
      severityOverride: (chi2 >= S.chi2Big && mad >= S.madBig) ? "big" : null,
    });
  }
  return out;
}

// ── f. fiscal_year_end_bunching — a buyer concentrating awards in March (the
// FY-end "use it or lose it" rush, associated with weaker scrutiny). ────────────
export async function detectFyEndBunching(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT buyer_norm, MAX(buyer) buyer, COUNT(*) n,
           SUM(CASE WHEN substr(contract_date,6,2)='03' THEN 1 ELSE 0 END) march,
           SUM(CASE WHEN substr(contract_date,6,2)='03' THEN COALESCE(value,0) ELSE 0 END) march_val
    FROM cppp_awards WHERE buyer_norm!='' AND contract_date IS NOT NULL
    GROUP BY buyer_norm HAVING n >= ?`).all(S.minN);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.buyer_norm)) continue;
    const share = r.march / r.n;
    if (share < S.marchShare) continue; // vs ~1/12 ≈ 0.083 baseline
    const score = Math.min(Math.round(8 + (share - 0.083) * 60 + r.march / 20), 40);
    out.push({
      subject: sub("buyer_org", r.buyer_norm, r.buyer),
      score,
      fingerprint: `fyend|${r.buyer_norm.slice(0, 24)}`,
      headline: `${r.buyer} made ${Math.round(share * 100)}% of its awards in March (${r.march} of ${r.n}, ${fmt(r.march_val)}) — fiscal-year-end bunching.`,
      rationale: `${r.march} of ${r.n} awards fell in March against a ~8% flat-month baseline. Year-end spend rushes to avoid budget lapse are associated with rushed, less-scrutinised procurement. Context flag, strongest when paired with single-bidding or a dominant supplier.`,
      evidence: [ev(`CPPP: ${r.march} March awards, one buyer`)],
      data: { statistic: "fy_end_bunching", march: r.march, total: r.n, march_share: share, march_value: r.march_val },
      severityOverride: (share >= S.bigShare && r.march >= S.bigMarch) ? "big" : null,
    });
  }
  return out;
}

// ── g. repeat_winner_streak — a buyer→bidder pair recurring across MANY years
// (an entrenched incumbent — durable capture, not a one-off). ────────────────────
export async function detectRepeatWinner(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT buyer_norm, bidder_norm, MAX(buyer) buyer, MAX(bidder) bidder,
           COUNT(*) wins, COUNT(DISTINCT year) years, SUM(COALESCE(value,0)) val
    FROM cppp_awards WHERE bidder_norm!='' AND buyer_norm!='' AND year IS NOT NULL
    GROUP BY buyer_norm, bidder_norm HAVING years >= ?`).all(S.minYears);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.bidder_norm)) continue;
    const score = Math.min(Math.round(10 + r.years * 4 + r.wins / 4), 48);
    out.push({
      subject: sub("company", r.bidder_norm, r.bidder),
      score,
      fingerprint: `streak|${r.buyer_norm.slice(0, 24)}`,
      headline: `${r.bidder} has won from ${r.buyer} across ${r.years} different years (${r.wins} awards, ${fmt(r.val)}) — an entrenched incumbent.`,
      rationale: `${r.wins} awards spanning ${r.years} years from the same buyer. Durable single-supplier relationships can be efficiency, or lock-in that forecloses competition. Worth checking whether the incumbency coincides with a political tenure or a shared director.`,
      evidence: [ev(`CPPP: ${r.wins} awards over ${r.years} years, one pair`)],
      data: { statistic: "repeat_winner", wins: r.wins, years: r.years, value: r.val, buyer: r.buyer },
      severityOverride: r.years >= S.bigYears ? "big" : null,
    });
  }
  return out;
}

// ── h. date_integrity — impossible date ordering (backdating signature) ────────
// Contract dated BEFORE the tender was published, or awarded implausibly fast —
// a process-integrity impossibility. Cheapest, strongest quick win: pure date
// logic, no joins. Aggregated per buyer so a systematic violation RATE (not one
// stray data-entry row) is the signal.
export async function detectDateIntegrity(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT buyer_norm, MAX(buyer) buyer, COUNT(*) n,
           SUM(CASE WHEN julianday(contract_date) < julianday(published_date) THEN 1 ELSE 0 END) backdated
    FROM cppp_awards
    WHERE buyer_norm!='' AND contract_date IS NOT NULL AND published_date IS NOT NULL
    GROUP BY buyer_norm HAVING backdated >= ?`).all(S.minViolations);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.buyer_norm)) continue;
    const rate = r.backdated / r.n;
    if (rate < S.rate) continue;
    const score = Math.min(Math.round(14 + rate * 30 + r.backdated / 3), 50);
    out.push({
      subject: sub("buyer_org", r.buyer_norm, r.buyer),
      score,
      fingerprint: `dates|${r.backdated}`,
      headline: `${r.buyer} has ${r.backdated} awards dated BEFORE their tender was published (${Math.round(rate * 100)}% of dated awards) — a backdating signature.`,
      rationale: `${r.backdated} of ${r.n} dated awards from this buyer show the contract dated before publication — chronologically impossible for genuine open tendering, the classic backdating/award-then-publish marker. A one-off is a data-entry slip; a systematic rate is the flag.`,
      evidence: [ev(`CPPP: ${r.backdated} date-order violations, one buyer`)],
      data: { statistic: "date_integrity", backdated: r.backdated, total: r.n, rate },
      severityOverride: (rate >= S.bigRate && r.backdated >= S.bigViolations) ? "big" : null,
    });
  }
  return out;
}

// ── i. anonymous_winner — high-value awards to an unverifiable payee ────────────
// A bidder that wins materially yet NEVER carries an address anywhere in the DB —
// an opaque payee the investigator's Tofler step should try to resolve.
export async function detectAnonymousWinner(S) {
  const db = await cpppDb(); if (!db) return [];
  const rows = db.prepare(`
    SELECT bidder_norm, MAX(bidder) bidder, COUNT(*) n, SUM(COALESCE(value,0)) val,
           SUM(CASE WHEN bidder_addr IS NOT NULL AND bidder_addr!='' THEN 1 ELSE 0 END) with_addr
    FROM cppp_awards WHERE bidder_norm!='' AND value IS NOT NULL
    GROUP BY bidder_norm HAVING val >= ? AND with_addr = 0 AND n >= ?`).all(S.minValue, S.minAwards);
  const out = [];
  for (const r of rows) {
    if (!reliableKey(r.bidder_norm)) continue;
    const score = Math.min(Math.round(10 + r.val / 5e7 + r.n / 3), 45);
    out.push({
      subject: sub("company", r.bidder_norm, r.bidder),
      score,
      fingerprint: `anon|${Math.round(r.val)}`,
      headline: `${r.bidder} won ${fmt(r.val)} across ${r.n} awards but carries NO address in any record — an unverifiable payee.`,
      rationale: `This bidder received ${fmt(r.val)} in government awards yet never has an address populated on any of them. A materially-paid supplier with no traceable address is worth resolving — expand its directors via Tofler and check whether it is a genuine firm or a pass-through. Address gaps can be mere data-entry, so this is a lead to verify, not a finding.`,
      evidence: [ev(`CPPP: ${r.n} awards, ${fmt(r.val)}, no address on any`)],
      data: { statistic: "anonymous_winner", value: r.val, awards: r.n },
      severityOverride: r.val >= S.bigValue ? "big" : null,
    });
  }
  return out;
}

// The registry the engine consumes: id → { run(settings), defaults, labels }.
export const CPPP_DETECTORS = [
  { id: "cppp_supplier_capture", run: detectSupplierCapture,
    defaults: { minWins: 5, minBuyerAwards: 20, captureShare: 0.5, bigShare: 0.7, bigWins: 15 } },
  { id: "cppp_single_bidder", run: detectSingleBidder,
    defaults: { minSingle: 5, minTotal: 8, singleRate: 0.5, bigRate: 0.75, bigSingle: 15 } },
  { id: "cppp_contract_splitting", run: detectContractSplitting,
    defaults: { minAwards: 5, nearRate: 0.5, bigNearRate: 0.7, bigAwards: 12 } },
  { id: "cppp_short_window", run: detectShortWindow,
    defaults: { minDays: 3, minFast: 4, fastRate: 0.4, bigFast: 12 } },
  { id: "cppp_benford_values", run: detectBenfordValues,
    defaults: { minN: 300, chi2Flag: 26, chi2Big: 40, madFlag: 0.012, madBig: 0.018 } },
  { id: "cppp_fy_end_bunching", run: detectFyEndBunching,
    defaults: { minN: 50, marchShare: 0.35, bigShare: 0.55, bigMarch: 40 } },
  { id: "cppp_repeat_winner", run: detectRepeatWinner,
    defaults: { minYears: 4, bigYears: 7 } },
  { id: "cppp_date_integrity", run: detectDateIntegrity,
    defaults: { minViolations: 3, rate: 0.15, bigRate: 0.35, bigViolations: 10 } },
  { id: "cppp_anonymous_winner", run: detectAnonymousWinner,
    defaults: { minValue: 5e7, minAwards: 3, bigValue: 5e8 } },
];
