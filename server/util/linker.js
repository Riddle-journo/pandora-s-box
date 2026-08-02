// Abstain-first identity ladder for bulk-dataset → politician attribution.
//
// The bulk government datasets (L1 caches, mega caches) are rows of text with no
// entity ids. Deciding WHICH real person a row refers to used to be a normalized
// substring test — `rowText.includes(politicianName)` — which is a candidate
// generator masquerading as a decision. At India's scale that is an existential
// error class for this project: "RAM SINGH" occurs in thousands of unrelated
// records, and the matched row is then persisted as ADVERSE evidence against one
// specific named person. A false attribution of an adverse record is the worst
// failure mode in the system, so the default answer here is "I don't know".
//
// The ladder, strongest rung first (see linkRow):
//   1. strong_id          — a labelled unique identifier shared by row + person.
//   2. name_plus_context  — full-name hit AND ≥1 independent corroborating signal
//                           from the same row (constituency, district, state,
//                           party, office, year). Mononyms need two.
//   3. distinctive_name   — full-name hit whose tokens carry real identity signal
//                           AND no roster namesake / longer subject name in the row.
//   4. abstain            — a name matched but nothing corroborated it. NO evidence.
//                           Reasons are distinct so review can be triaged:
//                           abstain_outranked, abstain_ambiguous_context,
//                           abstain_common_name, abstain_mononym, abstain_namesake,
//                           abstain_longer_row_name.
//
// Pure by construction: no DB, no network, no imports beyond this file, so the
// matcher can be unit-tested exhaustively and reused by the retro-audit script.
// (Callers do the persisting: evidence for a match, a PROPOSED entity assertion
// for an abstention.)

export const LINKER_VERSION = "linker-v1";

// Normalized text space shared by every comparison below: lowercase, single
// spaces, [a-z0-9] only. Digits are KEPT (ids, years, CINs live in row text).
export const normText = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

// Honorifics carry no identity signal and appear inconsistently across sources.
const HONORIFICS = new Set([
  "shri", "shrimati", "smt", "sri", "dr", "kumari", "kum", "km", "ms", "mr", "mrs",
  "miss", "prof", "adv", "mohd", "sardar", "col", "gen", "capt", "late", "thiru",
  "maj", "hon", "honble", "shrimathi", "sh",
]);

// Extremely common Indian name tokens. A "match" built only from these is a
// coin flip, not identity evidence. This is the union of the two lists already
// in the repo — publishing/graph.js COMMON and extractors/directorship-extract.js
// COMMON_TOKENS — deliberately re-stated here rather than imported: graph.js
// opens the shared DB handle at import time, and this module must stay free of
// side effects so it can be unit-tested and reused from a read-only audit.
const COMMON_TOKENS = new Set([
  "kumar", "kumari", "singh", "devi", "lal", "ram", "prasad", "sharma", "yadav",
  "khan", "das", "patel", "reddy", "rao", "gupta", "verma", "mishra", "nath",
  "chandra", "mohan", "bai", "ben", "bhai", "raj", "dev", "ali", "begum", "kaur",
  "prakash", "chand",
]);

/** Identity-bearing tokens of a personal name (≥3 chars, no honorifics/numbers). */
export function nameTokens(name) {
  return normText(name).split(" ")
    .filter((t) => t.length >= 3 && !HONORIFICS.has(t) && !/^\d+$/.test(t));
}

/** Non-common tokens; falls back to all tokens when a name is entirely common. */
export function distinctiveTokens(name) {
  const t = nameTokens(name);
  const d = t.filter((x) => !COMMON_TOKENS.has(x));
  return d.length ? d : t;
}

/**
 * How many tokens of a name actually carry identity signal — WITHOUT the
 * all-tokens fallback above. distinctiveTokens must fall back (an index needs
 * some key even for "Ram Singh"), but a human-readable count must not: the
 * abstention rationale used to read "2 distinctive of 2" while abstaining for
 * having none.
 */
export function distinctiveCount(name) {
  return nameTokens(name).filter((t) => !COMMON_TOKENS.has(t)).length;
}

