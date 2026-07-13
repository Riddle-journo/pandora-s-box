// Directorship extraction core (Phase 1). A PURE, no-I/O function that mines a
// blob of evidence text for "person → role → company" directorship triples.
//
// WHY THIS EXISTS: MCA publishes no free bulk director dataset and its portal is
// WAF-blocked, so we cannot look a politician up cold and ask "what is he a
// director of?". But director/promoter names DO appear, incidentally, inside
// evidence we already collect for free — company-law judgments (Indian Kanoon),
// offshore-leak connection records (ICIJ), and ED/CBI/SFIO press releases. This
// module turns that incidental prose into structured directorship links, so the
// data gets BUILT UP over time from sources we run anyway, instead of imported
// wholesale from a paid API. It will never be MCA-comprehensive — only a
// politician who surfaces in litigation/leaks/press is covered — but for an
// accountability project that slice is the newsworthy one.
//
// Pure by design: no DB, no network, no imports. Phase 2 (extract.js registration)
// is what turns these triples into entity assertions + ledger events; Phase 3
// verifies each company against the free MCA Company Master registry. Keeping the
// pattern logic here and dependency-free means it is trivially unit-testable and
// its version can be bumped + re-run without touching stored evidence.

// ── Legal-form suffixes: the reliable anchor for "this token-run is a company" ──
// We deliberately require a REGISTERED legal suffix (Pvt Ltd / Limited / LLP …).
// Softer anchors ("Industries", "Holdings", "Group") without a legal form are far
// too noisy against Indian prose and would manufacture false companies.
const SUFFIX_ALTS = [
  "Private\\s+Limited", "Pvt\\.?\\s*Ltd\\.?", "Private\\s+Ltd\\.?", "Pvt\\.?\\s*Limited",
  "Limited", "Ltd\\.?", "LLP",
];
const SUFFIX_RE = new RegExp(`\\b(${SUFFIX_ALTS.join("|")})(?![A-Za-z])`, "gi");

// A name token is a company-name word: starts uppercase (Titlecase legal docs OR
// ALLCAPS leak records), or a bare ampersand ("A & B Ltd"). Digits allowed after
// the first letter ("3M" is not our target, but "Larsen Toubro 2 Ltd" style is).
const NAME_TOKEN_RE = /^(?:[A-Z][\w.\-]*|&|and)$/;

// Roles, longest-first so "Managing Director" wins the match over "Director".
// Includes LLP ("Designated Partner"), proprietorship, and the ICIJ leak roles
// ("Beneficial Owner", "Shareholder", "Officer" — the last kept low-confidence
// because it is generic).
const ROLE_ALTS = [
  "Chairman[- ]?cum[- ]?Managing Director",
  "Managing Director", "Whole[- ]?time Director", "Whole time Director",
  "Executive Director", "Non[- ]?Executive Director", "Additional Director",
  "Independent Director", "Nominee Director",
  "Designated Partner", "Beneficial Owner", "Beneficial owner",
  "Director", "Promoter", "Proprietor", "Chairperson", "Chairman",
  "Shareholder", "Partner", "Officer",
];
const ROLE_RE = new RegExp(`\\b(${ROLE_ALTS.join("|")})\\b`, "gi");

// A person name near a role: optional honorific + 1-4 Titlecase/ALLCAPS words.
const HON = "(?:Shri|Sri|Smt\\.?|Shrimati|Kum\\.?|Kumari|Dr\\.?|Mr\\.?|Mrs\\.?|Ms\\.?|Prof\\.?|Adv\\.?|Sh\\.?)";
const PERSON_CORE = "(?:[A-Z][a-z]+|[A-Z]{2,})(?:\\s+(?:[A-Z][a-z]+|[A-Z]{2,})){0,3}";
// Person immediately BEFORE a role: "Ramesh Kumar, Director" / "Ramesh Kumar - Director".
const PERSON_BEFORE_RE = new RegExp(`((?:${HON}\\s+)?${PERSON_CORE})\\s*[,\\-–—(]?\\s*$`);
// Person immediately AFTER a role: "Director Shri Ramesh Kumar" / "Director, Mr X".
const PERSON_AFTER_RE = new RegExp(`^\\s*[,:\\-–—]?\\s*(?:its\\s+|the\\s+)?((?:${HON}\\s+)?${PERSON_CORE})`);

