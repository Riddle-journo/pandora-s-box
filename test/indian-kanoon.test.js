// Phase 2E — the Indian Kanoon extractor: the first to fill the CLAIMS and EVENTS
// ledgers. Pure-function tests pin the judgment/date parse; an integration test
// drives content through the framework and confirms claims + events land with the
// low-confidence/unverified framing, correct subject, provenance, and idempotency.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-kanoon-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store/store.js");
const { ensureEntity } = await import("../server/entities/entities.js");
const { claimsFor } = await import("../server/store/ledger.js");
const { eventsFor } = await import("../server/entities/relations.js");
const {
  parseKanoonDate, kanoonJudgments, runIndianKanoonExtraction, INDIAN_KANOON_VERSION,
} = await import("../server/extractors/indian-kanoon.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const CONTENT = [
  'Court judgment matches for "Test Rep" via Indian Kanoon (verify identity):',
  "• Full Document",
  "    Sh. Test Rep vs Ito Tds-1 on 6 June, 2019 Sh. Test Rep vs Ito Tds-1 [ITA 573]",
  "• Full Document",
  "    Kanishk Sinha vs Test Rep & Ors on 1 May, 2019 more context here",
  "• Full Document",
  "    Sh. Test Rep vs Ito Tds-1 on 6 June, 2019 duplicate should collapse",
].join("\n");

test("parseKanoonDate: '6 June, 2019' → ISO; junk → null", () => {
  assert.equal(parseKanoonDate("6 June, 2019"), "2019-06-06");
  assert.equal(parseKanoonDate("14 May, 2014"), "2014-05-14");
  assert.equal(parseKanoonDate("no date here"), null);
});

test("kanoonJudgments: parses title+date, dedupes repeats", () => {
  const js = kanoonJudgments(CONTENT);
  assert.equal(js.length, 2, "the duplicate 6-June entry collapses");
  assert.equal(js[0].date, "2019-06-06");
  assert.match(js[0].case_title, /Test Rep vs Ito Tds-1/);
  assert.equal(js[1].date, "2019-05-01");
  assert.equal(kanoonJudgments("").length, 0);
});

test("integration: judgments land as unverified claims AND dated events", () => {
  const eid = ensureEntity({ kind: "person", name: "Test Rep", strongIds: { politician_id: "PK" }, source: "seed" });
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run("IK1", "PK", null, null, 1, "t", JSON.stringify({ id: "IK1", source_type: "indian_kanoon", tier: 4, content: CONTENT }));

  const c = runIndianKanoonExtraction();
  assert.equal(c.claims, 2, "two distinct judgments → two claims");
  assert.equal(c.events, 2, "two distinct judgments → two events");

  // Claims: low-confidence, unverified, subject resolved, provenance stamped.
  const claims = claimsFor(eid, "named_in_court_judgment");
  assert.equal(claims.length, 2);
  const one = claims.find((x) => /Ito Tds-1/.test(x.object_text));
  assert.equal(one.status, "unverified");
  assert.equal(one.confidence, 0.2);
  assert.equal(one.subject_kind, "person");
  assert.equal(one.source_type, "indian_kanoon");
  assert.equal(one.as_of_date, "2019-06-06");
  assert.equal(one.extractor_version, INDIAN_KANOON_VERSION);

  // Events: dated court_judgment, linked to the entity, source-tagged.
  const events = eventsFor(eid, { kind: "court_judgment" });
  assert.equal(events.length, 2);
  const ev = events.find((e) => e.at === "2019-06-06");
  assert.ok(ev.entity_ids.includes(eid));
  assert.equal(ev.source, "indian_kanoon");
  assert.equal(ev.data.identity_unverified, true);
});

test("integration: re-run is idempotent", () => {
  const c = runIndianKanoonExtraction();
  assert.equal(c.claims, 0);
  assert.equal(c.events, 0);
});
