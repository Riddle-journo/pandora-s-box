// Unit tests for the audit + regulatory-order extractor. Fixtures are real
// evidence `content` layouts captured from the l1-cache (CAG title-only row,
// ITAT + NCLT body-text excerpt rows, an NCLAT "A Vs B" order row). We test the
// PURE parser/record builders — no DB writes — but importing the module registers
// extractors (which pulls in store.js and opens the SQLite handle), so we point
// PANDOROS_DB_PATH at a per-pid temp file first, exactly like ledger-detectors.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-auditreg-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const {
  parseAuditRegulatory, extractParties, isAuditSource, auditRegulatoryRecords,
  AUDIT_REGULATORY_SOURCE_TYPES, AUDIT_REGULATORY_VERSION,
} = await import("../server/extractors/audit-regulatory.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// Real CAG national-index layout: "• <report title> | <pdf url>" (no body cell).
const CAG = {
  title: "CAG audit reports (national index) — Ravi Kumar",
  content:
    "CAG audit reports (national index) (1 matching row, dataset of 2676):\n" +
    "• Performance Audit of Ravi Kumar Rural Roads Scheme | https://cag.gov.in/uploads/media/ravi-kumar-roads-98229279.pdf",
};

// Real ITAT body-text layout: "• Download PDF | <url> | …<body window>…" — a long
// prose cell naming a co-operative society (org) and several persons.
const ITAT = {
  title: "ITAT order PDFs (body-text) — Pradeep Kumar",
  content:
    "ITAT order PDFs (body-text) (1 matching row, dataset of 58):\n" +
    "• Download PDF | https://itat.gov.in/public/files/upload/1783487905-vqAAUgDs-CMS.pdf | " +
    "…A SAHKARI SAMITI LTD., DEHRADUN 4 ITA 227/DDN/2026 2017-18 [A] SHYAM KRISHNA GUPTA 5 ITA 235/DDN/2026 " +
    "2018-19 [A] PRADEEP KUMAR 6 ITA 252/DDN/2026 2019-2020 [A] SANTOSH CHAMOLI 7 ITA 253/DDN/2026…",
};

// Real NCLT body-text layout (annual-report demitted-members list) — no org.
const NCLT = {
  title: "NCLT order PDFs (body-text) — Suchitra Kanuparthi",
  content:
    "NCLT order PDFs (body-text) (1 matching row, dataset of 7):\n" +
    "• Annual Report 22-23 | https://nclt.gov.in/sites/default/files/2026-02/report.pdf | " +
    "…Bengaluru Bench Hon'ble Shri V K Rajsekhar DOB: 19-07-1968 Demitted on 03-07-2022 Kolkata Bench " +
    "Hon'ble Ms. Suchitra Kanuparthi DOB: 22-06-1968 Demitted on 03-07-2022…",
};

// NCLAT order body with an explicit "A Vs B" corporate matchup.
const NCLAT = {
  title: "NCLAT judgement/order PDFs (body-text) — Karan Malhotra",
  content:
    "NCLAT judgement/order PDFs (body-text) (1 matching row, dataset of 23):\n" +
    "• Read More | https://nclat.gov.in/sites/default/files/2026-07/notice.pdf | " +
    "…Comp. App. (AT) (Ins) No. 992 of 2024 HT Media Ltd. Vs. GHCL Ltd. Karan Malhotra Dhaval Deshpande…",
};

test("parseAuditRegulatory: CAG title-only row", () => {
  const p = parseAuditRegulatory(CAG);
  assert.equal(p.matched, 1);
  assert.equal(p.dataset, 2676);
  assert.equal(p.headerTitle, "CAG audit reports (national index)");
  assert.equal(p.selfName, "Ravi Kumar");
  assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].docTitle, "Performance Audit of Ravi Kumar Rural Roads Scheme");
  assert.match(p.rows[0].url, /cag\.gov\.in/);
  assert.equal(p.rows[0].body, null);
});

