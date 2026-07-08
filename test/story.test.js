// Story engine: deterministic incident assembly, registry numbering/cap, the
// [n]-resolution validator, and the status-flow guard. Runs against a throwaway
// SQLite DB — never the real data/pandoros.db, never an LLM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-story-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
const store = await import("../server/store.js");
const {
  assembleIncidents, incidentRegistry, validateAndRepairStory, canTransition,
} = await import("../server/story-generator.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(DB_PATH + suffix); } catch {} }
});

test("assembleIncidents groups eligible leads by actor and excludes non-eligible", () => {
  const leads = [
    { id: "l1", status: "proposed",  vector: "DONOR_REWARD",  actor_id: "a1", actor_name: "Alpha", beneficiary: "AcmeCo", evidence_urls: ["u1"] },
    { id: "l2", status: "published", vector: "SHELL_LINK",    actor_id: "a1", actor_name: "Alpha", beneficiary: "ShellX", evidence_urls: ["u2"] },
    { id: "l3", status: "detected",  vector: "DONOR_REWARD",  actor_id: "a1", actor_name: "Alpha", beneficiary: "AcmeCo", evidence_urls: ["u3"] },
    { id: "l4", status: "proposed",  vector: "DONOR_REWARD",  actor_id: "a2", actor_name: "Beta",  beneficiary: "AcmeCo", evidence_urls: ["u4"] },
  ];
  const incidents = assembleIncidents({ leads, scandals: [] });
  assert.equal(incidents.length, 2, "two actors → two incidents");
  const alpha = incidents.find((i) => i.actor_id === "a1");
  assert.equal(alpha.leads.length, 2, "detected lead is excluded; only proposed+published grouped");
  assert.ok(alpha.slug, "incident carries a slug");
});

test("assembleIncidents groups NETWORK_HUB meta-leads by beneficiary, not actor", () => {
  const leads = [
    { id: "h1", status: "proposed", vector: "NETWORK_HUB", actor_id: null, beneficiary: "HubCorp",
      key: "NETWORK_HUB|hubcorp", hub: { actors: ["Alpha", "Beta", "Gamma"] }, evidence_urls: ["u1"] },
  ];
  const incidents = assembleIncidents({ leads, scandals: [] });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].actor_id, null);
  assert.equal(incidents[0].label, "HubCorp");
});

test("assembleIncidents attaches scandals sharing the actor's name", () => {
  const leads = [
    { id: "l1", status: "proposed", vector: "DONOR_REWARD", actor_id: "a1", actor_name: "Lalu Prasad", beneficiary: "X", evidence_urls: [] },
  ];
  const scandals = [
    { slug: "fodder", title: "Fodder scam", summary: "Treasury fraud under Lalu Prasad government." },
    { slug: "other",  title: "Other scam",  summary: "Unrelated matter." },
  ];
  const incidents = assembleIncidents({ leads, scandals });
  assert.equal(incidents[0].scandals.length, 1);
  assert.equal(incidents[0].scandals[0].slug, "fodder");
});

test("incidentRegistry numbers referenced evidence 1..N, caps at 40, ranks documents first", () => {
  const urls = Array.from({ length: 45 }, (_, i) => `https://e/${i}`);
  const incident = { leads: [{ evidence_urls: urls }] };
  const evidenceRows = urls.map((u, i) => ({
    url: u, title: `Doc ${i}`, source_type: "eci_affidavit", admissible: true, content: "x".repeat(3000),
  }));
  // Add an unreferenced row that must NOT appear.
  evidenceRows.push({ url: "https://not-referenced", title: "Nope", content: "y" });

  const registry = incidentRegistry(incident, evidenceRows);
  assert.equal(registry.length, 40, "capped at 40 sources");
  assert.deepEqual(registry.map((r) => r.n), Array.from({ length: 40 }, (_, i) => i + 1), "numbered 1..40");
  assert.ok(registry.every((r) => r.url !== "https://not-referenced"), "unreferenced evidence excluded");
  assert.ok(registry[0].content.length <= 1500, "content truncated to 1500 chars");
});

test("validateAndRepairStory strips sentences whose [n] markers don't resolve", () => {
  const registry = [
    { n: 1, title: "Src one", url: "u1", admissible: true },
    { n: 2, title: "Src two", url: "u2", admissible: true },
  ];
  const raw = JSON.stringify({
    headline: "H", dek: "Standfirst [1].",
    body_markdown: "Fact A [1]. Fact B [9]. Fact C [2].",
    timeline: [
      { date: "2020", event: "Good event", marker: "[1]" },
      { date: "2021", event: "Bad event", marker: "[7]" },
    ],
    entities: ["Alpha"], caveats: ["Charges are not convictions."],
  });
  const out = validateAndRepairStory(raw, { label: "Test" }, registry);
  assert.ok(out.body_markdown.includes("Fact A"), "resolvable sentence kept");
  assert.ok(out.body_markdown.includes("Fact C"), "resolvable sentence kept");
  assert.ok(!out.body_markdown.includes("Fact B"), "unresolved [9] sentence stripped");
  assert.equal(out.timeline.length, 1, "timeline entry with unresolved marker dropped");
  assert.deepEqual(out.citations.map((c) => c.n), [1, 2], "citations attached from resolved markers");
});

test("validateAndRepairStory repairs missing required fields", () => {
  const registry = [{ n: 1, title: "S", url: "u", admissible: true }];
  const out = validateAndRepairStory(JSON.stringify({ body_markdown: "Something [1]." }), { label: "The Incident" }, registry);
  assert.ok(out.headline.includes("The Incident"), "missing headline repaired from incident label");
  assert.ok(out.dek.length > 0, "missing dek repaired");
  assert.deepEqual(out.entities, []);
  assert.deepEqual(out.caveats, []);
});

test("canTransition enforces draft→proposed→published|rejected and rejects backward moves", () => {
  assert.equal(canTransition("draft", "proposed"), true);
  assert.equal(canTransition("proposed", "published"), true);
  assert.equal(canTransition("proposed", "rejected"), true);
  assert.equal(canTransition("published", "draft"), false, "published→draft is illegal");
  assert.equal(canTransition("draft", "published"), false, "cannot skip proposed");
});

test("story store roundtrips and status guard blocks published→draft", () => {
  const saved = store.upsertStory({ slug: "test-incident", headline: "H", generated_at: Date.now(), lead_ids: ["l1"] });
  assert.equal(saved.status, "draft", "defaults to draft");
  const got = store.getStory("test-incident");
  assert.equal(got.id, saved.id);
  assert.equal(store.listStories({ status: "draft" }).length, 1);
  assert.equal(store.listStories({ status: "published" }).length, 0);
  // The guard is what index.js consults before persisting a transition.
  assert.equal(canTransition(got.status, "draft"), false);
});
