// L1/mega attribution end-to-end: the cached-dataset path (ingest.js l1Match /
// fetchL1Datasets) must emit evidence ONLY when the identity ladder decides, file
// an abstention for human review otherwise, and survive corrupt/oversized caches.
//
// Runs against a throwaway SQLite DB and a throwaway cache dir — never
// data/pandoros.db, never server/data/l1-cache, never the network. Both are read
// at import time, so they are set BEFORE the imports below.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pandoros-l1-"));
process.env.PANDOROS_DB_PATH = path.join(TMP, "test.db");
process.env.L1_CACHE_DIR = path.join(TMP, "l1-cache");
fs.mkdirSync(process.env.L1_CACHE_DIR, { recursive: true });

const store = await import("../server/store/store.js");
const { listProposed } = await import("../server/entities/entities.js");
const { buildRosterIndex, rowKey } = await import("../server/util/linker.js");
const ingest = await import("../server/orchestration/ingest.js");
const mega = await import("../server/orchestration/mega-ingest.js");

// Two same-named reps (the collision the old substring matcher could not see) plus
// one distinctive name.
const TWIN_A = store.upsertPolitician({ id: "twin-a", name: "Ramesh Kumar Sharma", party: "BJP", office: "MP", constituency: "Varanasi", state: "Uttar Pradesh" });
const TWIN_B = store.upsertPolitician({ id: "twin-b", name: "Ramesh Kumar Sharma", party: "INC", office: "MLA", constituency: "Bhopal", state: "Madhya Pradesh" });
const SOLO = store.upsertPolitician({ id: "solo", name: "Priyanka Chaturvedi", party: "SS", office: "RS", constituency: "Maharashtra", state: "Maharashtra" });
ingest.resetL1Roster();

const CFG = { id: "mega-test-tenders", title: "Test tender corpus", summary: "tenders", match: "name", tier: 5 };
const cache = (rows) => ({ total: rows.length, count: rows.length, meta: CFG, rows });
const writeMega = (rows) =>
  fs.writeFileSync(path.join(process.env.L1_CACHE_DIR, `${CFG.id}.json`),
    JSON.stringify({ fetched_at: new Date().toISOString(), ...cache(rows) }));

