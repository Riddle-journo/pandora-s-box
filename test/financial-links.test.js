// Financial + procurement link extractors — pure parsers tested against realistic
// fixtures, plus an integration pass driving one row of each source through the
// framework into the claims/events/relationships ledgers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-finlinks-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { db } = await import("../server/store.js");
const { ensureEntity } = await import("../server/entities.js");
const { claimsFor } = await import("../server/ledger.js");
const { relationsOf, eventsFor } = await import("../server/relations.js");
const { extractFromEvidence } = await import("../server/extract.js");
const {
  parseSecEdgar, parseIcij, parseElectoralBonds, parseProcurement, parseAnyDate, parseMatchCount,
} = await import("../server/extractors/financial-links.js");

test.after(() => { for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} } });

test("parseAnyDate handles the corpus date shapes", () => {
  assert.equal(parseAnyDate("2008-10-03"), "2008-10-03");
  assert.equal(parseAnyDate("12/Jan/2022"), "2022-01-12");
  assert.equal(parseAnyDate("28-Jul-2022"), "2022-07-28");
  assert.equal(parseAnyDate("21-07-2022"), "2022-07-21");
  assert.equal(parseAnyDate("garbage"), null);
});

test("parseSecEdgar pulls company, CIK, form, filing date", () => {
  const p = parseSecEdgar({
    title: "SEC EDGAR filing mentions Mamata Banerjee — TATA MOTORS LTD/FI  (CIK 0000926042) (6-K)",
    content: 'excerpt naming "Mamata Banerjee" (filer: TATA MOTORS LTD/FI (CIK 0000926042), form 6-K, filed 2008-10-03): …',
  });
  assert.equal(p.company, "TATA MOTORS LTD/FI");
  assert.equal(p.cik, "0000926042");
  assert.equal(p.form, "6-K");
  assert.equal(p.date, "2008-10-03");
});

test("parseIcij pulls node, dataset and the connected offshore entity", () => {
  const p = parseIcij({
    title: 'ICIJ Offshore Leaks — Abhishek BANERIEA (Officer, matched "Abhishek Banerjee")',
    content: "Node: Abhishek BANERIEA — Officer node extracted from the Pandora Papers - SFM Corporate Services data. Connections: Entity (1) Role From To Incorporation Jurisdiction Status Data From COMTRADE INTERNATIONAL LIMITED Shareholder - - United Arab Emirates - Pandora Papers",
  });
  assert.equal(p.node, "Abhishek BANERIEA");
  assert.equal(p.node_kind, "officer");
  assert.match(p.dataset, /Pandora Papers/);
  assert.equal(p.connected_entity, "COMTRADE INTERNATIONAL LIMITED");
});

test("parseElectoralBonds aggregates rows into a total + count", () => {
  const p = parseElectoralBonds({
    title: "Electoral Bonds — Encashments by party — Goa Forward Party",
    content: "Electoral Bonds — Encashments by party (17 matching rows, dataset of 20422): • 12/Jan/2022 | GOA FORWARD PARTY | 100000 • 12/Jan/2022 | GOA FORWARD PARTY | 1000000",
  });
  assert.equal(p.kind, "encashed");
  assert.equal(p.name, "GOA FORWARD PARTY");
  assert.equal(p.total, 1100000);
  assert.equal(p.count, 2);
  assert.equal(p.matched_rows, 17);
  assert.equal(p.first_date, "2022-01-12");
});

test("parseProcurement pulls tender id, org, role and a date", () => {
  const p = parseProcurement({
    title: "Government contracts (CPPP award-of-contract) — Duraimurugan",
    content: "CPPP award-of-contract matches: • [matched \"Duraimurugan\"] year: 2024 | aoc_date: 29-May-2024 12:00 AM | closing_date: 06-Mar-2024 | tender_id: 2024_RDTN_442971_1 | org_name: Tamil Nadu | detail_url",
  });
  assert.equal(p.tender_id, "2024_RDTN_442971_1");
  assert.equal(p.org, "Tamil Nadu");
  assert.equal(p.role, "awardee/party");
  assert.equal(p.date, "2024-05-29"); // prefers the labelled aoc_date
});

test("parseMatchCount reads the header tallies", () => {
  assert.deepEqual(parseMatchCount("foo (23 matching rows, dataset of 37311): •"), { matched: 23, dataset: 37311 });
  assert.deepEqual(parseMatchCount("no counts here"), { matched: null, dataset: null });
});

test("integration: sec_edgar row → claim + event + company relationship", async () => {
  await import("../server/extractors/financial-links.js"); // registers
  const pid = "FL1";
  const { upsertPolitician } = await import("../server/store.js");
  upsertPolitician({ id: pid, name: "Test Rep" });
  const eid = ensureEntity({ kind: "person", name: "Test Rep", strongIds: { politician_id: pid }, source: "seed" });

  const out = extractFromEvidence({
    id: "ev-sec-1", politician_id: pid, source_type: "sec_edgar", tier: 6,
    data: {
      source_type: "sec_edgar", tier: 6,
      title: "SEC EDGAR filing mentions Test Rep — ACME GLOBAL LTD (CIK 0000111222) (10-K)",
      content: 'naming "Test Rep" (filer: ACME GLOBAL LTD (CIK 0000111222), form 10-K, filed 2019-05-01):',
    },
  });
  assert.equal(out.claims, 1);
  assert.equal(out.events, 1);
  assert.equal(out.relationships, 1);

  const claims = claimsFor(eid, "named_in_sec_filing");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "unverified");
  assert.ok(claims[0].confidence <= 0.3);

  const rels = relationsOf(eid, { relType: "named_in_filing" });
  assert.equal(rels.length, 1);
  assert.equal(rels[0].data.identity_unverified, true);

  const events = eventsFor(eid, { kind: "sec_filing_mention" });
  assert.equal(events.length, 1);
});
