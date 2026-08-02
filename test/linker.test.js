// The identity ladder (server/util/linker.js) — the guard against attributing an
// adverse government record to the wrong person. Pure: no DB, no network, no temp
// files; linker.js imports nothing, so nothing here can touch data/pandoros.db.
//
// What these prove, in order of how badly the old substring matcher got them wrong:
//   • a namesake collision ABSTAINS instead of naming one of them
//   • an all-common short name ("Ram Singh") ABSTAINS with no corroboration
//   • "pa|ram singh|al" is not a match for "Ram Singh" (word boundaries)
//   • a labelled strong id outranks a conflicting name in the same row
//   • context in the SAME row (constituency/state/party) is what promotes a
//     bare name hit to a real match
import test from "node:test";
import assert from "node:assert/strict";
import {
  linkRow, linkRowsForPolitician, buildRosterIndex, normContainsWord, rowKey,
  identityStrong, nameTokens, distinctiveTokens, contextSignals, hasLongerRowName,
} from "../server/util/linker.js";

// A roster with a deliberate namesake pair plus one distinctive name.
const ROSTER = [
  { id: "p1", name: "Ramesh Kumar Sharma", party: "BJP", office: "MP", constituency: "Varanasi", state: "Uttar Pradesh" },
  { id: "p2", name: "Ramesh Kumar Sharma", party: "INC", office: "MLA", constituency: "Bhopal", state: "Madhya Pradesh" },
  { id: "p3", name: "Ram Singh", party: "BJP", office: "MP", constituency: "Aligarh", state: "Uttar Pradesh" },
  { id: "p4", name: "Priyanka Chaturvedi", party: "SS", office: "RS", constituency: "Maharashtra", state: "Maharashtra" },
];
const index = (list) => buildRosterIndex(list);
const P = (id) => ROSTER.find((p) => p.id === id);

// ── primitives ──────────────────────────────────────────────────────────────

test("normContainsWord requires token boundaries (the substring bug)", () => {
  assert.equal(normContainsWord("param singhal enterprises", "ram singh"), false,
    "'pa|ram singh|al' must not count as Ram Singh");
  assert.equal(normContainsWord("shri ram singh yadav", "ram singh"), true);
  assert.equal(normContainsWord("ram singhania", "ram singh"), false);
});

test("identity strength follows the repo's distinctive-token rule", () => {
  assert.equal(identityStrong(nameTokens("Ram Singh")), false);         // 0 distinctive of 2
  assert.equal(identityStrong(nameTokens("Ramesh Kumar Sharma")), true); // 1 distinctive of 3
  assert.equal(identityStrong(nameTokens("Priyanka Chaturvedi")), true); // 2 distinctive
  assert.deepEqual(distinctiveTokens("Shri Ramesh Kumar Sharma"), ["ramesh"]);
});

test("contextSignals ignores pseudo-states and reservation markers", () => {
  const s = contextSignals({ name: "X", constituency: "ADILABAD (ST)", state: "Lok Sabha (Parliament)", party: "AITC", office: "MP" });
  const keys = s.map((x) => x.key);
  assert.ok(s.some((x) => x.key === "constituency" && x.value === "adilabad"));
  assert.ok(!keys.includes("state"), "'Lok Sabha (Parliament)' is not a state");
  assert.ok(keys.includes("party") && keys.includes("office"));
});

test("only constituency and party can carry a decision; geography and era top up", () => {
  const s = contextSignals({ constituency: "Varanasi", state: "Uttar Pradesh", party: "AITC", office: "MP" });
  const w = Object.fromEntries(s.map((x) => [x.key, x]));
  assert.equal(w.constituency.anchor, true);
  assert.equal(w.party.anchor, true);
  assert.equal(w.state.anchor, false, "a state is a property of the DATASET, not of the person");
  assert.ok(w.state.weight < 1, "a state cell alone must not reach the context threshold");
  assert.equal(w.office.anchor, false);
});

// ── the ladder ──────────────────────────────────────────────────────────────

