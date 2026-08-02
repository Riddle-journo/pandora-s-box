// Seeds FICTIONAL demo politicians plus sample reports so the UI is fully
// browsable before you configure real subjects or an API key. All people,
// parties and findings are invented — deliberately, so the repository never
// ships claims about a real person that haven't gone through the evidence
// pipeline. Real Indian states are used so the home-page filters feel real.
import { upsertPolitician, addEvidence, addReport, listPoliticians } from "../store/store.js";
import { computeOverall } from "../publishing/report-generator.js";

if (listPoliticians().length > 0) {
  console.log("Store already has politicians — skipping seed. Delete data/db.json to reseed.");
  process.exit(0);
}

const cite = (n, title, url, admissible) => ({ n, title, url, admissible });
const DEMO_URL = "https://example.com/demo";

function seedRep({ person, evidence, headline, summary, params, gaps }) {
  const p = upsertPolitician({ ...person, is_demo: true });
  addEvidence(evidence.map((e) => ({ ...e, politician_id: p.id })));
  const overall = computeOverall(params);
  addReport({
    politician_id: p.id,
    model: "demo-seed",
    evidence_count: evidence.length,
    headline,
    summary,
    parameters: params,
    data_gaps: gaps,
    ...overall,
  });
  console.log(`Seeded ${p.name} → grade ${overall.overall_grade}`);
}

// ------------------------------------------------------------------ rep 1
seedRep({
  person: { name: "Demo Netaji (Fictional)", party: "Demo Party", office: "MP", constituency: "Demopur", state: "Maharashtra", myneta_url: null },
  evidence: [
    { source_type: "eci_affidavit", admissible: true, title: "DEMO: 2024 ECI affidavit — assets ₹14.2 cr (up from ₹3.1 cr in 2019), 2 criminal cases pending", url: "https://affidavits.eci.gov.in/", date: "2024-04-10", summary: "Fictional sample of an affidavit-derived evidence item." },
    { source_type: "cag", admissible: true, title: "DEMO: CAG Report 4/2023 flags ₹62 cr irregularity in district road contracts", url: "https://cag.gov.in/en/audit-report", date: "2023-08-02", summary: "Fictional sample CAG finding." },
    { source_type: "news", admissible: false, title: "DEMO: 'MP promises 24x7 water by 2023' — The Demopur Times (2019)", url: DEMO_URL, date: "2019-05-21", summary: "Fictional manifesto-promise coverage." },
    { source_type: "news", admissible: false, title: "DEMO: MP urges citizens to boycott imported electronics; customs record shows personal import of luxury TV (2023)", url: DEMO_URL, date: "2023-11-14", summary: "Fictional hypocrisy lead — statement vs personal act." },
  ],
  headline: "Delivered on roads, silent on water; asset growth of 358% across one term warrants scrutiny.",
  summary:
    "This is a fictional demonstration report. One CAG audit flagged irregularities in road contracts overseen during the MP's tenure [2]; the 2019 promise of 24x7 water has no completion record [3]; declared assets grew from ₹3.1 cr to ₹14.2 cr between sworn affidavits [1] — not itself wrongdoing, but flagged for explanation. Two criminal cases are pending: charges, not convictions [1].",
  params: [
    { key: "manifesto", label: "Manifesto delivery", score: 45, confidence: "medium", confidence_reason: "1 official record + 1 news report", verdict: "Roughly half of trackable promises show completion records.", rationale: "The flagship water promise [3] has no completion record. Road works were delivered but with audit objections [2].", citations: [cite(3, "DEMO: water promise (2019)", DEMO_URL, false), cite(2, "DEMO: CAG Report 4/2023", "https://cag.gov.in/en/audit-report", true)] },
    { key: "corruption", label: "Corruption indicators", score: 38, confidence: "high", confidence_reason: "2 independent official records", verdict: "Audit irregularities documented; no conviction.", rationale: "CAG flagged ₹62 cr in irregular contracting [2]. Two cases are pending — charges, not findings of guilt [1]. Asset growth of 358% across one term [1] is flagged for explanation.", citations: [cite(2, "DEMO: CAG Report 4/2023", "https://cag.gov.in/en/audit-report", true), cite(1, "DEMO: 2024 ECI affidavit", "https://affidavits.eci.gov.in/", true)] },
    { key: "favoritism", label: "Favoritism / nepotism", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "No record ties contracts to relatives or associates. MCA beneficial-ownership records of the contractors flagged in [2] would settle this.", citations: [cite(2, "DEMO: CAG Report 4/2023", "https://cag.gov.in/en/audit-report", true)] },
    { key: "hypocrisy", label: "Hypocrisy (says vs does)", score: 40, confidence: "low", confidence_reason: "news lead only — official customs record needed", verdict: "One reported boycott-vs-purchase contradiction, unverified.", rationale: "Reported: urged a boycott of imported electronics while personally importing a luxury television [4]. Both halves rest on a single news report; the customs/import record would settle it. The broken water commitment [3] also counts against says-does consistency.", citations: [cite(4, "DEMO: boycott vs import (2023)", DEMO_URL, false), cite(3, "DEMO: water promise (2019)", DEMO_URL, false)] },
    { key: "abuse_of_power", label: "Abuse of power", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "No court stricture or inquiry finding in the current evidence set.", citations: [] },
  ],
  gaps: [
    "Completion records (PWD/Jal Board) for the 2019 water promise.",
    "MCA beneficial ownership of contractors named in CAG Report 4/2023.",
    "Customs/import record to verify the reported boycott contradiction.",
    "Case status from eCourts for the two pending cases.",
  ],
});