/**
 * The containment needle for a roster name: honorifics dropped, everything else
 * (including initials) kept in order.
 *
 * Honorifics are source formatting, not identity — "Dr. Sanjay Jaiswal" and
 * "Sanjay Jaiswal" are the same claim — but the gate used to require the raw
 * normalized name verbatim, so 242 roster members carrying an honorific token
 * could never match any source that spelled them without it. Initials are
 * deliberately KEPT: dropping them from "S P Singh Baghel" would widen the
 * needle to "singh baghel", i.e. weaken the identity claim rather than fix a
 * formatting mismatch.
 */
export function nameNeedle(name) {
  return normText(name).split(" ").filter((t) => t && !HONORIFICS.has(t)).join(" ");
}

// Same bar as graph.js identityStrong: ≥2 distinctive tokens, or 1 distinctive
// among ≥3 tokens. "Ram Singh" (0 distinctive of 2) fails — that is the point.
export function identityStrong(tokens) {
  const distinctive = tokens.filter((t) => !COMMON_TOKENS.has(t));
  return distinctive.length >= 2 || (distinctive.length >= 1 && tokens.length >= 3);
}

/**
 * Word-boundary containment over ALREADY-normalized text. This is the one
 * primitive every rung uses: plain String.includes lets "ram singh" match
 * "pa|ram singh|al", which is exactly how bogus attributions were minted.
 */
export function normContainsWord(normHay, normNeedle) {
  if (!normHay || !normNeedle) return false;
  for (let i = normHay.indexOf(normNeedle); i >= 0; i = normHay.indexOf(normNeedle, i + 1)) {
    const end = i + normNeedle.length;
    if ((i === 0 || normHay[i - 1] === " ") && (end === normHay.length || normHay[end] === " ")) return true;
  }
  return false;
}

/** Convenience wrapper for un-normalized inputs (used by the cache prefilters). */
export const textContainsName = (text, needle) => normContainsWord(normText(text), normText(needle));

/** Row (array of cells or string) → the display string all matching runs on. */
export const rowText = (row) => (Array.isArray(row) ? row.join(" | ") : String(row ?? ""));

// Stable short key for a row, so a re-ingest of the same cache dedupes to the
// same proposed assertion instead of piling up duplicates (FNV-1a, hex).
export function rowKey(row) {
  const s = normText(rowText(row));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

// ── Corroborating context ───────────────────────────────────────────────────
// Signals live on the politician record (see store/politicians.js: name, party,
// office, constituency, state, myneta_url, affidavit). Weights are deliberately
// unequal: a constituency or district co-occurring with the full name is real
// corroboration; a bare year is nearly none.
const PSEUDO_STATE = /lok sabha|rajya sabha|parliament/i;
const OFFICE_PHRASES = {
  MP: ["member of parliament", "lok sabha"],
  RS: ["rajya sabha", "council of states"],
  MLA: ["legislative assembly", "vidhan sabha", "mla"],
  MLC: ["legislative council", "vidhan parishad", "mlc"],
};
const CONTEXT_THRESHOLD = 1;

// A geography cell is a CONSTANT of a state-scoped dataset, not corroboration of
// a person. Every row of l1_up_flood_tenders carries "Uttar Pradesh"; every row
// of l1_khoj_judges carries its court's state. A signal present in 100% of a
// cache's rows carries zero identity information, so geography can only ever TOP
// UP a real signal — never satisfy the threshold by itself. (The same is true of
// `office` in a single-house dataset, hence its 0.5.)
const GEO_WEIGHT = 0.5;

// Which signals genuinely narrow towards ONE person, as opposed to describing the
// dataset. A decision may not rest on non-anchor signals alone, however many of
// them stack up: constituency (1 of 543+) and party are properties of the member;
// state, district, office and year are properties of the record.
const ANCHOR_KEYS = new Set(["constituency", "party"]);

// Party values that are ordinary words, file extensions or column enumerations
// rather than identifying abbreviations. "INC" is a corporate suffix in every
// procurement vendor column, "PDF" the extension on every html-list href, and
// "Independent"/"IND" a candidate-TYPE value, not a party a row can corroborate.
const PARTY_STOP = new Set([
  "inc", "ind", "independent", "pdf", "sad", "aap", "none", "other", "others",
  "nota", "unknown", "party", "self",
]);

/** The context signals a politician record can corroborate a row with. */
export function contextSignals(p = {}) {
  const out = [];
  const add = (key, value, weight) => {
    const v = normText(value);
    if (v.length >= 4) out.push({ key, value: v, weight, anchor: ANCHOR_KEYS.has(key) });
  };
  // Parenthetical reservation markers ("ADILABAD (ST)") are not part of the name.
  add("constituency", String(p.constituency ?? "").replace(/\([^)]*\)/g, " "), 1);
  add("district", p.district, GEO_WEIGHT);
  if (!PSEUDO_STATE.test(String(p.state ?? ""))) add("state", p.state, GEO_WEIGHT);
  // Party goes through the SAME ≥4-char floor as every other signal. 3,000+ of the
  // 4,559 roster rows store party as a 3-letter code, and a 3-letter code sprays
  // itself across ordinary words — the exact failure the name needle's own ≥4
  // guard has always prevented.
  if (!PARTY_STOP.has(normText(p.party))) add("party", p.party, 1);
  for (const phrase of OFFICE_PHRASES[String(p.office ?? "").toUpperCase()] ?? []) {
    out.push({ key: "office", value: normText(phrase), weight: 0.5, anchor: false });
  }
  return out;
}

