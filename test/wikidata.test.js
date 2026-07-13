// Phase 2H — the wikidata family-graph extractor + the framework's new
// relationships-emit path. A pure test pins the relative→edge mapping; an
// integration test proves the edge lands in the graph with the relative created
// as its own wikidata-keyed entity, and that it's idempotent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-wikidata-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const { db } = await import("../server/store.js");
const { ensureEntity, findEntityByStrongId } = await import("../server/entities.js");
const { relationsOf } = await import("../server/relations.js");
const { wikidataRelationships, runWikidataExtraction, WIKIDATA_VERSION } = await import("../server/extractors/wikidata.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const NUMBERS = {
  wikidata_id: "Q1",
  relatives: [
    { relation: "father", name: "Rajiv Gandhi", wikidata_id: "Q4593" },
    { relation: "mother", name: "Sonia Gandhi", wikidata_id: "Q163225" },
    { relation: "father", name: "Rajiv Gandhi", wikidata_id: "Q4593" }, // dup → collapses
  ],
};

test("wikidataRelationships: maps relatives to family_of edges, deduped", () => {
  const rels = wikidataRelationships(NUMBERS);
  assert.equal(rels.length, 2);
  assert.equal(rels[0].rel_type, "family_of");
  assert.equal(rels[0].dst_name, "Rajiv Gandhi");
  assert.equal(rels[0].dst_strong_ids.wikidata_id, "Q4593");
  assert.equal(rels[0].data.relation, "father");
  assert.equal(wikidataRelationships(null).length, 0);
  assert.equal(wikidataRelationships({ relatives: [] }).length, 0);
});

test("integration: family edges land in the graph with relatives as entities", () => {
  const eid = ensureEntity({ kind: "person", name: "Rahul Gandhi", strongIds: { politician_id: "PW" }, source: "seed" });
  db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run("WD1", "PW", null, null, 0, "t", JSON.stringify({ id: "WD1", source_type: "wikidata", tier: 6, numbers: NUMBERS }));

  const c = runWikidataExtraction();
  assert.equal(c.relationships, 2, "two distinct family edges");

  // The relatives were created as their own entities, keyed by wikidata_id.
  const father = findEntityByStrongId("person", { wikidata_id: "Q4593" });
  assert.ok(father, "father entity created");
  assert.equal(father.canonical_name, "Rajiv Gandhi");

  // The edges connect the politician to them.
  const edges = relationsOf(eid, { relType: "family_of" });
  assert.equal(edges.length, 2);
  const toFather = edges.find((e) => e.dst_entity_id === father.id);
  assert.equal(toFather.source, "wikidata");
  assert.equal(toFather.detector_version, WIKIDATA_VERSION);
  assert.equal(toFather.data.relation, "father");
});

test("integration: re-run is idempotent", () => {
  const c = runWikidataExtraction();
  assert.equal(c.relationships, 0);
});