test("l1Match keeps the byte-compatible evidence shape and adds match provenance", () => {
  const rows = [["T/2021/88", "Awarded to Ramesh Kumar Sharma", "Varanasi", "Rs 4,20,000"]];
  const ev = ingest.l1Match(CFG, cache(rows), TWIN_A);
  assert.ok(ev);
  for (const k of ["politician_id", "source_type", "tier", "admissible", "title", "url", "date", "summary", "content"]) {
    assert.ok(k in ev, `evidence row must still carry ${k}`);
  }
  assert.equal(ev.source_type, "l1_mega_test_tenders");
  // The header + "• cells" contract the extractors parse must be untouched.
  assert.match(ev.content, /^Test tender corpus \(1 matching row, dataset of 1\):\n• T\/2021\/88 \| /);
  assert.equal(ev.match_method, "name_plus_context");
  assert.ok(ev.match_confidence >= 0.7);
  // Provenance is a NON-bullet trailing line, so bullet parsers ignore it.
  const bullets = ev.content.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(bullets.length, 1);
  assert.match(ev.content, /\nIdentity: name_plus_context \(confidence /);
});

// The roster index the ingest path builds internally; rebuilt here so the
// namesake guard is active in the direct-l1Match tests too.
const rosterIndex = () => buildRosterIndex([TWIN_A, TWIN_B, SOLO]);

test("a namesake-only row produces NO evidence for either twin", () => {
  const c = cache([["Payee: RAMESH KUMAR SHARMA", "Cheque 4471", "Rs 12,00,000"]]);
  const seen = [];
  assert.equal(ingest.l1Match(CFG, c, TWIN_A, { roster: rosterIndex(), onAbstain: (a) => seen.push(a) }), null);
  assert.equal(ingest.l1Match(CFG, c, TWIN_B, { roster: rosterIndex(), onAbstain: (a) => seen.push(a) }), null);
  assert.equal(seen.length, 2, "both abstentions are surfaced to the caller");
  assert.equal(seen[0].link.method, "abstain_namesake");
});

test("fetchL1Datasets: a corroborated row becomes evidence", () => {
  writeMega([["T/2021/88", "Awarded to Ramesh Kumar Sharma", "Varanasi", "Rs 4,20,000"]]);
  const out = ingest.fetchL1Datasets(TWIN_A);
  const row = out.find((e) => e.source_type === "l1_mega_test_tenders");
  assert.ok(row, "corroborated row is attributed");
  assert.equal(row.match_method, "name_plus_context");
  // …and NOT to the namesake, whose own context is absent from the row.
  assert.equal(ingest.fetchL1Datasets(TWIN_B).find((e) => e.source_type === "l1_mega_test_tenders"), undefined);
});

test("fetchL1Datasets: an abstention is filed as a PROPOSED assertion, and deduped", () => {
  writeMega([["Payee: RAMESH KUMAR SHARMA", "Cheque 4471", "Rs 12,00,000"]]);
  const got = ingest.fetchL1Datasets(TWIN_A);
  assert.equal(got.length, 0, `no evidence when the ladder abstains: ${JSON.stringify(got.map((e) => [e.source_type, e.match_method]))}`);
  const forTwinA = () => listProposed({ source: "l1_mega_test_tenders" }).filter((a) => a.politician_id === "twin-a");
  const first = forTwinA();
  assert.equal(first.length, 1);
  assert.equal(first[0].status, "proposed");
  assert.equal(first[0].entity_id, null, "an abstention must not mint or bind an entity");
  assert.match(first[0].method, /^l1_abstain:abstain_namesake$/);
  assert.ok(first[0].data.candidates.some((c) => c.politician_id === "twin-b"));

  // Re-ingesting the same cache must not pile up duplicates.
  ingest.fetchL1Datasets(TWIN_A);
  ingest.fetchL1Datasets(TWIN_A);
  assert.equal(forTwinA().length, 1, "same (source, row, politician) folds to one proposal");
  assert.equal(first[0].id, forTwinA()[0].id);
});

// ── regressions ─────────────────────────────────────────────────────────────

test("REGRESSION: a multi-row blob carries PER-ROW provenance and the WEAKEST confidence", () => {
  // One blob can hold up to 12 bullets decided by different rungs. Stamping it with
  // the single BEST row's method/confidence made the strongest row's provenance
  // cover the weakest — on a platform whose contract is per-claim traceability.
  const rows = [
    ["Donation from Priyanka Chaturvedi", "Maharashtra", "Rs 1,00,000"], // corroborated
    ["Payee Priyanka Chaturvedi", "Kerala", "Rs 90,00,000"],             // name only
  ];
  const ev = ingest.l1Match(CFG, cache(rows), SOLO, { roster: rosterIndex() });
  assert.ok(ev, "both rows are attributed");
  assert.equal(ev.content.split("\n").filter((l) => l.startsWith("•")).length, 2);
  assert.ok(Array.isArray(ev.match_rows), "per-row provenance must be emitted");
  assert.equal(ev.match_rows.length, 2);
  assert.deepEqual(ev.match_rows.map((r) => r.method), ["name_plus_context", "distinctive_name"]);
  const weakest = Math.min(...ev.match_rows.map((r) => r.confidence));
  assert.equal(ev.match_confidence, weakest, "the blob is only as good as its weakest bullet");
  assert.equal(ev.match_method, "distinctive_name");
  assert.ok(ev.match_rows.some((r) => r.confidence > weakest), "the stronger row is still recorded");
});

test("REGRESSION: an abstention is NOT filed as a mergeable person assertion", () => {
  // Accepting a `person` assertion whose raw_name is the POLITICIAN's name resolves
  // it against whatever entity already claims that name — gluing the member onto a
  // namesake's entity (the defect split-shared-entities.js exists to repair) while
  // never re-attributing the row. So these records must not be person-shaped.
  writeMega([["Payee: RAMESH KUMAR SHARMA", "Cheque 9911", "Rs 12,00,000"]]);
  ingest.fetchL1Datasets(TWIN_A);
  const a = listProposed({ source: "l1_mega_test_tenders" }).find((x) => x.politician_id === "twin-a");
  assert.ok(a, "the abstention is still queued for review");
  assert.notEqual(a.subject_kind, "person",
    "a person-kind assertion is auto-resolved by raw_name against existing person entities");
  assert.equal(a.entity_id, null);
  assert.ok(a.data.needs_attribution_handler,
    "the record must say that accepting it does not re-attribute the evidence row");
});

test("REGRESSION: the filed excerpt belongs to the row the key and reasons came from", () => {
  const twinC = store.upsertPolitician({ id: "twin-c", name: "Ramesh Kumar Sharma Chaturvedi", party: "BJP", office: "MP", constituency: "Kanpur", state: "Uttar Pradesh" });
  assert.ok(twinC);
  ingest.resetL1Roster();
  writeMega([
    ["ROW-ZERO payee RAMESH KUMAR SHARMA CHATURVEDI", "cheque 1"], // abstain_outranked
    ["ROW-ONE payee RAMESH KUMAR SHARMA", "cheque 2"],             // abstain_namesake ← best
  ]);
  ingest.fetchL1Datasets(TWIN_A);
  const filed = listProposed({ source: "l1_mega_test_tenders" })
    .filter((x) => x.politician_id === "twin-a")
    .find((x) => x.source_ref === rowKey(["ROW-ONE payee RAMESH KUMAR SHARMA", "cheque 2"]));
  assert.ok(filed, "the best abstention (ROW-ONE) is the row filed for review");
  assert.match(filed.method, /abstain_namesake$/);
  assert.match(filed.data.excerpt, /ROW-ONE/,
    "the reviewer must see the row whose key and rationale they are adjudicating");
  ingest.resetL1Roster();
});

test("REGRESSION: a cache fetched over an unverified TLS channel marks its evidence", () => {
  // tls-policy.js: "insecure: true means the bytes arrived unauthenticated and
  // callers should propagate that onto any evidence they derive from them."
  const rows = [["T/2021/88", "Awarded to Ramesh Kumar Sharma", "Varanasi", "Rs 4,20,000"]];
  const clean = ingest.l1Match(CFG, cache(rows), TWIN_A);
  assert.ok(!clean.tls_unverified, "a verified cache carries no marker");
  const ev = ingest.l1Match(CFG, { ...cache(rows), tls_unverified: true }, TWIN_A);
  assert.equal(ev.tls_unverified, true, "a network attacker could have chosen these bytes");
});

test("l1Read: over L1_MAX_BYTES the cache is a MISS, not a stall", () => {
  const id = "size-guard-probe";
  const file = path.join(process.env.L1_CACHE_DIR, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), rows: [["a"]] }));
  assert.ok(ingest.l1Read(id), "a small cache reads normally");
  // Pad past the default 128MB limit without writing 128MB: the guard reads the
  // file SIZE, so a sparse file of the right length is enough.
  const fd = fs.openSync(file, "r+");
  fs.ftruncateSync(fd, 200 * 1024 * 1024);
  fs.closeSync(fd);
  assert.equal(ingest.l1Read(id), null, "oversized cache is treated as a cache miss");
});

