// Phase 2 (Plan A1) — DIN cross-feed. Two layers: (1) the pure extractor captures a
// labelled DIN adjacent to a directorship; (2) the runner folds a DIN onto the
// politician's person entity ONLY when the director is confidently the subject — the
// exact `strong_ids.din` the Tofler director-matcher (director-link.js) reads but
// nothing previously wrote.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractDirectorships } from "../server/directorship-extract.js";

test("core: captures a labelled DIN next to the director", () => {
  const rows = extractDirectorships("Shri Ramesh Kumar (DIN: 01234567), Managing Director of Alpha Build Private Limited.", { subjectName: "Ramesh Kumar" });
  const r = rows.find((x) => /alpha build/.test(x.company_norm));
  assert.ok(r);
  assert.equal(r.din, "01234567");
  assert.equal(r.person_is_subject, true);
});

test("core: a BARE 8-digit number (unlabelled) is NOT treated as a DIN", () => {
  const rows = extractDirectorships("Ramesh Kumar, Director of Alpha Build Private Limited, phone 98765432.", { subjectName: "Ramesh Kumar" });
  const r = rows.find((x) => /alpha build/.test(x.company_norm));
  assert.ok(r);
  assert.equal(r.din, null);
});

test("core: two different DINs in the window → refuse to guess (din null)", () => {
  const rows = extractDirectorships("Ramesh Kumar (DIN 01234567), Director of Alpha Build Private Limited, and co-director Sunil Rao (DIN 07654321).", { subjectName: "Ramesh Kumar" });
  const r = rows.find((x) => /alpha build/.test(x.company_norm));
  assert.ok(r);
  assert.equal(r.din, null, "two DINs in view → must not pick one");
});

// ── integration: the runner attaches the DIN onto the politician entity ──────────
process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-din-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { db } = await import("../server/store.js");
const { ensureEntity, getEntity } = await import("../server/entities.js");
const { runDirectorshipExtraction } = await import("../server/extractors/directorships.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }
});

function seedPolitician(id, name) {
  db.prepare("INSERT OR IGNORE INTO politicians (id, name, data) VALUES (?,?,?)").run(id, name, JSON.stringify({ id, name }));
  return ensureEntity({ kind: "person", name, strongIds: { politician_id: id }, source: "seed" });
}
function seedEvidence(evId, pid, sourceType, content) {
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run(evId, pid, null, null, 1, "t", JSON.stringify({ id: evId, source_type: sourceType, tier: 5, content }));
}

test("integration: a subject-attributed DIN lands on the politician entity as a strong id", () => {
  const eid = seedPolitician("PDIN", "Ramesh Kumar Agarwal");
  seedEvidence("EV_DIN", "PDIN", "press_releases",
    "The ED noted Shri Ramesh Kumar Agarwal (DIN: 01239876), Managing Director of Aryan Buildcon Private Limited, in the matter.");
  const c = runDirectorshipExtraction();
  assert.ok(c.dins >= 1, `expected a DIN attach, got ${c.dins}`);
  // The Tofler matcher reads exactly this: kind='person' AND strong_ids.din.
  assert.equal(getEntity(eid).strong_ids.din, "01239876");
  const viaQuery = db.prepare("SELECT id FROM entities WHERE kind='person' AND json_extract(strong_ids,'$.din') = ?").get("01239876");
  assert.equal(viaQuery.id, eid);
});

test("integration: a DIN next to a NON-subject director is NOT attached to the politician", () => {
  const eid = seedPolitician("PDIN2", "Priya Menon");
  // The DIN belongs to Rakesh Gupta (a third party), not the subject.
  seedEvidence("EV_DIN2", "PDIN2", "news",
    "Separately, Rakesh Gupta (DIN 05556666), Director of Unrelated Traders Private Limited, was questioned.");
  runDirectorshipExtraction();
  assert.equal(getEntity(eid).strong_ids.din, undefined, "third-party DIN must not attach to the politician");
});
