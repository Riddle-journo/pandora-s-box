// Phase 3 (Plan A2) — the corroboration ladder. Seeds an extraction edge (Phase 2)
// and a Tofler DIRECTOR_LINK lead for the same politician, then confirms the shared
// company is marked corroborated (top confidence + basis), while a company only one
// source knows is left untouched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-corrob-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { db } = await import("../server/store/store.js");
const { ensureEntity, ensureCompanyEntity, resolveEntityIdForPolitician } = await import("../server/entities/entities.js");
const { relationsOf } = await import("../server/entities/relations.js");
const { runDirectorshipExtraction } = await import("../server/extractors/directorships.js");
const {
  corroborateDirectorshipsForPolitician, CORROBORATED_CONFIDENCE,
} = await import("../server/extractors/directorship-corroborate.js");

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
const dirEdge = (eid, norm) => relationsOf(eid).find((e) => e.data?.company_norm === norm);

test("CIN match: extraction edge + Tofler lead on the same CIN → corroborated (top confidence, basis 'cin')", () => {
  const pid = "PC1";
  const eid = seedPolitician(pid, "Mahesh Chandra Sharma");
  seedEvidence("EVC_PR", pid, "press_releases",
    "Shri Mahesh Chandra Sharma, Managing Director of Aryan Buildcon Private Limited, was named.");
  runDirectorshipExtraction();
  // Attach a CIN to the company entity (as Phase-3 verify would).
  ensureCompanyEntity({ name: "Aryan Buildcon Private Limited", cin: "U45200MH2011PTC111111", source: "verify" });

  // A Tofler DIRECTOR_LINK lead for the same politician + same CIN.
  const lead = {
    vector: "DIRECTOR_LINK", actor_id: pid, beneficiary: "ARYAN BUILDCON PRIVATE LIMITED",
    beneficiary_cin: "U45200MH2011PTC111111", match_kind: "din", director_din: "01239876",
  };
  const r = corroborateDirectorshipsForPolitician({ id: pid, name: "Mahesh Chandra Sharma" }, { leads: [lead] });
  assert.equal(r.corroborated, 1);

  const edge = dirEdge(eid, "aryan buildcon pvt ltd");
  assert.ok(edge);
  assert.equal(edge.data.corroborated, true);
  assert.equal(edge.data.corroborated_by, "tofler");
  assert.equal(edge.data.corroboration_basis, "cin");
  assert.equal(edge.data.corroboration_match_kind, "din");
  assert.ok(edge.confidence >= CORROBORATED_CONFIDENCE, `conf ${edge.confidence}`);
});

test("name match: no CIN, but same normalized name → corroborated with basis 'name'", () => {
  const pid = "PC2";
  const eid = seedPolitician(pid, "Priya Menon");
  seedEvidence("EVC_PR2", pid, "press_releases",
    "Smt. Priya Menon, Director of Coastal Cement Limited, appeared.");
  runDirectorshipExtraction();
  const lead = { vector: "DIRECTOR_LINK", actor_id: pid, beneficiary: "COASTAL CEMENT LIMITED", match_kind: "self_name" };
  // Same company, different casing → normalizeCompany folds both to "coastal cement ltd".
  const r = corroborateDirectorshipsForPolitician({ id: pid, name: "Priya Menon" }, { leads: [lead] });
  assert.equal(r.corroborated, 1);
  const edge = dirEdge(eid, "coastal cement ltd");
  assert.equal(edge.data.corroboration_basis, "name");
});

test("single-source: an extraction edge with NO matching Tofler lead is left untouched", () => {
  const pid = "PC3";
  const eid = seedPolitician(pid, "Rajesh Bhandari");
  seedEvidence("EVC_PR3", pid, "press_releases",
    "Rajesh Bhandari, Promoter of Skyline Realtors Private Limited, controlled it.");
  runDirectorshipExtraction();
  const before = dirEdge(eid, "skyline realtors pvt ltd");
  const r = corroborateDirectorshipsForPolitician({ id: pid, name: "Rajesh Bhandari" }, { leads: [] });
  assert.equal(r.corroborated, 0);
  const after = dirEdge(eid, "skyline realtors pvt ltd");
  assert.equal(after.data.corroborated, undefined, "must not mark corroborated");
  assert.equal(after.confidence, before.confidence, "confidence unchanged");
});

test("idempotent: re-running corroboration doesn't double-count or lower confidence", () => {
  const pid = "PC1";
  const lead = {
    vector: "DIRECTOR_LINK", actor_id: pid, beneficiary: "ARYAN BUILDCON PRIVATE LIMITED",
    beneficiary_cin: "U45200MH2011PTC111111", match_kind: "din",
  };
  const r = corroborateDirectorshipsForPolitician({ id: pid, name: "Mahesh Chandra Sharma" }, { leads: [lead] });
  assert.equal(r.corroborated, 1, "still reports the match");
  const eid = resolveEntityIdForPolitician(pid);
  assert.ok(dirEdge(eid, "aryan buildcon pvt ltd").confidence >= CORROBORATED_CONFIDENCE);
});
