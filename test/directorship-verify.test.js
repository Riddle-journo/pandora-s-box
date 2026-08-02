// Phase 3 — directorship verification + surfacing. Drives the FULL chain with a
// fake MCA lookup (no network): seed evidence → Phase 2 builds company edges →
// Phase 3 registry-checks them → an mca_company evidence row is emitted → the REAL
// analyzer harvests it and fires STRUCK_OFF_COMPANY_LINK. Proves the discovered-
// company path converges on the same surface as the affidavit-declared path.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-dirverify-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db, listEvidence } = await import("../server/store/store.js");
const { ensureEntity } = await import("../server/entities/entities.js");
const { gatherNumbers, computeFlags } = await import("../server/detectors/analyzer.js");
const { runDirectorshipExtraction } = await import("../server/extractors/directorships.js");
const {
  verifyDirectorshipCompanies, runDirectorshipVerification,
} = await import("../server/extractors/directorship-verify.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

function seedPolitician(id, name) {
  db.prepare("INSERT OR IGNORE INTO politicians (id, name, data) VALUES (?,?,?)")
    .run(id, name, JSON.stringify({ id, name }));
  return ensureEntity({ kind: "person", name, strongIds: { politician_id: id }, source: "seed" });
}
function seedEvidence(evId, politicianId, sourceType, content) {
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run(evId, politicianId, null, null, 1, "t", JSON.stringify({ id: evId, source_type: sourceType, tier: 5, content }));
}

// A fake MCA registry: one active company, one struck-off, others unknown.
const FAKE_REGISTRY = {
  "ARYAN BUILDCON PVT LTD": { name: "ARYAN BUILDCON PRIVATE LIMITED", cin: "U45200MH2011PTC111111", status: "Active", paidup_capital: 5000000, source_url: "https://mca/verify" },
  "SHELL VANISH PVT LTD": { name: "SHELL VANISH PRIVATE LIMITED", cin: "U74999DL2013PTC222222", status: "Strike Off", paidup_capital: 100000, source_url: "https://mca/verify" },
};
// Mirrors company-registry.registryName() folding (Private→PVT, Limited→LTD).
function fakeVerify(name) {
  const key = String(name).toUpperCase()
    .replace(/\bPRIVATE\b/g, "PVT").replace(/\bLIMITED\b/g, "LTD")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return Promise.resolve(FAKE_REGISTRY[key] ?? null);
}

test("verify: confirmed companies emit an mca_company row; struck-off flagged via the real analyzer", async () => {
  const pid = "PV1";
  seedPolitician(pid, "Mahesh Chandra Sharma");
  seedEvidence("EVV_PR", pid, "press_releases",
    "The ED stated that Shri Mahesh Chandra Sharma, Managing Director of Aryan Buildcon Private Limited, and its associate Shell Vanish Private Limited, of which Mahesh Chandra Sharma is Promoter, were used to route funds.");

  // Phase 2: build the directorship edges.
  const ext = runDirectorshipExtraction();
  assert.ok(ext.edges >= 2, `phase2 edges ${ext.edges}`);

  // Phase 3: verify against the fake MCA registry.
  const r = await verifyDirectorshipCompanies({ id: pid, name: "Mahesh Chandra Sharma" }, { verify: fakeVerify });
  assert.equal(r.verified, 2, "both companies confirmed");
  assert.equal(r.struck, 1, "one struck-off");

  // An mca_company evidence row now exists, tagged as discovered.
  const ev = listEvidence(pid).find((e) => e.id === `dirverify:${pid}`);
  assert.ok(ev, "dirverify evidence row emitted");
  assert.equal(ev.source_type, "mca_company");
  assert.equal(ev.numbers.companies.length, 2);
  assert.ok(ev.numbers.companies.every((c) => c.discovered_via === "directorship_extraction"));

  // The REAL analyzer harvests it and fires the struck-off flag.
  const { companies } = gatherNumbers(listEvidence(pid));
  assert.ok(companies.some((c) => /shell vanish/i.test(c.name) && /strike off/i.test(c.status)));
  const { flags } = computeFlags(listEvidence(pid));
  const struckFlag = flags.find((f) => f.code === "STRUCK_OFF_COMPANY_LINK");
  assert.ok(struckFlag, "STRUCK_OFF_COMPANY_LINK fired from a directorship-discovered company");
});

test("verify: re-run is idempotent (evidence row stable, no duplicate companies)", async () => {
  const pid = "PV1";
  await verifyDirectorshipCompanies({ id: pid, name: "Mahesh Chandra Sharma" }, { verify: fakeVerify });
  const rows = listEvidence(pid).filter((e) => e.id === `dirverify:${pid}`);
  assert.equal(rows.length, 1, "still exactly one dirverify row");
  assert.equal(rows[0].numbers.companies.length, 2, "still two companies, not duplicated");
});

test("verify: a company not in the registry is skipped (no false confirmation)", async () => {
  const pid = "PV2";
  seedPolitician(pid, "Priya Menon");
  seedEvidence("EVV_PR2", pid, "press_releases",
    "Smt. Priya Menon, Director of Ghost Unknown Private Limited, was named.");
  runDirectorshipExtraction();
  const r = await verifyDirectorshipCompanies({ id: pid, name: "Priya Menon" }, { verify: fakeVerify });
  assert.equal(r.verified, 0, "unregistered company not confirmed");
  assert.ok(!listEvidence(pid).some((e) => e.id === `dirverify:${pid}`), "no evidence row when nothing confirmed");
});

test("runDirectorshipVerification batches across the roster", async () => {
  const total = await runDirectorshipVerification({ verify: fakeVerify });
  assert.ok(total.politicians >= 2);
  assert.ok(total.verified >= 2);
});
