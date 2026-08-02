// Summarizer card engine (Branch 1) — the public report card.
//
// A card is a "one stop shop" of everything public about a subject, built
// almost entirely IN CODE from the structured `numbers` the fetchers attach to
// evidence, plus the deterministic analysis modules (analyzer, graph,
// scorecard arithmetic). The ONLY LLM involvement is an optional, FREE-chain
// "clerical" pass that writes short connective prose — and every card must be
// complete and publishable with ZERO LLM calls (template_prose fallback).
//
// Never included here: investigation leads, pattern flags, or anything from
// the Investigator branch — those are admin-only by design.
import "dotenv/config";
import { formatRupees } from "../util/numbers.js";
import { computeFlags, scoreFromFlags, gatherNumbers } from "../detectors/analyzer.js";
import { relationsForPolitician } from "./graph.js";
import { PARAMETERS, computeOverall } from "./scoring.js";
import { freeJson } from "../synthesis/free-chain.js";
import {
  getPolitician, listEvidence, addCard, listScandals,
  listPoliticians, cardLeaderboardRows,
} from "../store/store.js";
import { blankBucket, addToBucket, finalize } from "./scorecard.js";
import {
  ledgerViewForPolitician, ledgerFindings, mergeFindings, growthOf, peerContextFor,
} from "./card-ledger.js";
import { getMinistry, resolveMinistry, getParty, resolveParty, PARTIES } from "../data/ministries.js";
import { getOrg, orgChildren, resolveOrg } from "../data/orgs.js";
import { fundingForParty } from "../data/electoral-bonds.js";

export const CARD_VERSION = 1;

// ── helpers ─────────────────────────────────────────────────────────────
function section(key, title) {
  return { key, title, stats: [], facts: [], template_prose: "", prose: null };
}
function fact(text, severity = "INFO", sources = []) {
  return { text, severity, sources: (sources ?? []).filter(Boolean) };
}
const pct = (n) => (n == null ? null : `${Number(n).toFixed(1)}%`);

// Pull legislative activity counts out of the Digital Sansad evidence content
// (parliament_questions/_debates + the sansad summary row). Pure text parse — the
// same numbers the parliament extractor writes to the ledger, but kept self-contained
// so a card is buildable from evidence alone.
export function gatherLegislative(evidence) {
  const text = evidence
    .filter((e) => /sansad|parliament/i.test(e.source_type ?? "") || /parliament|Lok Sabha|Rajya Sabha/i.test(e.title ?? ""))
    .map((e) => e.content ?? "")
    .join("\n");
  const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };
  const questions = num(/Asked\s+([\d,]+)\s+question/i);
  const debates = num(/Participated in\s+([\d,]+)\s+debate/i);
  const assurances = num(/assurances secured:\s*([\d,]+)/i);
  const url = evidence.find((e) => /sansad|parliament/i.test(e.source_type ?? ""))?.url ?? null;
  return { questions, debates, assurances, url, hasData: questions != null || debates != null || assurances != null };
}

// Which evidence source types make a scorecard parameter "scoreable" at all.
// A parameter with no flag contributions AND none of its relevant sources in
// evidence scores -1 (insufficient data) — absence of data is never a score.
const PARAM_RELEVANT_SOURCES = {
  manifesto: [],                                    // no promises fetcher yet → -1 until flagged
  corruption: ["eci_affidavit"],
  favoritism: ["mca_company"],
  hypocrisy: [],                                    // needs statement-vs-action records → -1 until flagged
  abuse_of_power: ["eci_affidavit", "mplads"],
};

// A parameter is also scoreable when the LEDGER carries the figures it is
// judged on, not only when an evidence row with the right source_type exists.
// Without this, a politician whose affidavit reached `facts` but never minted a
// typed evidence row would be scored -1 on data we demonstrably hold.
const PARAM_LEDGER_METRICS = {
  manifesto: [],
  corruption: ["declared_assets", "declared_liabilities", "criminal_cases"],
  favoritism: ["declared_business_interests"],
  hypocrisy: [],
  abuse_of_power: ["criminal_cases", "mplads_utilization_pct"],
};

// Peer-comparison wording. Direction matters: "richer than 90%" and "more
// charges than 90%" are both true statements about a high percentile, but only
// one of them reads as English for each metric.
const PEER_PHRASING = [
  ["declared_assets", { label: "Declared assets", verb: () => "higher than" }],
  ["declared_income", { label: "Declared income", verb: () => "higher than" }],
  ["declared_liabilities", { label: "Declared liabilities", verb: () => "higher than" }],
  ["election_expenditure", { label: "Election spending", verb: () => "higher than" }],
  ["criminal_cases", { label: "Declared criminal cases", verb: (p) => (p >= 50 ? "more than" : "fewer than or equal to") }],
  ["mplads_utilization_pct", { label: "MPLADS utilisation", verb: () => "higher than" }],
];
const PEER_MONEY = new Set(["declared_assets", "declared_income", "declared_liabilities", "election_expenditure"]);

// Key sources a complete card draws on, for the data-gaps section.
const EXPECTED_SOURCES = [
  { type: "eci_affidavit", label: "Sworn election affidavit (assets, cases)" },
  { type: "mplads", label: "MPLADS constituency-fund record", offices: ["MP"] },
  { type: "mca_company", label: "MCA company-registry cross-reference" },
  { type: "wikidata", label: "Family / relations (Wikidata)" },
  { type: "sansad", label: "Parliamentary record (Digital Sansad)", offices: ["MP", "RS"], match: (t) => /sansad|parliament/i.test(t) },
  { type: "news", label: "News coverage", match: (t) => /news/i.test(t) },
];

