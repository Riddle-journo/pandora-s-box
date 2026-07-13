// Unit tests for the anti-corruption / vigilance / blacklist extractor.
//
// The parse path is pure (no DB), but importing the module pulls in extract.js →
// store.js, which opens the SQLite DB at import time. So — exactly like
// ledger-detectors.test.js — point PANDOROS_DB_PATH at a per-pid temp file and
// clear any stale leftover BEFORE importing anything from server/.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-vigilance-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const {
  extractVigilanceCases, parseRowLines, parseLooseDate,
  VIGILANCE_SOURCE_TYPES, VIGILANCE_CASES_VERSION,
} = await import("../server/extractors/vigilance-cases.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────
test("parseLooseDate covers hyphen, dotted, numeric-slash and ISO forms", () => {
  assert.equal(parseLooseDate("03-01-2026"), "2026-01-03");
  assert.equal(parseLooseDate("07.08.2019"), "2019-08-07");
  assert.equal(parseLooseDate("07/08/2024"), "2024-08-07");
  assert.equal(parseLooseDate("2008-10-03"), "2008-10-03");
  assert.equal(parseLooseDate("not a date"), null);
});

test("parseRowLines splits bullet rows on ' | ' and ignores the header line", () => {
  const content = "Some Title (2 matching rows, dataset of 99):\n• a | b | c\n• d | e";
  const rows = parseRowLines(content);
  assert.deepEqual(rows, [["a", "b", "c"], ["d", "e"]]);
});

test("every registered source_type has a config and the version is stamped", () => {
  assert.ok(VIGILANCE_SOURCE_TYPES.includes("l1_acb_jk_fir"));
  assert.ok(VIGILANCE_SOURCE_TYPES.includes("l1_rec_banned"));
  assert.ok(VIGILANCE_SOURCE_TYPES.includes("l1_ugc_fake"));
  assert.equal(VIGILANCE_CASES_VERSION, "vigilance-cases-v1");
});

// ── layout 1: ACB J&K FIR table ──────────────────────────────────────────────
// [S.No | FIR No | Date of Registration | Brief Allegations | Individuals | Remarks]
test("ACB J&K FIR row → vigilance claim with case no + date, co-accused edge", () => {
  const content =
    "ACB Jammu & Kashmir — FIR cases (1 matching row, dataset of 10):\n" +
    "• 05 | 12/2026- PS ACB Srinagar | 15-02-2026 | Demand and acceptance of ₹5,000 as bribe (Trap) | Bashir Ahmad Wani, Patwari, Halqa Budgam; Ghulam Nabi, Clerk | ";
  const { claims, relationships } = extractVigilanceCases(
    { content, title: "ACB Jammu & Kashmir — FIR cases — Bashir Ahmad Wani" },
    "l1_acb_jk_fir",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, "named_in_vigilance_case");
  assert.equal(claims[0].status, "unverified");
  assert.ok(claims[0].confidence <= 0.3 && claims[0].confidence >= 0.15);
  assert.equal(claims[0].as_of_date, "2026-02-15");
  assert.match(claims[0].object_text, /12\/2026/);
  assert.equal(claims[0].data.case_no, "12/2026- PS ACB Srinagar");
  assert.ok(claims[0].data.note.length > 0);
  // Bashir Ahmad Wani is the matched politician → excluded; Ghulam Nabi is a co-accused.
  const names = relationships.map((r) => r.dst_name);
  assert.ok(names.includes("Ghulam Nabi"), `expected Ghulam Nabi in ${JSON.stringify(names)}`);
  assert.ok(!names.some((n) => /Bashir/.test(n)), "matched politician must not be a self-edge");
  assert.equal(relationships[0].rel_type, "co_accused_in_vigilance_case");
  assert.equal(relationships[0].dst_kind, "person");
  assert.equal(relationships[0].data.identity_unverified, true);
});

// ── layout 2: REC banned-firms (blacklist) ───────────────────────────────────
// [Sr | Company | Address | Ban date | Duration | Reason | Remark]
test("REC banned firm row → blacklist claim + company relationship", () => {
  const content =
    "REC List of Banned Firms (1 matching row, dataset of 4):\n" +
    "• 3 | M/s Acme Cables Pvt Ltd | 12 Industrial Area, Delhi | 07.08.2019 | 3 years | Submitting forged documents with bills | Banned across REC group";
  const { claims, relationships } = extractVigilanceCases(
    { content, title: "REC List of Banned Firms — Acme" },
    "l1_rec_banned",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, "named_on_blacklist");
  assert.equal(claims[0].as_of_date, "2019-08-07");
  assert.match(claims[0].object_text, /Acme Cables/);
  assert.match(claims[0].object_text, /forged documents/);
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].rel_type, "named_with_blacklisted_firm");
  assert.equal(relationships[0].dst_name, "M/s Acme Cables Pvt Ltd");
  assert.equal(relationships[0].dst_kind, "company");
  assert.equal(relationships[0].valid_from, "2019-08-07");
});