// A 4-digit year in a plausible window. Weak on purpose — it corroborates the
// record's era, never the person — so it can only top up a stronger signal.
const YEAR_WEIGHT = 0.25;
function yearSignal(normRow) {
  const max = new Date().getFullYear() + 1;
  for (const m of normRow.matchAll(/\b(19[9]\d|20\d\d)\b/g)) {
    const y = Number(m[1]);
    if (y >= 1990 && y <= max) return { key: "year", value: m[1], weight: YEAR_WEIGHT, anchor: false };
  }
  return null;
}

function scoreContext(normRow, signals) {
  const hits = [];
  let score = 0;
  const seenKeys = new Set();
  const seenValues = new Set();
  for (const s of signals) {
    if (seenKeys.has(s.key)) continue;    // one hit per signal KIND (office aliases)
    // …and one hit per VALUE: 243 roster members (the Rajya Sabha cohort) store the
    // SAME string in constituency and state, which let one geography word in the row
    // score twice and satisfy the "two independent signals" rule on its own.
    if (seenValues.has(s.value)) continue;
    if (!normContainsWord(normRow, s.value)) continue;
    seenKeys.add(s.key);
    seenValues.add(s.value);
    hits.push(s);
    score += s.weight;
  }
  const y = yearSignal(normRow);
  if (y) { hits.push(y); score += y.weight; }
  return { score, hits, anchored: hits.some((h) => h.anchor) };
}

/** Corroborated = enough weight AND at least one signal that narrows to a person. */
const corroborated = (ctx, needed) => ctx.anchored && ctx.score >= needed;

// ── Strong ids ──────────────────────────────────────────────────────────────
// A bare number is NOT an identifier in free text: a 4-digit MyNeta candidate id
// collides with tender numbers, amounts, and years. So an id only counts when it
// is LABELLED in the row, or is long and non-numeric (PAN/CIN/URL shaped).
//
// The label must correspond to the id it labels. A single alternation applied to
// EVERY id meant any of six labels followed by the politician's 4-digit MyNeta
// candidate id ("Registration No. 8974", "DIN 8974") produced a 0.98-confidence
// match that skipped every abstention rung — on a 4-digit coincidence, in caches
// full of 4-digit bid, folio and registration numbers. `folio` and
// `registration no` are gone entirely: no id key we hold is a folio or a
// registration number, so those labels could only ever validate the wrong id.
const ID_LABELS = {
  myneta_candidate_id: "(?:candidate[ _]?id|myneta)",
  din: "din",
  pan: "pan",
  cin: "cin",
  mpsno: "(?:mpsno|mp[ _]?s[ _]?no)",
};
// A purely numeric id needs this many digits before it can identify anybody, even
// under its own label. MyNeta candidate ids are 4–5 digits and are not printed in
// government bulk data at all, so they never reach this rung; DIN (8) and CIN/PAN
// (letters) still do.
const MIN_NUMERIC_ID_LEN = 6;