// ── Politician card (pure/deterministic part — no LLM) ─────────────────
export function buildPoliticianCard(pid) {
  const p = getPolitician(pid);
  if (!p) throw new Error(`no politician ${pid}`);
  const evidence = listEvidence(pid);
  // Two sources, one rubric. Evidence `numbers` carry richer nested detail and
  // win on conflict; the typed ledger fills every gap — which for most of the
  // roster is the difference between a populated card and "INSUFFICIENT_DATA".
  const ledger = ledgerViewForPolitician(pid);
  const { flags, facts } = mergeFindings(computeFlags(evidence), ledgerFindings(ledger));
  const lm = ledger.metrics ?? {};
  const lval = (k) => lm[k]?.value ?? null;
  const lsrc = (k) => lm[k]?.url ?? null;
  const { affidavits, mplads, companies, defaulters } = gatherNumbers(evidence);
  const sections = [];

  // Identity & tenure
  const idSec = section("identity", "Identity & Tenure");
  idSec.stats.push({ label: "Office", value: p.office ?? "—" });
  if (p.party) idSec.stats.push({ label: "Party", value: p.party });
  if (p.constituency) idSec.stats.push({ label: "Constituency", value: p.constituency });
  if (p.state) idSec.stats.push({ label: "State", value: p.state });
  idSec.template_prose = `${p.name} is a ${p.office ?? "representative"}${p.party ? ` from ${p.party}` : ""}${p.constituency ? `, representing ${p.constituency}` : ""}${p.state ? ` (${p.state})` : ""}.`;
  sections.push(idSec);

  // Verified findings (the computed flags, verbatim — each is a citable fact)
  if (flags.length) {
    const fs = section("findings", "Verified Findings");
    for (const f of flags) fs.facts.push(fact(f.headline, f.severity, f.sources));
    fs.template_prose = `${flags.length} findings computed directly from public records.`;
    sections.push(fs);
  }

  // Wealth & assets
  if (affidavits.length) {
    const w = section("wealth", "Wealth & Assets");
    const latest = affidavits.at(-1);
    if (latest.net_worth != null) w.stats.push({ label: "Declared net worth", value: formatRupees(latest.net_worth) });
    if (latest.total_liabilities != null) w.stats.push({ label: "Liabilities", value: formatRupees(latest.total_liabilities) });
    if (facts.asset_growth_multiple != null)
      w.stats.push({ label: "Asset growth", value: `${facts.asset_growth_multiple}×`, trend: facts.asset_growth_span_years != null ? `over ${facts.asset_growth_span_years} yrs` : null });
    w.series = affidavits.map((a) => ({ year: a.election_year ?? null, net_worth: a.net_worth ?? null, display: formatRupees(a.net_worth) }));
    for (const a of affidavits)
      w.facts.push(fact(`${a.election_year ?? "Undated"} affidavit: net worth ${formatRupees(a.net_worth)}${a.total_liabilities ? `, liabilities ${formatRupees(a.total_liabilities)}` : ""}.`, "INFO", [a.url]));
    w.template_prose = `Declared net worth across ${affidavits.length} sworn affidavit${affidavits.length > 1 ? "s" : ""}: ${affidavits.map((a) => `${a.election_year ?? "?"} — ${formatRupees(a.net_worth)}`).join("; ")}.`;
    sections.push(w);
  } else if (lval("declared_assets") != null) {
    // Same section, built from the typed ledger for the ~3,000 representatives
    // whose affidavit figures were extracted straight into `facts` and never
    // attached to an evidence row as structured `numbers`.
    const assets = lval("declared_assets");
    const liabilities = lval("declared_liabilities");
    const w = section("wealth", "Wealth & Assets");
    const netWorth = liabilities != null ? assets - liabilities : assets;
    w.stats.push({ label: "Declared net worth", value: formatRupees(netWorth) });
    w.stats.push({ label: "Total assets", value: formatRupees(assets) });
    if (liabilities != null) w.stats.push({ label: "Liabilities", value: formatRupees(liabilities) });
    const growth = growthOf(ledger.series?.declared_assets);
    if (growth) w.stats.push({ label: "Asset growth", value: `${growth.multiple}×`, trend: `over ${growth.years} yrs` });

    // Movable-asset breakdown — the line items readers actually recognise.
    for (const [key, label] of [
      ["cash_in_hand", "Cash in hand"], ["jewellery_value", "Jewellery"],
      ["vehicles_value", "Vehicles"], ["immovable_total", "Immovable property"],
      ["loans_given", "Loans given out"],
    ]) {
      if (lval(key) != null) w.stats.push({ label, value: formatRupees(lval(key)) });
    }
    if (lval("declared_immovable_properties") != null)
      w.stats.push({ label: "Properties declared", value: String(lval("declared_immovable_properties")) });

    if (ledger.series?.declared_assets?.length)
      w.series = ledger.series.declared_assets.map((p) => ({ year: p.year, net_worth: p.value, display: formatRupees(p.value) }));
    w.facts.push(fact(
      `Declared assets ${formatRupees(assets)}${liabilities != null ? `, liabilities ${formatRupees(liabilities)}` : ""}${lm.declared_assets.year ? ` (${lm.declared_assets.year} declaration)` : ""}.`,
      "INFO", [lsrc("declared_assets")]));
    if (growth)
      w.facts.push(fact(`Declared assets rose from ${formatRupees(growth.from)} in ${growth.from_year} to ${formatRupees(growth.to)} in ${growth.to_year} — ${growth.multiple}× over ${growth.years} years.`,
        growth.multiple >= 3 ? "NOTABLE" : "INFO", [lsrc("declared_assets")]));
    w.template_prose = w.facts[0].text;
    sections.push(w);
  }

  // Criminal record (declared case COUNT — per-case detail needs the affidavit itself)
  const latestAff = affidavits.at(-1);
  if (latestAff?.criminal_cases != null) {
    const c = section("criminal", "Criminal Record (self-declared)");
    c.stats.push({ label: "Cases declared", value: String(latestAff.criminal_cases) });
    c.facts.push(fact(
      latestAff.criminal_cases === 0
        ? "No criminal cases declared in the sworn affidavit."
        : `${latestAff.criminal_cases} criminal case${latestAff.criminal_cases > 1 ? "s" : ""} declared in the sworn affidavit (charges, not convictions).`,
      latestAff.criminal_cases === 0 ? "CLEAN" : latestAff.criminal_cases >= 3 ? "NOTABLE" : "INFO",
      [latestAff.url]));
    c.template_prose = c.facts[0].text + " See the affidavit for case details.";
    sections.push(c);
  } else if (lval("criminal_cases") != null) {
    const n = lval("criminal_cases");
    const c = section("criminal", "Criminal Record (self-declared)");
    c.stats.push({ label: "Cases declared", value: String(n) });
    c.facts.push(fact(
      n === 0
        ? "No criminal cases declared in the sworn affidavit."
        : `${n} criminal case${n > 1 ? "s" : ""} declared in the sworn affidavit (charges, not convictions).`,
      n === 0 ? "CLEAN" : n >= 3 ? "NOTABLE" : "INFO", [lsrc("criminal_cases")]));
    c.template_prose = c.facts[0].text + " See the affidavit for case details.";
    sections.push(c);
  }

  // Income declared to the tax authorities, year by year. A single net-worth
  // figure invites the wrong question ("is that a lot?"); an income series next
  // to an asset series invites the right one ("do these two move together?").
  const incomeSeries = ledger.series?.declared_income;
  if (incomeSeries?.length || lval("declared_income") != null) {
    const inc = section("income", "Declared Income");
    if (lval("declared_income") != null)
      inc.stats.push({ label: `Latest declared income${lm.declared_income.year ? ` (${lm.declared_income.year})` : ""}`, value: formatRupees(lval("declared_income")) });
    if (lval("election_expenditure") != null)
      inc.stats.push({ label: "Declared election spend", value: formatRupees(lval("election_expenditure")) });
    if (incomeSeries?.length) {
      inc.series = incomeSeries.map((p) => ({ year: p.year, value: p.value, display: formatRupees(p.value) }));
      inc.facts.push(fact(
        `Income declared across ${incomeSeries.length} years: ${incomeSeries.map((p) => `${p.year} — ${formatRupees(p.value)}`).join("; ")}.`,
        "INFO", [lsrc("declared_income")]));
      const ig = growthOf(incomeSeries);
      if (ig && ig.multiple >= 3)
        inc.facts.push(fact(`Declared income rose ${ig.multiple}× between ${ig.from_year} and ${ig.to_year}.`, "NOTABLE", [lsrc("declared_income")]));
    } else {
      inc.facts.push(fact(`Declared income ${formatRupees(lval("declared_income"))}${lm.declared_income.year ? ` (${lm.declared_income.year})` : ""}.`, "INFO", [lsrc("declared_income")]));
    }
    inc.template_prose = inc.facts[0]?.text ?? "";
    sections.push(inc);
  }

  // Public funds (MPLADS, MPs only)
  if (mplads && mplads.utilization_pct != null) {
    const m = section("funds", "Public Funds (MPLADS)");
    m.stats.push({ label: "Utilisation", value: pct(mplads.utilization_pct) });
    if (mplads.allocated != null) m.stats.push({ label: "Allocated", value: formatRupees(mplads.allocated) });
    if (mplads.unspent != null) m.stats.push({ label: "Unspent", value: formatRupees(mplads.unspent) });
    m.facts.push(fact(`${pct(mplads.utilization_pct)} of MPLADS local-development funds utilised${mplads.unspent ? `, ${formatRupees(mplads.unspent)} unspent` : ""}.`, mplads.utilization_pct < 50 ? "NOTABLE" : "INFO", [mplads.url]));
    m.template_prose = m.facts[0].text;
    sections.push(m);
  } else if (lval("mplads_utilization_pct") != null) {
    const util = lval("mplads_utilization_pct");
    const alloc = lval("mplads_allocated"), spent = lval("mplads_spent");
    const m = section("funds", "Public Funds (MPLADS)");
    m.stats.push({ label: "Utilisation", value: pct(util) });
    if (alloc != null) m.stats.push({ label: "Allocated", value: formatRupees(alloc) });
    if (spent != null) m.stats.push({ label: "Spent", value: formatRupees(spent) });
    if (alloc != null && spent != null) m.stats.push({ label: "Unspent", value: formatRupees(Math.max(0, alloc - spent)) });
    if (lval("mplads_works_recommended") != null) m.stats.push({ label: "Works recommended", value: String(lval("mplads_works_recommended")) });
    if (lval("mplads_works_completed") != null) m.stats.push({ label: "Works completed", value: String(lval("mplads_works_completed")) });
    m.facts.push(fact(`${pct(util)} of MPLADS local-development funds utilised${alloc != null && spent != null ? `, ${formatRupees(Math.max(0, alloc - spent))} unspent` : ""}.`,
      util < 50 ? "NOTABLE" : "INFO", [lsrc("mplads_utilization_pct")]));
    m.template_prose = m.facts[0].text;
    sections.push(m);
  }

  // Business links
  if (companies.length || defaulters.length) {
    const b = section("business", "Business Links");
    if (companies.length) b.stats.push({ label: "Companies (MCA)", value: String(companies.length) });
    const struckOff = companies.filter((x) => /struck off|strike off|dormant/i.test(x.status ?? ""));
    if (struckOff.length) b.stats.push({ label: "Struck-off / dormant", value: String(struckOff.length) });
    for (const cmp of companies.slice(0, 12))
      b.facts.push(fact(`${cmp.name}${cmp.status ? ` — ${cmp.status}` : ""}${cmp.cin ? ` (CIN ${cmp.cin})` : ""}.`, /struck|dormant/i.test(cmp.status ?? "") ? "NOTABLE" : "INFO", [cmp.source_url]));
    for (const d of defaulters.slice(0, 5))
      b.facts.push(fact(`Possible match in wilful-defaulter/insolvency records: ${d.entity}${d.amount ? ` (${formatRupees(d.amount)})` : ""} — identity unverified.`, "SIGNIFICANT", [d.source_url]));
    b.template_prose = `${companies.length} compan${companies.length === 1 ? "y" : "ies"} linked via the MCA registry${struckOff.length ? `, of which ${struckOff.length} recorded as struck off or dormant` : ""}.`;
    sections.push(b);
  }

  // Power & influence (Digital Sansad "power" numbers)
  const power = evidence.find((e) => e.numbers?.power)?.numbers?.power;
  if (power && (power.ministries?.length || Object.keys(power.question_sectors ?? {}).length || power.positions?.length)) {
    const pw = section("power", "Power & Influence");
    const src = evidence.find((e) => e.numbers?.power)?.url;
    if (power.ministries?.length) {
      pw.stats.push({ label: "Ministerial roles", value: String(power.ministries.length) });
      pw.facts.push(fact(`Ministerial positions held: ${power.ministries.join("; ")}.`, "INFO", [src]));
    }
    const qs = Object.entries(power.question_sectors ?? {}).sort((a, b) => b[1] - a[1]);
    if (qs.length)
      pw.facts.push(fact(`Parliamentary questions concentrated in: ${qs.slice(0, 5).map(([s, n]) => `${s} (${n})`).join(", ")}.`, "INFO", [src]));
    if (power.positions?.length) pw.stats.push({ label: "Positions held", value: String(power.positions.length) });
    pw.template_prose = `Official record of positions held and the sectors this member's parliamentary work targets.`;
    sections.push(pw);
  }

  // Legislative record (MP/RS) — questions asked, debates participated, assurances.
  // Parsed from the Digital Sansad evidence content (the same counts the parliament
  // extractor pulls into the ledger). Zero questions for a sitting MP is itself an
  // accountability signal, so it is surfaced (NOTABLE), not hidden.
  if (["MP", "RS"].includes(p.office)) {
    const leg = gatherLegislative(evidence);
    if (leg.hasData) {
      const lg = section("legislative", "Legislative Record");
      if (leg.questions != null) lg.stats.push({ label: "Questions asked", value: String(leg.questions) });
      if (leg.debates != null) lg.stats.push({ label: "Debates", value: String(leg.debates) });
      if (leg.assurances != null) lg.stats.push({ label: "Assurances", value: String(leg.assurances) });
      const bits = [];
      if (leg.questions != null) bits.push(`asked ${leg.questions} question${leg.questions === 1 ? "" : "s"}`);
      if (leg.debates != null) bits.push(`participated in ${leg.debates} debate${leg.debates === 1 ? "" : "s"}`);
      const sev = (leg.questions === 0 && leg.debates === 0) ? "NOTABLE" : "INFO";
      lg.facts.push(fact(`Parliamentary activity: ${bits.join(", ")}${leg.assurances != null ? `; ${leg.assurances} government assurance${leg.assurances === 1 ? "" : "s"} secured` : ""}.`, sev, [leg.url]));
      lg.template_prose = lg.facts[0].text;
      sections.push(lg);
    } else if (lval("questions_asked") != null || lval("debates_participated") != null) {
      const lg = section("legislative", "Legislative Record");
      const qs = lval("questions_asked"), db_ = lval("debates_participated"), as = lval("assurances_count");
      if (qs != null) lg.stats.push({ label: "Questions asked", value: String(qs) });
      if (db_ != null) lg.stats.push({ label: "Debates", value: String(db_) });
      if (as != null) lg.stats.push({ label: "Assurances", value: String(as) });
      const bits = [];
      if (qs != null) bits.push(`asked ${qs} question${qs === 1 ? "" : "s"}`);
      if (db_ != null) bits.push(`participated in ${db_} debate${db_ === 1 ? "" : "s"}`);
      lg.facts.push(fact(`Parliamentary activity: ${bits.join(", ")}${as != null ? `; ${as} government assurance${as === 1 ? "" : "s"} secured` : ""}.`,
        (qs === 0 && db_ === 0) ? "NOTABLE" : "INFO", [lsrc("questions_asked") ?? lsrc("debates_participated")]));
      lg.template_prose = lg.facts[0].text;
      sections.push(lg);
    }
  }

  // Network (deterministic relatives / dynasty links)
  const relations = relationsForPolitician(p, evidence);
  if (relations.relatives.length || relations.links.length) {
    const n = section("network", "Family & Network");
    for (const l of relations.links) n.facts.push(fact(l.note, l.type === "RELATIVE_IN_SCANDAL" ? "NOTABLE" : "INFO", [l.source_url]));
    if (!relations.links.length)
      n.facts.push(fact(`Documented relatives: ${relations.relatives.map((r) => `${r.name} (${r.relation})`).join("; ")}.`, "INFO", relations.relatives.map((r) => r.source_url)));
    n.template_prose = relations.links.length
      ? `${relations.links.length} notable family/network link${relations.links.length > 1 ? "s" : ""} found in public records.`
      : `Documented family relations, none currently linked to office or scandals.`;
    sections.push(n);
  }

  // Scandals on their watch (as minister-in-charge)
  const watch = scandalsOnWatch(p);
  if (watch.length) {
    const sw = section("watch", "Failures On Their Watch");
    sw.stats.push({ label: "Documented failures", value: String(watch.length) });
    for (const s of watch.slice(0, 8))
      sw.facts.push(fact(`${s.title}${s.date ? ` (${String(s.date).slice(0, 4)})` : ""} — accountability: ${s.verdict ?? "unassessed"}.`, s.signal === "RED" ? "SIGNIFICANT" : "NOTABLE", []));
    sw.template_prose = `${watch.length} documented governance failure${watch.length > 1 ? "s" : ""} occurred while this person held the responsible portfolio.`;
    sections.push(sw);
  }

  // How they compare — the section that turns a figure into information.
  // "Net worth ₹7 crore" answers nothing on its own; "richer than 88% of MLAs
  // in this state, median ₹2.1 crore" answers the question a reader actually
  // arrived with. Ranks are only shown for cohorts large enough to be honest.
  const peers = peerContextFor({ id: p.id, office: p.office, state: p.state });
  const rankKeys = Object.keys(peers.ranks ?? {});
  if (rankKeys.length) {
    const cmp = section("peers", "How They Compare");
    cmp.cohort = { label: peers.cohort_label, size: peers.cohort_size };
    for (const [key, phrasing] of PEER_PHRASING) {
      const r = peers.ranks[key];
      if (!r) continue;
      const money = PEER_MONEY.has(key);
      const shown = money ? formatRupees(r.value) : key.endsWith("_pct") ? pct(r.value) : String(r.value);
      const median = money ? formatRupees(r.median) : key.endsWith("_pct") ? pct(r.median) : String(r.median);
      cmp.stats.push({ label: phrasing.label, value: shown, trend: `rank ${r.rank} of ${r.of}` });
      cmp.facts.push(fact(
        `${phrasing.label}: ${shown} — ${phrasing.verb(r.percentile)} ${r.percentile}% of ${r.cohort_label} (rank ${r.rank} of ${r.of}; median ${median}).`,
        "INFO", []));
    }
    cmp.template_prose = `Ranked against ${peers.cohort_size} ${peers.cohort_label}, using the same declared figures for everyone.`;
    if (cmp.facts.length) sections.push(cmp);
  }

  // Data gaps — which key sources have nothing yet (honesty about coverage)
  const present = new Set(evidence.map((e) => e.source_type).filter(Boolean));
  const gaps = EXPECTED_SOURCES.filter((s) => {
    if (s.offices && !s.offices.includes(p.office)) return false;
    return s.match ? ![...present].some(s.match) : !present.has(s.type);
  }).map((s) => s.label);
  if (gaps.length) {
    const g = section("gaps", "Data Gaps");
    for (const label of gaps) g.facts.push(fact(`Not yet on record: ${label}.`, "INFO", []));
    g.template_prose = `Some public records are not yet in the corpus; the card reflects only what is on file.`;
    sections.push(g);
  }

  // ── Scorecard: deterministic, fully auditable ─────────────────────────
  const { baseline, contributions } = scoreFromFlags(flags);
  const parameters = PARAMETERS.map((pm) => {
    const contribs = contributions[pm.key] ?? [];
    const relevant = (PARAM_RELEVANT_SOURCES[pm.key] ?? []).some((t) => present.has(t))
      || (PARAM_LEDGER_METRICS[pm.key] ?? []).some((k) => lval(k) != null);
    const score = contribs.length || relevant ? baseline[pm.key] : -1;
    return { key: pm.key, label: pm.label, score, contributions: contribs };
  });
  const overall = computeOverall(parameters);

  return {
    kind: "politician",
    subject_key: p.id,
    scope: "union",
    card_version: CARD_VERSION,
    politician_id: p.id,
    name: p.name,
    party: p.party ?? null,
    office: p.office ?? null,
    state: p.state ?? null,
    constituency: p.constituency ?? null,
    score: overall.overall_score,
    grade: overall.overall_grade,
    calc: overall.calc,
    parameters,
    headline: defaultHeadline(p, overall, facts),
    summary: null,               // filled by the prose pass, else UI uses template
    sections,
    computed_facts: facts,
    evidence_count: evidence.length,
    // How much typed, citable data stands behind this card — the honest measure
    // of its depth, and the number that tells an operator whether a thin card is
    // a coverage gap or a generation bug.
    ledger_metric_count: Object.keys(lm).length,
    peers: rankKeys.length ? peers : null,
    prose_model: null,
  };
}