test("l1Read: a truncated cache file is a recorded MISS, not a throw", () => {
  const id = "corrupt-probe";
  fs.writeFileSync(path.join(process.env.L1_CACHE_DIR, `${id}.json`), '{"fetched_at":"2026-01-01","rows":[["a"],["b"');
  assert.equal(ingest.l1Read(id), null);
});

test("tolerant JSONL reader survives a truncated final line", () => {
  const file = path.join(TMP, "docs.jsonl");
  fs.writeFileSync(file,
    JSON.stringify({ title: "one", rows: [["a"]] }) + "\n"
    + JSON.stringify({ title: "two", rows: [["b"]] }) + "\n"
    + '{"title":"three","rows":[["c"' /* killed mid-write */);
  const got = [];
  const { ok, bad } = mega.readJsonlTolerant(file, (r) => got.push(r.title));
  assert.deepEqual(got, ["one", "two"]);
  assert.equal(ok, 2);
  assert.equal(bad, 1, "the corrupt line is counted, not swallowed");
});

test("mega prefilter (candidate generation) is boundary-aware", () => {
  const needles = ["ram singh"];
  assert.equal(mega.matchRow(needles, ["Param Singhal & Sons"]), false);
  assert.equal(mega.matchRow(needles, ["Accused: RAM SINGH, s/o X"]), true);
});

test.after(() => {
  try { store.db.close(); } catch { /* already closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows handle lag */ }
});
