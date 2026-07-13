// Phase 5 (Plans B2 + B3) — the crossfeed network effect. Extraction links politician A
// to company X (from text) → crossfeed pulls X's full board via a fake Tofler fetch →
// the matcher discovers politician B (co-director, never named with X in any text) AND
// a relative of politician C (dynasty directorship) on that same board, writing edges.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-crossfeed-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const store = await import("../server/store.js");
const { ensureEntity, ensureCompanyEntity, resolveEntityIdForPolitician } = await import("../server/entities.js");
const { relationsOf, upsertRelationship } = await import("../server/relations.js");
const { runDirectorshipExtraction } = await import("../server/extractors/directorships.js");
const { seedCompaniesForCrossfeed, runDirectorshipCrossfeed } = await import("../server/extractors/directorship-crossfeed.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }
});

const CIN = "U74999DL2015PTC900900";

function seedPolitician(id, name) {
  store.upsertPolitician({ id, name });
  return ensureEntity({ kind: "person", name, strongIds: { politician_id: id }, source: "seed" });
}
function seedEvidence(evId, pid, sourceType, content) {
  store.db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
    .run(evId, pid, null, null, 1, "t", JSON.stringify({ id: evId, source_type: sourceType, tier: 5, content }));
}
const dirEdge = (eid, norm) => relationsOf(eid).filter((e) => e.rel_type === "director_of").find((e) => {
  const other = e.src_entity_id === eid ? e.dst_entity_id : e.src_entity_id;
  const ent = store.db.prepare("SELECT canonical_name FROM entities WHERE id=?").get(other);
  return new RegExp(norm, "i").test(ent?.canonical_name ?? "");
});

test("crossfeed: extraction seed → full board → co-director + relative discovered", async () => {
  // A: linked to Sunrise Ventures by an ED press release (extraction).
  const aEid = seedPolitician("cf_a", "Arvind Kejpunwal");
  seedEvidence("CF_PR", "cf_a", "press_releases",
    "Shri Arvind Kejpunwal, Director of Sunrise Ventures Private Limited, was named by the ED.");
  runDirectorshipExtraction();
  // Verify-style CIN attach so the company becomes a crossfeed seed.
  ensureCompanyEntity({ name: "Sunrise Ventures Private Limited", cin: CIN, source: "verify" });

  // B: another politician, NOT linked to Sunrise anywhere in text.
  seedPolitician("cf_b", "Bhagwant Manndeep");
  // C + relative via family_of (dynasty directorship target).
  const cSelf = ensureEntity({ kind: "person", name: "Chandni Rathore", strongIds: { politician_id: "cf_c" } });
  store.upsertPolitician({ id: "cf_c", name: "Chandni Rathore" });
  const relative = ensureEntity({ kind: "person", name: "Devansh Rathore" });
  upsertRelationship({ src_entity_id: cSelf, dst_entity_id: relative, rel_type: "family_of", source: "test", data: { relation: "son" } });

  // The seed list must contain Sunrise (CIN-bearing, extraction edge, not yet cached).
  const seeds = seedCompaniesForCrossfeed();
  assert.ok(seeds.some((s) => s.cin === CIN), "Sunrise is a crossfeed seed");

  // Fake Tofler board for that CIN: A (self), B (co-director), Devansh Rathore (C's son).
  const fakeFetch = async ({ cin }) => cin !== CIN ? null : ({
    name: "SUNRISE VENTURES PRIVATE LIMITED", cin: CIN,
    source_url: `https://www.tofler.in/sunrise/company/${CIN}/directors`,
    directors: [
      { name: "Arvind Kejpunwal", din: "01111111" },
      { name: "Bhagwant Manndeep", din: "02222222" },
      { name: "Devansh Rathore", din: "03333333" },
    ],
  });

  const r = await runDirectorshipCrossfeed({ fetchBoard: fakeFetch });
  assert.equal(r.cached, 1, "one board cached");
  assert.ok(r.edges >= 2, `expected new co-director/relative edges, got ${r.edges}`);

  // B2: politician B — never named with Sunrise in text — now has a director_of edge to it.
  const bEdge = dirEdge(resolveEntityIdForPolitician("cf_b"), "sunrise ventures");
  assert.ok(bEdge, "co-director B discovered via the board");
  assert.equal(bEdge.source, "tofler");

  // B3: the RELATIVE (C's son) has a director_of edge (dynasty directorship).
  const relEdge = dirEdge(relative, "sunrise ventures");
  assert.ok(relEdge, "relative director discovered via the board");
  assert.equal(relEdge.data.is_relative, true);
});

test("crossfeed: a company already cached is not re-seeded", () => {
  const seeds = seedCompaniesForCrossfeed();
  assert.ok(!seeds.some((s) => s.cin === CIN), "Sunrise no longer a seed once its board is cached");
});