// Failures on this politician's watch — same matcher as the public endpoint.
// Uses the lazily-loaded resolver (scandal-generator pulls in llm.js, so it is
// imported dynamically in loadResolver to keep pure card builds light).
function scandalsOnWatch(p) {
  return listScandals().filter((s) =>
    s.minister_politician_id === p.id ||
    (_resolveMinister && s.minister_in_charge?.name && _resolveMinister(s.minister_in_charge.name) === p.id))
    .map((s) => ({ slug: s.slug, title: s.title, date: s.date, verdict: s.accountability?.verdict ?? null, signal: s.signal ?? null }));
}
let _resolveMinister = null;
// Loaded lazily on first generateCard call (scandal-generator pulls in llm.js).
async function loadResolver() {
  if (_resolveMinister) return;
  try {
    const m = await import("./scandal-generator.js");
    _resolveMinister = m.resolveMinisterPolitician;
  } catch { _resolveMinister = null; }
}

function defaultHeadline(p, overall, facts) {
  const bits = [];
  if (overall.overall_grade && overall.overall_grade !== "INSUFFICIENT_DATA") bits.push(`Grade ${overall.overall_grade}`);
  if (facts.criminal_cases != null) bits.push(facts.criminal_cases === 0 ? "no declared cases" : `${facts.criminal_cases} declared cases`);
  if (facts.net_worth_display) bits.push(`net worth ${facts.net_worth_display}`);
  if (facts.asset_growth_multiple != null && facts.asset_growth_multiple >= 3) bits.push(`assets grew ${facts.asset_growth_multiple}×`);
  return bits.length ? `${p.name}: ${bits.join(" · ")}` : `${p.name} — public record report card`;
}

