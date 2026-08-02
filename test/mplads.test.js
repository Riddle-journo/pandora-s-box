// Phase 2D — the MPLADS extractor. A pure-function test pins the field-map, then
// an integration test drives a real-shaped `numbers` object through the framework
// into the ledger and confirms provenance + idempotency.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-mplads-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store/store.js");
const { ensureEntity } = await import("../server/entities/entities.js");
const { factsFor } = await import("../server/store/ledger.js");
const { mpladsFacts, runMpladsExtraction, MPLADS_VERSION } = await import("../server/extractors/mplads.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const NUMBERS = {
  allocated: 147000000, spent: 18326491, unspent: 128673509,
  utilization_pct: 12.467, works_recommended: 107, works_completed: 72, completion_pct: 40.223,
};

test("mpladsFacts: maps the six metrics with units, skips unspent, handles empty", () => {
  const facts = mpladsFacts(NUMBERS, { as_of_date: "2026-07-05" });
  const m = Object.fromEntries(facts.map((f) => [f.metric, f]));
  assert.equal(m.mplads_allocated.value, 147000000);
  assert.equal(m.mplads_allocated.unit, "inr");
  assert.equal(m.mplads_spent.value, 18326491);
  assert.equal(m.mplads_utilization_pct.value, 12.467);
  assert.equal(m.mplads_utilization_pct.unit, "pct");
  assert.equal(m.mplads_works_completed.value, 72);
  assert.equal(m.mplads_works_completed.unit, "count");
  assert.equal(m.mplads_utilization_pct.as_of_date, "2026-07-05");
  assert.ok(!("mplads_unspent" in m), "unspent is redundant (allocated - spent) and not emitted");
  assert.equal(mpladsFacts(null).length, 0);
  assert.equal(mpladsFacts({}).length, 0);
});

test("integration: mplads numbers flow through the framework into the ledger", () => {
  const eid = ensureEntity({ kind: "person", name: "MPLADS Rep", strongIds: { politician_id: "PM" }, source: "seed" });
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run("MPL1", "PM", null, "2026-07-05T08:42:33.723Z", 0, "t",
      JSON.stringify({ id: "MPL1", source_type: "mplads", tier: 2, date: "2026-07-05T08:42:33.723Z", numbers: NUMBERS }));

  const c = runMpladsExtraction();
  assert.ok(c.facts >= 6, "should write all six metrics");

  const [util] = factsFor(eid, "mplads_utilization_pct");
  assert.equal(util.value, 12.467);
  assert.equal(util.subject_kind, "person");
  assert.equal(util.source_type, "mplads");
  assert.equal(util.tier, 2);
  assert.equal(util.evidence_id, "MPL1");
  assert.equal(util.extractor_version, MPLADS_VERSION);
  assert.equal(util.as_of_date, "2026-07-05"); // snapshot date, truncated
});

test("integration: mplads extraction is idempotent", () => {
  const c = runMpladsExtraction();
  assert.equal(c.facts, 0);
});
