// Phase 2B — the extraction framework. A fake extractor drives the full pipeline
// so the framework is tested independently of any real source parser (that's 2C):
// subject resolution, provenance stamping, the universal-subject override (a fact
// attributed to a company, not the evidence's politician), idempotency, unknown-
// source skipping, the batch runner, and the reprocessing lever.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-extract-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store.js");
const { ensureEntity } = await import("../server/entities.js");
const { factsFor, claimsFor, deleteByExtractorVersion } = await import("../server/ledger.js");
const { eventsFor } = await import("../server/relations.js");
const {
  registerExtractor, extractFromEvidence, runExtraction, listExtractors, _clearRegistry,
} = await import("../server/extract.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// One politician-entity (the default subject) and one company-entity (an override
// target), plus the fake extractors under test.
const POL_ENTITY = ensureEntity({ kind: "person", name: "Test MP", strongIds: { politician_id: "PX" }, source: "seed" });
const CO_ENTITY = ensureEntity({ kind: "company", name: "Acme Infra", strongIds: { cin: "CIN1" }, source: "seed" });

_clearRegistry();
registerExtractor("test_src", {
  version: "test-v1",
  extract: () => ({
    facts: [
      { metric: "declared_assets", value: 42, unit: "inr", as_of_date: "2024" },
      // universal-subject override: a fact about the COMPANY, not the politician.
      { metric: "contract_value", value: 900000, unit: "inr", as_of_date: "2024",
        entity_id: CO_ENTITY, subject_kind: "company" },
    ],
    claims: [{ claim_type: "flagged", object_text: "coal scam", confidence: 0.5 }],
    events: [{ kind: "filed", at: "2024-01-01" }],
  }),
});

const evidence = { id: "EVID1", politician_id: "PX", source_type: "test_src", tier: 1, data: { source_type: "test_src", tier: 1 } };

test("registry: the extractor is registered", () => {
  assert.ok(listExtractors().includes("test_src"));
});

test("extractFromEvidence: writes facts/claims/events with resolved subject + stamped provenance", () => {
  const out = extractFromEvidence(evidence);
  assert.deepEqual(out, { facts: 2, claims: 1, events: 1, relationships: 0, skipped: 0 });

  // The politician fact resolved to the person entity and was fully stamped.
  const [assets] = factsFor(POL_ENTITY, "declared_assets");
  assert.equal(assets.value, 42);
  assert.equal(assets.subject_kind, "person");
  assert.equal(assets.source_type, "test_src");
  assert.equal(assets.tier, 1);
  assert.equal(assets.evidence_id, "EVID1");
  assert.equal(assets.extractor_version, "test-v1");

  // The claim landed on the same subject with default status.
  const [claim] = claimsFor(POL_ENTITY, "flagged");
  assert.equal(claim.object_text, "coal scam");
  assert.equal(claim.status, "unverified");
  assert.equal(claim.evidence_id, "EVID1");

  // The event landed with the source as provenance and version inside data.
  const [ev] = eventsFor(POL_ENTITY, { kind: "filed" });
  assert.equal(ev.source, "test_src");
  assert.equal(ev.data.extractor_version, "test-v1");
});

test("universal subject: an override attributes a fact to the company, not the politician", () => {
  const [co] = factsFor(CO_ENTITY, "contract_value");
  assert.equal(co.value, 900000);
  assert.equal(co.subject_kind, "company");
  // And it did NOT leak onto the politician.
  assert.equal(factsFor(POL_ENTITY, "contract_value").length, 0);
});

test("idempotency: re-running the same evidence inserts nothing new", () => {
  const out = extractFromEvidence(evidence);
  assert.deepEqual(out, { facts: 0, claims: 0, events: 0, relationships: 0, skipped: 0 });
  assert.equal(factsFor(POL_ENTITY, "declared_assets").length, 1, "no duplicate fact");
});

test("unknown source_type is skipped, writes nothing", () => {
  const out = extractFromEvidence({ id: "EVID9", politician_id: "PX", source_type: "no_such_src", data: {} });
  assert.equal(out.skipped, 1);
  assert.equal(out.facts, 0);
});

test("runExtraction: batch runner picks rows up by source_type from the evidence table", () => {
  // Insert a second real evidence row and let the batch runner discover it.
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run("EVID2", "PX", null, "2024-02-02", 0, "t", JSON.stringify({ id: "EVID2", source_type: "test_src", tier: 1 }));

  const total = runExtraction({ sourceType: "test_src" });
  assert.ok(total.evidence >= 1, "should have scanned the inserted row");
  assert.ok(total.facts >= 2, "should have written EVID2's two facts");
  // EVID2's assets fact is a distinct row (different evidence_id) from EVID1's.
  assert.equal(factsFor(POL_ENTITY, "declared_assets").length, 2);
});

test("reprocessing: deleteByExtractorVersion clears this version's ledger rows", () => {
  const before = factsFor(POL_ENTITY, "declared_assets").length;
  assert.ok(before > 0);
  const del = deleteByExtractorVersion("test-v1");
  assert.ok(del.facts >= before);
  assert.equal(factsFor(POL_ENTITY, "declared_assets").length, 0, "facts for the version are gone");
  assert.equal(claimsFor(POL_ENTITY, "flagged").length, 0, "claims for the version are gone");
});