// ── Ministry card (pure aggregation over the scandal corpus) ────────────
export function buildMinistryCard(key) {
  const m = getMinistry(key);
  if (!m) throw new Error(`unknown ministry key: ${key}`);
  const hits = listScandals().filter((s) => resolveMinistry(s.ministry)?.key === key);
  const bucket = blankBucket(m.name);
  for (const s of hits) addToBucket(bucket, s);
  finalize({ [m.name]: bucket });

  const sections = [];
  const ov = section("overview", "Accountability Overview");
  ov.stats.push({ label: "Documented failures", value: String(bucket.total) });
  if (bucket.accountability_rate != null) ov.stats.push({ label: "Accountability rate", value: `${bucket.accountability_rate}%` });
  ov.stats.push({ label: "Resignations", value: String(bucket.resignations) });
  ov.stats.push({ label: "Prosecutions", value: String(bucket.prosecutions) });
  ov.template_prose = bucket.total
    ? `${bucket.total} documented governance failure${bucket.total > 1 ? "s" : ""} traced to ${m.name}; ${bucket.accountability_rate ?? 0}% of them saw real accountability (resignation, prosecution, or remedy).`
    : `No documented failures traced to ${m.name} in the current corpus.`;
  sections.push(ov);

  if (bucket.scandals.length) {
    const fs = section("failures", "Documented Failures");
    for (const s of bucket.scandals)
      fs.facts.push(fact(`${s.title}${s.date ? ` (${String(s.date).slice(0, 4)})` : ""}${s.minister ? ` — minister in charge: ${s.minister}` : ""} — accountability: ${s.verdict}.`,
        s.signal === "RED" ? "SIGNIFICANT" : s.signal === "AMBER" ? "NOTABLE" : "INFO", []));
    fs.slugs = bucket.scandals.map((s) => s.slug);
    fs.template_prose = `Each failure links to its full, cited Government Watch analysis.`;
    sections.push(fs);
  }

  // Ministers in charge over time (linked to their own report cards when known).
  const ministers = [...new Map(hits.filter((s) => s.minister_in_charge?.name).map((s) => [
    s.minister_in_charge.name,
    { name: s.minister_in_charge.name, politician_id: s.minister_politician_id ?? null, scandals: hits.filter((x) => x.minister_in_charge?.name === s.minister_in_charge.name).length },
  ])).values()];
  if (ministers.length) {
    const mi = section("ministers", "Ministers On Watch");
    for (const x of ministers)
      mi.facts.push(fact(`${x.name} — ${x.scandals} documented failure${x.scandals > 1 ? "s" : ""} on their watch.`, "INFO", []));
    mi.ministers = ministers;
    mi.template_prose = `Ministers who held the portfolio when documented failures occurred.`;
    sections.push(mi);
  }

  return {
    kind: "ministry", subject_key: key, scope: m.scope, card_version: CARD_VERSION,
    name: m.name, sectors: m.sectors ?? [],
    score: bucket.accountability_rate, grade: null,
    headline: `${m.name}: ${bucket.total} documented failure${bucket.total !== 1 ? "s" : ""}${bucket.accountability_rate != null ? ` · ${bucket.accountability_rate}% accountability` : ""}`,
    summary: null, sections,
  };
}