const labelPatternFor = (key) =>
  ID_LABELS[key] ?? `(?:${String(key).split(/[^a-z0-9]+/i).filter(Boolean).map(escapeRe).join("[ _]?")})`;

/** Strong ids derivable from a politician record, plus any caller-supplied ones. */
export function politicianStrongIds(p = {}, extra = {}) {
  const ids = {};
  const myneta = /candidate_id=(\d+)/i.exec(String(p.myneta_url ?? ""));
  if (myneta) ids.myneta_candidate_id = myneta[1];
  for (const k of ["din", "pan", "cin", "mpsno"]) if (p[k]) ids[k] = String(p[k]);
  for (const [k, v] of Object.entries(extra ?? {})) if (v != null && v !== "") ids[k] = String(v);
  return ids;
}

function strongIdHit(normRow, ids) {
  for (const [key, raw] of Object.entries(ids ?? {})) {
    const v = normText(raw);
    if (v.length < 4) continue;
    // A short all-digit token is a number, not an identifier, whatever labels it.
    if (!/[a-z]/.test(v) && v.length < MIN_NUMERIC_ID_LEN) continue;
    if (new RegExp(`\\b${labelPatternFor(key)}\\b[^a-z0-9]{0,6}${escapeRe(v)}(?![a-z0-9])`, "i").test(normRow)) {
      return { key, value: v, labelled: true };
    }
    // Unlabelled is only trustworthy when the token itself cannot be a stray
    // number: ≥8 chars and carrying at least one letter (PAN/CIN/DIN-with-prefix).
    if (v.length >= 8 && /[a-z]/.test(v) && normContainsWord(normRow, v)) {
      return { key, value: v, labelled: false };
    }
  }
  return null;
}

// ── Roster index (namesake / ambiguity guard) ───────────────────────────────
/**
 * Inverted index over the roster so a row can be checked for OTHER politicians
 * who match it just as well. Pass the non-demo roster; build once per run.
 */
export function buildRosterIndex(politicians = []) {
  const entries = [];
  const byToken = new Map();
  for (const p of politicians) {
    const tokens = nameTokens(p.name);
    // Mononymous members (552 of the roster) are indexed too. Dropping them meant
    // a mononym could never be reported as a competing candidate for a row.
    if (tokens.length < 1) continue;
    const e = {
      politician_id: p.id, name: p.name, normName: nameNeedle(p.name),
      tokens, strong: identityStrong(tokens), signals: contextSignals(p),
    };
    const idx = entries.push(e) - 1;
    for (const t of distinctiveTokens(p.name)) {
      const bucket = byToken.get(t) ?? byToken.set(t, new Set()).get(t);
      bucket.add(idx);
    }
  }
  return { entries, byToken };
}

// Roster politicians (other than `selfId`) whose full name also lands in this row.
// These are the namesakes that must force an abstention.
//
// Admission is by NAME OVERLAP, not by the rival's own identity strength: 1,052 of
// 4,559 roster names are not identityStrong, and requiring strength made the
// guards blind to exactly the highest-collision segment. "Ram Singh Yadav" is all
// common tokens, yet it is the longer, more specific name that owns a
// "payee RAM SINGH YADAV" row — a rival's weak identity is a reason to abstain,
// never a reason to ignore it. Strength survives as `e.strong` for weighting.
function rivalsForRow(roster, normRow, selfId) {
  if (!roster?.entries?.length) return [];
  const shortlist = new Set();
  for (const t of new Set(normRow.split(" "))) {
    for (const i of roster.byToken.get(t) ?? []) shortlist.add(i);
  }
  const out = [];
  for (const i of shortlist) {
    const e = roster.entries[i];
    if (String(e.politician_id) === String(selfId)) continue;
    if (!normContainsWord(normRow, e.normName)) continue;
    out.push(e);
  }
  return out;
}