test("true match: full name + constituency in the same row", () => {
  const row = ["Tender T/2021/88", "Awarded to Ramesh Kumar Sharma", "Varanasi", "Rs 4,20,000"];
  const r = linkRow(row, P("p1"), { roster: index([P("p1"), P("p3"), P("p4")]) });
  assert.equal(r.decision, "match");
  assert.equal(r.method, "name_plus_context");
  assert.ok(r.confidence >= 0.7, `confidence ${r.confidence}`);
  assert.match(r.reasons.join(" "), /constituency='varanasi'/);
});

test("namesake collision ABSTAINS rather than picking one of two same-named reps", () => {
  const row = ["Payee: RAMESH KUMAR SHARMA", "Cheque 4471", "Rs 12,00,000"];
  const roster = index(ROSTER);
  for (const id of ["p1", "p2"]) {
    const r = linkRow(row, P(id), { roster });
    assert.equal(r.decision, "abstain", `${id} must abstain`);
    assert.equal(r.method, "abstain_namesake");
    assert.ok(r.candidates.length >= 1, "the rival candidate is reported for review");
  }
});

test("namesake with corroborating context wins over the uncorroborated one", () => {
  const row = ["Payee: RAMESH KUMAR SHARMA", "District Bhopal, Madhya Pradesh", "Rs 12,00,000"];
  const roster = index(ROSTER);
  const bhopal = linkRow(row, P("p2"), { roster });
  const varanasi = linkRow(row, P("p1"), { roster });
  assert.equal(bhopal.decision, "match");
  assert.equal(bhopal.method, "name_plus_context");
  assert.equal(varanasi.decision, "abstain");
});

test("short/common name ABSTAINS with nothing corroborating it", () => {
  const row = ["Accused: Ram Singh", "FIR 221/2019"];
  const r = linkRow(row, P("p3"), { roster: index(ROSTER) });
  assert.equal(r.decision, "abstain");
  assert.equal(r.method, "abstain_common_name");
  assert.match(r.reasons.join(" "), /common name tokens/);
});

test("a common name DOES resolve once the row corroborates it", () => {
  const row = ["Accused: Ram Singh", "MP, Aligarh, Uttar Pradesh", "FIR 221/2019"];
  const r = linkRow(row, P("p3"), { roster: index(ROSTER) });
  assert.equal(r.decision, "match");
  assert.equal(r.method, "name_plus_context");
});

test("a more specific roster name outranks a shorter one on the same row", () => {
  const roster = index([...ROSTER, { id: "p5", name: "Ram Singh Chaudhary", party: "BSP", office: "MLA", constituency: "Etah", state: "Uttar Pradesh" }]);
  const row = ["Contract awarded to Ram Singh Chaudhary", "Aligarh, Uttar Pradesh"];
  const r = linkRow(row, P("p3"), { roster });
  assert.equal(r.decision, "abstain");
  assert.equal(r.method, "abstain_outranked");
  assert.match(r.reasons.join(" "), /more specific/);
});

test("distinctive name with no context and no namesake is a (lower-confidence) match", () => {
  const row = ["Donation received from Priyanka Chaturvedi", "Rs 1,00,000"];
  const r = linkRow(row, P("p4"), { roster: index(ROSTER) });
  assert.equal(r.decision, "match");
  assert.equal(r.method, "distinctive_name");
  assert.equal(r.confidence, 0.6);
});

