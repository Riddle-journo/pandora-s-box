// Phase 1 (Plan A3) — ensureCompanyEntity: the single canonical company resolver both
// the directorship-extraction path and the Tofler path use, so they converge on ONE
// company entity keyed by CIN instead of minting near-duplicates.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-coent-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { getEntity } = await import("../server/entities.js");
const { ensureCompanyEntity } = await import("../server/entities.js");
const { findEntityByAlias, findEntityByStrongId } = await import("../server/entities.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }
});

test("same CIN, different name spellings → ONE entity, all spellings aliased", () => {
  const a = ensureCompanyEntity({ name: "Sterling Finvest Private Limited", cin: "U51909WB1995PTC070449", source: "t" });
  const b = ensureCompanyEntity({ name: "STERLING FINVEST PRIVATE LIMITED", cin: "U51909WB1995PTC070449", source: "t" });
  const c = ensureCompanyEntity({ name: "Sterling Finvest Pvt Ltd", cin: "U51909WB1995PTC070449", source: "t" });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(getEntity(a).kind, "company");
});

test("CIN-first convergence: name-only entity, later given a CIN, is then found by CIN (the Tofler↔extraction bridge)", () => {
  // Extraction path: learns the company by NAME, no CIN yet.
  const byName = ensureCompanyEntity({ name: "Aryan Buildcon Private Limited", source: "directorship" });
  // Verify path: same name, now WITH a CIN → folds the CIN onto the same entity.
  const withCin = ensureCompanyEntity({ name: "Aryan Buildcon Private Limited", cin: "U45200MH2011PTC111111", source: "verify" });
  assert.equal(byName, withCin, "folding a CIN must not mint a new entity");
  // Tofler path: knows only the CIN (and a different spelling) → must resolve to the SAME entity.
  const byCin = ensureCompanyEntity({ name: "ARYAN BUILDCON PVT LTD", cin: "U45200MH2011PTC111111", source: "tofler" });
  assert.equal(byName, byCin, "a CIN-keyed lookup converges on the name-first entity");
  assert.equal(findEntityByStrongId("company", { cin: "U45200MH2011PTC111111" }).id, byName);
});

test("a foreign registration number (non-standard CIN) is still accepted as an identity", () => {
  const a = ensureCompanyEntity({ name: "Vedanta Resources Limited", cin: "F06579", source: "t" });
  const b = ensureCompanyEntity({ name: "VEDANTA RESOURCES LTD", cin: "F06579", source: "t" });
  assert.equal(a, b);
});

test("junk/empty CIN does NOT merge unrelated companies", () => {
  const a = ensureCompanyEntity({ name: "Alpha Traders Private Limited", cin: "", source: "t" });
  const b = ensureCompanyEntity({ name: "Beta Cement Limited", cin: "NA", source: "t" });
  assert.notEqual(a, b, "empty/'NA' CIN must not be used as a shared strong id");
});

test("without a CIN, differing names stay separate; identical-normalized names merge", () => {
  const a = ensureCompanyEntity({ name: "Gamma Mining Private Limited", source: "t" });
  const aAgain = ensureCompanyEntity({ name: "Gamma Mining Pvt Ltd", source: "t" }); // normalizes equal
  assert.equal(a, aAgain, "Pvt Ltd / Private Limited normalize to the same alias");
  const other = ensureCompanyEntity({ name: "Delta Realtors Limited", source: "t" });
  assert.notEqual(a, other);
});
