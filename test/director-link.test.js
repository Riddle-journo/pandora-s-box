// Phase-2 director→politician matching: a director of a flagged (cached) company
// becomes a DIRECTOR_LINK lead when it resolves to the member (self), a relative
// (family_of edge), or an exact DIN — and ambiguous / unrelated names are dropped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-dirlink-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}


const store = await import("../server/store.js");
const { ensureEntity, getEntity, resolveEntityIdForPolitician } = await import("../server/entities.js");
const { upsertRelationship, relationsOf } = await import("../server/relations.js");
const { matchDirectorsToPoliticians, buildDirectorMatchIndex, matchDirector } = await import("../server/director-link.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const CIN = "U74999DL2015PTC276819";

// A relative linked via a persisted family_of edge.
function seedRelative(politicianId, politicianName, relativeName, relation) {
  const src = ensureEntity({ kind: "person", name: politicianName, strongIds: { politician_id: politicianId } });
  const dst = ensureEntity({ kind: "person", name: relativeName });
  upsertRelationship({ src_entity_id: src, dst_entity_id: dst, rel_type: "family_of", source: "test", data: { relation } });
}

test("self, relative, and DIN all match; unrelated & ambiguous are dropped", () => {
  // Roster
  store.upsertPolitician({ id: "p_self", name: "Priyanka Vadra" });
  store.upsertPolitician({ id: "p_rel", name: "Rahul Testgandhi" });
  store.upsertPolitician({ id: "p_din", name: "Din Person" });
  store.upsertPolitician({ id: "p_amb1", name: "Zeta Xifander" });
  store.upsertPolitician({ id: "p_amb2", name: "Zeta Xifander" }); // same name, different rep

  // Relative of p_rel
  seedRelative("p_rel", "Rahul Testgandhi", "Sonia Testmaino", "mother");
  // DIN identity for p_din (name deliberately different from the director's name)
  ensureEntity({ kind: "person", name: "Din Person", strongIds: { politician_id: "p_din", din: "00777888" } });

  // A flagged company (only flagged companies are ever cached) with directors.
  store.upsertToflerCompany({
    company_key: CIN, cin: CIN, name: "Suspect Infra Pvt Ltd",
    source_url: `https://www.tofler.in/suspect-infra/company/${CIN}/directors`,
    directors: [
      { name: "Priyanka Vadra", din: "00100200" },      // self
      { name: "Sonia Testmaino", din: "00300400" },     // relative
      { name: "Someone Else Entirely", din: "00777888" }, // DIN → p_din despite name
      { name: "Zeta Xifander", din: "00500600" },        // ambiguous → 2 reps → skip
      { name: "Totally Unrelated Person", din: "00900900" }, // no match
    ],
  });

  const r = matchDirectorsToPoliticians();
  assert.equal(r.directors, 5);
  assert.equal(r.edges, 3, "Plan B1: self + relative + din matches each also write a director_of edge");

  const byPol = Object.fromEntries(r.emitted.map((l) => [l.actor_id, l]));
  // self
  assert.ok(byPol.p_self, "self director matched");
  assert.equal(byPol.p_self.match_kind, "self_name");
  assert.equal(byPol.p_self.beneficiary_cin, CIN);
  // relative
  assert.ok(byPol.p_rel, "relative director matched");
  assert.equal(byPol.p_rel.match_kind, "relative_name");
  // DIN (name mismatch, DIN carries it)
  assert.ok(byPol.p_din, "DIN director matched despite name mismatch");
  assert.equal(byPol.p_din.match_kind, "din");
  // ambiguous + unrelated produced nothing
  assert.ok(!byPol.p_amb1 && !byPol.p_amb2, "ambiguous name dropped");
  assert.equal(r.leads, 3, "exactly 3 leads (self, relative, din)");

  // Leads are queryable as detected investigation_leads.
  const detected = store.listLeads({ status: "detected" }).filter((l) => l.vector === "DIRECTOR_LINK");
  assert.equal(detected.length, 3);
});

test("Plan B1: matches also become director_of graph edges on the right entities", () => {
  // Reads the edges written by the previous test's matchDirectorsToPoliticians run.
  const selfEdges = relationsOf(resolveEntityIdForPolitician("p_self")).filter((e) => e.rel_type === "director_of" && e.source === "tofler");
  assert.equal(selfEdges.length, 1, "self match → one director_of edge on the politician");
  assert.equal(selfEdges[0].data.via, "self_name");
  assert.ok(selfEdges[0].confidence >= 0.85, `self conf ${selfEdges[0].confidence}`);
  // Company endpoint carries the CIN — converges with the extraction path via ensureCompanyEntity.
  assert.equal(getEntity(selfEdges[0].dst_entity_id).strong_ids.cin, CIN);

  // DIN match → top confidence.
  const dinEdges = relationsOf(resolveEntityIdForPolitician("p_din")).filter((e) => e.rel_type === "director_of" && e.source === "tofler");
  assert.equal(dinEdges.length, 1);
  assert.ok(dinEdges[0].confidence >= 0.95, "DIN match is top confidence");

  // Relative match → the edge sits on the RELATIVE entity (they hold the seat), is_relative true.
  const rel = store.db.prepare("SELECT id FROM entities WHERE kind='person' AND name_lc = ?").get("sonia testmaino");
  const relEdges = relationsOf(rel.id).filter((e) => e.rel_type === "director_of" && e.source === "tofler");
  assert.equal(relEdges.length, 1);
  assert.equal(relEdges[0].data.is_relative, true);
});

test("matchDirector returns null for a name made only of common tokens", () => {
  store.upsertPolitician({ id: "p_common", name: "Sunil Kumar" });
  const index = buildDirectorMatchIndex();
  // Another "Sunil Kumar" director — 1 distinctive token, coin-flip identity → no match.
  assert.equal(matchDirector({ name: "Sunil Kumar", din: "00011122" }, index), null);
});
