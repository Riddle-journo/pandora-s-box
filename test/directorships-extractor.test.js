// Phase 2 — the directorship extractor: drives real-shaped evidence content through
// runDirectorshipExtraction() and confirms company entities + politician→company
// relationship edges land with the right rel_type, confidence, provenance, subject
// attribution, and idempotency — and that non-attributable leads are NOT linked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-dirship-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store.js");
const { ensureEntity, resolveEntityIdForPolitician } = await import("../server/entities.js");
const { relationsOf } = await import("../server/relations.js");
const {
  roleToRelType, subjectDirectorships, runDirectorshipExtraction, DIRECTORSHIP_VERSION,
} = await import("../server/extractors/directorships.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// Seed a politician row + its person entity, and one evidence row per source.
function seedPolitician(id, name) {
  db.prepare("INSERT OR IGNORE INTO politicians (id, name, data) VALUES (?,?,?)")
    .run(id, name, JSON.stringify({ id, name }));
  return ensureEntity({ kind: "person", name, strongIds: { politician_id: id }, source: "seed" });
}
function seedEvidence(evId, politicianId, sourceType, content) {
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run(evId, politicianId, null, null, 1, "t", JSON.stringify({ id: evId, source_type: sourceType, tier: 5, content }));
}

test("roleToRelType maps roles to distinct canonical edge types", () => {
  assert.equal(roleToRelType("Managing Director"), "director_of");
  assert.equal(roleToRelType("Beneficial Owner"), "beneficial_owner_of");
  assert.equal(roleToRelType("Promoter"), "promoter_of");
  assert.equal(roleToRelType("Designated Partner"), "partner_of");
  assert.equal(roleToRelType("Proprietor"), "proprietor_of");
});

test("subjectDirectorships keeps only subject-attributable triples above the floor", () => {
  const content = "Shri Test Rep, Director of Alpha Build Private Limited, and unrelated Sunil Rao, Director of Beta Cement Limited.";
  const kept = subjectDirectorships(content, { subjectName: "Test Rep" });
  assert.ok(kept.some((t) => /Alpha Build/.test(t.company)), "subject's own company kept");
  assert.ok(!kept.some((t) => /Beta Cement/.test(t.company)), "unrelated third-party directorship dropped");
});

test("integration: attributable directorships become company entities + edges", () => {
  const pid = "PD1";
  const eid = seedPolitician(pid, "Mahesh Chandra Sharma");
  seedEvidence("EV_ICIJ", pid, "icij_leaks",
    "Connections: Beneficial Owner of MAHESH OFFSHORE HOLDINGS LIMITED registered in Panama.");
  seedEvidence("EV_PR", pid, "press_releases",
    "The ED stated that Shri Mahesh Chandra Sharma, Managing Director of Aryan Buildcon Private Limited, laundered proceeds.");

  const c = runDirectorshipExtraction();
  assert.ok(c.edges >= 2, `expected >=2 edges, got ${c.edges}`);

  const edges = relationsOf(eid);
  const aryan = edges.find((e) => /aryan buildcon/.test(e.data.company_norm));
  assert.ok(aryan, "Aryan Buildcon edge exists");
  assert.equal(aryan.rel_type, "director_of");
  assert.equal(aryan.src_entity_id, eid);
  assert.equal(aryan.source, "press_releases");
  assert.equal(aryan.detector_version, DIRECTORSHIP_VERSION);
  assert.ok(aryan.confidence >= 0.8, `conf ${aryan.confidence}`);
  assert.equal(aryan.data.person_is_subject, true);

  const offshore = edges.find((e) => /mahesh offshore/.test(e.data.company_norm));
  assert.ok(offshore, "ICIJ beneficial-owner edge exists");
  assert.equal(offshore.rel_type, "beneficial_owner_of");
  assert.equal(offshore.source, "icij_leaks");

  // The company endpoint really is a distinct company entity (not the person).
  const companyId = aryan.src_entity_id === eid ? aryan.dst_entity_id : aryan.src_entity_id;
  assert.notEqual(companyId, eid);
});

test("integration: re-run is idempotent (no duplicate edges)", () => {
  const c = runDirectorshipExtraction();
  assert.equal(c.edges, 0, "second run inserts no new edges");
});

test("integration: a purely third-party evidence blob creates no edge for the subject", () => {
  const pid = "PD2";
  const eid = seedPolitician(pid, "Priya Menon");
  // Names a director, but not the subject and subject not in-window → no link.
  seedEvidence("EV_NEWS", pid, "news",
    "In separate news, Rakesh Gupta, Director of Unrelated Traders Private Limited, was questioned.");
  runDirectorshipExtraction();
  const edges = relationsOf(eid);
  assert.equal(edges.length, 0, JSON.stringify(edges));
});
