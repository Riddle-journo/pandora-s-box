// Corpus of documented Indian governance failures — scams, accidents, policy
// failures — for the accountability engine. The generator researches each
// (minister responsible, action taken, Indian + international precedent).
//
// ── NEUTRALITY IS LOAD-BEARING ──────────────────────────────────────────
// This list is DELIBERATELY balanced across parties, governments, states and
// decades. Accountability is non-partisan: a scam under Congress, BJP, a Left
// front, a regional party, or a coalition is recorded the same way. Convictions
// and clean chits both span every party. When you add entries, KEEP THE BALANCE —
// do not let the corpus skew toward (or against) any one party or era. Each seed
// carries `party` (the governing party/coalition responsible at the time) and
// `government` (the specific ministry/term) precisely so the scorecards can show
// that balance openly.
//
// Fields: slug, title, date, sector, govt_level("union"|"state"), state?,
//         ministry, party, government, summary (neutral one-liner; the engine
//         adds the analysis and respects "charged ≠ convicted").

export const SCANDAL_SEEDS = [
  // ─────────────── 1980s–1990s ───────────────
  {
    slug: "bhopal-gas-1984", title: "Bhopal gas tragedy and its aftermath",
    date: "1984-12-03", sector: "Industrial safety / Environment", govt_level: "union", state: "Madhya Pradesh",
    ministry: "Union Chemicals & MP State Government", party: "Indian National Congress", government: "Rajiv Gandhi (Union) / Arjun Singh (MP)",
    summary: "A Union Carbide pesticide-plant gas leak killed thousands in Bhopal; the decades-long failure to secure adequate compensation, prosecution and clean-up is one of India's gravest accountability failures.",
  },
  {
    slug: "bofors-1987", title: "Bofors howitzer kickbacks",
    date: "1987", sector: "Defence procurement", govt_level: "union",
    ministry: "Ministry of Defence", party: "Indian National Congress", government: "Rajiv Gandhi government",
    summary: "Alleged kickbacks in the purchase of Bofors field guns from Sweden became a defining defence-corruption controversy; prosecutions ultimately collapsed without conviction.",
  },
  {
    slug: "harshad-mehta-1992", title: "1992 securities (Harshad Mehta) scam",
    date: "1992", sector: "Banking / Securities", govt_level: "union",
    ministry: "Ministry of Finance", party: "Indian National Congress", government: "P. V. Narasimha Rao government",
    summary: "A stockbroker exploited banking-system loopholes to divert funds into equities, triggering a market crash and exposing regulatory and banking-supervision failures.",
  },
  {
    slug: "jain-hawala-1991", title: "Jain hawala / diaries case",
    date: "1991", sector: "Political funding", govt_level: "union",
    ministry: "Multiple (cross-party)", party: "Multiple parties", government: "Cross-party (Congress, BJP, others named)",
    summary: "Hawala diaries implicated politicians across parties in alleged illegal payments; most prosecutions failed for want of corroborating evidence, raising questions about investigation quality.",
  },
  {
    slug: "fodder-scam-1996", title: "Bihar fodder scam",
    date: "1996", sector: "Animal husbandry / Treasury", govt_level: "state", state: "Bihar",
    ministry: "Bihar Animal Husbandry Department", party: "Rashtriya Janata Dal / Janata Dal", government: "Lalu Prasad Yadav government",
    summary: "Fraudulent withdrawals from the state treasury for non-existent livestock fodder; the case resulted in multiple convictions including of a former chief minister.",
  },
  {
    slug: "sukh-ram-1996", title: "Telecom corruption case (Sukh Ram)",
    date: "1996", sector: "Telecommunications", govt_level: "union",
    ministry: "Ministry of Communications", party: "Indian National Congress", government: "Narasimha Rao government",
    summary: "A Union telecom minister was investigated and later convicted over cash recovered and favourable equipment tenders, an early major telecom-graft conviction.",
  },
  {
    slug: "uphaar-fire-1997", title: "Uphaar cinema fire",
    date: "1997-06-13", sector: "Public safety / Licensing", govt_level: "state", state: "Delhi",
    ministry: "Delhi licensing & fire authorities", party: "Local administration", government: "Delhi (licensing authorities)",
    summary: "A cinema fire killed 59 people amid documented licensing and safety-norm violations; the prolonged fight for accountability reshaped public-safety jurisprudence.",
  },

  // ─────────────── 2000s ───────────────
  {
    slug: "telgi-stamp-2003", title: "Telgi counterfeit stamp-paper scam",
    date: "2003", sector: "Revenue / Policing", govt_level: "state", state: "Maharashtra",
    ministry: "State revenue & police (multi-state)", party: "Multiple states", government: "Multi-state (police complicity alleged)",
    summary: "A multi-thousand-crore counterfeit stamp-paper racket exposed complicity within police and revenue establishments across several states.",
  },
  {
    slug: "cash-for-votes-2008", title: "Cash-for-votes (2008 confidence vote)",
    date: "2008-07", sector: "Parliamentary integrity", govt_level: "union",
    ministry: "Government floor management", party: "Indian National Congress (UPA)", government: "Manmohan Singh (UPA-I)",
    summary: "MPs displayed cash on the Lok Sabha floor alleging bribes to survive a confidence vote; the investigation produced no major conviction.",
  },
  {
    slug: "satyam-2009", title: "Satyam Computers accounting fraud",
    date: "2009-01", sector: "Corporate / Auditing", govt_level: "union",
    ministry: "Ministry of Corporate Affairs (regulatory)", party: "Regulatory failure", government: "UPA-era corporate regulation",
    summary: "A founder's confession to inflating accounts by thousands of crore exposed gaps in corporate auditing and governance oversight; convictions followed.",
  },
  {
    slug: "2g-spectrum-2008", title: "2G spectrum allocation case",
    date: "2008", sector: "Telecommunications", govt_level: "union",
    ministry: "Ministry of Communications & IT", party: "DMK (in UPA coalition)", government: "Manmohan Singh (UPA-I)",
    summary: "The CAG flagged a large notional loss from first-come spectrum allocation; the accused, including a Union minister, were acquitted by the trial court in 2017, a verdict under appeal.",
  },

  // ─────────────── 2010–2014 (UPA-II era + states) ───────────────
  {
    slug: "cwg-2010", title: "Commonwealth Games organising scam",
    date: "2010", sector: "Sports / Public works", govt_level: "union", state: "Delhi",
    ministry: "Organising Committee / Urban Development", party: "Indian National Congress", government: "UPA-II / Delhi government",
    summary: "Cost overruns and inflated contracts marred the Delhi Commonwealth Games; the organising-committee chief faced prosecution and was later discharged in some cases.",
  },
  {
    slug: "adarsh-housing-2010", title: "Adarsh Housing Society scam",
    date: "2010", sector: "Land / Housing", govt_level: "state", state: "Maharashtra",
    ministry: "Maharashtra Revenue / Urban Development", party: "Indian National Congress", government: "Maharashtra (Congress-NCP)",
    summary: "A Mumbai housing society meant for war widows was allegedly cornered by politicians, bureaucrats and military officers, forcing a chief minister's resignation.",
  },
  {
    slug: "coalgate-2012", title: "Coal block allocation (\"Coalgate\")",
    date: "2012", sector: "Coal / Mining", govt_level: "union",
    ministry: "Ministry of Coal", party: "Indian National Congress (UPA)", government: "Manmohan Singh (UPA-II)",
    summary: "The CAG estimated a large notional loss from non-auctioned coal-block allocations; the Supreme Court later cancelled most allocations and some officials were convicted.",
  },
  {
    slug: "antrix-devas-2011", title: "Antrix–Devas S-band spectrum deal",
    date: "2011", sector: "Space / Telecom", govt_level: "union",
    ministry: "Department of Space (ISRO/Antrix)", party: "Indian National Congress (UPA)", government: "Manmohan Singh (UPA-II)",
    summary: "A scrapped satellite-spectrum deal between ISRO's commercial arm and a private firm led to arbitration losses and long-running litigation over the original contracting.",
  },
  {
    slug: "augustawestland-2013", title: "AgustaWestland VVIP helicopter deal",
    date: "2013", sector: "Defence procurement", govt_level: "union",
    ministry: "Ministry of Defence", party: "Indian National Congress (UPA)", government: "Manmohan Singh (UPA-II)",
    summary: "Alleged bribery in a VVIP-helicopter contract led to cancellation, extraditions and prosecutions that remain in progress.",
  },
  {
    slug: "maharashtra-irrigation-2012", title: "Maharashtra irrigation scam",
    date: "2012", sector: "Irrigation / Public works", govt_level: "state", state: "Maharashtra",
    ministry: "Maharashtra Water Resources", party: "Nationalist Congress Party", government: "Maharashtra (Congress-NCP)",
    summary: "Tens of thousands of crore were spent on irrigation projects with little increase in irrigated area, prompting an inquiry into a deputy chief minister's department.",
  },
  {
    slug: "karnataka-mining-2011", title: "Karnataka illegal iron-ore mining",
    date: "2011", sector: "Mining / Environment", govt_level: "state", state: "Karnataka",
    ministry: "Karnataka Mines & Geology", party: "Bharatiya Janata Party", government: "Karnataka (BJP)",
    summary: "A Lokayukta report on rampant illegal iron-ore mining forced a chief minister's resignation and led to the arrest of mining-baron ministers.",
  },
  {
    slug: "saradha-2013", title: "Saradha chit-fund collapse",
    date: "2013", sector: "Finance / Chit funds", govt_level: "state", state: "West Bengal",
    ministry: "State finance / SEBI regulation", party: "All India Trinamool Congress", government: "West Bengal (TMC)",
    summary: "The collapse of a large Ponzi-style deposit scheme wiped out small investors' savings; several political figures faced investigation over alleged patronage.",
  },
  {
    slug: "snc-lavalin", title: "SNC-Lavalin hydroelectric case",
    date: "2009", sector: "Power / Public works", govt_level: "state", state: "Kerala",
    ministry: "Kerala Electricity Department", party: "Communist Party of India (Marxist)", government: "Kerala (LDF)",
    summary: "A power-project renovation contract with a Canadian firm led to a long-running corruption case against a state power minister, who was later discharged by the trial court.",
  },
  {
    slug: "jayalalithaa-da-case", title: "Disproportionate assets case (AIADMK leadership)",
    date: "1996", sector: "Disproportionate assets", govt_level: "state", state: "Tamil Nadu",
    ministry: "Tamil Nadu Chief Minister's office", party: "AIADMK", government: "Tamil Nadu (AIADMK)",
    summary: "A disproportionate-assets prosecution against a sitting chief minister produced a conviction upheld by the Supreme Court against a close associate after the leader's death.",
  },

  // ─────────────── 2013–2024 (NDA era + states) ───────────────
  {
    slug: "vyapam-scam", title: "Vyapam recruitment & admissions scam",
    date: "2013", sector: "Recruitment / Education", govt_level: "state", state: "Madhya Pradesh",
    ministry: "MP Professional Examination Board (Vyapam)", party: "Bharatiya Janata Party", government: "Madhya Pradesh (BJP)",
    summary: "Mass rigging of state entrance and recruitment exams via impersonation and bribery, linked to a series of unexplained deaths of accused and witnesses, investigated by a court-ordered CBI probe.",
  },
  {
    slug: "demonetisation-2016", title: "Demonetisation of high-value currency",
    date: "2016-11-08", sector: "Monetary policy", govt_level: "union",
    ministry: "Ministry of Finance / RBI", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-I)",
    summary: "The overnight withdrawal of 86% of currency by value caused widespread disruption; the RBI later reported nearly all notes returned, prompting debate over the policy's stated anti-black-money goals.",
  },
  {
    slug: "rafale-controversy-2016", title: "Rafale fighter-jet deal controversy",
    date: "2016", sector: "Defence procurement", govt_level: "union",
    ministry: "Ministry of Defence", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-I)",
    summary: "Opposition allegations over pricing and offset-partner selection in the France fighter-jet purchase were examined by the Supreme Court, which declined to order a probe; the political dispute continued.",
  },
  {
    slug: "pnb-nirav-modi-2018", title: "Punjab National Bank (Nirav Modi) fraud",
    date: "2018-02", sector: "Banking", govt_level: "union",
    ministry: "Ministry of Finance / RBI supervision", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-I)",
    summary: "Fraudulent letters of undertaking caused a multi-billion-dollar loss at a public-sector bank; the prime accused fled abroad and faces extradition proceedings.",
  },
  {
    slug: "mallya-kingfisher", title: "Kingfisher Airlines loan defaults",
    date: "2016", sector: "Banking", govt_level: "union",
    ministry: "Ministry of Finance / public-sector banks", party: "Cross-government (loans 2009-2012)", government: "Loans under UPA; default/flight under NDA",
    summary: "Large unpaid loans to a now-defunct airline, and the borrower's departure from India, raised questions about public-bank lending and recovery across two governments.",
  },
  {
    slug: "migrant-crisis-2020", title: "COVID-19 lockdown migrant-worker crisis",
    date: "2020-03", sector: "Labour / Disaster management", govt_level: "union",
    ministry: "Ministry of Home Affairs / Labour", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "A near-zero-notice national lockdown stranded millions of migrant workers without transport, wages or food; the government later told Parliament it had no data on lockdown migrant deaths.",
  },
  {
    slug: "kerala-gold-2020", title: "Kerala diplomatic-channel gold smuggling",
    date: "2020", sector: "Customs / Smuggling", govt_level: "state", state: "Kerala",
    ministry: "Kerala CM's office (alleged links)", party: "Communist Party of India (Marxist)", government: "Kerala (LDF)",
    summary: "Gold smuggled through diplomatic baggage implicated officials linked to the chief minister's office, triggering central-agency probes during a state-election period.",
  },
  {
    slug: "farm-laws-2020", title: "Three farm laws — enactment and repeal",
    date: "2020-09", sector: "Agriculture / Legislative process", govt_level: "union",
    ministry: "Ministry of Agriculture", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "Three agriculture-marketing laws passed amid procedural objections triggered a year-long farmers' protest and were ultimately repealed, a notable policy reversal.",
  },
  {
    slug: "covid-oxygen-shortage-2021", title: "Second-wave COVID-19 medical oxygen shortage",
    date: "2021-04", sector: "Health / Disaster management", govt_level: "union",
    ministry: "Ministry of Health & Family Welfare", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "Acute medical-oxygen shortages were reported across hospitals during the Delta wave; the government's parliamentary statement that no deaths were specifically reported due to oxygen shortage was contradicted by several states' data.",
  },
  {
    slug: "pegasus-surveillance-2021", title: "Pegasus spyware surveillance allegations",
    date: "2021-07", sector: "Civil liberties / Home affairs", govt_level: "union",
    ministry: "Ministry of Home Affairs", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "Forensic analysis indicated military-grade spyware targeted journalists, opposition figures and activists; a Supreme Court-appointed committee examined devices after the government declined to confirm or deny procurement.",
  },
  {
    slug: "delhi-liquor-policy-2021", title: "Delhi excise (liquor) policy 2021-22",
    date: "2021-11", sector: "Excise / Revenue", govt_level: "state", state: "Delhi",
    ministry: "Delhi Excise Department", party: "Aam Aadmi Party", government: "Delhi (AAP)",
    summary: "The 2021-22 excise policy was withdrawn after the Lieutenant Governor flagged irregularities; ED and CBI cases over alleged kickbacks led to the arrest of serving ministers later granted bail.",
  },
  {
    slug: "hathras-case-2020", title: "Hathras case handling",
    date: "2020-09", sector: "Policing / Women's safety", govt_level: "state", state: "Uttar Pradesh",
    ministry: "Uttar Pradesh Home / Police", party: "Bharatiya Janata Party", government: "Uttar Pradesh (BJP)",
    summary: "The administration's handling of a gang-rape victim's death — including a contested late-night cremation and restrictions on the family and press — drew judicial scrutiny over due process.",
  },
  {
    slug: "morbi-bridge-collapse-2022", title: "Morbi suspension-bridge collapse",
    date: "2022-10-30", sector: "Public works / Urban administration", govt_level: "state", state: "Gujarat",
    ministry: "Morbi Municipality / Gujarat Urban Development", party: "Bharatiya Janata Party", government: "Gujarat (BJP)",
    summary: "A colonial-era pedestrian bridge reopened after a private repair contract without a fitness certificate collapsed and killed about 135 people; the operator faced prosecution.",
  },
  {
    slug: "balasore-train-crash-2023", title: "Balasore (Bahanaga) triple train crash",
    date: "2023-06-02", sector: "Railways / Public safety", govt_level: "union", state: "Odisha",
    ministry: "Ministry of Railways", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "A signalling failure caused a three-train collision that killed about 296 people, India's deadliest rail accident in decades, prompting a CRS inquiry and a CBI probe.",
  },
  {
    slug: "manipur-violence-2023", title: "Manipur ethnic-violence response",
    date: "2023-05", sector: "Internal security / Governance", govt_level: "state", state: "Manipur",
    ministry: "Manipur Home / Union Home Affairs", party: "Bharatiya Janata Party", government: "Manipur & Union (BJP)",
    summary: "Months of ethnic violence with mass displacement and a delayed high-level response raised questions about state and central governance and the timeline of intervention.",
  },
  {
    slug: "electoral-bonds-scheme", title: "Electoral Bonds scheme struck down",
    date: "2024-02-15", sector: "Political funding / Transparency", govt_level: "union",
    ministry: "Ministry of Finance", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "The Supreme Court struck down the 2018 anonymous Electoral Bonds scheme as unconstitutional for violating voters' right to information, and ordered disclosure of donor-party data.",
  },
  {
    slug: "neet-2024-paper-leak", title: "NEET-UG 2024 medical-entrance paper leak",
    date: "2024-05", sector: "Education", govt_level: "union",
    ministry: "Ministry of Education (National Testing Agency)", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-III)",
    summary: "The NEET-UG 2024 exam, taken by about 24 lakh students, was hit by paper-leak and grace-mark irregularities, triggering re-tests, arrests and a Supreme Court challenge over the NTA's conduct.",
  },

  // ─────────────── Additional balanced entries (added 2026-06-30) ───────────────
  {
    slug: "mundhra-1958", title: "Mundhra affair (first independent-India financial scandal)",
    date: "1958", sector: "Insurance / Public finance", govt_level: "union",
    ministry: "Ministry of Finance (LIC)", party: "Indian National Congress", government: "Jawaharlal Nehru government",
    summary: "State-owned LIC funds were invested in Haridas Mundhra's troubled companies under reported pressure; the Chagla Commission inquiry led Finance Minister T. T. Krishnamachari to resign — an early benchmark for ministerial accountability.",
  },
  {
    slug: "tehelka-defence-2001", title: "Tehelka defence-procurement exposé",
    date: "2001-03", sector: "Defence procurement", govt_level: "union",
    ministry: "Ministry of Defence", party: "Bharatiya Janata Party (NDA)", government: "Atal Bihari Vajpayee (NDA)",
    summary: "A sting operation recorded officials and party figures discussing payments around arms deals; the BJP president and the defence minister stepped down pending inquiry, though prosecutions were limited.",
  },
  {
    slug: "tatra-truck-2012", title: "Tatra army-truck procurement allegations",
    date: "2012-03", sector: "Defence procurement", govt_level: "union",
    ministry: "Ministry of Defence", party: "Indian National Congress (UPA)", government: "Manmohan Singh (UPA-II)",
    summary: "The Army chief publicly alleged a bribe offer to clear sub-standard Tatra trucks bought via a state firm; a CBI inquiry followed into the long-running single-vendor supply arrangement.",
  },
  {
    slug: "national-herald", title: "National Herald / Associated Journals case",
    date: "2012", sector: "Corporate / Money laundering", govt_level: "union",
    ministry: "Enforcement Directorate (court matter)", party: "Indian National Congress", government: "Congress leadership",
    summary: "A private complaint and later an ED case allege that party leaders acquired control of the company that published National Herald and its prime-property assets through a low-value transaction; the case is contested in court and remains unproven.",
  },
  {
    slug: "inx-media-2007", title: "INX Media foreign-investment approval case",
    date: "2007", sector: "Corporate / Foreign investment", govt_level: "union",
    ministry: "Ministry of Finance (FIPB)", party: "Indian National Congress (UPA)", government: "Manmohan Singh (UPA-I)",
    summary: "CBI and ED cases allege irregular foreign-investment clearances granted to INX Media while a senior minister held the finance portfolio, with benefits reportedly routed to associates; charges are contested and not established by conviction.",
  },
  {
    slug: "kerala-solar-2013", title: "Kerala solar-panel investment scam",
    date: "2013-06", sector: "Renewable energy / Fraud", govt_level: "state", state: "Kerala",
    ministry: "Kerala Chief Minister's Office", party: "Indian National Congress (UDF)", government: "Oommen Chandy (UDF)",
    summary: "Promoters of a solar-energy firm allegedly cheated investors of crores by promising installations and influence; a judicial commission examined the proximity of the accused to the Chief Minister's office.",
  },
  {
    slug: "madhu-koda-2009", title: "Madhu Koda mining money-laundering case",
    date: "2009", sector: "Mining / Money laundering", govt_level: "state", state: "Jharkhand",
    ministry: "Jharkhand Mines & Chief Minister's Office", party: "Independent-led coalition", government: "Madhu Koda (Independent coalition)",
    summary: "A former Jharkhand chief minister was charged and later convicted in cases involving alleged diversion of hundreds of crores tied to mining leases and laundering through shell entities.",
  },
  {
    slug: "yedyurappa-denotification-2011", title: "Karnataka land-denotification case",
    date: "2011", sector: "Land / Urban development", govt_level: "state", state: "Karnataka",
    ministry: "Karnataka Chief Minister's Office", party: "Bharatiya Janata Party", government: "Karnataka (BJP)",
    summary: "A Lokayukta report and complaints over the denotification of government land and benefits to family-linked entities led the chief minister to resign; he was later granted relief by the courts.",
  },
  {
    slug: "chhattisgarh-nan-2015", title: "Chhattisgarh civil-supplies (NAN) PDS scam",
    date: "2015-02", sector: "Food / Public distribution", govt_level: "state", state: "Chhattisgarh",
    ministry: "Chhattisgarh Food & Civil Supplies (Nagrik Apurti Nigam)", party: "Bharatiya Janata Party", government: "Chhattisgarh (BJP, Raman Singh)",
    summary: "Anti-corruption raids on the state civil-supplies corporation seized cash and diaries pointing to alleged large-scale graft in PDS rice and salt procurement; the case ran for years across successive governments.",
  },
  {
    slug: "lalit-modi-ipl-2010", title: "IPL governance & 'Lalitgate' controversy",
    date: "2010-04", sector: "Sports administration / Foreign exchange", govt_level: "union",
    ministry: "Ministry of Finance / External Affairs (cross-party)", party: "Cross-party (INC then BJP)", government: "UPA-II (2010) and later NDA figures (2015)",
    summary: "Questions over IPL franchise finances and FEMA breaches first forced a Congress minister of state to resign in 2010, and in 2015 drew in BJP leaders accused of aiding the league's former chief — a rare cross-party accountability test.",
  },
  {
    slug: "rose-valley-chit", title: "Rose Valley chit-fund collapse",
    date: "2013", sector: "Finance / Deposit fraud", govt_level: "state", state: "West Bengal",
    ministry: "SEBI / State (court matter)", party: "All India Trinamool Congress (state context)", government: "West Bengal (TMC)",
    summary: "A deposit-mobilising group allegedly defrauded lakhs of small investors of thousands of crores; ED and CBI cases named several political figures, with charges contested in court.",
  },
  {
    slug: "punjab-drugs-sand-2017", title: "Punjab synthetic-drug trade & illegal sand mining",
    date: "2017", sector: "Narcotics / Mining", govt_level: "state", state: "Punjab",
    ministry: "Punjab Home & Mining", party: "Cross-party (Shiromani Akali Dal then Congress)", government: "Punjab (SAD then Congress)",
    summary: "Sustained reporting and court monitoring documented a synthetic-drug epidemic and unchecked illegal sand mining allegedly enabled by political-administrative patronage across successive state governments.",
  },
  {
    slug: "dhfl-yes-bank-2020", title: "DHFL / Yes Bank lending fraud",
    date: "2020-03", sector: "Banking / Financial fraud", govt_level: "union",
    ministry: "Ministry of Finance / RBI supervision", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "CBI and ED cases allege a quid-pro-quo of large loans and investments between a private bank's promoter and a housing-finance company, exposing supervisory gaps; the matter is before the courts.",
  },
  {
    slug: "abg-shipyard-2022", title: "ABG Shipyard bank-loan fraud",
    date: "2022-02", sector: "Banking / Corporate fraud", govt_level: "union",
    ministry: "Ministry of Finance / public-sector banks", party: "Bharatiya Janata Party (NDA)", government: "Narendra Modi (NDA-II)",
    summary: "A shipbuilder was booked by the CBI in one of the largest bank-fraud cases (over ₹22,000 crore across a lender consortium), with the alleged diversion spanning years and multiple banks; the case is under prosecution.",
  },
];