test("a name FIELD naming a longer name is not the member ('Vijay Kumar' ⊂ 'VIJAY KUMAR GOYAL')", () => {
  const p = { id: "vk", name: "Vijay Kumar Chaturvedi", party: "BJP", office: "MP", constituency: "Kanpur", state: "Uttar Pradesh" };
  const r = linkRow(["18/Apr/2019", "MR. VIJAY KUMAR CHATURVEDI GOYAL", "1000000"], p, { roster: index([p]) });
  assert.equal(r.decision, "abstain");
  assert.equal(r.method, "abstain_longer_row_name");
  assert.match(r.reasons.join(" "), /longer name than the member's/);
});

test("the longer-name guard does NOT fire inside prose (only in name fields)", () => {
  const p = { id: "vk", name: "Vijay Kumar Chaturvedi" };
  const prose = "The audit observed that tenders awarded to a firm connected to Shri Vijay Kumar Chaturvedi were not routed through competitive bidding, causing a loss to the exchequer and prompting a review.";
  const r = linkRow(["Audit Report 4 of 2025", "https://x/y.pdf", prose], p, {});
  assert.equal(r.decision, "match", "an English word after a name in prose is not an extra name token");
});

test("a labelled strong id wins over a conflicting name in the same row", () => {
  const row = ["Borrower: SOME OTHER PERSON", "Director DIN 00123456", "Rs 40 cr"];
  const r = linkRow(row, P("p4"), { strongIds: { din: "00123456" } });
  assert.equal(r.decision, "match");
  assert.equal(r.method, "strong_id");
  assert.ok(r.confidence >= 0.95);
});

test("a bare number is never a strong id (tender numbers collide with candidate ids)", () => {
  const p = { id: "px", name: "Priyanka Chaturvedi", myneta_url: "https://www.myneta.info/x/candidate.php?candidate_id=8974" };
  const r = linkRow(["Tender 8974 for road works", "Nagpur"], p, {});
  assert.equal(r.decision, "no_match", "8974 alone must not identify anyone");
});

test("a row that matches nobody returns no_match", () => {
  const r = linkRow(["Purchase of stationery", "Rs 900"], P("p1"), { roster: index(ROSTER) });
  assert.equal(r.decision, "no_match");
});

test("substring-only occurrences are no_match, not evidence", () => {
  const r = linkRow(["Param Singhal & Sons, contractor"], P("p3"), { roster: index(ROSTER) });
  assert.equal(r.decision, "no_match");
});

// ── dataset-level aggregation ───────────────────────────────────────────────

test("linkRowsForPolitician separates matches from abstentions across a cache", () => {
  const rows = [
    ["Awarded to Ramesh Kumar Sharma", "Varanasi", "2021"],   // match (context)
    ["Payee RAMESH KUMAR SHARMA", "Cheque 12"],               // abstain (namesake)
    ["Unrelated stationery purchase"],                        // not a candidate
  ];
  const out = linkRowsForPolitician(rows, P("p1"), { roster: index(ROSTER) });
  assert.equal(out.decision, "match");
  assert.equal(out.matchedCount, 1);
  assert.equal(out.abstainedCount, 1);
  assert.equal(out.scanned, 2);
  assert.equal(out.method, "name_plus_context");
});

test("all-abstain cache yields decision 'abstain' with a stable dedupe key", () => {
  const rows = [["Payee RAMESH KUMAR SHARMA", "Cheque 12"]];
  const a = linkRowsForPolitician(rows, P("p1"), { roster: index(ROSTER) });
  const b = linkRowsForPolitician(rows, P("p1"), { roster: index(ROSTER) });
  assert.equal(a.decision, "abstain");
  assert.equal(a.abstainKey, b.abstainKey, "same row → same key → one proposed assertion");
  assert.equal(a.abstainKey, rowKey(rows[0]));
});

test("party mode still attributes party-level rows, and only on a whole-token hit", () => {
  const rows = [["12-Apr-2019", "BHARTIYA JANTA PARTY", "Rs 1,00,00,000"], ["Income increased", "INC"]];
  const bjp = linkRowsForPolitician(rows, { id: "p1", party: "Bhartiya Janta Party" }, { mode: "party" });
  assert.equal(bjp.decision, "match");
  assert.equal(bjp.method, "party_name");
  // The needle guard (<4 chars) is unchanged, so a 3-letter abbreviation never
  // sprays itself across words like "income".
  const inc = linkRowsForPolitician(rows, { id: "p2", party: "INC" }, { mode: "party" });
  assert.equal(inc.decision, "no_match");
});

test("a mononym abstains on a bare name hit", () => {
  const r = linkRow(["Order against Mayawati"], { id: "p9", name: "Mayawati" }, {});
  assert.equal(r.decision, "abstain");
  assert.equal(r.method, "abstain_mononym");
});

test("a mononym needs TWO context signals, not one", () => {
  const p = { id: "p9", name: "Mayawati", party: "BSP", office: "MLA", constituency: "Lucknow", state: "Uttar Pradesh" };
  const one = linkRow(["Land allotted to Mayawati", "Lucknow"], p, {});
  assert.equal(one.decision, "abstain", "constituency alone is not enough for a single-token name");
  // Constituency + state is NOT two signals either: both are geography, and the
  // state is a constant of any state-scoped cache (see the geography regression).
  const geoOnly = linkRow(["Land allotted to Mayawati", "Lucknow, Uttar Pradesh"], p, {});
  assert.equal(geoOnly.decision, "abstain", "stacked geography is one kind of signal, not two");
  const two = linkRow(["Land allotted to Mayawati", "Lucknow, Uttar Pradesh", "Vidhan Sabha question 41"], p, {});
  assert.equal(two.decision, "match");
  assert.equal(two.method, "name_plus_context");
  assert.ok(two.confidence < 0.72, "a mononym match is held below a full-name match");
});

test("no roster supplied: the namesake guard is inert and says so", () => {
  const r = linkRow(["Donation from Priyanka Chaturvedi"], P("p4"), {});
  assert.equal(r.decision, "match");
  assert.match(r.reasons.join(" "), /no roster supplied/);
});

// ── regressions: the ladder must not be bypassable ──────────────────────────
// Each test below pins a hole that let an all-common name be attributed anyway.

test("REGRESSION: a geography cell alone never corroborates a common name", () => {
  // Every row of a state-scoped bulk cache (l1_up_flood_tenders, l1_khoj_judges)
  // carries the SAME state, so the state cell is a constant of the dataset and
  // carries zero identity information about the person.
  const p = { id: "rs", name: "Ram Singh", state: "Uttar Pradesh", constituency: "Aligarh", party: "BJP", office: "MP" };
  const stateOnly = linkRow(["Contractor: RAM SINGH & SONS", "Ballia, Uttar Pradesh"], p, {});
  assert.equal(stateOnly.decision, "abstain", "state alone must not reach the context threshold");
  // …and a bare year on top of it is still not corroboration of a PERSON.
  const stateAndYear = linkRow(
    ["Tender UPFL/2021/8891", "Contractor: RAM SINGH & SONS", "Ballia, Uttar Pradesh", "Rs 42,00,000"], p, {});
  assert.equal(stateAndYear.decision, "abstain", "state + year is era + geography, not identity");
  assert.equal(stateAndYear.method, "abstain_common_name");
});

test("REGRESSION: a geography cell cannot defeat the longer-row-name guard", () => {
  // "ASHOK KUMAR BASUMATARY" is a different person from roster member "Ashok Kumar";
  // rung 2 used to fire first and match on the state cell alone.
  const r = linkRow(["Supplier: RAM SINGH BASUMATARY", "Assam"], { id: "rs", name: "Ram Singh", state: "Assam" }, {});
  assert.equal(r.decision, "abstain");
});

test("REGRESSION: a 3-letter party abbreviation is not a context signal", () => {
  // 3,000+ of 4,559 roster rows store party as a 3-letter code, and those codes
  // collide with ordinary words: "INC" is a corporate suffix, "PDF" a file
  // extension present in every html-list/readBodies row in the repo.
  for (const party of ["BJP", "INC", "PDF", "IND", "DMK", "TDP"]) {
    assert.ok(!contextSignals({ party }).some((s) => s.key === "party"),
      `'${party}' is too short to be identity corroboration`);
  }
  const inc = linkRow(["Vendor: RAM SINGH TRADERS INC", "invoice 771"],
    { id: "rs", name: "Ram Singh", party: "INC", state: "Karnataka", constituency: "Kolar" }, {});
  assert.equal(inc.decision, "abstain", "the 'Inc' corporate suffix is not the Congress party");
  const pdf = linkRow(["CAG Report 4 of 2019 — Ram Singh irregularity", "https://cag.gov.in/uploads/report-2019.pdf"],
    { id: "rs", name: "Ram Singh", party: "PDF" }, {});
  assert.equal(pdf.decision, "abstain", "a .pdf href is not the PDF party");
});

test("REGRESSION: an ordinary-word party value is blocklisted even when long enough", () => {
  assert.ok(!contextSignals({ party: "Independent" }).some((s) => s.key === "party"),
    "'Independent' is a candidate-type column value, not corroboration");
  assert.ok(contextSignals({ party: "AITC" }).some((s) => s.key === "party"),
    "a real ≥4-char abbreviation still corroborates");
});

test("REGRESSION: a strong-id label must correspond to the id it labels", () => {
  const p = { id: "rs", name: "Ram Singh", myneta_url: "https://myneta.info/x/candidate.php?candidate_id=8974" };
  // "Registration No. 8974" is a tender/bid number; it is not a MyNeta id.
  const reg = linkRow(["Contractor RAM SINGH", "Registration No. 8974", "Rs 4 cr"], p, {});
  assert.notEqual(reg.method, "strong_id", "any-label-plus-4-digits is not an identifier");
  const din = linkRow(["Contractor RAM SINGH", "DIN 8974", "Rs 4 cr"], p, {});
  assert.notEqual(din.method, "strong_id", "a DIN label must not validate a MyNeta candidate id");
  // A short all-numeric id is never strong, even under its OWN label.
  const own = linkRow(["Contractor RAM SINGH", "candidate id 8974"], p, {});
  assert.notEqual(own.method, "strong_id", "a 4-digit number is not a public identifier");
});

test("REGRESSION: the longer-row-name guard is case-insensitive", () => {
  // Lowercase/mixed-case supplier and payee fields are normal in the OCDS/CKAN
  // JSON caches; cell case is source formatting, never an identity signal.
  const p = { id: "nj", name: "Naveen Jindal", party: "INC", office: "MP", constituency: "Kurukshetra", state: "Haryana" };
  assert.equal(hasLongerRowName(["mr. naveen jindal saxena"], "naveen jindal"), "saxena");
  const r = linkRow(["18/Apr/2019", "mr. naveen jindal saxena", "1000000"], p, { roster: index([p]) });
  assert.equal(r.decision, "abstain", "the same row must not flip on letter case");
  assert.equal(r.method, "abstain_longer_row_name");
});

test("REGRESSION: an extra GIVEN name before the match also blocks attribution", () => {
  const p = { id: "nj", name: "Naveen Jindal", party: "INC", office: "MP", constituency: "Kurukshetra", state: "Haryana" };
  const r = linkRow(["18/Apr/2019", "BHARATH NAVEEN JINDAL", "1000000"], p, { roster: index([p]) });
  assert.equal(r.decision, "abstain", "'Bharath Naveen Jindal' is not 'Naveen Jindal'");
  assert.equal(r.method, "abstain_longer_row_name");
});

test("REGRESSION: field labels and connectors before a name do NOT block it", () => {
  const p = { id: "p4x", name: "Priyanka Chaturvedi" };
  for (const cell of ["Payee: PRIYANKA CHATURVEDI", "Awarded to Priyanka Chaturvedi", "Contractor Priyanka Chaturvedi"]) {
    const r = linkRow([cell, "Rs 1,00,000"], p, {});
    assert.equal(r.decision, "match", `'${cell}' is a labelled name field, not a longer name`);
  }
});

test("REGRESSION: an honorific in the ROSTER name does not make a member unmatchable", () => {
  // 242 of 4,559 roster names carry an honorific token; sources spell the name
  // without it, and the containment gate used to require it verbatim.
  const r = linkRow(["Awarded to Sanjay Jaiswal", "Bihar", "Rs 2 cr"],
    { id: "sj", name: "Dr. Sanjay Jaiswal", state: "Bihar", constituency: "Paschim Champaran" }, {});
  assert.notEqual(r.decision, "no_match", "'Dr. Sanjay Jaiswal' must still reach the ladder");
  const rows = [["Awarded to Sanjay Jaiswal", "Paschim Champaran"]];
  const agg = linkRowsForPolitician(rows, { id: "sj", name: "Dr. Sanjay Jaiswal", constituency: "Paschim Champaran" }, {});
  assert.equal(agg.decision, "match", "candidate generation must also drop the honorific");
});

test("REGRESSION: one geography word cannot score twice (constituency == state)", () => {
  // 243 roster members (the Rajya Sabha cohort) store the same string in both
  // fields, which handed a single row word the TWO signals a mononym requires.
  const p = { id: "may", name: "Mayawati", office: "RS", constituency: "Uttar Pradesh", state: "Uttar Pradesh" };
  const r = linkRow(["Land allotted to Mayawati Builders Pvt Ltd", "Uttar Pradesh"], p, {});
  assert.equal(r.decision, "abstain", "one word is one signal, however many fields hold it");
  const hits = contextSignals(p).filter((s) => s.value === "uttar pradesh");
  assert.ok(hits.length >= 2, "both fields still emit — the DEDUPE is scoreContext's job");
});

test("REGRESSION: a rival is admitted on name overlap, not on its own identity strength", () => {
  // "Ram Singh Yadav" is entirely common tokens, so identityStrong is false and the
  // guards could not see it — yet it is exactly the longer name that owns the row.
  const roster = index([
    { id: "rs", name: "Ram Singh", party: "BJP", office: "MP", constituency: "Aligarh", state: "Uttar Pradesh" },
    { id: "rsy", name: "Ram Singh Yadav", party: "SP", office: "MLA", constituency: "Etah", state: "Uttar Pradesh" },
  ]);
  const r = linkRow(["payee RAM SINGH YADAV", "cheque 3"], { id: "rs", name: "Ram Singh" }, { roster });
  assert.equal(r.decision, "abstain");
  assert.equal(r.method, "abstain_outranked", "the more specific roster name is the likelier subject");
  assert.ok(r.candidates.some((c) => c.politician_id === "rsy"), "the rival is surfaced for review");
});

test("REGRESSION: mononymous members are indexed as rivals too", () => {
  const roster = index([{ id: "m", name: "Mayawati" }, { id: "o", name: "Other Person" }]);
  assert.ok(roster.entries.some((e) => e.name === "Mayawati"), "552 mononym members were dropped from the index");
});

test("REGRESSION: the common-name reason text does not claim distinctive tokens", () => {
  const r = linkRow(["Accused: Ram Singh", "FIR 221/2019"], { id: "rs", name: "Ram Singh" }, {});
  assert.equal(r.method, "abstain_common_name");
  assert.match(r.reasons.join(" "), /0 distinctive of 2/,
    "the rationale a human reads must not say '2 distinctive of 2' while abstaining for having none");
});

test("REGRESSION: the reviewable abstention excerpt is the BEST abstention's row", () => {
  const twin = { id: "t1", name: "Ramesh Kumar Sharma" };
  const sameName = { id: "t1b", name: "Ramesh Kumar Sharma" };
  const longer = { id: "t2", name: "Ramesh Kumar Sharma Chaturvedi" };
  const rows = [
    ["ROW-ZERO payee RAMESH KUMAR SHARMA CHATURVEDI", "cheque 1"], // abstain_outranked (0.2)
    ["ROW-ONE payee RAMESH KUMAR SHARMA", "cheque 2"],             // abstain_namesake (0.25) ← best
  ];
  const out = linkRowsForPolitician(rows, twin, { roster: index([twin, sameName, longer]) });
  assert.equal(out.decision, "abstain");
  const best = out.abstained.find((a) => a.key === out.abstainKey);
  assert.ok(best, "abstainKey must name one of the reported abstentions");
  assert.equal(out.abstainExcerpt, best.excerpt,
    "the excerpt a reviewer adjudicates must be the row the key and reasons came from");
});
