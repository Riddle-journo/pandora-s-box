// Unit tests for the corporate-insolvency + wilful-defaulter extractor.
// Pure record-builders (data -> {claims, events, relationships}) are exercised
// against inline fixture `content` shaped exactly like ingest's l1Match output
// ("• cellA | cellB | ..."). Importing the module registers extractors, which
// pulls in extract.js -> store.js and opens the DB, so PANDOROS_DB_PATH is pointed
// at a per-pid temp file BEFORE the import (mirrors test/ledger-detectors.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-insolv-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const {
  parseIbbiCirp, ibbiCirpRecords,
  parseIbbiOrders, ibbiOrdersRecords,
  parseWilfulDefaulter, wilfulDefaulterRecords,
  INSOLVENCY_DEFAULTER_SOURCE_TYPES,
} = await import("../server/extractors/insolvency-defaulters.js");

const { listExtractors } = await import("../server/extractors/extract.js");

// ── IBBI CIRP ────────────────────────────────────────────────────────────────
test("parseIbbiCirp pulls debtor / applicant / IP / date from the fixed columns", () => {
  const content =
    "IBBI CIRP public announcements (2 matching rows, dataset of 8912):\n" +
    "• Public Announcement of Corporate Insolvency Resolution Process | 08-07-2026 | 21-07-2026 | MONTECARLO LIMITED | Vanshita Transport | Sanjaykumar Jitendralal Shah | 5th Floor, Navrangpura, Ahmadabad, Gujarat, 380009 | (1.11 MB) | \n" +
    "• Public Announcement of Corporate Insolvency Resolution Process | 08-07-2026 | 18-07-2026 | KALKA HOME DEVELOPERS PRIVATE LIMITED | DCB Bank Limited | Mr. Vikram Kumar | D-46, Hauz Khas Enclave, Delhi | (1.73 MB) | ";
  const p = parseIbbiCirp({ content });
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].debtor, "MONTECARLO LIMITED");
  assert.equal(p.rows[0].ann_date, "2026-07-08");
  assert.equal(p.rows[0].applicant, "Vanshita Transport");
  assert.equal(p.rows[1].debtor, "KALKA HOME DEVELOPERS PRIVATE LIMITED");
  assert.equal(p.matched, 2);
  assert.equal(p.dataset, 8912);
});

test("ibbiCirpRecords emits an unverified claim + one company relationship per debtor", () => {
  const content =
    "IBBI CIRP public announcements (2 matching rows, dataset of 8912):\n" +
    "• Public Announcement of Corporate Insolvency Resolution Process | 08-07-2026 | 21-07-2026 | MONTECARLO LIMITED | Vanshita Transport | Sanjaykumar Jitendralal Shah | addr | (1.11 MB) | \n" +
    "• Public Announcement of Corporate Insolvency Resolution Process | 08-07-2026 | 18-07-2026 | KALKA HOME DEVELOPERS PRIVATE LIMITED | DCB Bank Limited | Mr. Vikram Kumar | addr | (1.73 MB) | ";
  const rec = ibbiCirpRecords({ content });
  assert.equal(rec.claims.length, 1);
  assert.equal(rec.claims[0].claim_type, "linked_insolvency_proceeding");
  assert.equal(rec.claims[0].status, "unverified");
  assert.ok(rec.claims[0].confidence <= 0.3 && rec.claims[0].confidence >= 0.15);
  assert.match(rec.claims[0].object_text, /MONTECARLO LIMITED/);

  assert.equal(rec.relationships.length, 2);
  const r0 = rec.relationships[0];
  assert.equal(r0.rel_type, "linked_insolvent_company");
  assert.equal(r0.dst_kind, "company");
  assert.equal(r0.dst_name, "MONTECARLO LIMITED");
  assert.equal(r0.valid_from, "2026-07-08");
  assert.equal(r0.data.identity_unverified, true);
  assert.equal(rec.relationships[1].dst_name, "KALKA HOME DEVELOPERS PRIVATE LIMITED");
});

// ── IBBI disciplinary orders ─────────────────────────────────────────────────
test("parseIbbiOrders extracts the named insolvency professional + spaced date", () => {
  const content =
    "IBBI disciplinary orders (1 matching row, dataset of 833):\n" +
    "• 2 | 03 July, 2026 | In the matter of Mr. Chandra Prakash Jain, Insolvency Professional (537.28 KB) | Order of Disciplinary Committee";
  const p = parseIbbiOrders({ content });
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].name, "Chandra Prakash Jain");
  assert.equal(p.rows[0].date, "2026-07-03");

  const rec = ibbiOrdersRecords({ content });
  assert.equal(rec.claims[0].claim_type, "linked_insolvency_proceeding");
  assert.equal(rec.relationships[0].rel_type, "linked_insolvency_professional");
  assert.equal(rec.relationships[0].dst_kind, "person");
  assert.equal(rec.relationships[0].dst_name, "Chandra Prakash Jain");
});