// ── Org card (ministry / department / PSU / regulator) ─────────────────
// Scandal-corpus aggregation (as buildMinistryCard) PLUS ledger-native
// evidence: relationships, facts, claims and events attached to the org's
// canonical entity (dynamic import of entities.js keeps this module loadable
// without the DB in card-shape tests, mirroring the route pattern).
export async function buildOrgCard(key) {
  const org = getOrg(key);
  if (!org) throw new Error(`unknown org key: ${key}`);
  const children = orgChildren(key);
  // Failures roll up: a department's scandals also count toward its ministry.
  const keys = new Set([key, ...children.map((c) => c.key)]);
  const hits = listScandals().filter((s) => keys.has(resolveMinistry(s.ministry)?.key));
  const bucket = blankBucket(org.name);
  for (const s of hits) addToBucket(bucket, s);
  finalize({ [org.name]: bucket });

  const sections = [];
  const ov = section("overview", "Accountability Overview");
  ov.stats.push({ label: "Documented failures", value: String(bucket.total) });
  if (bucket.accountability_rate != null) ov.stats.push({ label: "Accountability rate", value: `${bucket.accountability_rate}%` });
  ov.stats.push({ label: "Resignations", value: String(bucket.resignations) });
  ov.stats.push({ label: "Prosecutions", value: String(bucket.prosecutions) });
  ov.template_prose = bucket.total
    ? `${bucket.total} documented governance failure${bucket.total > 1 ? "s" : ""} traced to ${org.name}; ${bucket.accountability_rate ?? 0}% of them saw real accountability (resignation, prosecution, or remedy).`
    : `No documented failures traced to ${org.name} in the current corpus.`;
  sections.push(ov);

  if (bucket.scandals.length) {
    const fs = section("failures", "Documented Failures");
    for (const s of bucket.scandals)
      fs.facts.push(fact(`${s.title}${s.date ? ` (${String(s.date).slice(0, 4)})` : ""}${s.minister ? ` — minister in charge: ${s.minister}` : ""} — accountability: ${s.verdict}.`,
        s.signal === "RED" ? "SIGNIFICANT" : s.signal === "AMBER" ? "NOTABLE" : "INFO", []));
    fs.slugs = bucket.scandals.map((s) => s.slug);
    fs.template_prose = `Each failure links to its full, cited Government Watch analysis.`;
    sections.push(fs);
  }

  // Ministers in charge over time (ministry/department kinds).
  const ministers = [...new Map(hits.filter((s) => s.minister_in_charge?.name).map((s) => [
    s.minister_in_charge.name,
    { name: s.minister_in_charge.name, politician_id: s.minister_politician_id ?? null, scandals: hits.filter((x) => x.minister_in_charge?.name === s.minister_in_charge.name).length },
  ])).values()];
  if (ministers.length) {
    const mi = section("ministers", "Ministers On Watch");
    for (const x of ministers)
      mi.facts.push(fact(`${x.name} — ${x.scandals} documented failure${x.scandals > 1 ? "s" : ""} on their watch.`, "INFO", []));
    mi.ministers = ministers;
    mi.template_prose = `Ministers who held the portfolio when documented failures occurred.`;
    sections.push(mi);
  }

  // ── Ledger-native evidence trail ─────────────────────────────────────
  try {
    const { findEntityByStrongId, getEntity } = await import("../entities/entities.js");
    const { db } = await import("../store/store.js");
    const ent = findEntityByStrongId("org", { org_key: key });
    if (ent) {
      const REL_LABEL = {
        named_in_government_contract: "Named in government contracts",
        named_in_committee_report: "Named in parliamentary committee reports",
        awarded_tender: "Tenders awarded",
        audited_by: "Audit findings",
      };
      // A PSU is also a registered company: the registry/directorship sources
      // file records against a separate `company` entity, linked by same_as
      // (scripts/backfill-org-entities.js). Read both so the page shows the
      // whole body, not half of it.
      const linked = db.prepare(
        "SELECT dst_entity_id AS id FROM relationships WHERE src_entity_id = ? AND rel_type = 'same_as'"
      ).all(ent.id).map((r) => r.id);
      const ids = [ent.id, ...linked];
      const placeholders = ids.map(() => "?").join(",");
      const rels = db.prepare(
        `SELECT rel_type, src_entity_id, evidence_id, data FROM relationships
         WHERE dst_entity_id IN (${placeholders}) AND rel_type <> 'same_as'
         ORDER BY created_at DESC LIMIT 400`
      ).all(...ids);
      if (rels.length) {
        const byType = new Map();
        for (const r of rels) { if (!byType.has(r.rel_type)) byType.set(r.rel_type, []); byType.get(r.rel_type).push(r); }
        const ev = section("evidence", "Evidence Trail — Records Naming This Organization");
        for (const [type, rows] of byType) {
          const label = REL_LABEL[type] ?? type.replace(/_/g, " ");
          ev.stats.push({ label, value: String(rows.length) });
          for (const r of rows.slice(0, 12)) {
            const src = getEntity(r.src_entity_id);
            const pid = src?.strong_ids?.politician_id ?? null;
            let note = "";
            try { const d = JSON.parse(r.data ?? "{}"); note = d.note ?? d.title ?? ""; } catch {}
            ev.facts.push({
              text: `${label}: ${src?.canonical_name ?? "record"}${note ? ` — ${String(note).slice(0, 160)}` : ""}`,
              severity: "INFO", sources: [],
              politician_id: pid, evidence_id: r.evidence_id ?? null,
            });
          }
        }
        ev.template_prose = `Records in the analysis ledgers that name ${org.name}. Counts are shown in full; the newest items are listed.`;
        sections.push(ev);
      }
      const events = db.prepare(
        `SELECT kind, at, data FROM events WHERE ${ids.map(() => "entity_ids LIKE ?").join(" OR ")} ORDER BY coalesce(at,'') DESC LIMIT 60`
      ).all(...ids.map((i) => `%"${i}"%`));
      const nonScandal = events.filter((e) => e.kind !== "governance_failure");
      if (nonScandal.length) {
        const evs = section("events", "Recorded Events");
        for (const e of nonScandal.slice(0, 20)) {
          let d = {}; try { d = JSON.parse(e.data ?? "{}"); } catch {}
          evs.facts.push(fact(`${e.kind.replace(/_/g, " ")}${e.at ? ` (${String(e.at).slice(0, 10)})` : ""}${d.title ? ` — ${d.title}` : ""}`, "INFO", []));
        }
        sections.push(evs);
      }
    }
  } catch { /* ledger sections are best-effort; the card must build without them */ }

  // Structure: parent breadcrumb + children directory.
  if (children.length) {
    const ch = section("children", org.kind === "ministry" ? "Departments & Bodies Under This Ministry" : "Subordinate Bodies");
    ch.orgs = children.map((c) => ({ key: c.key, name: c.name, kind: c.kind }));
    ch.template_prose = "Each has its own accountability page.";
    sections.push(ch);
  }

  return {
    kind: org.kind, subject_key: key, scope: org.scope, card_version: CARD_VERSION,
    name: org.name, short: org.short ?? null, sectors: org.sectors ?? [],
    parent: org.parent ? { key: org.parent, name: getOrg(org.parent)?.name ?? org.parent } : null,
    score: bucket.accountability_rate, grade: null,
    headline: `${org.name}: ${bucket.total} documented failure${bucket.total !== 1 ? "s" : ""}${bucket.accountability_rate != null ? ` · ${bucket.accountability_rate}% accountability` : ""}`,
    summary: null, sections,
  };
}

