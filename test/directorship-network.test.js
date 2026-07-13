// Phase 6 (Plans C1 + C2) — the admin directorship-network data layer. Builds the
// company web for a politician (companies they hold + co-directors/relatives on those
// boards) and adapts it to the family-graph renderer's { relatives, links } contract.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-dnet-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }

const { ensureEntity, ensureCompanyEntity, resolveEntityIdForPolitician } = await import("../server/entities.js");
const { upsertRelationship, updateRelationship, relationsOf } = await import("../server/relations.js");
const { buildDirectorshipNetwork, directorshipNetworkForGraph } = await import("../server/directorship-network.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {} }
});

function person(name, politicianId) {
  return ensureEntity({ kind: "person", name, strongIds: politicianId ? { politician_id: politicianId } : {}, source: "seed" });
}
function edge(src, dst, rel, source, data = {}) {
  return upsertRelationship({ src_entity_id: src, dst_entity_id: dst, rel_type: rel, source, confidence: 0.8, data }).id;
}

test("network: companies held + co-director + relative on the same board", () => {
  const a = person("Arvind Netraj", "dn_a");
  const co = ensureCompanyEntity({ name: "Sunrise Ventures Private Limited", cin: "U74999DL2015PTC112233", source: "verify" });
  edge(a, co, "director_of", "press_releases");

  // Another politician on the same board (co-director), and a relative.
  const b = person("Bhavna Solanki", "dn_b");
  edge(b, co, "director_of", "tofler", { via: "self_name" });
  const rel = person("Devansh Netraj"); // a relative (no politician_id)
  edge(rel, co, "director_of", "tofler", { is_relative: true, relation: "son" });

  const net = buildDirectorshipNetwork("dn_a");
  assert.equal(net.center.name, "Arvind Netraj");
  assert.equal(net.companies.length, 1);
  assert.equal(net.companies[0].cin, "U74999DL2015PTC112233");
  assert.deepEqual(net.companies[0].roles, ["director"]);

  const names = net.codirectors.map((c) => c.name).sort();
  assert.deepEqual(names, ["Bhavna Solanki", "Devansh Netraj"]);
  const bhavna = net.codirectors.find((c) => c.name === "Bhavna Solanki");
  assert.equal(bhavna.politician_id, "dn_b");
  const devansh = net.codirectors.find((c) => c.name === "Devansh Netraj");
  assert.equal(devansh.is_relative, true);
});

test("adapter: shapes to { relatives, links } for the family-graph renderer", () => {
  const g = directorshipNetworkForGraph("dn_a");
  assert.equal(g.center, "Arvind Netraj");
  // company → a 'relatives'-style node with the role as its relation label.
  assert.ok(g.relatives.some((r) => /Sunrise Ventures/.test(r.name) && /director/.test(r.relation)));
  // co-director politician → a clickable 'links' entry.
  const bLink = g.links.find((l) => l.target_name === "Bhavna Solanki");
  assert.equal(bLink.target_kind, "politician");
  assert.equal(bLink.target_id, "dn_b");
  // relative → a DYNASTY-typed link.
  assert.ok(g.links.some((l) => l.target_name === "Devansh Netraj" && l.type === "DYNASTY"));
});

test("corroboration surfaces in the adapter label", () => {
  const eid = resolveEntityIdForPolitician("dn_a");
  const co = relationsOf(eid).find((e) => e.rel_type === "director_of");
  updateRelationship(co.id, { data: { corroborated: true } });
  const g = directorshipNetworkForGraph("dn_a");
  assert.ok(g.relatives.some((r) => /corroborated/.test(r.relation)), "corroborated company is marked ✓");
});

test("unknown politician → empty network, not a throw", () => {
  const net = buildDirectorshipNetwork("nope");
  assert.deepEqual(net, { center: null, companies: [], codirectors: [] });
});
