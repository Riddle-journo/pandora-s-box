// Scoring rubric + arithmetic — the single source of truth, shared by the
// Summarizer card engine, the (legacy) dossier generator, and the public
// /api/methodology endpoint. Pure code, no LLM.

// ── Scorecard rubric ────────────────────────────────────────────────────
export const PARAMETERS = [
  { key: "manifesto", label: "Manifesto delivery",
    desc: "Share of concrete manifesto/campaign promises verifiably completed, in progress, or broken — judged against official completion records, not press releases." },
  { key: "corruption", label: "Corruption indicators",
    desc: "Documented findings only: CAG audit objections, court convictions or charges framed, Lokpal/Lokayukta findings, disproportionate asset growth across sworn affidavits. Allegations without records score as 'insufficient evidence', never as guilt." },
  { key: "favoritism", label: "Favoritism / nepotism",
    desc: "Documented patterns of directing public resources, contracts, or posts to relatives or associates (traceable via MCA directorship records, procurement databases)." },
  { key: "hypocrisy", label: "Hypocrisy (says vs does)",
    desc: "Preaching one thing while practising another. Examples: telling citizens to boycott a product while personally indulging in it; campaigning against a policy while voting for it; urging austerity while declaring lavish spending. Requires a documented statement AND a documented contradicting action by the same person." },
  { key: "abuse_of_power", label: "Abuse of power",
    desc: "Documented misuse of office to unjustly benefit self or others: court strictures, tribunal findings, official inquiry reports, misuse of discretionary funds (MPLADS/MLALAD irregularities)." },
];

export const SCORING = {
  formula:
    "Overall score = simple average of every parameter that had enough evidence to score. Parameters with insufficient evidence are EXCLUDED from the average (score -1) — never guessed, never counted against the person, and NEVER given a low number.",
  scale: "Each parameter is scored 0–100, where 100 = exemplary documented conduct and 0 = serious documented wrongdoing. CRITICAL: a CLEAN record scores HIGH. Absence of documented wrongdoing = a high score (75–90), NOT a low one. A LOW score (below 40) requires SPECIFIC documented wrongdoing — a conviction, a CAG objection, a framed charge, a proven disproportionate-assets finding. 'I am unsure' or 'the case is unexamined' is NEVER a low score — it is -1 (excluded). Do not collapse everyone to F by scoring uncertainty as wrongdoing.",
  bands: [
    { min: 85, grade: "A", meaning: "Strong documented record" },
    { min: 70, grade: "B", meaning: "Good record, minor issues" },
    { min: 55, grade: "C", meaning: "Mixed record" },
    { min: 40, grade: "D", meaning: "Significant documented concerns" },
    { min: 25, grade: "E", meaning: "Serious documented concerns" },
    { min: 0,  grade: "F", meaning: "Severe documented record" },
  ],
  confidence_levels: {
    high: "Strong evidence — at least two independent official records (affidavit, CAG, court, parliamentary) point the same way.",
    medium: "Moderate evidence — one official record, or several consistent news reports awaiting an official record.",
    low: "Limited evidence — news leads only, sparse, or contradictory. Treat the score as provisional.",
  },
};

export function computeOverall(parameters) {
  const scored = parameters.filter((p) => p.score >= 0);
  if (scored.length === 0) {
    return { overall_score: -1, overall_grade: "INSUFFICIENT_DATA", calc: "No parameter had enough evidence to score." };
  }
  const overall = Math.round(scored.reduce((s, p) => s + p.score, 0) / scored.length);
  const grade = SCORING.bands.find((b) => overall >= b.min)?.grade ?? "F";
  const calc = `(${scored.map((p) => p.score).join(" + ")}) ÷ ${scored.length} = ${overall} → Grade ${grade}`;
  return { overall_score: overall, overall_grade: grade, calc };
}