const clamp = (n) => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

function result(decision, extra = {}) {
  return {
    decision, politician_id: extra.politician_id ?? null,
    confidence: extra.confidence ?? 0, method: extra.method ?? null,
    reasons: extra.reasons ?? [], candidates: extra.candidates ?? [],
    excerpt: extra.excerpt ?? null, context: extra.context ?? [],
  };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Locate a normalized needle in the RAW text. Indexing normalized text and then
// slicing the raw string drifts (normalization collapses each " | " separator to
// one space), which matters: the excerpt is what a human adjudicates from.
export function rawNameSpan(text, normNeedle) {
  if (!normNeedle) return null;
  const pattern = normNeedle.split(" ").map(escapeRe).join("[^A-Za-z0-9]+");
  const m = new RegExp(pattern, "i").exec(String(text ?? ""));
  return m ? { index: m.index, length: m[0].length } : null;
}

// Connectors/qualifiers that legitimately follow a name in a NAME FIELD and do
// not mean the subject's name is longer than the roster's.
const NAME_TAIL_STOP = new Set([
  "and", "the", "for", "vs", "versus", "with", "son", "wife", "daughter", "others",
  "aged", "resident", "district", "village", "police", "station", "state", "party",
  "president", "minister", "member", "mla", "alias", "then", "former", "chairman",
  "director", "anr", "ors", "etc", "ltd", "limited", "pvt", "private", "company",
]);

// Field labels and connectors that legitimately precede a name in a name FIELD.
// A token before the match is only an extra GIVEN name if it is none of these.
const NAME_LEAD_STOP = new Set([
  "payee", "payer", "name", "names", "vendor", "supplier", "contractor", "bidder",
  "borrower", "accused", "respondent", "petitioner", "applicant", "appellant",
  "complainant", "informant", "witness", "donor", "purchaser", "buyer", "seller",
  "lessee", "lessor", "owner", "occupant", "allottee", "beneficiary", "candidate",
  "contestant", "employer", "employee", "awarded", "allotted", "granted", "issued",
  "against", "favour", "favor", "regarding", "from", "shri", "sarvashri", "deceased",
  "firm", "trust", "society", "proprietor", "partner", "signatory", "authorised",
  "authorized", "representative", "official", "officer", "justice", "judge", "hon",
  "secretary", "commissioner", "collector", "sub", "smt", "late", "one", "certain",
]);

// A field-shaped cell (a name column), not prose. The guard below only applies to
// these: in a sentence the word after a name is arbitrary English, but in a name
// FIELD an extra name token is part of the subject's actual name.
const NAME_FIELD_MAX_CHARS = 80;

// Whether letter case carries information in this cell. Bulk sources are wildly
// inconsistent: an ALL-CAPS or all-lowercase cell tells us nothing by capitalising
// (or failing to capitalise) a name token, so in those cells ANY adjacent word is a
// name-token candidate. Only a genuinely mixed-case cell lets us use capitalisation
// to tell "Saxena" (a surname) from "trust" (a common noun).
const caseIsInformative = (raw) => /[a-z]/.test(raw) && /[A-Z]/.test(raw);

const NAME_TOKEN_RE = (raw) => (caseIsInformative(raw) ? /[A-Z][A-Za-z]{2,}/ : /[A-Za-z]{3,}/);
const notANameToken = (tok) =>
  NAME_TAIL_STOP.has(tok) || NAME_LEAD_STOP.has(tok) || HONORIFICS.has(tok);

/**
 * The extra name token when the row's subject carries one immediately AFTER or
 * BEFORE the matched name inside a name field ("Vijay Kumar" ⊂ "MR. VIJAY KUMAR
 * GOYAL", "Naveen Jindal" ⊂ "BHARATH NAVEEN JINDAL"), else null. This is the
 * commonest way a bulk row gets pinned on a politician whose name is merely a
 * SUBSTRING of whoever the row is actually about.
 */
export function hasLongerRowName(row, normNeedle) {
  for (const cell of Array.isArray(row) ? row : [row]) {
    const raw = String(cell ?? "");
    if (raw.length > NAME_FIELD_MAX_CHARS) continue; // prose — exempt
    const span = rawNameSpan(raw, normNeedle);
    if (!span) continue;
    const nameTok = NAME_TOKEN_RE(raw).source;
    // Trailing: an extra family name after the member's name.
    const after = new RegExp(`^[^A-Za-z0-9|\\n]{0,2}(${nameTok})`)
      .exec(raw.slice(span.index + span.length));
    if (after && !notANameToken(after[1].toLowerCase())) return after[1].toLowerCase();
    // Leading: an extra GIVEN name before it. The row's subject is then a different
    // person whose name merely ENDS with the member's.
    const before = new RegExp(`(${nameTok})[^A-Za-z0-9|\\n]{0,2}$`)
      .exec(raw.slice(0, span.index));
    if (before && !notANameToken(before[1].toLowerCase())) return before[1].toLowerCase();
  }
  return null;
}

/** ~360-char window around the matched needle, for a human reviewing later. */
export function excerptAround(text, normNeedle, span = 180) {
  const raw = String(text ?? "");
  const at = rawNameSpan(raw, normNeedle);
  if (!at) return raw.slice(0, 2 * span).replace(/\s+/g, " ").trim();
  return raw.slice(Math.max(0, at.index - span), at.index + at.length + span).replace(/\s+/g, " ").trim();
}

/**
 * The ladder, for ONE row. Never writes anything, never throws.
 * @returns {{decision:"match"|"abstain"|"no_match", politician_id:string|null,
 *   confidence:number, method:string|null, reasons:string[],
 *   candidates:{politician_id:string,name:string}[], excerpt:string|null}}
 */
export function linkRow(row, politician, { mode = "name", roster = null, strongIds = null } = {}) {
  const text = rowText(row);
  const normRow = normText(text);
  if (!normRow) return result("no_match", { reasons: ["empty row"] });

  // Party-mode datasets (electoral-bond encashments, party finances) are about
  // the PARTY, not the person; the party name is the whole identity claim. Kept
  // as its own mode so it is never confused with a personal-identity decision.
  if (mode === "party") {
    const needle = normText(politician?.party);
    if (needle.length < 4) return result("no_match", { reasons: ["party needle too short"] });
    if (!normContainsWord(normRow, needle)) return result("no_match", { reasons: ["party not in row"] });
    return result("match", {
      politician_id: politician?.id ?? null, confidence: 0.5, method: "party_name",
      reasons: [`party '${needle}' named in row (party-level attribution, not personal identity)`],
      excerpt: excerptAround(text, needle),
    });
  }

  const ids = strongIds ?? politicianStrongIds(politician ?? {});
  const hit = strongIdHit(normRow, ids);
  if (hit) {
    return result("match", {
      politician_id: politician?.id ?? null,
      confidence: hit.labelled ? 0.98 : 0.95, method: "strong_id",
      reasons: [`${hit.labelled ? "labelled " : ""}strong id ${hit.key}=${hit.value} present in row`],
      excerpt: excerptAround(text, hit.value),
    });
  }

  const needle = nameNeedle(politician?.name);
  const tokens = nameTokens(politician?.name);
  // The pre-existing ≥4-char guard, kept: a 3-char "name" is not a name.
  if (needle.length < 4 || tokens.length < 1) {
    return result("no_match", { reasons: ["name needle too short"] });
  }
  if (!normContainsWord(normRow, needle)) {
    return result("no_match", { reasons: ["full name not present as whole words"] });
  }
  // Mononymous reps are real (Mayawati, Jayalalithaa, Stalin…), so a one-token
  // name must stay linkable — but a single token is the weakest possible identity
  // claim, so it needs TWO independent context signals and can never reach the
  // name-only rung below.
  const mononym = tokens.length < 2;
  const needed = mononym ? 2 * CONTEXT_THRESHOLD : CONTEXT_THRESHOLD;

  const excerpt = excerptAround(text, needle);
  const ctx = scoreContext(normRow, contextSignals(politician ?? {}));
  const { score, hits } = ctx;
  const contextHits = hits.map((h) => `${h.key}='${h.value}'`);
  const rivals = rivalsForRow(roster, normRow, politician?.id);
  const candidates = rivals.slice(0, 5).map((r) => ({ politician_id: r.politician_id, name: r.name }));

  // A namesake whose name is STRICTLY more specific (more matched tokens) is the
  // likelier subject — "Ram Singh" must not claim a "Ram Singh Yadav" row.
  const outranked = rivals.filter((r) => r.tokens.length > tokens.length);
  if (outranked.length) {
    return result("abstain", {
      politician_id: politician?.id ?? null, confidence: 0.2, method: "abstain_outranked",
      reasons: [`a longer roster name also matches this row (${outranked.map((r) => r.name).slice(0, 3).join(", ")}) — the more specific name is the likelier subject`],
      candidates, excerpt, context: contextHits,
    });
  }

  if (corroborated(ctx, needed)) {
    // Rung 2. A namesake that corroborates the row just as well leaves the row
    // genuinely ambiguous — no amount of context breaks a symmetric tie.
    const rivalsWithContext = rivals.filter((r) => corroborated(scoreContext(normRow, r.signals), CONTEXT_THRESHOLD));
    if (rivalsWithContext.length) {
      return result("abstain", {
        politician_id: politician?.id ?? null, confidence: 0.3, method: "abstain_ambiguous_context",
        reasons: [`name and context also fit ${rivalsWithContext.length} roster namesake(s) — ambiguous`],
        candidates, excerpt, context: contextHits,
      });
    }
    return result("match", {
      politician_id: politician?.id ?? null,
      confidence: clamp(0.72 + 0.06 * (score - needed) - (rivals.length ? 0.1 : 0) - (mononym ? 0.08 : 0)),
      method: "name_plus_context",
      reasons: [
        `${mononym ? "mononym" : "full name"} '${needle}' present as whole words`,
        `corroborated in the same row by ${contextHits.join(", ")}`,
        ...(rivals.length ? [`${rivals.length} roster namesake(s) present but uncorroborated`] : []),
      ],
      candidates, excerpt, context: contextHits,
    });
  }

  // Rung 3 / 4. Without corroboration the only remaining signal is how much
  // identity the name itself carries — and a namesake voids even that.
  if (mononym) {
    return result("abstain", {
      politician_id: politician?.id ?? null, confidence: 0.15, method: "abstain_mononym",
      reasons: [`'${needle}' is a single name token; two independent context signals are required and the row supplied ${score}${ctx.anchored ? "" : " (none of which narrows to a person)"}`],
      candidates, excerpt, context: contextHits,
    });
  }
  if (!identityStrong(tokens)) {
    return result("abstain", {
      politician_id: politician?.id ?? null, confidence: 0.15, method: "abstain_common_name",
      reasons: [`'${needle}' is built from common name tokens (${distinctiveCount(politician?.name)} distinctive of ${tokens.length}) and nothing in the row corroborates it${hits.length ? ` (row supplied only ${contextHits.join(", ")})` : ""}`],
      candidates, excerpt, context: contextHits,
    });
  }
  if (rivals.length) {
    return result("abstain", {
      politician_id: politician?.id ?? null, confidence: 0.25, method: "abstain_namesake",
      reasons: [`${rivals.length} other roster politician(s) match this row by name and nothing distinguishes them`],
      candidates, excerpt, context: contextHits,
    });
  }
  // Last guard before an uncorroborated name-only match: the row's subject has an
  // extra name token, so the politician's name is only a PREFIX of whoever the row
  // is actually about ("Vijay Kumar" ⊂ "VIJAY KUMAR GOYAL", a bond purchaser).
  // A longer name is ALSO how official records spell a roster short name, which is
  // why this is checked only here — corroborating context (rung 2, above) already
  // resolved that case in the member's favour.
  const longer = hasLongerRowName(row, needle);
  if (longer) {
    return result("abstain", {
      politician_id: politician?.id ?? null, confidence: 0.2, method: "abstain_longer_row_name",
      reasons: [`the row names '${needle} ${longer}…' — a longer name than the member's, with nothing corroborating that they are the same person`],
      candidates, excerpt, context: contextHits,
    });
  }
  return result("match", {
    politician_id: politician?.id ?? null, confidence: 0.6, method: "distinctive_name",
    reasons: [
      `full name '${needle}' present as whole words with ${distinctiveCount(politician?.name)} distinctive token(s)`,
      roster ? "no roster namesake matches this row" : "no roster supplied — namesake collisions unchecked",
    ],
    excerpt,
  });
}

/**
 * Run the ladder across a whole cached dataset for ONE politician.
 * Substring containment survives only as the cheap CANDIDATE GENERATOR here.
 *
 * @returns aggregate decision plus the per-row matches (capped for display),
 *   the count of abstentions, and the best abstention for human review.
 */
// scanStrongIds: also treat a bare strong-id occurrence as a candidate row (a row
// that carries the DIN/PAN but spells the name differently). Default OFF because
// the prefilter runs over every row of every cached dataset for every politician,
// where one boundary-substring test per row is the whole budget; the strong_id
// rung still applies (and outranks the name) on every candidate row.
export function linkRowsForPolitician(rows, politician, {
  mode = "name", roster = null, strongIds = null, maxHits = 12, maxScan = 0,
  scanStrongIds = false,
} = {}) {
  const needle = mode === "party" ? normText(politician?.party) : nameNeedle(politician?.name);
  const base = {
    needle, matched: [], matchedCount: 0, abstained: [], abstainedCount: 0,
    scanned: 0, candidates: [], reasons: [], method: null, confidence: 0,
    politician_id: politician?.id ?? null,
  };
  if (!Array.isArray(rows) || !rows.length) return { ...base, decision: "no_match" };
  if (needle.length < 4) return { ...base, decision: "no_match", reasons: ["needle too short"] };

  const ids = strongIds ?? politicianStrongIds(politician ?? {});
  const out = { ...base };
  for (let i = 0; i < rows.length; i++) {
    if (maxScan && out.scanned >= maxScan) break;
    const text = rowText(rows[i]);
    const normRow = normText(text);
    // Candidate generation: the name/party needle, or a strong id, must be in the
    // row at a word boundary. Everything past this point is the DECISION.
    if (!normContainsWord(normRow, needle) && !(scanStrongIds && strongIdHit(normRow, ids))) continue;
    out.scanned++;
    const r = linkRow(rows[i], politician, { mode, roster, strongIds: ids });
    if (r.decision === "match") {
      out.matchedCount++;
      if (out.matched.length < maxHits) out.matched.push({ index: i, row: rows[i], ...r });
      if (r.confidence > out.confidence) { out.confidence = r.confidence; out.method = r.method; out.reasons = r.reasons; }
    } else if (r.decision === "abstain") {
      out.abstainedCount++;
      if (out.abstained.length < 5) out.abstained.push({ index: i, row: rows[i], key: rowKey(rows[i]), ...r });
    }
  }
  if (out.matchedCount) return { ...out, decision: "match" };
  if (out.abstainedCount) {
    const best = out.abstained.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    // key, reasons, candidates AND excerpt all come from the SAME row: the caller
    // files one proposed assertion per (source, politician) and a reviewer must not
    // be shown one row's text next to another row's dedupe key and rationale.
    return {
      ...out, decision: "abstain", method: best.method, confidence: best.confidence,
      reasons: best.reasons, candidates: best.candidates, abstainKey: best.key,
      abstainExcerpt: best.excerpt ?? null, abstainIndex: best.index,
    };
  }
  return { ...out, decision: "no_match" };
}
