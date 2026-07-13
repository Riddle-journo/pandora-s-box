// Phase 2G — election-expenditure extractor. Pin that we take the FIRST "Grand
// Total" (expenditure, not the later funds-received total) and skip cleanly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-expenditure-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store.js");
const { ensureEntity } = await import("../server/entities.js");
const { factsFor } = await import("../server/ledger.js");
const { expenditureFacts, runExpenditureExtraction, EXPENDITURE_VERSION } = await import("../server/extractors/expenditure.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// Expenditure grand total FIRST, then a later receipts "Total" that must be ignored.
const CONTENT = "Election Expenses)) Lok Sabha 2024 TEST CANDIDATE (Winner) ... Grand Total 65,15,248 65 Lacs+ ... Lump sum received ... Total 50,77,000 50 Lacs+";

test("expenditureFacts: takes the first Grand Total (expenditure), with year", () => {
  const [f] = expenditureFacts(CONTENT);
  assert.equal(f.metric, "election_expenditure");
  assert.equal(f.value, 6515248); // NOT the 50,77,000 receipts total
  assert.equal(f.as_of_date, "2024");
  assert.equal(f.period, "LS2024");
  assert.equal(expenditureFacts("no grand total here").length, 0);
});

test("integration: expenditure flows into the ledger", () => {
  const eid = ensureEntity({ kind: "person", name: "Test Candidate", strongIds: { politician_id: "PE" }, source: "seed" });
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run("EE1", "PE", null, null, 1, "t", JSON.stringify({ id: "EE1", source_type: "eci_expenditure", tier: 1, content: CONTENT }));
  const c = runExpenditureExtraction();
  assert.equal(c.facts, 1);
  const [f] = factsFor(eid, "election_expenditure");
  assert.equal(f.value, 6515248);
  assert.equal(f.source_type, "eci_expenditure");
  assert.equal(f.extractor_version, EXPENDITURE_VERSION);
});