test("parseAuditRegulatory: ITAT body row keeps org, drops generic label", () => {
  const p = parseAuditRegulatory(ITAT);
  const r = p.rows[0];
  // Generic "Download PDF" label → falls back to the corpus header title.
  assert.equal(r.docTitle, "ITAT order PDFs (body-text)");
  assert.ok(r.body && /SAHKARI SAMITI/.test(r.body));
  const orgs = r.parties.filter((x) => x.kind === "org").map((x) => x.name);
  assert.ok(orgs.some((n) => /SAHKARI SAMITI LTD/i.test(n)), `expected society org in ${JSON.stringify(r.parties)}`);
});

test("extractParties: Vs pairing + self-exclusion", () => {
  const parties = extractParties("HT Media Ltd. Vs. GHCL Ltd. Karan Malhotra", "Karan Malhotra");
  const names = parties.map((x) => x.name.toLowerCase());
  assert.ok(names.some((n) => n.includes("ht media")), "HT Media captured");
  assert.ok(names.some((n) => n.includes("ghcl")), "GHCL captured");
  assert.ok(!names.some((n) => n.includes("karan malhotra")), "self excluded");
});

test("isAuditSource classifies families", () => {
  assert.equal(isAuditSource("l1_cag_audit_index"), true);
  assert.equal(isAuditSource("l1_mp_lfa_body"), true);
  assert.equal(isAuditSource("l1_sfio_investigations"), true);
  assert.equal(isAuditSource("l1_fiu_publications"), true);
  assert.equal(isAuditSource("l1_nclt_orders"), false);
  assert.equal(isAuditSource("l1_atfp_orders_body"), false);
  assert.equal(isAuditSource("l1_kspcb_consent"), false);
});

test("auditRegulatoryRecords: audit source → named_in_audit_report claim", () => {
  const out = auditRegulatoryRecords(CAG, "l1_cag_audit_index");
  assert.equal(out.claims.length, 1);
  const c = out.claims[0];
  assert.equal(c.claim_type, "named_in_audit_report");
  assert.equal(c.status, "unverified");
  assert.ok(c.confidence >= 0.15 && c.confidence <= 0.3);
  assert.match(c.object_text, /Rural Roads Scheme/);
  assert.equal(c.data.source, "cag_audit_index");
  assert.ok(/verify identity/i.test(c.data.note));
});

test("auditRegulatoryRecords: order source → claim + relationships (universal subjects)", () => {
  const out = auditRegulatoryRecords(NCLAT, "l1_nclat_orders");
  assert.equal(out.claims.length, 1);
  assert.equal(out.claims[0].claim_type, "named_in_regulatory_order");
  // Vs pairing folded into the order subject.
  assert.match(out.claims[0].object_text, /vs/i);
  assert.ok(out.relationships.length >= 2, "co-named order parties become edges");
  for (const rel of out.relationships) {
    assert.equal(rel.rel_type, "named_in_same_order");
    assert.equal(rel.data.identity_unverified, true);
    assert.ok(rel.confidence <= 0.2);
  }
  const dsts = out.relationships.map((r) => r.dst_name.toLowerCase());
  assert.ok(dsts.some((n) => n.includes("ht media")) && dsts.some((n) => n.includes("ghcl")));
});

test("auditRegulatoryRecords: NCLT body row still emits a claim (row never dropped)", () => {
  const out = auditRegulatoryRecords(NCLT, "l1_nclt_orders");
  assert.equal(out.claims.length, 1);
  assert.equal(out.claims[0].claim_type, "named_in_regulatory_order");
});

test("empty / non-matching content → no records", () => {
  assert.deepEqual(auditRegulatoryRecords({ content: "" }, "l1_cag_audit_index"), {});
  assert.deepEqual(
    auditRegulatoryRecords({ content: "Some header (0 matching rows, dataset of 5):" }, "l1_nclt_orders"),
    {},
  );
});

test("registration covers every declared source_type with the shared version", () => {
  assert.ok(AUDIT_REGULATORY_SOURCE_TYPES.includes("l1_cag_bihar"));
  assert.ok(AUDIT_REGULATORY_SOURCE_TYPES.includes("l1_ric_raj_body"));
  assert.equal(AUDIT_REGULATORY_VERSION, "audit-regulatory-v1");
});