// ── Party card (roster aggregates + funding + scandal record) ───────────
export function buildPartyCard(key, scope = "union") {
  const party = getParty(key);
  if (!party) throw new Error(`unknown party key: ${key}`);
  const stateScope = scope !== "union" ? String(scope) : null;

  // Roster: all reps whose party string resolves to this canonical party.
  let roster = listPoliticians().filter((p) => !p.is_demo && resolveParty(p.party)?.key === key);
  if (stateScope) roster = roster.filter((p) => (p.state ?? "").toLowerCase() === stateScope.toLowerCase());
  const cardsById = new Map(cardLeaderboardRows().map((r) => [r.id, r]));

  const sections = [];
  const ro = section("roster", "Elected Representatives");
  ro.stats.push({ label: "Total reps", value: String(roster.length) });
  const byOffice = {};
  for (const p of roster) byOffice[p.office ?? "?"] = (byOffice[p.office ?? "?"] ?? 0) + 1;
  for (const [office, n] of Object.entries(byOffice)) ro.stats.push({ label: office, value: String(n) });
  ro.template_prose = `${roster.length} elected representative${roster.length !== 1 ? "s" : ""}${stateScope ? ` in ${stateScope}` : " nationwide"} on the current roster.`;
  sections.push(ro);

  // Grade distribution + record aggregates from politician cards.
  const graded = roster.map((p) => cardsById.get(p.id)).filter((c) => c && c.grade && c.grade !== "INSUFFICIENT_DATA");
  const withCases = roster.map((p) => cardsById.get(p.id)).filter((c) => c && c.cases != null);
  const worths = roster.map((p) => cardsById.get(p.id)?.net_worth_num).filter((v) => v != null).sort((a, b) => a - b);
  if (graded.length || withCases.length) {
    const rec = section("record", "Collective Record");
    if (graded.length) {
      const dist = {};
      for (const c of graded) dist[c.grade] = (dist[c.grade] ?? 0) + 1;
      rec.grade_distribution = dist;
      const avg = Math.round(graded.reduce((s, c) => s + (c.score ?? 0), 0) / graded.length);
      rec.stats.push({ label: "Avg accountability score", value: `${avg}/100`, trend: `${graded.length} scored` });
      rec.facts.push(fact(`Grade distribution across ${graded.length} scored members: ${["A","B","C","D","E","F"].filter((g) => dist[g]).map((g) => `${g}: ${dist[g]}`).join(", ")}.`, "INFO", []));
    }
    if (withCases.length) {
      const withAny = withCases.filter((c) => c.cases > 0).length;
      rec.stats.push({ label: "Members with declared cases", value: `${Math.round((withAny / withCases.length) * 100)}%`, trend: `${withAny} of ${withCases.length}` });
    }
    if (worths.length) {
      const median = worths[Math.floor(worths.length / 2)];
      rec.stats.push({ label: "Median declared net worth", value: formatRupees(median) });
    }
    rec.template_prose = `Aggregated from each member's sworn affidavit and computed report card — same formula for every party.`;
    sections.push(rec);
  }

  // Electoral-bond funding (union scope only — disclosure is national).
  if (!stateScope) {
    const funding = fundingForParty(party.name);
    if (funding) {
      const fu = section("funding", "Electoral-Bond Funding");
      fu.stats.push({ label: "Total received", value: `₹${funding.total_cr.toLocaleString("en-IN")} Cr` });
      fu.stats.push({ label: "Rank", value: `#${funding.rank} of ${funding.total_parties}` });
      for (const d of (funding.donors ?? []).slice(0, 6))
        fu.facts.push(fact(`${d.donor}${d.sector ? ` (${d.sector})` : ""} — ₹${d.total_cr.toLocaleString("en-IN")} Cr.`, "INFO", []));
      fu.template_prose = `Electoral bonds disclosed by SBI on Supreme Court order (Apr 2019 – Jan 2024), at party level.`;
      sections.push(fu);
    }
  }

  // Scandal record — same bucket arithmetic as every party.
  let hits = listScandals().filter((s) => resolveParty(s.party)?.key === key);
  if (stateScope) hits = hits.filter((s) => (s.state ?? "").toLowerCase() === stateScope.toLowerCase());
  const bucket = blankBucket(party.name);
  for (const s of hits) addToBucket(bucket, s);
  finalize({ [party.name]: bucket });
  if (bucket.total) {
    const sc = section("scandals", "Documented Failures On Their Watch");
    sc.stats.push({ label: "Documented failures", value: String(bucket.total) });
    if (bucket.accountability_rate != null) sc.stats.push({ label: "Accountability rate", value: `${bucket.accountability_rate}%` });
    for (const s of bucket.scandals.slice(0, 10))
      sc.facts.push(fact(`${s.title}${s.date ? ` (${String(s.date).slice(0, 4)})` : ""} — accountability: ${s.verdict}.`, s.signal === "RED" ? "SIGNIFICANT" : "NOTABLE", []));
    sc.slugs = bucket.scandals.map((s) => s.slug);
    sc.template_prose = `Failures documented while this party held the responsible office. Same corpus, same formula, for every party.`;
    sections.push(sc);
  }

  return {
    kind: "party", subject_key: key, scope: stateScope ?? "union", card_version: CARD_VERSION,
    name: party.name,
    score: null, grade: null, // deliberately NO single invented party number
    headline: `${party.name}${stateScope ? ` — ${stateScope}` : ""}: ${roster.length} reps · ${bucket.total} documented failure${bucket.total !== 1 ? "s" : ""}`,
    summary: null, sections,
  };
}

