// Entity layer: normName, ensureEntity dedup, assertion idempotency + auto-accept,
// gray-zone proposed, and the decideAssertion accept path. Temp DB, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-entities-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;

const store = await import("../server/store.js");
const ent = await import("../server/entities.js");
const {
  normName, ensureEntity, recordAssertion, listProposed, decideAssertion,
  findEntityByStrongId, findEntityByAlias,
} = ent;

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("normName: honorifics, dots, case, and Pvt/Private + Ltd/Limited equivalence", () => {
  assert.equal(normName("Dr. Manmohan Singh"), "MANMOHAN SINGH");
  assert.equal(normName("Shri Narendra  Modi"), "NARENDRA MODI");
  assert.equal(normName("narendra modi"), "NARENDRA MODI");
  // company-suffix equivalence
  assert.equal(normName("Acme Infra Pvt Ltd"), normName("Acme Infra Private Limited"));
  assert.equal(normName("Acme Infra Pvt. Ltd."), "ACME INFRA PVT LTD");
  // empty / junk
  assert.equal(normName("  ...  "), "");
});

test("ensureEntity dedups by strong id, then by exact alias", () => {
  const a = ensureEntity({ kind: "person", name: "Ramesh Kumar", strongIds: { din: "D100" }, source: "t" });
  // same strong id, different surface name → same entity
  const b = ensureEntity({ kind: "person", name: "R. Kumar", strongIds: { din: "D100" }, source: "t" });
  assert.equal(a, b, "matched by strong id");
  // no strong id, but exact alias of the canonical name → same entity
  const c = ensureEntity({ kind: "person", name: "ramesh kumar", strongIds: {}, source: "t" });
  assert.equal(a, c, "matched by exact alias");
  // a genuinely different person → new entity
  const d = ensureEntity({ kind: "person", name: "Sunita Rao", strongIds: {}, source: "t" });
  assert.notEqual(a, d);

  assert.equal(findEntityByStrongId("person", { din: "D100" }).id, a);
  assert.equal(findEntityByAlias("person", "Ramesh Kumar").id, a);
});

test("recordAssertion auto-accepts strong_id and resolves the entity", () => {
  const r = recordAssertion({
    subject_kind: "person", raw_name: "Anil Verma", source: "sansad_mp",
    source_ref: "MP555", politician_id: "pol_1", confidence: 0.95, method: "strong_id",
  });
  assert.equal(r.inserted, true);
  assert.equal(r.status, "accepted");
  assert.ok(r.entity_id, "strong_id assertion resolved an entity");
  // the strong id (mpsno) is now on the entity
  assert.equal(findEntityByStrongId("person", { mpsno: "MP555" }).id, r.entity_id);
});

test("recordAssertion is idempotent (same insert twice → one row)", () => {
  const payload = {
    subject_kind: "person", raw_name: "Dup Name", source: "mca_directors",
    source_ref: "DIN9", politician_id: "pol_2", confidence: 0.8, method: "strong_id",
  };
  const first = recordAssertion(payload);
  const second = recordAssertion(payload);
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false, "duplicate is ignored");
  assert.equal(second.id, first.id, "returns the existing assertion id");
});

test("gray-zone token_score stays proposed with no entity", () => {
  const r = recordAssertion({
    subject_kind: "person", raw_name: "Maybe Person", source: "mca_directors",
    source_ref: "DIN_GRAY", politician_id: "pol_3", confidence: 0.52, method: "token_score",
  });
  assert.equal(r.status, "proposed");
  assert.equal(r.entity_id, null);

  const proposed = listProposed({ source: "mca_directors" });
  assert.ok(proposed.some((a) => a.raw_name === "Maybe Person"), "shows up in the review queue");
});

test("decideAssertion accept creates the entity + alias and stamps the assertion", () => {
  const r = recordAssertion({
    subject_kind: "person", raw_name: "Gray Zone Gita", source: "mca_directors",
    source_ref: "DIN_G2", politician_id: "pol_4", confidence: 0.5, method: "token_score",
  });
  assert.equal(r.status, "proposed");

  const decided = decideAssertion(r.id, "accepted");
  assert.equal(decided.status, "accepted");
  assert.ok(decided.entity_id, "accepting resolved/created an entity");
  // the raw_name is now an alias pointing at that entity
  assert.equal(findEntityByAlias("person", "Gray Zone Gita").id, decided.entity_id);
  // and it's no longer in the proposed queue
  assert.ok(!listProposed({}).some((a) => a.id === r.id));
});
