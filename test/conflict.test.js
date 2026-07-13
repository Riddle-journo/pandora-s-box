// Conflict detector golden test: an office/family sector overlap must emit a
// REGULATORY_SELF_DEALING lead stamped with the detector version; a rep whose
// interests sit in an unrelated sector must emit none. Pure/code-only — no DB,
// no network, no LLM. (conflict.js imports the store transitively via graph.js,
// so we point the DB at a throwaway file before importing.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-conflict-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "conflict.json"), "utf8"));
const { detectConflicts, DETECTOR_VERSION } = await import("../server/conflict.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

test("detectConflicts emits a REGULATORY_SELF_DEALING lead on office/family sector overlap", () => {
  const { politician, evidence } = FX.overlap;
  const { leads } = detectConflicts(politician, evidence, [], []);
  const lead = leads.find((l) => l.vector === "REGULATORY_SELF_DEALING");
  assert.ok(lead, "a REGULATORY_SELF_DEALING lead is emitted");
  assert.equal(lead.actor_id, politician.id);
  assert.ok(lead.signal_score > 0, "lead carries a positive signal score");
  // The lead must be stamped with the detector version (Task 5).
  assert.equal(lead.detector_version, DETECTOR_VERSION);
  assert.equal(DETECTOR_VERSION, "conflict-v1");
});

test("detectConflicts emits no REGULATORY_SELF_DEALING lead when interests are in an unrelated sector", () => {
  const { politician, evidence } = FX.clean;
  const { leads } = detectConflicts(politician, evidence, [], []);
  assert.equal(
    leads.filter((l) => l.vector === "REGULATORY_SELF_DEALING").length, 0,
    "no self-dealing lead without a sector overlap",
  );
});
