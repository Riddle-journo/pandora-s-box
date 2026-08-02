// Electoral-bond donor attribution.
//
// THE BUG: India's electoral-bond disclosure says which companies bought bonds
// and which parties encashed them — never how much of a given purchase reached
// a given party. The dataset records this honestly, as a donor total plus the
// list of parties it funded. Every consumer then read that national total as
// the amount given to whichever party was on screen.
//
// So a report card headed "Top disclosed donors to INC" listed
// "Megha Engineering — ₹966 Cr", the same figure it showed under BJP. Both were
// false statements about a named real company and a named real party. The party
// view was internally contradictory too: INC's donor rows summed to ₹3,550 Cr
// against a disclosed party total of ₹1,422 Cr.
//
// These tests exist so that misreading cannot return through a new consumer.
import test from "node:test";
import assert from "node:assert/strict";

import { fundingForParty, TOP_DONORS, PARTY_TOTALS } from "../server/data/electoral-bonds.js";

test("a donor entry never claims an amount was given to this party", () => {
  const inc = fundingForParty("Indian National Congress");
  assert.ok(inc.donors.length > 0);
  for (const d of inc.donors) {
    assert.equal(d.amount_to_this_party, null, "the per-party split is not disclosed and must not be invented");
    assert.equal(typeof d.total_cr_all_parties, "number");
    assert.equal(d.total_cr, undefined,
      "the ambiguous field is gone — a bare `total_cr` on a donor is what caused the false attribution");
    assert.ok(Array.isArray(d.recipient_parties) && d.recipient_parties.length >= 1);
    assert.equal(d.shared, d.recipient_parties.length > 1);
  }
});

test("a shared donor reports the same total under every party it funded", () => {
  // Megha Engineering funded six parties. The figure is identical under each
  // because it is one national total — which is exactly why it must be labelled
  // as such rather than presented as a party-specific donation.
  const megha = TOP_DONORS.find((d) => /Megha/.test(d.donor));
  assert.ok(megha, "fixture donor still present");
  assert.ok(megha.parties.length > 1);
  const seen = megha.parties.map((abbr) => {
    const p = PARTY_TOTALS.find((x) => x.abbr === abbr);
    const f = fundingForParty(p.party);
    return f.donors.find((d) => /Megha/.test(d.donor));
  });
  for (const entry of seen) {
    assert.equal(entry.total_cr_all_parties, megha.total_cr);
    assert.equal(entry.shared, true);
    assert.equal(entry.recipient_count, megha.parties.length);
  }
});

test("REGRESSION: a party's donor rows are not presented as summing to its total", () => {
  // The contradiction that exposed the bug. The sum of donor totals exceeding
  // the party total is EXPECTED and fine — precisely because those totals are
  // not party-specific. What must not exist is a per-party rupee figure that
  // invites the comparison.
  const inc = fundingForParty("Indian National Congress");
  const naiveSum = inc.donors.reduce((s, d) => s + d.total_cr_all_parties, 0);
  assert.ok(naiveSum > inc.total_cr,
    "shared donor totals legitimately exceed the party total — which is why they are labelled, not summed");
  for (const s of inc.sectors) {
    assert.equal(typeof s.donor_count, "number", "sectors are counted, not given a fabricated party rupee total");
    assert.equal(s.total_cr, undefined, "a per-party sector rupee sum would repeat the same error");
    assert.equal(typeof s.total_cr_all_parties, "number");
  }
});

test("the party's own total IS disclosed, and stays exact", () => {
  for (const p of PARTY_TOTALS.slice(0, 5)) {
    const f = fundingForParty(p.party);
    assert.equal(f.total_cr, p.total_cr, "party-level totals are disclosed per party and must pass through unchanged");
    assert.ok(f.rank >= 1 && f.rank <= f.total_parties);
  }
});

test("the payload carries the disclosure caveat with it", () => {
  const f = fundingForParty("Bharatiya Janata Party");
  assert.match(f.disclosure_note, /not how much of a given donor's purchase reached a given party/i,
    "any consumer — card, API, or LLM prompt — receives the caveat alongside the numbers");
});

test("an unknown party is null, not a fabricated profile", () => {
  assert.equal(fundingForParty("Not A Real Party"), null);
  assert.equal(fundingForParty(""), null);
  assert.equal(fundingForParty(null), null);
});
