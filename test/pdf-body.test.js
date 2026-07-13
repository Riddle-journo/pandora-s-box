// PDF body-matching tests (gap #1: readBodies). Pure — exercises l1Match, the
// function that turns a cached PDF-index row into matched evidence — with no
// network and no DB. Proves that a politician named INSIDE a report body (the
// 3rd cell added by readBodies), not just in the title, is matched, and that the
// displayed excerpt is a window AROUND the name rather than the document preamble.
import test from "node:test";
import assert from "node:assert/strict";
import { l1Match } from "../server/ingest.js";

const CFG = { id: "cag-bihar", title: "CAG Bihar — audit reports", summary: "audit PDFs", match: "name", tier: 5 };

// A realistic long audit-report body: the name sits deep in the text, after a
// lot of boilerplate — exactly the case title-only matching used to miss.
const PREAMBLE = "Report of the Comptroller and Auditor General of India on General and Social Sector for the year ended March 2024 Government of Bihar. ".repeat(6);
const BODY = PREAMBLE + "The audit observed that tenders awarded to a firm connected to Shri Ramesh Kumar Sharma were not routed through competitive bidding, causing a loss to the exchequer. " + PREAMBLE;

test("readBodies: a name in the PDF BODY (3rd cell) is matched, not just the title", () => {
  const cache = { total: 1, rows: [["Audit Report No. 4 of 2025", "https://cag.gov.in/x/report.pdf", BODY]] };
  const p = { id: "p1", name: "Ramesh Kumar Sharma" };
  const ev = l1Match(CFG, cache, p);
  assert.ok(ev, "should produce an evidence row from a body hit");
  assert.equal(ev.source_type, "l1_cag_bihar");
  assert.match(ev.content, /Ramesh Kumar Sharma/);
});

test("readBodies: the excerpt is a window AROUND the name, not the document preamble", () => {
  const cache = { total: 1, rows: [["Audit Report No. 4 of 2025", "https://cag.gov.in/x/report.pdf", BODY]] };
  const ev = l1Match(CFG, cache, { id: "p1", name: "Ramesh Kumar Sharma" });
  // The snippet must contain the sentence around the name and be far shorter
  // than the full body — i.e. it did NOT just slice the first 160 chars.
  assert.match(ev.content, /tenders awarded to a firm connected to Shri Ramesh Kumar Sharma/);
  assert.ok(ev.content.length < BODY.length, "excerpt must be a window, not the whole body");
  assert.match(ev.content, /…/, "windowed snippet is delimited with ellipses");
});

test("title-only rows (no body) still match and print in full — no regression", () => {
  const cache = { total: 1, rows: [["Audit on Ramesh Kumar Sharma trust", "https://cag.gov.in/x/t.pdf"]] };
  const ev = l1Match(CFG, cache, { id: "p1", name: "Ramesh Kumar Sharma" });
  assert.ok(ev, "title match still works for 2-cell rows");
  assert.match(ev.content, /Audit on Ramesh Kumar Sharma trust/);
});

test("no false positive: an unrelated name does not match", () => {
  const cache = { total: 1, rows: [["Audit Report No. 4 of 2025", "https://cag.gov.in/x/report.pdf", BODY]] };
  assert.equal(l1Match(CFG, cache, { id: "p2", name: "Sunita Devi Yadav" }), null);
});
