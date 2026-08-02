// Deterministic computed-flags layer — the "research desk" of the AI journalist.
//
// This runs in CODE, after ingest, before the LLM writes anything. It reads the
// structured `numbers` that fetchers attach to evidence and computes named,
// reproducible facts: asset growth multiples, MPLADS utilisation, pending-case
// counts, struck-off companies, defaulter matches, etc. Each fact is exact and
// re-derivable — the same evidence ALWAYS yields the same flags.
//
// The LLM never decides WHETHER these facts are true; its job shrinks to
// narrating and contextualising facts this module has already verified. This is
// the Serenata/RUBLI model: compute first, narrate second.
import { formatRupees } from "../util/numbers.js";

// A single computed fact. `weight` is its fixed contribution (−100..+100) to the
// named scorecard parameter — negative = adverse, positive = clean/good. These
// are transparent constants, not model judgment.
function flag(code, param, weight, severity, headline, detail, sources = []) {
  return { code, param, weight, severity, headline, detail, sources };
}

// Merge all evidence `numbers` for a politician into one view. Where a politician
// has multiple affidavits (different election years), keep them all for growth.
// Exported: the Summarizer card engine (cards.js) builds its wealth/criminal/
// business sections from this same gathered view.
export function gatherNumbers(evidence) {
  const affidavits = [];
  let mplads = null;
  const companies = []; // {name, status, cin, source_url} from mca verification
  const defaulters = []; // {entity, amount, source_url} from defaulter cross-ref
  for (const e of evidence) {
    const n = e.numbers;
    if (!n) continue;
    if (e.source_type === "eci_affidavit" && n.total_assets != null)
      affidavits.push({ ...n, url: e.url });
    else if (e.source_type === "mplads") mplads = { ...n, url: e.url };
    else if (e.source_type === "mca_company" && Array.isArray(n.companies)) companies.push(...n.companies);
    else if (e.source_type === "defaulter" && Array.isArray(n.matches)) defaulters.push(...n.matches);
  }
  affidavits.sort((a, b) => (a.election_year ?? 0) - (b.election_year ?? 0));
  return { affidavits, mplads, companies, defaulters };
}