// ------------------------------------------------------------------ rep 2
seedRep({
  person: { name: "Asha Verma (Fictional)", party: "Janata Vikas Party", office: "MLA", constituency: "Rampur Nagar", state: "Uttar Pradesh", myneta_url: null },
  evidence: [
    { source_type: "eci_affidavit", admissible: true, title: "DEMO: 2022 affidavit — assets ₹1.8 cr, no criminal cases", url: "https://affidavits.eci.gov.in/", date: "2022-02-01", summary: "Fictional affidavit." },
    { source_type: "assembly", admissible: true, title: "DEMO: Assembly record — 91% attendance, 142 questions on schools & health", url: DEMO_URL, date: "2024-12-01", summary: "Fictional assembly record." },
    { source_type: "mlalads", admissible: true, title: "DEMO: MLALAD audit — 94% utilization, no objections", url: DEMO_URL, date: "2024-09-15", summary: "Fictional fund-utilization record." },
  ],
  headline: "Clean affidavit, high attendance, funds fully accounted — promises largely on track.",
  summary: "Fictional demonstration report. Sworn affidavit declares no criminal cases [1]; assembly attendance is 91% with active questioning [2]; constituency development funds show 94% audited utilization with no objections [3].",
  params: [
    { key: "manifesto", label: "Manifesto delivery", score: 78, confidence: "medium", confidence_reason: "1 official record", verdict: "Most trackable promises show progress records.", rationale: "School and clinic upgrades pledged in 2022 appear in the audited MLALAD work list [3].", citations: [cite(3, "DEMO: MLALAD audit", DEMO_URL, true)] },
    { key: "corruption", label: "Corruption indicators", score: 88, confidence: "high", confidence_reason: "2 independent official records", verdict: "No adverse finding on record.", rationale: "No criminal cases declared [1]; fund audit closed without objection [3].", citations: [cite(1, "DEMO: 2022 affidavit", "https://affidavits.eci.gov.in/", true), cite(3, "DEMO: MLALAD audit", DEMO_URL, true)] },
    { key: "favoritism", label: "Favoritism / nepotism", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "No contractor-relative linkage examined yet; MCA directorship search pending.", citations: [] },
    { key: "hypocrisy", label: "Hypocrisy (says vs does)", score: 80, confidence: "medium", confidence_reason: "1 official record, no contradictions found", verdict: "Statements and assembly votes align so far.", rationale: "Public statements on school funding match her assembly questions and votes [2]. No documented contradiction found.", citations: [cite(2, "DEMO: assembly record", DEMO_URL, true)] },
    { key: "abuse_of_power", label: "Abuse of power", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "No stricture or inquiry on record.", citations: [] },
  ],
  gaps: ["MCA directorship search for family members.", "Independent verification of school upgrade completion."],
});

