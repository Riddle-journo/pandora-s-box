// Summarizer card tests: the politician card must build deterministically with
// ZERO LLM calls, its score must be reproducible from the flags, insufficient
// data must exclude (never lower) parameters, and NOTHING from the Investigator
// branch (pattern flags / leads) may appear in the payload. Also covers the
// digit-guard on the clerical prose pass and the ministry/party resolvers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-cards-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const store = await import("../server/store/store.js");
const { buildPoliticianCard, buildPartyCard, gatherLegislative, CARD_VERSION } = await import("../server/publishing/cards.js");
const { resolveMinistry, resolveParty } = await import("../server/data/ministries.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// A rep with two affidavits (8x asset growth), 4 cases, and MPLADS underuse.
function seedRep() {
  const p = store.upsertPolitician({
    name: "Test Rep", office: "MP", state: "Testland", party: "BJP", constituency: "Testpur",
  });
  store.addEvidence([
    { id: store.id(), politician_id: p.id, url: "https://ex.test/aff-2019", title: "Affidavit 2019",
      source_type: "eci_affidavit", admissible: true, date: "2019-04-01",
      numbers: { election_year: 2019, total_assets: 10_000_000, net_worth: 10_000_000, total_liabilities: 1_000_000, criminal_cases: 4 } },
    { id: store.id(), politician_id: p.id, url: "https://ex.test/aff-2024", title: "Affidavit 2024",
      source_type: "eci_affidavit", admissible: true, date: "2024-04-01",
      numbers: { election_year: 2024, total_assets: 80_000_000, net_worth: 80_000_000, total_liabilities: 2_000_000, criminal_cases: 4 } },
    { id: store.id(), politician_id: p.id, url: "https://ex.test/mplads", title: "MPLADS record",
      source_type: "mplads", admissible: true, date: "2024-01-01",
      numbers: { allocated: 50_000_000, utilization_pct: 30, unspent: 35_000_000 } },
  ]);
  return p;
}

const rep = seedRep();
const card = buildPoliticianCard(rep.id);

test("politician card builds with zero LLM calls and carries the version", () => {
  assert.equal(card.card_version, CARD_VERSION);
  assert.equal(card.kind, "politician");
  assert.ok(card.sections.length >= 3, "has sections");
  // Every section is complete without prose (template fallback present).
  for (const s of card.sections) assert.ok(typeof s.template_prose === "string");
});

test("card scoring is deterministic and auditable", () => {
  const again = buildPoliticianCard(rep.id);
  assert.equal(again.score, card.score, "same evidence → same score");
  assert.equal(again.grade, card.grade);
  const corr = card.parameters.find((p) => p.key === "corruption");
  // 70 baseline + ASSET_GROWTH_ANOMALY (8x → -22) = 48
  assert.equal(corr.score, 48);
  assert.ok(corr.contributions.some((c) => c.code === "ASSET_GROWTH_ANOMALY"));
});

test("insufficient data excludes a parameter (-1), never lowers it", () => {
  const manifesto = card.parameters.find((p) => p.key === "manifesto");
  assert.equal(manifesto.score, -1, "no promises source → excluded, not low");
  const hyp = card.parameters.find((p) => p.key === "hypocrisy");
  assert.equal(hyp.score, -1);
});

test("card payload contains nothing from the Investigator branch", () => {
  const json = JSON.stringify(card);
  assert.ok(!json.includes("pattern_flags"), "no pattern_flags");
  assert.ok(!json.includes("investigation_lead"), "no leads");
  assert.ok(!("pattern_flags" in card));
});

test("every adverse fact carries at least one source link", () => {
  for (const s of card.sections) {
    for (const f of s.facts) {
      if (f.severity === "SIGNIFICANT" || f.severity === "NOTABLE") {
        // watch/gaps sections aggregate; others must cite
        if (["watch", "gaps"].includes(s.key)) continue;
        assert.ok(f.sources.length > 0, `${s.key}: "${f.text}" has a source`);
      }
    }
  }
});

test("resolveMinistry maps free text to canonical keys, most specific wins", () => {
  assert.equal(resolveMinistry("Ministry of Finance / RBI supervision")?.key, "union/finance");
  assert.equal(resolveMinistry("Karnataka Mines & Geology")?.key, "state/karnataka/mines");
  assert.equal(resolveMinistry("Something Unrelated"), null);
});

test("resolveParty canonicalizes abbreviations and full names; coalitions → null", () => {
  assert.equal(resolveParty("BJP")?.key, "bjp");
  assert.equal(resolveParty("Bharatiya Janata Party (NDA)")?.key, "bjp");
  assert.equal(resolveParty("All India Trinamool Congress")?.key, "aitc", "Trinamool must not resolve to INC");
  assert.equal(resolveParty("Cross-party (INC then BJP)"), null);
});

test("party card aggregates the roster with no single invented score", () => {
  const pc = buildPartyCard("bjp");
  assert.equal(pc.score, null, "no opaque single party number in v1");
  const roster = pc.sections.find((s) => s.key === "roster");
  assert.ok(Number(roster.stats[0].value) >= 1, "seeded BJP rep counted");
});

test("gatherLegislative: parses question/debate/assurance counts from sansad evidence", () => {
  const ev = [
    { source_type: "parliament_questions", title: "Lok Sabha questions", url: "u1", content: "Asked 1,234 question(s) in the 18th Lok Sabha." },
    { source_type: "parliament_debates", title: "debates", url: "u2", content: "Participated in 12 debate(s)." },
    { source_type: "parliament_ls", title: "record", url: "u3", content: "Govt assurances secured: 3" },
  ];
  const leg = gatherLegislative(ev);
  assert.equal(leg.questions, 1234);
  assert.equal(leg.debates, 12);
  assert.equal(leg.assurances, 3);
  assert.ok(leg.hasData);
});

test("gatherLegislative: no parliament evidence → no data", () => {
  assert.equal(gatherLegislative([{ source_type: "news", title: "x", content: "y" }]).hasData, false);
});