// Words that TERMINATE the leftward company-name walk even though capitalized.
// Three groups: (1) sentence-openers/connectors that precede a legal suffix; (2)
// ROLE words — a directorship phrase puts the role immediately before the company
// ("… Director Greatshine Holdings Ltd"), and without this the role (and the person
// before it) get swallowed into the company name; (3) ICIJ node-page HEADER words
// ("Incorporation Jurisdiction Status Data From <ENTITY>") that otherwise leak in.
const STOP_LEAD = new Set([
  // (1) connectors / openers
  "The", "A", "An", "This", "That", "Its", "His", "Her", "Their", "Of", "And",
  "In", "At", "For", "To", "By", "With", "As", "Is", "Was", "Not", "No",
  "Whose", "Which", "Who", "M",
  // (2) role words (and their modifiers)
  "Director", "Managing", "Whole", "Wholetime", "Executive", "Additional",
  "Independent", "Nominee", "Designated", "Partner", "Promoter", "Proprietor",
  "Chairman", "Chairperson", "Cum", "Beneficial", "Owner", "Shareholder",
  "Officer", "Karta",
  // (3) ICIJ node-page headers / connectors
  "From", "Data", "Status", "Jurisdiction", "Incorporation", "Country",
  "Countries", "Linked", "Connections", "Address", "Entity", "Intermediary",
  "Registered", "Note",
]);
// Lowercased copy for case-insensitive matching against ALLCAPS leak/press text.
const STOP_LEAD_LC = new Set([...STOP_LEAD].map((w) => w.toLowerCase()));
// Generic corporate-structure words: a "company name" consisting only of these is a
// truncation artifact ("Corporation Limited"), not a specific firm.
const GENERIC_ONLY = new Set(["corporation", "company", "co", "corp", "group", "enterprises", "holdings"]);

const COMMON_TOKENS = new Set(["kumar", "singh", "devi", "ram", "prasad", "yadav", "lal", "bai", "reddy", "rao", "das", "khan", "sharma", "verma", "gupta", "prakash", "chand", "nath"]);

// Capitalized words that LOOK like a name to the person regex but are really
// sentence-openers / pronouns / connectors ("The Director of…"). A captured
// person whose leading word is one of these is not a person.
const PERSON_STOP = new Set(["The", "A", "An", "This", "That", "These", "Those", "It", "He", "She", "They", "We", "His", "Her", "Its", "Their", "Our", "Later", "Separately", "Meanwhile", "However", "Subsequently", "Thereafter", "Accordingly", "Whose", "Which", "Who", "Both", "Also", "Further", "Moreover", "Said", "One"]);

function distinctiveTokens(name) {
  return String(name ?? "").toLowerCase().split(/[\s.]+/).filter((t) => t.length > 2 && !COMMON_TOKENS.has(t));
}