// ── Clerical prose pass (FREE chain only; card must survive without it) ─
// The stylist may only CONNECT facts, never add any. Guard: every digit run in
// its output must already appear somewhere in the input facts/stats.
function digitRuns(s) { return String(s ?? "").match(/\d[\d,.]*/g) ?? []; }
function allowedDigits(card) {
  const set = new Set();
  const eat = (s) => { for (const d of digitRuns(s)) set.add(d.replace(/[,.]+$/, "")); };
  eat(card.headline);
  for (const sec of card.sections) {
    for (const st of sec.stats) { eat(st.label); eat(String(st.value)); eat(String(st.trend ?? "")); }
    for (const f of sec.facts) eat(f.text);
    eat(sec.template_prose);
  }
  return set;
}
function digitsOk(text, allowed) {
  return digitRuns(text).every((d) => allowed.has(d.replace(/[,.]+$/, "")));
}

const PROSE_SYS = `You are a copy clerk for a non-partisan public-records report card on an Indian elected representative.
You are given computed FACTS (each already verified in code from public records). Write short connective prose:
- "headline": one factual line (max 120 chars) naming the subject and the most load-bearing facts.
- "summary": 2-4 plain sentences tying the facts together for a citizen. Neutral, no adjectives of guilt or praise.
- "section_notes": an object mapping section keys to ONE short sentence each (only for sections listed).
ABSOLUTE RULES: use ONLY facts given — add NO new fact, number, name, date, or claim. Never call anyone corrupt,
criminal, or dishonest. No speculation. If the record is thin, say plainly that the record is thin.
Respond with ONLY JSON: {"headline":"...","summary":"...","section_notes":{"key":"..."}}`;