// ── RBI wilful defaulter (with CIN / PAN / DIN) ──────────────────────────────
test("parseWilfulDefaulter token-extracts company CIN/PAN + a co-director's DIN", () => {
  // Body mirrors a bank-published wilful-defaulter PDF snippet: a borrower company
  // carrying a CIN + company PAN (4th char C), and a co-director with DIN + a
  // personal PAN (4th char P). SUIT = suit-filed.
  const content =
    "Bank of Baroda — Wilful Defaulters list (1 matching row, dataset of 4120):\n" +
    "• PDF | https://bankofbaroda.bank.in/media/Wilful-Defaulter-April-2026.pdf | " +
    "SUIT 245.50 SHREEJI TEXTILES PRIVATE LIMITED U17110GJ1995PTC024567 AABCS1234K " +
    "Director RAJESH KUMAR PATEL (DIN 01234567) PAN ABCPK5678L Ahmadabad Gujarat";
  const p = parseWilfulDefaulter({ title: "Bank of Baroda — Wilful Defaulters list", content });
  assert.equal(p.bank, "Bank of Baroda");
  assert.equal(p.borrower, "SHREEJI TEXTILES PRIVATE LIMITED");
  assert.ok(p.cins.includes("U17110GJ1995PTC024567"));
  assert.ok(p.entityPans.includes("AABCS1234K"));   // 4th char C -> company
  assert.ok(p.personPans.includes("ABCPK5678L"));   // 4th char P -> individual
  assert.ok(p.dins.includes("01234567"));
  assert.equal(p.suit, true);
  const director = p.directors.find((d) => /RAJESH KUMAR PATEL/.test(d.name));
  assert.ok(director, "co-director parsed");
  assert.equal(director.din, "01234567");
});

test("wilfulDefaulterRecords emits claim + company relationship (CIN) + director relationship (DIN)", () => {
  const content =
    "Bank of Baroda — Wilful Defaulters list (1 matching row, dataset of 4120):\n" +
    "• PDF | https://example/wd.pdf | " +
    "SUIT 245.50 SHREEJI TEXTILES PRIVATE LIMITED U17110GJ1995PTC024567 AABCS1234K " +
    "Director RAJESH KUMAR PATEL (DIN 01234567) PAN ABCPK5678L";
  const rec = wilfulDefaulterRecords({ title: "Bank of Baroda — Wilful Defaulters list", content });

  assert.equal(rec.claims[0].claim_type, "named_wilful_defaulter");
  assert.equal(rec.claims[0].status, "unverified");
  assert.match(rec.claims[0].object_text, /suit-filed wilful defaulter — Bank of Baroda/);
  assert.ok(rec.claims[0].confidence <= 0.3 && rec.claims[0].confidence >= 0.15);

  const company = rec.relationships.find((r) => r.rel_type === "linked_defaulter_company");
  assert.ok(company, "company relationship present");
  assert.equal(company.dst_kind, "company");
  assert.equal(company.dst_name, "SHREEJI TEXTILES PRIVATE LIMITED");
  assert.equal(company.dst_strong_ids.cin, "U17110GJ1995PTC024567");
  assert.equal(company.dst_strong_ids.pan, "AABCS1234K");

  const director = rec.relationships.find((r) => r.rel_type === "linked_defaulter_codirector");
  assert.ok(director, "co-director relationship present");
  assert.equal(director.dst_kind, "person");
  assert.equal(director.dst_strong_ids.din, "01234567");
});

test("wilfulDefaulterRecords keeps the row (claim) even with no parseable company", () => {
  // Real BoB run-on with no corporate suffix / no identifiers — still a lead.
  const content =
    "Bank of Baroda — Wilful Defaulters list (1 matching row, dataset of 4120):\n" +
    "• PDF | https://example/wd.pdf | Rajesh Kumar APR26 BN01030001 Bank of Baroda ZOSARB New Delhi Radhey Polymers 34 01";
  const rec = wilfulDefaulterRecords({ title: "Bank of Baroda — Wilful Defaulters list", content });
  assert.equal(rec.claims.length, 1);
  assert.equal(rec.claims[0].claim_type, "named_wilful_defaulter");
});

// ── registration ─────────────────────────────────────────────────────────────
test("live l1_mega_* source_types are registered with the framework", () => {
  const registered = listExtractors();
  for (const st of ["l1_mega_ibbi_cirp", "l1_mega_ibbi_orders", "l1_mega_rbi_wd_bob", "l1_mega_rbi_wd_pnb"]) {
    assert.ok(registered.includes(st), `${st} registered`);
    assert.ok(INSOLVENCY_DEFAULTER_SOURCE_TYPES.includes(st));
  }
});