// Light company normaliser for de-duping within one text (Phase 3 does the real
// registry-grade normalisation). Folds Pvt/Private and Ltd/Limited so the same
// firm written two ways collapses to one triple.
export function normalizeCompany(s) {
  return String(s ?? "").toUpperCase()
    .replace(/\bPRIVATE\b/g, "PVT").replace(/\bLIMITED\b/g, "LTD")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// Find every company mention: walk LEFT from each legal suffix, collecting
// capitalized name tokens (stopping at the first non-name / stop-lead word).
// Returns [{ name, start, end }] spans over the original text.
function findCompanies(text) {
  const out = [];
  SUFFIX_RE.lastIndex = 0;
  let m;
  while ((m = SUFFIX_RE.exec(text))) {
    const suffix = m[1];
    const suffixStart = m.index;
    // Tokens preceding the suffix, nearest-first.
    const before = text.slice(0, suffixStart).replace(/\s+$/, "");
    const tokens = before.split(/\s+/);
    const nameTokens = [];
    for (let i = tokens.length - 1; i >= 0 && nameTokens.length < 6; i--) {
      const tok = tokens[i].replace(/^[("']+/, ""); // strip an opening bracket/quote
      if (!NAME_TOKEN_RE.test(tok)) break;
      // Case-insensitive stop check: ICIJ/press text is often ALLCAPS ("… DIRECTOR
      // GHOSH BROTHERS PVT LTD"), so a case-sensitive match on "Director" would miss it.
      if (STOP_LEAD.has(tok) || STOP_LEAD_LC.has(tok.toLowerCase())) break; // role word / connector / ICIJ header
      nameTokens.unshift(tok);
    }
    // A lone "&"/"and" is not a name.
    while (nameTokens.length && /^(?:&|and)$/i.test(nameTokens[0])) nameTokens.shift();
    if (!nameTokens.length) continue;
    // Reject a "name" made ONLY of generic corporate-structure words ("Corporation
    // Limited", "Company Limited") — that's a truncation artifact, not a real firm.
    if (nameTokens.every((t) => GENERIC_ONLY.has(t.toLowerCase()))) continue;
    const name = `${nameTokens.join(" ")} ${suffix}`.replace(/\s+/g, " ").trim();
    // Recover the span start by locating the first name token before the suffix.
    const nameStart = text.lastIndexOf(nameTokens[0], suffixStart);
    out.push({ name, start: nameStart >= 0 ? nameStart : suffixStart, end: suffixStart + suffix.length });
  }
  return out;
}

function findRoles(text) {
  const out = [];
  ROLE_RE.lastIndex = 0;
  let m;
  while ((m = ROLE_RE.exec(text))) out.push({ role: m[1], start: m.index, end: m.index + m[1].length });
  return out;
}

const stripHonorific = (n) => String(n ?? "").replace(new RegExp(`^${HON}\\s+`, "i"), "").trim();

// True when the captured string is really a sentence-opener/pronoun, not a name.
function looksLikePerson(name) {
  const stripped = stripHonorific(name);
  const first = stripped.split(/\s+/)[0];
  return !!first && !PERSON_STOP.has(first);
}

// A person adjacent to a role, if any — checks the ~45 chars before the role for a
// trailing name, then the ~45 chars after for a leading name. Rejects article/
// pronoun openers ("The Director …") that merely look name-shaped.
function personNearRole(text, role) {
  // Strip a trailing "(DIN 01234567)" / "(PAN …)" / "(CIN …)" parenthetical that
  // commonly sits between a director's name and their role ("Ramesh Kumar (DIN X),
  // Director") — otherwise it blocks the name from being detected.
  const preWin = text.slice(Math.max(0, role.start - 45), role.start)
    .replace(/\(\s*(?:DIN|PAN|CIN)[^)]*\)\s*[,;]?\s*$/i, " ");
  const preM = preWin.match(PERSON_BEFORE_RE);
  if (preM && looksLikePerson(preM[1])) return preM[1].trim();
  const postWin = text.slice(role.end, role.end + 45);
  const postM = postWin.match(PERSON_AFTER_RE);
  if (postM && looksLikePerson(postM[1])) return postM[1].trim();
  return null;
}

// A DIN (Director Identification Number) is an 8-digit government id for a company
// director. Only capture one when it is LABELLED ("DIN 01234567", "DIN: 01234567",
// "Director Identification Number 01234567") — a bare 8-digit run is too easily a
// year-range, PIN, or amount. Returns the DIN only when EXACTLY ONE distinct labelled
// DIN appears in the window: with two directors' DINs present we must never guess
// which belongs to the politician (identity is defamation-sensitive).
function findDin(text) {
  const re = /\b(?:DIN|Director\s+Identification\s+Number)\b[\s.:#No()-]*?(\d{8})\b/gi;
  const dins = new Set();
  let m;
  while ((m = re.exec(text))) dins.add(m[1]);
  return dins.size === 1 ? [...dins][0] : null;
}

// ── The one public entry point ──────────────────────────────────────────────
// extractDirectorships(text, { subjectName }) → array of directorship triples:
//   { company, company_norm, role, person, person_is_subject, subject_nearby,
//     confidence, snippet, din }
//   din: 8-digit Director Identification Number when the text labels one adjacent to
//        the role (else null) — Plan A1 feeds this to the person entity when the
//        director is confidently the politician (person_is_subject).
// Conservative and deduped. Confidence tiers:
//   0.80  role + company + a named person that IS the subject
//   0.72  role + company, subject's distinctive token appears in the pairing window
//   0.68  role + company + a named person (not obviously the subject)
//   0.45  role + company only (a lead: someone is a director of X, party unclear)
// "Officer"/"Shareholder"/"Partner" alone are damped by 0.15 (generic roles).
export function extractDirectorships(text, { subjectName = "" } = {}) {
  const src = String(text ?? "");
  if (src.length < 8) return [];
  const companies = findCompanies(src);
  if (!companies.length) return [];
  const roles = findRoles(src);
  if (!roles.length) return [];

  const subjTokens = distinctiveTokens(subjectName);
  const results = [];
  const seen = new Set();

  for (const role of roles) {
    // Nearest company to this role, measured edge-to-edge, within 80 chars.
    let best = null, bestGap = Infinity;
    for (const co of companies) {
      const gap = role.start >= co.end ? role.start - co.end
        : co.start >= role.end ? co.start - role.end : 0; // overlapping ⇒ 0
      if (gap < bestGap) { bestGap = gap; best = co; }
    }
    if (!best || bestGap > 80) continue;

    const person = personNearRole(src, role);
    // Tight window for the human-readable snippet…
    const winStart = Math.max(0, Math.min(role.start, best.start) - 30);
    const winEnd = Math.min(src.length, Math.max(role.end, best.end) + 30);
    const window = src.slice(winStart, winEnd);
    // …and a wider one for subject-proximity (the politician is often named a
    // clause away from the role — "X controlled operations at Y Ltd as its Promoter").
    const subjWin = src.slice(
      Math.max(0, Math.min(role.start, best.start) - 70),
      Math.min(src.length, Math.max(role.end, best.end) + 70),
    ).toLowerCase();

    const subject_nearby = subjTokens.length > 0 && subjTokens.some((t) => subjWin.includes(t));
    const personStripped = stripHonorific(person);
    const person_is_subject = !!person && subjTokens.length > 0 &&
      distinctiveTokens(personStripped).some((t) => subjTokens.includes(t));

    let confidence;
    if (person_is_subject) confidence = 0.80;
    else if (subject_nearby) confidence = 0.72;
    else if (person) confidence = 0.68;
    else confidence = 0.45;
    if (/^(officer|shareholder|partner)$/i.test(role.role)) confidence = Math.max(0.3, confidence - 0.15);

    // DIN window: wide enough that a two-director sentence exposes BOTH DINs (so
    // findDin sees the ambiguity and refuses to guess), while still local to the pair.
    const din = findDin(src.slice(
      Math.max(0, Math.min(role.start, best.start) - 100),
      Math.min(src.length, Math.max(role.end, best.end) + 100),
    ));

    const company_norm = normalizeCompany(best.name);
    const dedupKey = `${company_norm}|${role.role.toLowerCase()}|${(personStripped || "").toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    results.push({
      company: best.name,
      company_norm,
      role: role.role,
      person: person || null,
      person_is_subject,
      subject_nearby,
      confidence: Number(confidence.toFixed(2)),
      snippet: window.replace(/\s+/g, " ").trim(),
      din,
    });
  }

  // Strongest first, so downstream top-N slicing keeps the best evidence.
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}
