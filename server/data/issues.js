// Policy-issue seeds for the "Where India Stands" vertical (task #5).
//
// For each issue, GLM-5.2 (see server/issue-analyzer.js) produces: what the
// issue means in the Indian context, India's current state, India vs the world
// (rank + best-performing countries), and what successive parties/governments
// have actually DONE on it — their stance, measures, and record — judged on the
// public record, with STRICT political neutrality across parties.
//
// Add or edit freely; `slug` is the stable id. The user controls this list.
export const ISSUE_SEEDS = [
  {
    slug: "poverty-reduction",
    title: "Poverty Reduction",
    icon: "🍚",
    description: "Lifting people above the poverty line; multidimensional poverty (nutrition, sanitation, housing, schooling, assets), not just income.",
    metrics_hint: "MPI headcount, % below poverty line, NFHS indicators, MGNREGA/PDS/PM-Awas/Ujjwala coverage.",
  },
  {
    slug: "press-freedom",
    title: "Press Freedom",
    icon: "🗞️",
    description: "Freedom of the press and of journalists to report without intimidation, legal harassment, internet shutdowns, or state pressure.",
    metrics_hint: "RSF World Press Freedom Index rank, journalist arrests/cases, internet shutdowns, sedition/UAPA/defamation use against media.",
  },
  {
    slug: "improving-judiciary",
    title: "Judicial Reform",
    icon: "⚖️",
    description: "A faster, more accessible, more independent judiciary: pendency, judicial vacancies, undertrial population, legal aid, judicial appointments.",
    metrics_hint: "Case pendency (crores), undertrials as % of prisoners, judge-to-population ratio, NJDG data, collegium vs NJAC debate.",
  },
  {
    slug: "climate-change",
    title: "Climate Change",
    icon: "🌍",
    description: "Cutting emissions, expanding renewables, adapting to climate impacts, and meeting India's international commitments fairly.",
    metrics_hint: "Renewable capacity, per-capita emissions, NDC/net-zero-2070 targets, air quality, forest cover, CCPI rank.",
  },
  {
    slug: "healthcare",
    title: "Healthcare",
    icon: "🏥",
    description: "Access to and quality of public health: spending, insurance, primary care, out-of-pocket costs, health outcomes.",
    metrics_hint: "Public health spend as % GDP, out-of-pocket %, Ayushman Bharat coverage, IMR/MMR, doctors per 1000, NFHS outcomes.",
  },
  {
    slug: "education",
    title: "Education",
    icon: "📚",
    description: "Access to and quality of schooling and higher education: enrolment, learning outcomes, spending, dropout, NEP implementation.",
    metrics_hint: "ASER learning levels, GER, public education spend as % GDP, dropout rates, NEP 2020 rollout, teacher vacancies.",
  },
  {
    slug: "national-security",
    title: "National Security",
    icon: "🛡️",
    description: "Defence preparedness, internal security, borders, terrorism, and the balance between security powers and accountability.",
    metrics_hint: "Defence budget, border incidents, terror/insurgency trends, AFSPA, defence indigenisation, intelligence oversight.",
  },
  {
    slug: "civil-rights-liberties",
    title: "Civil Rights & Liberties",
    icon: "✊",
    description: "Freedoms and liberties: speech, assembly, dissent, due process, minority and caste rights, surveillance, and equality before law.",
    metrics_hint: "Use of UAPA/sedition, custodial deaths (NCRB), surveillance law, RTI dilution, V-Dem/Freedom House civil-liberties scores.",
  },
];