export async function applyCardProse(card) {
  const payload = {
    subject: { name: card.name, office: card.office, party: card.party, state: card.state, grade: card.grade, score: card.score },
    sections: card.sections.map((s) => ({
      key: s.key, title: s.title,
      stats: s.stats, facts: s.facts.map((f) => f.text),
    })),
  };
  const out = await freeJson({
    system: PROSE_SYS,
    user: JSON.stringify(payload, null, 1),
    maxTokens: 1500, temperature: 0.4, tag: "card",
  });
  if (!out) { console.log("[card]   no free model available — template prose kept"); return card; }

  const allowed = allowedDigits(card);
  const keep = (s, cap = 700) => typeof s === "string" && s.trim() && s.length <= cap && digitsOk(s, allowed) ? s.trim() : null;

  let kept = 0, rejected = 0;
  const h = keep(out.data.headline, 160); if (h) { card.headline = h; kept++; } else if (out.data.headline) rejected++;
  const sm = keep(out.data.summary); if (sm) { card.summary = sm; kept++; } else if (out.data.summary) rejected++;
  const notes = out.data.section_notes ?? {};
  for (const sec of card.sections) {
    const n = keep(notes[sec.key], 400);
    if (n) { sec.prose = n; kept++; } else if (notes[sec.key]) rejected++;
  }
  card.prose_model = kept > 0 ? out.model : null;
  console.log(`[card]   ${out.model} · ${kept} field(s) written, ${rejected} rejected by digit guard`);
  return card;
}

// ── Entry point ─────────────────────────────────────────────────────────
export async function generateCard(kind, subjectKey, { prose = true, persist = true, scope = "union" } = {}) {
  let card;
  if (kind === "politician") { await loadResolver(); card = buildPoliticianCard(subjectKey); }
  else if (kind === "ministry") card = buildMinistryCard(subjectKey);
  else if (kind === "party") card = buildPartyCard(subjectKey, scope);
  else throw new Error(`unknown card kind: ${kind}`);
  if (prose) {
    try { await applyCardProse(card); }
    catch (err) { console.warn(`[card]   prose pass failed (${err.message}) — template prose kept`); }
  }
  return persist ? addCard(card) : card;
}