// ------------------------------------------------------------------ rep 3
seedRep({
  person: { name: "Vikram Reddy (Fictional)", party: "Independent", office: "MP", constituency: "Kakinada East", state: "Andhra Pradesh", myneta_url: null },
  evidence: [
    { source_type: "eci_affidavit", admissible: true, title: "DEMO: 2024 affidavit — assets ₹6.4 cr, 1 case (defamation, pending)", url: "https://affidavits.eci.gov.in/", date: "2024-04-12", summary: "Fictional affidavit." },
    { source_type: "mplads", admissible: true, title: "DEMO: MPLADS — 61% utilization; 3 works re-tendered after delays", url: DEMO_URL, date: "2025-01-20", summary: "Fictional MPLADS record." },
    { source_type: "news", admissible: false, title: "DEMO: 'Fisherfolk jetty promise still on paper' — Coastal Herald", url: DEMO_URL, date: "2024-08-03", summary: "Fictional promise-tracking coverage." },
  ],
  headline: "Middling fund utilization and a stalled flagship promise; record otherwise clean.",
  summary: "Fictional demonstration report. MPLADS utilization stands at 61% with delays [2]; the flagship jetty promise has no work order [3]; the single pending case is defamation, not corruption [1].",
  params: [
    { key: "manifesto", label: "Manifesto delivery", score: 48, confidence: "medium", confidence_reason: "1 official record + 1 news report", verdict: "Flagship promise stalled; smaller works progressing.", rationale: "The jetty promise has no sanctioned work order [3]; MPLADS works progress slowly [2].", citations: [cite(3, "DEMO: jetty promise", DEMO_URL, false), cite(2, "DEMO: MPLADS record", DEMO_URL, true)] },
    { key: "corruption", label: "Corruption indicators", score: 72, confidence: "medium", confidence_reason: "1 official record", verdict: "No corruption finding; one unrelated case pending.", rationale: "Affidavit shows one pending defamation case — not a corruption charge [1].", citations: [cite(1, "DEMO: 2024 affidavit", "https://affidavits.eci.gov.in/", true)] },
    { key: "favoritism", label: "Favoritism / nepotism", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "Re-tendered works [2] merit a contractor-linkage check via MCA records.", citations: [cite(2, "DEMO: MPLADS record", DEMO_URL, true)] },
    { key: "hypocrisy", label: "Hypocrisy (says vs does)", score: -1, confidence: "low", confidence_reason: "no documented statement-action pair", verdict: "Insufficient evidence to score.", rationale: "No documented statement contradicted by a documented action in the current set.", citations: [] },
    { key: "abuse_of_power", label: "Abuse of power", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "Nothing on record.", citations: [] },
  ],
  gaps: ["Work-order trail for the jetty promise.", "MCA check on re-tendered contractors."],
});

// ------------------------------------------------------------------ rep 4
seedRep({
  person: { name: "Meera Iyer (Fictional)", party: "Pragati Congress", office: "MP", constituency: "Chennai Central", state: "Tamil Nadu", myneta_url: null },
  evidence: [
    { source_type: "eci_affidavit", admissible: true, title: "DEMO: 2024 affidavit — assets ₹3.9 cr (stable since 2019), no cases", url: "https://affidavits.eci.gov.in/", date: "2024-04-08", summary: "Fictional affidavit." },
    { source_type: "parliament", admissible: true, title: "DEMO: Sansad record — 96% attendance, 218 questions, 2 private member bills", url: DEMO_URL, date: "2025-02-11", summary: "Fictional parliamentary record." },
    { source_type: "mplads", admissible: true, title: "DEMO: MPLADS — 97% utilization, third-party audit clean", url: DEMO_URL, date: "2025-01-05", summary: "Fictional MPLADS audit." },
  ],
  headline: "Near-perfect attendance, clean audits, stable assets — the record voters cite as the benchmark.",
  summary: "Fictional demonstration report. Assets stable across two terms with no cases [1]; 96% attendance and high legislative activity [2]; MPLADS utilization at 97% with a clean third-party audit [3].",
  params: [
    { key: "manifesto", label: "Manifesto delivery", score: 85, confidence: "high", confidence_reason: "2 independent official records", verdict: "Nearly all trackable promises delivered.", rationale: "Metro feeder and school-lab pledges appear as completed works in the audited MPLADS list [3]; legislative pledges match introduced bills [2].", citations: [cite(3, "DEMO: MPLADS audit", DEMO_URL, true), cite(2, "DEMO: Sansad record", DEMO_URL, true)] },
    { key: "corruption", label: "Corruption indicators", score: 92, confidence: "high", confidence_reason: "2 independent official records", verdict: "No adverse finding; assets stable.", rationale: "No cases [1]; clean fund audit [3]; asset declarations flat across terms [1].", citations: [cite(1, "DEMO: 2024 affidavit", "https://affidavits.eci.gov.in/", true), cite(3, "DEMO: MPLADS audit", DEMO_URL, true)] },
    { key: "favoritism", label: "Favoritism / nepotism", score: 82, confidence: "medium", confidence_reason: "1 official record", verdict: "No linkage found in audited works.", rationale: "Third-party MPLADS audit found no related-party contractors [3].", citations: [cite(3, "DEMO: MPLADS audit", DEMO_URL, true)] },
    { key: "hypocrisy", label: "Hypocrisy (says vs does)", score: 84, confidence: "medium", confidence_reason: "1 official record, no contradictions found", verdict: "Votes match stated positions.", rationale: "Stated positions on urban transport match voting record [2]; no documented contradiction.", citations: [cite(2, "DEMO: Sansad record", DEMO_URL, true)] },
    { key: "abuse_of_power", label: "Abuse of power", score: -1, confidence: "low", confidence_reason: "no record in evidence set", verdict: "Insufficient evidence to score.", rationale: "Nothing on record.", citations: [] },
  ],
  gaps: ["Independent verification of school-lab completions."],
});

