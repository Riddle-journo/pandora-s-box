// Phase 2F — parliament legislative-activity extractor. Pure parsers pin the count
// lines; an integration test drives all three sources through the framework.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-parliament-${process.pid}.db`);
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
const {
  questionsFacts, debatesFacts, assurancesFacts, runParliamentExtraction, PARLIAMENT_VERSION,
} = await import("../server/extractors/parliament.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

test("questionsFacts: count + term period", () => {
  const [f] = questionsFacts("Asked 80 question(s) in the 18th Lok Sabha.\n• ...");
  assert.equal(f.metric, "questions_asked");
  assert.equal(f.value, 80);
  assert.equal(f.period, "LS18");
  assert.equal(questionsFacts("no count here").length, 0);
});

test("debatesFacts: count", () => {
  const [f] = debatesFacts("Participated in 18 debate(s). Topics: ...");
  assert.equal(f.metric, "debates_participated");
  assert.equal(f.value, 18);
});

test("assurancesFacts: counts bulleted items", () => {
  const [f] = assurancesFacts("Government assurances:\n• one\n• two\n• three");
  assert.equal(f.value, 3);
  assert.equal(assurancesFacts("no bullets").length, 0);
});

test("integration: the three sources write counts to the ledger", () => {
  const eid = ensureEntity({ kind: "person", name: "MP Q", strongIds: { politician_id: "PQ" }, source: "seed" });
  const rows = [
    ["PQ1", "parliament_questions", "Asked 80 question(s) in the 18th Lok Sabha."],
    ["PQ2", "parliament_debates", "Participated in 18 debate(s). Topics: x, y"],
  ];
  for (const [id, st, content] of rows) {
    db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
      .run(id, "PQ", null, null, 1, "t", JSON.stringify({ id, source_type: st, tier: 2, content }));
  }
  const c = runParliamentExtraction();
  assert.equal(c.questions.facts, 1);
  assert.equal(c.debates.facts, 1);

  const [q] = factsFor(eid, "questions_asked");
  assert.equal(q.value, 80);
  assert.equal(q.source_type, "parliament_questions");
  assert.equal(q.extractor_version, PARLIAMENT_VERSION);
  assert.equal(factsFor(eid, "debates_participated")[0].value, 18);
});