// ── layout 3: UGC fake universities (blacklist) ──────────────────────────────
// [Sr No | State | University Name (+ address)]
test("UGC fake-university row → blacklist claim + org relationship", () => {
  const content =
    "UGC Fake/Blacklisted Universities (1 matching row, dataset of 33):\n" +
    "• 7 | Delhi | Commercial University Ltd, Daryaganj, Delhi-110002";
  const { claims, relationships } = extractVigilanceCases(
    { content, title: "UGC Fake/Blacklisted Universities — Commercial University" },
    "l1_ugc_fake",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, "named_on_blacklist");
  assert.match(claims[0].object_text, /Commercial University Ltd/);
  assert.match(claims[0].object_text, /Delhi/);
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].dst_kind, "org");
  assert.equal(relationships[0].dst_name, "Commercial University Ltd");
});

// ── layout 4: Lokayukta document link-list ───────────────────────────────────
// [link-text | url]
test("Lokayukta press-release link row → vigilance claim, no self-edge", () => {
  const content =
    "AP Lokayukta — reports & press releases (1 matching row, dataset of 7):\n" +
    "• Press Note: Enquiry against Tahsildar Rama Rao, Case 44/2025 | https://lokayukta.ap.gov.in/files/pn.pdf";
  const { claims, relationships } = extractVigilanceCases(
    { content, title: "AP Lokayukta — reports & press releases — Rama Rao" },
    "l1_ap_lokayukta",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, "named_in_vigilance_case");
  assert.match(claims[0].object_text, /Tahsildar Rama Rao/);
  assert.equal(claims[0].data.case_no, "Case 44/2025");
  assert.equal(relationships.length, 0);
});

// ── layout 5: Karnataka Lokayukta PDF body (mega) ────────────────────────────
// [title | url | body-snippet with enquiry nos + many names]
test("Lokayukta body snippet → enquiry no in claim + capped co-accused edges", () => {
  const content =
    "Karnataka Lokayukta reports (1 matching row, dataset of 10):\n" +
    "• Enquiry Cases Cause List | https://x/CauseListDoc.pdf | 162/2025 hearing. Sl No Enquiry_No 1 539/2018 1. Mayanna Gowda, Asst. Public Prosecutor 2 542/2018 1. Sumangala Chandrashekhar, Public Prosecutor 3 556/2018 1. Sunil Patil, Tahsildar";
  const { claims, relationships } = extractVigilanceCases(
    { content, title: "Karnataka Lokayukta reports/cause-lists (body-text) — Sunil Patil" },
    "l1_mega_ka_lokayukta_body",
  );
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, "named_in_vigilance_case");
  assert.match(claims[0].object_text, /162\/2025|539\/2018/);
  const names = relationships.map((r) => r.dst_name);
  assert.ok(names.includes("Mayanna Gowda"));
  assert.ok(names.includes("Sumangala Chandrashekhar"));
  assert.ok(!names.some((n) => /Sunil Patil/.test(n)), "matched politician excluded");
  assert.ok(relationships.every((r) => r.rel_type === "co_accused_in_vigilance_case"));
});

// ── KEEP ALL DATA: one claim per matched row ─────────────────────────────────
test("multiple matched rows each yield their own distinct claim", () => {
  const content =
    "AP Lokayukta — reports (2 matching rows, dataset of 7):\n" +
    "• Press Note A about official X | https://x/a.pdf\n" +
    "• Press Note B about official X | https://x/b.pdf";
  const { claims } = extractVigilanceCases(
    { content, title: "AP Lokayukta — reports — official X" },
    "l1_ap_lokayukta",
  );
  assert.equal(claims.length, 2);
  assert.notEqual(claims[0].object_text, claims[1].object_text);
});

test("unknown source_type yields nothing", () => {
  assert.deepEqual(extractVigilanceCases({ content: "x (1 matching row):\n• a | b" }, "l1_unknown"), {});
});