// ------------------------------------------------------------------ rep 5
seedRep({
  person: { name: "Harpreet Singh Gill (Fictional)", party: "Punjab Lok Morcha", office: "MLA", constituency: "Ludhiana West", state: "Punjab", myneta_url: null },
  evidence: [
    { source_type: "eci_affidavit", admissible: true, title: "DEMO: 2022 affidavit — assets ₹22 cr (up from ₹4 cr in 2017), 4 cases incl. 1 charge framed (PMLA)", url: "https://affidavits.eci.gov.in/", date: "2022-02-03", summary: "Fictional affidavit." },
    { source_type: "court", admissible: true, title: "DEMO: HC order — strictures for 'colourable exercise of power' in transfer of mandi officials (2023)", url: DEMO_URL, date: "2023-07-19", summary: "Fictional court stricture." },
    { source_type: "lokayukta", admissible: true, title: "DEMO: Lokayukta report — sand-mining permits issued to firm directed by brother-in-law", url: DEMO_URL, date: "2024-03-30", summary: "Fictional Lokayukta finding." },
    { source_type: "news", admissible: false, title: "DEMO: Campaigned on 'end sand mafia'; permits to relative's firm — Punjab Tribune", url: DEMO_URL, date: "2024-04-02", summary: "Fictional hypocrisy coverage of the Lokayukta finding." },
  ],
  headline: "Court strictures, a Lokayukta finding naming a relative's firm, and 450% asset growth.",
  summary: "Fictional demonstration report. A High Court recorded strictures for misuse of transfer powers [2]; the Lokayukta found mining permits issued to a firm directed by a relative [3] — directly contradicting his signature campaign plank [4]; assets grew 450% in five years and a money-laundering charge has been framed [1].",
  params: [
    { key: "manifesto", label: "Manifesto delivery", score: 25, confidence: "medium", confidence_reason: "1 official record + 1 news report", verdict: "Signature promise contradicted by official finding.", rationale: "The 'end sand mafia' plank is contradicted by the Lokayukta's permit finding [3][4].", citations: [cite(3, "DEMO: Lokayukta report", DEMO_URL, true), cite(4, "DEMO: campaign coverage", DEMO_URL, false)] },
    { key: "corruption", label: "Corruption indicators", score: 18, confidence: "high", confidence_reason: "3 independent official records", verdict: "Charge framed; adverse ombudsman finding; steep unexplained asset growth.", rationale: "A PMLA charge has been framed — a judicial finding of prima facie case, still not a conviction [1]. The Lokayukta finding [3] and 450% asset growth [1] compound the picture.", citations: [cite(1, "DEMO: 2022 affidavit", "https://affidavits.eci.gov.in/", true), cite(3, "DEMO: Lokayukta report", DEMO_URL, true)] },
    { key: "favoritism", label: "Favoritism / nepotism", score: 15, confidence: "high", confidence_reason: "official ombudsman finding", verdict: "Documented permits to a relative's firm.", rationale: "Lokayukta found mining permits issued to a firm directed by his brother-in-law [3].", citations: [cite(3, "DEMO: Lokayukta report", DEMO_URL, true)] },
    { key: "hypocrisy", label: "Hypocrisy (says vs does)", score: 12, confidence: "high", confidence_reason: "official finding contradicts documented campaign statement", verdict: "Campaigned against the practice he facilitated.", rationale: "Campaign statements against sand mining [4] are contradicted by the documented permit decisions [3]. Both halves are on record.", citations: [cite(4, "DEMO: campaign coverage", DEMO_URL, false), cite(3, "DEMO: Lokayukta report", DEMO_URL, true)] },
    { key: "abuse_of_power", label: "Abuse of power", score: 20, confidence: "high", confidence_reason: "court stricture on record", verdict: "High Court strictures for misuse of transfer powers.", rationale: "HC recorded a 'colourable exercise of power' in official transfers [2].", citations: [cite(2, "DEMO: HC order (2023)", DEMO_URL, true)] },
  ],
  gaps: ["Trial outcome of the framed PMLA charge.", "Appeal status of the Lokayukta finding."],
});

console.log("Seed complete.");