export function computeFlags(evidence) {
  const { affidavits, mplads, companies, defaulters } = gatherNumbers(evidence);
  const flags = [];
  const facts = {}; // structured summary for the frontend + prompt

  // ── Wealth & asset growth ──────────────────────────────────────────────
  const latest = affidavits.at(-1);
  if (latest) {
    facts.net_worth = latest.net_worth;
    facts.net_worth_display = formatRupees(latest.net_worth);
    facts.total_liabilities = latest.total_liabilities;
    // Liabilities exceeding assets is a hard, objective fact.
    if (latest.total_liabilities > latest.total_assets && latest.total_assets > 0) {
      flags.push(flag("LIABILITIES_EXCEED_ASSETS", "corruption", -8, "NOTABLE",
        `Declared liabilities (${formatRupees(latest.total_liabilities)}) exceed declared assets (${formatRupees(latest.total_assets)}).`,
        `In the sworn affidavit, liabilities are larger than total assets — a fact worth noting for financial standing.`,
        [latest.url]));
    }
  }
  // Asset growth across two+ affidavits (the disproportionate-assets classic).
  if (affidavits.length >= 2) {
    const first = affidavits[0], last = affidavits.at(-1);
    if (first.net_worth > 0 && last.net_worth > 0) {
      const mult = last.net_worth / first.net_worth;
      // Only state a year span when BOTH filings actually carry a year —
      // otherwise a null year coerces to 0 and produces "over 2024 years".
      const bothYears = first.election_year != null && last.election_year != null && last.election_year > first.election_year;
      const years = bothYears ? last.election_year - first.election_year : null;
      facts.asset_growth_multiple = Number(mult.toFixed(1));
      if (years != null) facts.asset_growth_span_years = years;
      if (mult >= 3) {
        const filings = bothYears ? `sworn affidavits of ${first.election_year} and ${last.election_year}` : "successive sworn affidavits";
        flags.push(flag("ASSET_GROWTH_ANOMALY", "corruption", mult >= 8 ? -22 : -12,
          mult >= 8 ? "SIGNIFICANT" : "NOTABLE",
          `Declared net worth grew ${mult.toFixed(1)}× (${formatRupees(first.net_worth)} → ${formatRupees(last.net_worth)})${years != null ? ` over ${years} years` : ""}.`,
          `Computed directly from ${filings}. Rapid growth is not itself wrongdoing, but is flagged for explanation against declared income.`,
          [first.url, last.url]));
      }
    }
  }

  // ── Criminal record ─────────────────────────────────────────────────────
  if (latest?.criminal_cases != null) {
    facts.criminal_cases = latest.criminal_cases;
    if (latest.criminal_cases === 0) {
      flags.push(flag("CLEAN_CRIMINAL_RECORD", "corruption", +6, "CLEAN",
        `No criminal cases declared in the sworn affidavit.`,
        `A clean declared record — a documented positive.`, [latest.url]));
    } else if (latest.criminal_cases >= 3) {
      flags.push(flag("MULTIPLE_PENDING_CASES", "abuse_of_power", latest.criminal_cases >= 8 ? -20 : -12,
        latest.criminal_cases >= 8 ? "SIGNIFICANT" : "NOTABLE",
        `${latest.criminal_cases} criminal cases declared (charges, not convictions).`,
        `Self-declared in the sworn affidavit. Charges are a public record, not proof of guilt.`, [latest.url]));
    }
  }

  // ── MPLADS fund utilisation (MPs only) ──────────────────────────────────
  // Only meaningful when real money was actually allocated (≥ ₹1 cr) — a newly
  // sworn-in MP with a zero/nominal allocation must not be penalised for "0%".
  if (mplads && mplads.utilization_pct != null && (mplads.allocated ?? 0) >= 1e7) {
    facts.mplads_utilization_pct = Number(mplads.utilization_pct.toFixed(1));
    facts.mplads_unspent = mplads.unspent;
    if (mplads.utilization_pct < 50) {
      flags.push(flag("MPLADS_UNDERUTILISED", "abuse_of_power", mplads.utilization_pct < 25 ? -14 : -8,
        mplads.utilization_pct < 25 ? "SIGNIFICANT" : "NOTABLE",
        `Only ${mplads.utilization_pct.toFixed(1)}% of MPLADS local-development funds utilised${mplads.unspent ? `, leaving ${formatRupees(mplads.unspent)} unspent` : ""}.`,
        `Computed from the official MPLADS record. Low utilisation means allocated development money for the constituency went unspent.`, [mplads.url]));
    } else if (mplads.utilization_pct >= 90) {
      flags.push(flag("MPLADS_WELL_UTILISED", "abuse_of_power", +6, "CLEAN",
        `${mplads.utilization_pct.toFixed(1)}% of MPLADS funds utilised — strong constituency-development spending.`,
        `A documented positive from the official MPLADS record.`, [mplads.url]));
    }
  }

  // ── Company / defaulter cross-references (from new sources) ──────────────
  const struckOff = companies.filter((c) => /struck off|strike off|dormant/i.test(c.status ?? ""));
  if (struckOff.length) {
    flags.push(flag("STRUCK_OFF_COMPANY_LINK", "favoritism", -10, "NOTABLE",
      `Linked to ${struckOff.length} struck-off/dormant compan${struckOff.length > 1 ? "ies" : "y"} in the MCA registry.`,
      `Companies named in the affidavit that the Ministry of Corporate Affairs records as struck off or dormant: ${struckOff.map((c) => c.name).slice(0, 5).join("; ")}.`,
      struckOff.map((c) => c.source_url).filter(Boolean)));
  }
  if (defaulters.length) {
    flags.push(flag("DEFAULTER_MATCH", "corruption", -18, "SIGNIFICANT",
      `Name/entity match against a bank wilful-defaulter / insolvency record (${defaulters.length}).`,
      `Potential match — MUST be identity-verified before drawing any conclusion: ${defaulters.map((d) => d.entity).slice(0, 3).join("; ")}.`,
      defaulters.map((d) => d.source_url).filter(Boolean)));
  }

  return { flags, facts };
}

// Fold computed flags into the 5-parameter scorecard as a transparent, additive
// baseline. Every parameter starts at a neutral 70 (clean-by-default, since a
// record with nothing adverse should score well — see the scoring-direction
// fix) and each flag's fixed weight nudges it. Returns per-parameter baselines
// + the itemised contributions, so the score is fully reproducible & auditable.
export function scoreFromFlags(flags) {
  const PARAMS = ["manifesto", "corruption", "favoritism", "hypocrisy", "abuse_of_power"];
  const baseline = {}; const contributions = {};
  for (const k of PARAMS) { baseline[k] = 70; contributions[k] = []; }
  for (const f of flags) {
    if (!PARAMS.includes(f.param)) continue;
    baseline[f.param] = Math.max(0, Math.min(100, baseline[f.param] + f.weight));
    contributions[f.param].push({ code: f.code, weight: f.weight, headline: f.headline });
  }
  return { baseline, contributions };
}
