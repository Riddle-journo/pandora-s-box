// Eval-harness unit tests — the PURE logic of scripts/label-leads.js and
// scripts/eval-investigator.js: the lead_feedback → label mapping, labels.jsonl
// round-tripping, resumability, and the precision / recall / calibration maths on
// synthetic data (including the zero-denominator and single-sample cases that a
// naive implementation reports as "100%").
//
// Neither module opens a database at import time, and nothing here opens one at
// all. PANDOROS_DB_PATH is pointed at a path that does not exist anyway, so any
// accidental DB access would throw loudly instead of touching data/pandoros.db.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = path.join(os.tmpdir(), `pandoros-eval-harness-${process.pid}`);
process.env.PANDOROS_DB_PATH = path.join(TMP, "never-created.db");

const L = await import("../scripts/label-leads.js");
const E = await import("../scripts/eval-investigator.js");

test.before(() => { fs.mkdirSync(TMP, { recursive: true }); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const tmpFile = (name) => path.join(TMP, name);

// ── lead_feedback → label mapping ───────────────────────────────────────────
test("mapFeedbackDecision maps only HUMAN decisions", () => {
  assert.equal(L.mapFeedbackDecision("approved", "admin"), "true_positive");
  assert.equal(L.mapFeedbackDecision("rejected", "ops"), "false_positive");
  assert.equal(L.mapFeedbackDecision("dismissed", "ops"), "false_positive");
  // The GLM's own verdict is the PREDICTION. Seeding it would make the eval
  // circular and it would score a perfect 100%.
  assert.equal(L.mapFeedbackDecision("glm_proposed", "glm"), null);
  assert.equal(L.mapFeedbackDecision("glm_dismissed", "glm"), null);
  assert.equal(L.mapFeedbackDecision("approved", "glm"), null, "source=glm is never a human label");
  assert.equal(L.mapFeedbackDecision("something_new", "admin"), null);
});

test("seedRowsFromFeedback collapses per-detector rows to one label per lead", () => {
  const seeds = L.seedRowsFromFeedback([
    { lead_id: "A", lead_key: "V|a", vector: "V", detector: "conflict", decision: "approved", source: "admin", at: "2026-01-01T00:00:00Z" },
    { lead_id: "A", lead_key: "V|a", vector: "V", detector: "benford", decision: "approved", source: "admin", at: "2026-01-01T00:00:00Z" },
    { lead_id: "B", lead_key: "V|b", vector: "V", detector: "network_hub", decision: "dismissed", source: "ops", at: "2026-01-02T00:00:00Z" },
    { lead_id: "C", vector: "V", detector: "x", decision: "glm_proposed", source: "glm", at: "2026-01-03T00:00:00Z" },
  ]);
  assert.equal(seeds.length, 2, "one seed per lead; the glm row is not a label");
  const a = seeds.find((s) => s.lead_id === "A");
  assert.equal(a.label, "true_positive");
  assert.equal(a.labeler, L.SEED_LABELER);
  assert.deepEqual(a.detectors.sort(), ["benford", "conflict"], "detectors are unioned across rows");
  assert.match(a.note, /APPROVED/);
  assert.equal(a.labeled_at, "2026-01-01T00:00:00Z", "the label keeps the decision's own timestamp");
  const b = seeds.find((s) => s.lead_id === "B");
  assert.equal(b.label, "false_positive");
  assert.match(b.note, /Weaker signal/, "a dismiss is flagged as the weaker signal it is");
});

test("seedRowsFromFeedback: explicit approve/reject outranks a dismiss, then newest wins", () => {
  const [seed] = L.seedRowsFromFeedback([
    { lead_id: "A", detector: "d", decision: "dismissed", source: "ops", at: "2026-05-01T00:00:00Z" },
    { lead_id: "A", detector: "d", decision: "approved", source: "admin", at: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(seed.label, "true_positive", "the parked-for-later dismiss does not beat a real approval");

  const [later] = L.seedRowsFromFeedback([
    { lead_id: "B", detector: "d", decision: "approved", source: "admin", at: "2026-01-01T00:00:00Z" },
    { lead_id: "B", detector: "d", decision: "rejected", source: "admin", at: "2026-06-01T00:00:00Z" },
  ]);
  assert.equal(later.label, "false_positive", "among equals the operator's latest view wins");
});

test("seedRowsFromFeedback falls back to lead_key when lead_id is absent", () => {
  const [seed] = L.seedRowsFromFeedback([{ lead_key: "V|k", decision: "rejected", source: "admin", at: "2026-01-01T00:00:00Z" }]);
  assert.equal(seed.lead_id, "V|k", "a rejected lead is DELETED, so the key may be all that survives");
});

// ── labels.jsonl round-tripping ────────────────────────────────────────────
test("labels.jsonl round-trips, last label per lead wins, malformed lines are reported", () => {
  const file = tmpFile("labels-roundtrip.jsonl");
  assert.deepEqual([...L.readLabels(file).byLeadId.keys()], [], "a missing file is an empty label set, not a crash");

  const one = L.makeLabel({ lead_id: "A", label: "true_positive", note: "real", labeler: "tester" });
  const two = L.makeLabel({ lead_id: "B", label: "undecidable", note: "no record exists", labeler: "tester" });
  assert.equal(L.appendLabels(file, [one, two]), 2);

  let read = L.readLabels(file);
  assert.equal(read.all.length, 2);
  assert.equal(read.byLeadId.get("A").label, "true_positive");
  assert.equal(read.byLeadId.get("B").note, "no record exists");
  assert.deepEqual(Object.keys(one).sort(), ["detectors", "labeled_at", "labeler", "lead_id", "lead_key", "label", "note", "vector"].sort());

  // Relabelling appends; the newest line is operative and the old one stays as an
  // audit trail of the rubric changing under the labeller.
  L.appendLabels(file, [L.makeLabel({ lead_id: "A", label: "false_positive", note: "misattributed", labeler: "tester" })]);
  read = L.readLabels(file);
  assert.equal(read.all.length, 3, "append-only: nothing is overwritten");
  assert.equal(read.byLeadId.size, 2);
  assert.equal(read.byLeadId.get("A").label, "false_positive");

  fs.appendFileSync(file, "not json at all\n" + JSON.stringify({ lead_id: "C", label: "maybe" }) + "\n" + JSON.stringify({ label: "true_positive" }) + "\n");
  read = L.readLabels(file);
  assert.equal(read.byLeadId.size, 2, "unusable lines never enter the label set");
  assert.equal(read.malformed.length, 3);
  assert.deepEqual(read.malformed.map((m) => m.why), ["not JSON", 'unknown label "maybe"', "missing lead_id"]);
});

test("makeLabel rejects an unknown label or a missing lead id", () => {
  assert.throws(() => L.makeLabel({ lead_id: "A", label: "probably" }), /unknown label/);
  assert.throws(() => L.makeLabel({ label: "true_positive" }), /lead_id is required/);
});

test("appendLabels creates the eval directory on first write", () => {
  const file = path.join(TMP, "nested", "deeper", "labels.jsonl");
  L.appendLabels(file, [L.makeLabel({ lead_id: "Z", label: "true_positive", labeler: "t" })]);
  assert.equal(L.readLabels(file).byLeadId.size, 1);
});

// ── resumability / sampling ────────────────────────────────────────────────
const lead = (over = {}) => ({ id: over.id ?? "id1", key: over.key ?? "V|1", vector: "V", signal_score: 10, headline: "h", ...over });

test("already-labelled leads are skipped, by id OR by key", () => {
  const leads = [lead({ id: "a", key: "K|a" }), lead({ id: "b", key: "K|b" }), lead({ id: "c", key: "K|c" })];
  assert.deepEqual(L.filterUnlabeled(leads, new Set(["a"])).map((x) => x.id), ["b", "c"]);
  // A label seeded from a rejected (deleted) lead carries the KEY as its id, so
  // key matching is what makes the resume complete.
  assert.deepEqual(L.filterUnlabeled(leads, new Set(["K|b"])).map((x) => x.id), ["a", "c"]);
  assert.deepEqual(L.filterUnlabeled(leads, new Set(["a", "K|b", "c"])), []);
});

test("selectSample stratifies by detector and by stored verdict, and honours --limit", () => {
  const leads = [
    lead({ id: "1", vector: "DONOR_REWARD", data: { engine_flag_key: "conflict|x|DONOR_REWARD" }, investigation: { verdict: "SUGGESTIVE", confidence: 0.6 } }),
    lead({ id: "2", vector: "BENFORD", data: { flags: [{ detector: "benford" }] }, investigation: { verdict: "COINCIDENCE", confidence: 0.9 } }),
    lead({ id: "3", vector: "NETWORK_HUB" }),
  ];
  const ids = (o) => L.selectSample({ leads, labeledIds: new Set(), ...o }).map((l) => l.id);
  assert.deepEqual(ids({ detector: "conflict" }), ["1"]);
  assert.deepEqual(ids({ detector: "BENFORD" }), ["2"], "detector match is case-insensitive and falls back to the vector");
  assert.deepEqual(ids({ verdict: "suggestive" }), ["1"]);
  assert.deepEqual(ids({ verdict: "none" }), ["3"], "--verdict none finds the never-investigated leads");
  assert.deepEqual(ids({ limit: 2 }), ["1", "2"]);
  assert.deepEqual(ids({ limit: 0 }), []);
  assert.deepEqual(ids({ labeledIds: new Set(["1", "2", "3"]) }), []);
});

test("shuffled is deterministic per seed — a reproducible sample, not an anecdote", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(L.shuffled(items, 7), L.shuffled(items, 7));
  assert.notDeepEqual(L.shuffled(items, 7), L.shuffled(items, 8));
  assert.deepEqual(L.shuffled(items, 7).slice().sort((a, b) => a - b), items, "a permutation, not a filter");
  assert.deepEqual(items, [1, 2, 3, 4, 5, 6, 7, 8], "input is not mutated");
});

test("detectorsForLead mirrors store/content.js recordLeadFeedback attribution", () => {
  assert.deepEqual(L.detectorsForLead({ vector: "X", data: { flags: [{ detector: "a" }, { detector: "b" }, {}] } }), ["a", "b"]);
  assert.deepEqual(L.detectorsForLead({ vector: "X", data: { engine_flag_key: "conflict|pol|X|y" } }), ["conflict"]);
  assert.deepEqual(L.detectorsForLead({ vector: "NETWORK_HUB" }), ["network_hub"], "falls back to the lower-cased vector");
  assert.deepEqual(L.detectorsForLead({}), []);
});

test("strataCounts shows which strata are thin", () => {
  const leads = [
    lead({ id: "1", vector: "A", investigation: { verdict: "SUGGESTIVE" } }),
    lead({ id: "2", vector: "A" }),
    lead({ id: "3", vector: "B" }),
  ];
  const s = L.strataCounts(leads, new Set(["1"]));
  assert.equal(s.leads, 3);
  assert.equal(s.labelled, 1);
  assert.deepEqual(s.byVerdict.find((v) => v.verdict === "NONE"), { verdict: "NONE", total: 2, labelled: 0 });
  assert.deepEqual(s.byVerdict.find((v) => v.verdict === "SUGGESTIVE"), { verdict: "SUGGESTIVE", total: 1, labelled: 1 });
  assert.deepEqual(s.byDetector.find((d) => d.detector === "a"), { detector: "a", total: 2, labelled: 1 });
});

// ── presentation helpers ───────────────────────────────────────────────────
test("wrapText wraps to the terminal width and indents every line", () => {
  const out = L.wrapText("alpha beta gamma delta epsilon zeta", 20, "  ");
  for (const line of out.split("\n")) assert.ok(line.length <= 20, `"${line}" fits`);
  assert.ok(out.split("\n").every((l) => l.startsWith("  ")));
  assert.equal(L.wrapText("   ", 20), "");
  assert.equal(L.wrapText(null, 20), "");
  assert.ok(L.wrapText("word ".repeat(40), 88).includes("\n"));
});

test("formatLeadForReview surfaces everything a labeller must weigh", () => {
  const out = L.formatLeadForReview({
    lead: lead({
      id: "abc", actor_name: "Someone", headline: "A headline", detail: "The detail",
      data: { engine_flag_key: "conflict|p|V" },
      investigation: { verdict: "SUGGESTIVE", confidence: 0.7, summary: "sum", mechanism: "mech", evidence_for: ["for1"], evidence_against: ["against1"], confirming_record: "the record" },
    }),
    evidence: [{ source_type: "eci_affidavit", title: "Affidavit", url: "https://x/1", content: "body text" }],
    feedback: [{ at: "2026-01-01", decision: "dismissed", source: "ops", detector: "conflict" }],
  }, { width: 88, index: 2, total: 9 });
  for (const needle of ["LEAD 2/9", "abc", "A headline", "The detail", "conflict", "eci_affidavit", "https://x/1",
    "SUGGESTIVE", "0.70", "mech", "FOR:", "AGAINST:", "would settle it", "PRIOR DECISIONS", "dismissed"]) {
    assert.ok(out.includes(needle), `summary mentions ${needle}`);
  }
  const noVerdict = L.formatLeadForReview({ lead: lead(), evidence: [], feedback: [] });
  assert.ok(noVerdict.includes("(none — this lead has not been through L2/L3)"));
  assert.ok(noVerdict.includes("none of the lead's URLs resolved"), "an unciteable lead says so out loud");
});

test("formatLeadLine keeps the headline readable instead of truncating it to nothing", () => {
  const line = L.formatLeadLine(lead({ id: "deadbeefcafe", headline: "H".repeat(200) }), 88);
  const [head, body] = line.split("\n");
  assert.ok(head.includes("deadbeef"));
  assert.ok(body.trim().length > 40, "the headline gets real room on its own line");
  assert.ok(body.length <= 88);
});

// ── confidence normalisation / orientation ─────────────────────────────────
test("normalizeConfidence copes with both scales the model emits and refuses junk", () => {
  assert.equal(L.normalizeConfidence(0.82), 0.82);
  assert.equal(L.normalizeConfidence(82), 0.82);
  assert.equal(L.normalizeConfidence(100), 1);
  assert.equal(L.normalizeConfidence(0), 0);
  assert.equal(L.normalizeConfidence(1), 1);
  // Unparseable is "no confidence", NOT 0 — a silent 0 would poison calibration.
  assert.equal(L.normalizeConfidence(101), null);
  assert.equal(L.normalizeConfidence(-1), null);
  assert.equal(L.normalizeConfidence("abc"), null);
  assert.equal(L.normalizeConfidence(null), null);
  assert.equal(L.normalizeConfidence(undefined), null);
});

test("claimProbability flips COINCIDENCE confidence — 0.9 innocent is 0.1 guilty", () => {
  assert.equal(E.claimProbability("SUBSTANTIATED", 0.9), 0.9);
  assert.equal(E.claimProbability("SUGGESTIVE", 60), 0.6);
  assert.ok(Math.abs(E.claimProbability("COINCIDENCE", 0.9) - 0.1) < 1e-9);
  assert.equal(E.claimProbability("COINCIDENCE", null), null);
});

test("bucketOf places boundary values in exactly one bucket, including p=1", () => {
  assert.equal(E.bucketOf(0), 0);
  assert.equal(E.bucketOf(0.199), 0);
  assert.equal(E.bucketOf(0.2), 1, "a bucket owns its lower bound");
  assert.equal(E.bucketOf(0.8), 4);
  assert.equal(E.bucketOf(1), 4, "the top bucket is closed so 1.0 is not dropped");
  assert.equal(E.bucketOf(null), -1);
  assert.equal(E.bucketOf(1.5), -1);
});

// ── rate arithmetic: the honesty layer ─────────────────────────────────────
test("rate never divides by zero and flags samples below the floor", () => {
  assert.deepEqual(E.rate(0, 0, 5), { value: null, num: 0, den: 0, insufficient: true });
  assert.deepEqual(E.rate(1, 1, 5), { value: 1, num: 1, den: 1, insufficient: true }, "n=1 is 100% AND insufficient");
  assert.deepEqual(E.rate(4, 5, 5), { value: 0.8, num: 4, den: 5, insufficient: false }, "the floor itself is sufficient");
  assert.equal(E.rate(3, 4, 1).insufficient, false);
});

test("f1 is withheld unless both inputs exist", () => {
  assert.equal(E.f1(E.rate(1, 2, 1), E.rate(1, 2, 1)), 0.5);
  assert.equal(E.f1(E.rate(0, 0), E.rate(1, 2)), null);
  assert.equal(E.f1(E.rate(0, 2), E.rate(0, 2)), null, "0 precision and 0 recall is undefined, not 0");
});

// ── metrics on synthetic data ──────────────────────────────────────────────
const pair = (label, verdict, confidence, detectors = ["d"]) => ({
  lead_id: `${label}-${verdict}-${confidence}-${Math.random()}`,
  label, verdict, detectors,
  confidence, claim_probability: verdict ? E.claimProbability(verdict, confidence) : null,
  missing_lead: false, unknown_verdict: null,
});

test("makePair records a missing lead and an unrecognised verdict tier", () => {
  const gone = E.makePair({ lead_id: "A", label: "false_positive", lead_key: "V|a", detectors: ["conflict"] }, null);
  assert.equal(gone.missing_lead, true);
  assert.equal(gone.verdict, null);
  assert.deepEqual(gone.detectors, ["conflict"], "a deleted lead keeps the detectors the label remembered");

  const weird = E.makePair({ lead_id: "B", label: "true_positive" }, lead({ investigation: { verdict: "PROBABLY", confidence: 0.5 } }));
  assert.equal(weird.verdict, null, "an unknown tier is not silently scored");
  assert.equal(weird.unknown_verdict, "PROBABLY");
  assert.equal(weird.claim_probability, null);

  const good = E.makePair({ lead_id: "C", label: "true_positive" }, lead({ investigation: { verdict: "substantiated", confidence: 88, model: "m" } }));
  assert.equal(good.verdict, "SUBSTANTIATED");
  assert.equal(good.confidence, 0.88);
  assert.equal(good.model, "m");
});

test("counts separate undecidable, missing predictions and missing leads", () => {
  const c = E.counts([
    pair("true_positive", "SUBSTANTIATED", 0.9),
    pair("false_positive", "SUGGESTIVE", 0.5),
    pair("undecidable", "COINCIDENCE", 0.5),
    { ...pair("true_positive", null, null), missing_lead: true },
    { ...pair("false_positive", null, null), unknown_verdict: "MAYBE" },
  ]);
  assert.equal(c.labels_total, 5);
  assert.equal(c.true_positive, 2);
  assert.equal(c.undecidable, 1);
  assert.equal(c.missing_lead, 1);
  assert.equal(c.no_verdict, 2);
  assert.equal(c.scoreable, 2, "undecidable and prediction-less rows are not scoreable");
  assert.deepEqual(c.unknown_verdicts, ["MAYBE"]);
});

test("scoreTiers computes per-tier precision and recall, excluding undecidable", () => {
  const pairs = [
    pair("true_positive", "SUBSTANTIATED", 0.9),
    pair("true_positive", "SUBSTANTIATED", 0.9),
    pair("false_positive", "SUBSTANTIATED", 0.9),
    pair("undecidable", "SUBSTANTIATED", 0.9),
    pair("true_positive", "SUGGESTIVE", 0.5),
    pair("false_positive", "COINCIDENCE", 0.8),
  ];
  const t = E.scoreTiers(pairs, { minSample: 3 });
  const sub = t.find((x) => x.tier === "SUBSTANTIATED");
  assert.equal(sub.predicted, 4);
  assert.equal(sub.undecidable, 1);
  assert.deepEqual([sub.precision.num, sub.precision.den], [2, 3], "the undecidable lead leaves the denominator");
  assert.equal(sub.precision.value, 2 / 3);
  assert.deepEqual([sub.recall.num, sub.recall.den], [2, 3], "recall is over all 3 labelled true positives with a prediction");
  const coin = t.find((x) => x.tier === "COINCIDENCE");
  assert.equal(coin.precision.value, 0, "a correctly buried false positive scores 0 tier precision, by definition");
  assert.deepEqual(t.map((x) => x.tier), L.VERDICT_TIERS);
});

test("scoreGate reports the confusion matrix of the surface/bury decision", () => {
  const pairs = [
    pair("true_positive", "SUBSTANTIATED", 0.9),  // tp
    pair("true_positive", "SUGGESTIVE", 0.6),     // tp
    pair("false_positive", "SUGGESTIVE", 0.6),    // fp
    pair("true_positive", "COINCIDENCE", 0.9),    // fn — real material thrown away
    pair("false_positive", "COINCIDENCE", 0.9),   // tn
    pair("undecidable", "SUBSTANTIATED", 0.9),    // excluded
  ];
  const g = E.scoreGate(pairs, { minSample: 3 });
  assert.deepEqual(g.confusion, { tp: 2, fp: 1, fn: 1, tn: 1 });
  assert.equal(g.precision.value, 2 / 3);
  assert.equal(g.recall.value, 2 / 3);
  assert.equal(g.f1, 2 / 3);
  assert.deepEqual([g.accuracy.num, g.accuracy.den], [3, 5]);
  assert.equal(g.precision.insufficient, false);

  const empty = E.scoreGate([], { minSample: 5 });
  assert.deepEqual(empty.confusion, { tp: 0, fp: 0, fn: 0, tn: 0 });
  assert.equal(empty.precision.value, null);
  assert.equal(empty.f1, null);
});

test("calibration buckets predicted claim probability against observed precision", () => {
  const pairs = [
    // 0.8–1.0: 3 confident claims, 2 real → observed 0.67 vs mean predicted 0.9.
    pair("true_positive", "SUBSTANTIATED", 0.9),
    pair("true_positive", "SUBSTANTIATED", 0.9),
    pair("false_positive", "SUBSTANTIATED", 0.9),
    // 0.0–0.2: confidently dismissed, and correctly so.
    pair("false_positive", "COINCIDENCE", 0.9),
    pair("false_positive", "COINCIDENCE", 0.85),
    pair("undecidable", "COINCIDENCE", 0.9),
    // no usable confidence at all
    pair("true_positive", "SUGGESTIVE", null),
  ];
  const c = E.calibration(pairs, { minSample: 2 });
  const top = c.buckets.find((b) => b.range === "0.8–1.0");
  assert.equal(top.n, 3);
  assert.equal(top.decided, 3);
  assert.deepEqual([top.true_positive, top.false_positive], [2, 1]);
  assert.ok(Math.abs(top.mean_predicted - 0.9) < 1e-9);
  assert.ok(Math.abs(top.gap - (2 / 3 - 0.9)) < 1e-9, "a negative gap means over-confident");
  assert.deepEqual(top.verdict_mix, { SUBSTANTIATED: 3 });

  const bottom = c.buckets.find((b) => b.range === "0.0–0.2");
  assert.equal(bottom.n, 3);
  assert.equal(bottom.decided, 2, "the undecidable lead is counted but not scored");
  assert.equal(bottom.undecidable, 1);
  assert.equal(bottom.observed_precision.value, 0, "0 observed against ~0.12 predicted is well calibrated");

  assert.equal(c.unbucketed, 1, "the verdict with no confidence number is reported, not dropped");
  assert.equal(c.decided, 5);
  assert.ok(c.expected_calibration_error > 0 && c.expected_calibration_error < 1);
});

test("calibration withholds ECE and precision below the sample floor", () => {
  const c = E.calibration([pair("true_positive", "SUBSTANTIATED", 0.95)], { minSample: 5 });
  const top = c.buckets.find((b) => b.range === "0.8–1.0");
  assert.equal(top.decided, 1);
  assert.equal(top.observed_precision.value, 1);
  assert.equal(top.observed_precision.insufficient, true, "n=1 is never a calibration claim");
  assert.equal(top.gap, null, "no gap is reported off one sample");
  assert.equal(c.expected_calibration_error, null, "a 1-lead ECE would be noise with a name");
});

test("scoreDetectors attributes a multi-detector lead to each detector", () => {
  const d = E.scoreDetectors([
    pair("true_positive", "SUBSTANTIATED", 0.9, ["conflict", "benford"]),
    pair("false_positive", "SUGGESTIVE", 0.5, ["conflict"]),
    pair("undecidable", "COINCIDENCE", 0.9, ["conflict"]),
    pair("false_positive", "COINCIDENCE", 0.9, []),
  ], { minSample: 2 });
  const conflict = d.find((x) => x.detector === "conflict");
  assert.equal(conflict.labelled, 3);
  assert.equal(conflict.gate_positive, 2);
  assert.deepEqual([conflict.precision.num, conflict.precision.den], [1, 2]);
  assert.equal(conflict.precision.insufficient, false);
  const benford = d.find((x) => x.detector === "benford");
  assert.equal(benford.labelled, 1);
  assert.equal(benford.precision.insufficient, true);
  assert.ok(d.find((x) => x.detector === "(unattributed)"), "an unattributable lead is still counted");
  assert.deepEqual(d.map((x) => x.detector)[0], "conflict", "sorted by volume");
});

// ── run assembly, delta, persistence ───────────────────────────────────────
test("buildRun assembles a self-describing run and survives an empty label set", () => {
  const run = E.buildRun([], { mode: "stored", minSample: 5, labelsPath: "x.jsonl" });
  assert.equal(run.schema, 1);
  assert.equal(run.counts.labels_total, 0);
  assert.equal(run.gate.precision.value, null);
  assert.equal(run.tiers.length, 3);
  assert.equal(run.calibration.buckets.length, 5);
  const text = E.renderSummary({ ...run, delta: E.deltaAgainst(null, run) });
  assert.ok(text.includes("NOTHING TO SCORE"), "an empty run says so instead of printing zeros as results");
  assert.ok(!text.includes("NaN"));
});

test("renderSummary labels thin samples as insufficient rather than printing a percentage", () => {
  const run = E.buildRun([pair("true_positive", "SUBSTANTIATED", 0.9)], { minSample: 5 });
  const text = E.renderSummary(run);
  assert.ok(text.includes("INSUFFICIENT DATA"));
  assert.ok(text.includes("(1/1)"), "counts always travel with the rate");
  assert.ok(!text.includes("NaN"));
});

test("deltaAgainst reports the baseline case and the changed metrics", () => {
  const a = E.buildRun([pair("true_positive", "SUBSTANTIATED", 0.9), pair("false_positive", "SUGGESTIVE", 0.6)], { minSample: 1 });
  const b = E.buildRun([pair("true_positive", "SUBSTANTIATED", 0.9), pair("true_positive", "SUGGESTIVE", 0.6)], { minSample: 1 });
  const baseline = E.deltaAgainst(null, a);
  assert.equal(baseline.previous_run, null);
  assert.match(baseline.note, /baseline/);

  const d = E.deltaAgainst(a, b);
  const gate = d.changes.find((c) => c.metric === "gate.precision");
  assert.equal(gate.from, 0.5);
  assert.equal(gate.to, 1);
  assert.equal(gate.delta, 0.5);
  assert.ok(!d.changes.some((c) => c.metric === "labels.total"), "unchanged metrics are not noise in the delta");
});

test("run files are Windows-safe and findPreviousRun picks the newest, skipping the current one", () => {
  const dir = path.join(TMP, "runs");
  assert.equal(E.findPreviousRun(dir), null, "a missing runs dir is not an error");
  const first = E.saveRun(E.buildRun([], { minSample: 5, extra: { tag: "first" } }), dir);
  assert.ok(!path.basename(first).includes(":"), "':' is illegal in Windows filenames");
  const second = E.saveRun({ ...E.buildRun([], { minSample: 5, extra: { tag: "second" } }), at: "2099-01-01T00:00:00.000Z" }, dir);
  assert.equal(E.findPreviousRun(dir).tag, "second");
  assert.equal(E.findPreviousRun(dir, second).tag, "first", "a run is never its own baseline");
  fs.writeFileSync(path.join(dir, "2100-01-01T00-00-00-000Z.json"), "{ broken", "utf8");
  assert.equal(E.findPreviousRun(dir).tag, "second", "a corrupt run file falls through to the next-newest");
});

// ── --live gating ──────────────────────────────────────────────────────────
test("assertLiveAllowed refuses to spend money or mutate the live DB by accident", () => {
  const key = { AI_API_KEY: "k", PANDOROS_DB_PATH: "/tmp/copy.db" };
  assert.throws(() => E.assertLiveAllowed({}, key), /--confirm-spend/);
  assert.throws(() => E.assertLiveAllowed({ "confirm-spend": true }, { PANDOROS_DB_PATH: "/tmp/copy.db" }), /AI_API_KEY/);
  // No PANDOROS_DB_PATH means the LIVE 432 MB database, which investigateLead writes to.
  assert.throws(() => E.assertLiveAllowed({ "confirm-spend": true }, { AI_API_KEY: "k" }), /WRITES to the database/);
  assert.equal(E.assertLiveAllowed({ "confirm-spend": true }, key), true);
  assert.equal(E.assertLiveAllowed({ "confirm-spend": true, "allow-live-db": true }, { AI_API_KEY: "k" }), true);
});

test("parseArgs handles the flag shapes both CLIs document", () => {
  assert.deepEqual(L.parseArgs(["--limit", "20", "--dry-run", "--detector", "conflict"]),
    { limit: "20", "dry-run": true, detector: "conflict" });
  assert.deepEqual(L.parseArgs([]), {});
  assert.deepEqual(L.parseArgs(["stray", "--live"]), { live: true });
});

// ── REGRESSIONS ────────────────────────────────────────────────────────────
// Each test below pins a defect that shipped once. Read the comment before
// "simplifying" one of them.

test("REGRESSION: --live refuses the LIVE db even when PANDOROS_DB_PATH points AT it", () => {
  // The old gate asked "is PANDOROS_DB_PATH set?", which is not the question. Any
  // spelling of the live file satisfied it and let --live mutate the real database.
  const spend = { "confirm-spend": true };
  for (const p of ["data/pandoros.db", "./data/pandoros.db", "data/../data/pandoros.db", L.LIVE_DB_PATH,
    path.join(L.REPO_ROOT, "data", "..", "data", "pandoros.db")]) {
    assert.throws(
      () => E.assertLiveAllowed(spend, { AI_API_KEY: "k", PANDOROS_DB_PATH: p }),
      /IS the live database/,
      `${p} is the live DB and must be refused`);
  }
  // A copy is still fine, and --allow-live-db is still the deliberate override.
  assert.equal(E.assertLiveAllowed(spend, { AI_API_KEY: "k", PANDOROS_DB_PATH: path.join(TMP, "copy.db") }), true);
  assert.equal(E.assertLiveAllowed({ ...spend, "allow-live-db": true }, { AI_API_KEY: "k", PANDOROS_DB_PATH: "data/pandoros.db" }), true);
  // Spend and key gates still come first, in that order.
  assert.throws(() => E.assertLiveAllowed({}, { AI_API_KEY: "k", PANDOROS_DB_PATH: "/tmp/copy.db" }), /--confirm-spend/);
  assert.throws(() => E.assertLiveAllowed(spend, { PANDOROS_DB_PATH: "/tmp/copy.db" }), /AI_API_KEY/);
});

test("samePath compares resolved paths, not strings", () => {
  assert.equal(L.samePath("data/pandoros.db", L.LIVE_DB_PATH), true);
  assert.equal(L.samePath("data/pandoros.db", "data/backups/copy.db"), false);
  assert.equal(L.samePath(null, L.LIVE_DB_PATH), false);
});

test("REGRESSION: both CLIs load .env, so --live can see AI_API_KEY", async () => {
  // scripts/label-leads.js must import "dotenv/config" (eval-investigator inherits
  // it). Without it --live died with "needs AI_API_KEY in your .env" while the .env
  // sat unread, and a PANDOROS_DB_PATH in .env was ignored — silently scoring the
  // LIVE database while the run file claimed a copy.
  const src = fs.readFileSync(path.join(L.REPO_ROOT, "scripts", "label-leads.js"), "utf8");
  assert.match(src, /^import "dotenv\/config";$/m, "label-leads.js imports dotenv/config");
  // dotenv must not clobber an inline PANDOROS_DB_PATH — this suite set one.
  assert.equal(process.env.PANDOROS_DB_PATH, path.join(TMP, "never-created.db"));
  assert.equal(L.dbPath(), path.join(TMP, "never-created.db"));
  assert.equal(L.dbPath({}), L.LIVE_DB_PATH, "no override means the live file");
});

test("REGRESSION: planLive loses no label and duplicates none", () => {
  // The old tail loop did labels.slice(targets.length) — indexing the ORIGINAL
  // array with the length of a FILTERED one. With [A(gone), B, C] it dropped A
  // entirely and counted C twice, once with a verdict and once as a phantom
  // missing row. labels_total stayed right, which is what hid the corruption.
  const labels = [{ lead_id: "A" }, { lead_id: "B" }, { lead_id: "C" }, { lead_id: "D" }];
  // store.getLead resolves an id OR a key, like the real one.
  const present = ["B", "C", "D"].map((id) => ({ id, key: `K|${id}` }));
  const getLead = (idOrKey) => present.find((l) => l.id === idOrKey || l.key === idOrKey) ?? null;

  const plan = E.planLive(labels, getLead, 10);
  assert.deepEqual(plan.targets.map((t) => t.rec.lead_id), ["B", "C", "D"]);
  assert.deepEqual(plan.rest.map((t) => t.rec.lead_id), ["A"], "the purged label is reported, not dropped");

  const capped = E.planLive(labels, getLead, 2);
  assert.deepEqual(capped.targets.map((t) => t.rec.lead_id), ["B", "C"]);
  assert.deepEqual(capped.rest.map((t) => t.rec.lead_id), ["A", "D"], "over-cap labels are the rest, not re-runs of the tail");

  const seen = [...capped.targets, ...capped.rest].map((t) => t.rec.lead_id);
  assert.equal(seen.length, labels.length, "every label appears exactly once");
  assert.equal(new Set(seen).size, labels.length, "and none appears twice");

  // Live mode resolves by key too, so a re-detected lead is investigated.
  const byKey = E.planLive([{ lead_id: "stale", lead_key: "K|B" }], getLead, 10);
  assert.equal(byKey.targets.length, 1);
  assert.equal(byKey.targets[0].resolvedBy, "lead_key");
});

test("REGRESSION: runLive accounting — one pair per label, verdicts only from THIS run", async () => {
  const labels = [{ lead_id: "gone", label: "false_positive", lead_key: "K|gone" },
    { lead_id: "B", label: "true_positive" },
    { lead_id: "C", label: "false_positive" },
    { lead_id: "D", label: "true_positive" }];
  const leads = { B: { id: "B", key: "K|B", vector: "V", investigation: { verdict: "COINCIDENCE", confidence: 0.9 } },
    C: { id: "C", key: "K|C", vector: "V" }, D: { id: "D", key: "K|D", vector: "V" } };
  const deps = {
    getLead: (id) => leads[id] ?? null,
    investigateLead: async (lead) => {
      if (lead.id === "C") throw new Error("boom");
      return { ...lead, investigation: { verdict: "SUBSTANTIATED", confidence: 0.7, model: "m" } };
    },
  };
  const flags = { "confirm-spend": true, "allow-live-db": true, "max-leads": "2", "delay-ms": "0" };
  const r = await E.runLive({ prepare: () => ({ get: () => null }) }, labels, flags, deps);

  assert.equal(r.pairs.length, labels.length, "one pair per label — no drops, no duplicates");
  assert.equal(new Set(r.pairs.map((p) => p.lead_id)).size, labels.length);
  assert.deepEqual(r.live, { investigated: 1, failed: 1, skipped: 2, missing_leads: 1, over_cap: 1, max_leads: 2, usage_rows: null, tokens: null });

  const by = Object.fromEntries(r.pairs.map((p) => [p.lead_id, p]));
  assert.equal(by.B.verdict, "SUBSTANTIATED", "the fresh verdict is the prediction");
  assert.equal(by.C.verdict, null, "a failed investigation is a missing prediction");
  assert.equal(by.C.error, "boom");
  // D exists but was never investigated: reporting it as a missing lead row would
  // be a lie, and reusing its STORED verdict would mix two models into one score.
  assert.equal(by.D.missing_lead, false);
  assert.equal(by.D.not_investigated, "over_max_leads");
  assert.equal(by.D.verdict, null);
  assert.equal(by.gone.missing_lead, true);
  assert.equal(by.gone.not_investigated, "missing_lead");

  const c = E.counts(r.pairs);
  assert.equal(c.labels_total, 4);
  assert.equal(c.missing_lead, 1, "only the genuinely purged row counts as missing");
  assert.equal(c.no_verdict, 3);
});

test("REGRESSION: a stale lead_id still scores when the label's lead_key resolves", () => {
  // upsertLead dedupes on `key` and mints a NEW id when the row was purged, so an
  // id-only lookup scored a re-detected lead as missing_lead — and the dropped
  // labels are disproportionately the human-rejected FALSE POSITIVES, which
  // biases gate precision upward. lead_key is persisted precisely for this.
  const stored = { id: "new-uuid", key: "V|actor|beneficiary", vector: "V", investigation: { verdict: "COINCIDENCE", confidence: 0.82 } };
  const read = (_db, idOrKey) => (idOrKey === stored.id || idOrKey === stored.key ? stored : null);
  const label = { lead_id: "stale-uuid", lead_key: "V|actor|beneficiary", label: "false_positive" };

  const [pair] = E.pairsFromStored(null, [label], read);
  assert.equal(pair.missing_lead, false, "the label is scoreable, not lost");
  assert.equal(pair.verdict, "COINCIDENCE");
  assert.equal(pair.resolved_by, "lead_key", "the audit trail says which identifier matched");
  assert.equal(E.counts([pair]).key_resolved, 1);
  assert.equal(E.counts([pair]).scoreable, 1);

  // A label whose id resolves directly is still marked as such.
  const [direct] = E.pairsFromStored(null, [{ lead_id: "new-uuid", label: "true_positive" }], read);
  assert.equal(direct.resolved_by, "lead_id");
  // And a label matching nothing is still an honest missing row.
  const [missing] = E.pairsFromStored(null, [{ lead_id: "x", lead_key: "y", label: "true_positive" }], read);
  assert.equal(missing.missing_lead, true);
  assert.equal(missing.resolved_by, null);
});

test("REGRESSION: the DELTA section carries counts and marks thin sides", () => {
  // The delta is the one section read to decide whether a prompt change helped, and
  // it printed bare values: "gate.precision 0.5 → 1 (+0.500)" off two labels.
  const a = E.buildRun([pair("false_positive", "SUGGESTIVE", 0.6), pair("true_positive", "SUGGESTIVE", 0.6)], { minSample: 5 });
  const b = E.buildRun([pair("true_positive", "SUGGESTIVE", 0.6), pair("true_positive", "SUGGESTIVE", 0.6)], { minSample: 5 });
  const d = E.deltaAgainst(a, b);
  const gate = d.changes.find((c) => c.metric === "gate.precision");
  assert.equal(gate.from, 0.5);
  assert.equal(gate.to, 1);
  assert.deepEqual([gate.from_detail.num, gate.from_detail.den], [1, 2], "the numerator/denominator travel with the delta");
  assert.equal(gate.insufficient, true, "both sides are below the floor of 5");

  const text = E.renderSummary({ ...b, delta: d });
  const line = text.split("\n").find((l) => l.includes("gate.precision"));
  assert.match(line, /50% \(1\/2\) \[INSUFFICIENT\] → 100% \(2\/2\) \[INSUFFICIENT\]/);
  assert.ok(text.includes("below the min-sample floor"), "the report explains the marker");
  assert.ok(!/gate\.precision\s+0\.5 → 1/.test(text), "no bare rate survives in the delta");

  // With enough labels the marker disappears rather than crying wolf.
  const many = (label) => Array.from({ length: 6 }, () => pair(label, "SUGGESTIVE", 0.6));
  const big = E.deltaAgainst(E.buildRun(many("false_positive"), { minSample: 5 }), E.buildRun(many("true_positive"), { minSample: 5 }));
  assert.equal(big.changes.find((c) => c.metric === "gate.precision").insufficient, false);
});

test("REGRESSION: gate f1 inherits the insufficiency of its inputs", () => {
  // f1 has no counts of its own, so "f1: 1.00" printed clean off n=2 beside two
  // lines already marked INSUFFICIENT DATA.
  const thin = E.buildRun([pair("true_positive", "SUBSTANTIATED", 0.9), pair("true_positive", "SUGGESTIVE", 0.6)], { minSample: 5 });
  assert.equal(thin.gate.f1, 1);
  assert.equal(thin.gate.f1_insufficient, true);
  const text = E.renderSummary(thin);
  assert.match(text, /f1: 1\.00 — INSUFFICIENT DATA/);
  assert.ok(text.includes("do not quote it"));

  const fat = E.buildRun(Array.from({ length: 6 }, () => pair("true_positive", "SUGGESTIVE", 0.6)), { minSample: 5 });
  assert.equal(fat.gate.f1_insufficient, false);
  assert.ok(!E.renderSummary(fat).includes("f1: 1.00 — INSUFFICIENT"));
});

test("REGRESSION: a value-less numeric flag is an error, not a silent 1", () => {
  // Number(true) === 1: `--min-sample` with no value turned the whole small-sample
  // guard into a floor of ONE, and `--limit` labelled exactly one lead.
  assert.throws(() => L.numFlag(L.parseArgs(["--min-sample"]), "min-sample", 5), /needs a number/);
  assert.throws(() => L.numFlag(L.parseArgs(["--limit", "--dry-run"]), "limit", 20), /needs a number/);
  assert.throws(() => L.numFlag({ limit: "abc" }, "limit", 20), /must be an integer/);
  assert.throws(() => L.numFlag({ limit: "-3" }, "limit", 20), /must be an integer/);
  assert.throws(() => L.numFlag({ limit: "2.5" }, "limit", 20), /must be an integer/);
  assert.equal(L.numFlag({}, "limit", 20), 20, "absent means the default");
  assert.equal(L.numFlag({ limit: "5" }, "limit", 20), 5);
  assert.equal(L.numFlag({ "min-sample": "0" }, "min-sample", 5), 0, "an explicit 0 turns the floor off deliberately");
  // A flag typo is a usage error: one clear line at the CLI, not a stack trace.
  assert.throws(() => L.numFlag({}, "limit", 20, { min: 1 }) && L.numFlag({ limit: true }, "limit", 20),
    (err) => err.usage === true);
});

test("REGRESSION: a non-array `detectors` is malformed, not seven letter-detectors", () => {
  // A string has .length and iterates by CHARACTER, so scoreDetectors invented
  // detectors named c, f, i, l, n, o, t from "conflict". The rubric invites
  // hand-editing labels.jsonl, so this is an expected input.
  const { labels, malformed } = L.parseLabelsJsonl([
    JSON.stringify({ lead_id: "A", label: "true_positive", detectors: "conflict" }),
    JSON.stringify({ lead_id: "B", label: "true_positive", detectors: ["conflict", 7] }),
    JSON.stringify({ lead_id: "C", label: "true_positive" }),
  ].join("\n"));
  assert.deepEqual(malformed.map((m) => m.why), ["detectors is not an array"]);
  assert.deepEqual(labels.map((l) => l.lead_id), ["B", "C"]);
  assert.deepEqual(labels[0].detectors, ["conflict", "7"], "entries are normalised to strings");
  assert.deepEqual(labels[1].detectors, [], "a label with no detectors gets an empty array");

  // Belt and braces for direct callers of makePair.
  const p = E.makePair({ lead_id: "A", label: "true_positive", detectors: "conflict" }, null);
  assert.deepEqual(p.detectors, []);
  assert.deepEqual(E.scoreDetectors([p], { minSample: 1 }).map((r) => r.detector), ["(unattributed)"]);
});

test("REGRESSION: an ambiguous 1..10 confidence is counted, not silently read as percent", () => {
  // The prompt states no scale. A model answering 7 on a 1-10 scale becomes 0.07 —
  // "almost certainly innocent" — and the calibration table reports catastrophic
  // under-confidence on a model that was confident. The value is still normalised
  // (82 → 0.82 is the case that occurs today) but the GUESS is surfaced.
  assert.equal(L.isAmbiguousConfidenceScale(7), true);
  assert.equal(L.isAmbiguousConfidenceScale(10), true);
  assert.equal(L.isAmbiguousConfidenceScale(0.7), false);
  assert.equal(L.isAmbiguousConfidenceScale(82), false);
  assert.equal(L.isAmbiguousConfidenceScale(1), false);
  assert.equal(L.isAmbiguousConfidenceScale(null), false);

  const p = E.makePair({ lead_id: "A", label: "true_positive" }, lead({ investigation: { verdict: "SUBSTANTIATED", confidence: 7 } }));
  assert.equal(p.ambiguous_confidence_scale, true);
  assert.ok(Math.abs(p.claim_probability - 0.07) < 1e-9, "the heuristic still applies — it is just no longer silent");
  const run = E.buildRun([p], { minSample: 1 });
  assert.equal(run.counts.ambiguous_confidence_scale, 1);
  assert.match(E.renderSummary(run), /READ AS PERCENT/);
  assert.equal(E.buildRun([pair("true_positive", "SUBSTANTIATED", 0.9)], { minSample: 1 }).counts.ambiguous_confidence_scale, 0);
});

test("REGRESSION: wrapText is hard-bounded by width, even on an unbreakable token", () => {
  // A 200-char URL was emitted unwrapped: verified 147 columns on an 88-column
  // budget. Evidence bodies routinely contain them, so the review screen broke.
  const long = "https://example.gov.in/" + "a".repeat(200);
  for (const [w, indent] of [[88, "    "], [22, "    "], [20, "  "], [30, ""]]) {
    const out = L.wrapText(`intro text ${long} tail words here`, w, indent);
    for (const line of out.split("\n")) {
      assert.ok(line.length <= w, `width ${w}: "${line.slice(0, 30)}…" is ${line.length} cols`);
      assert.ok(line.startsWith(indent));
    }
    assert.equal(out.replace(/\s/g, "").length, `intro text ${long} tail words here`.replace(/\s/g, "").length,
      "hard-breaking must not lose or add characters");
  }
});

test("REGRESSION: an inherited property name at the prompt is unrecognised, not a crash", () => {
  // KEYS was a plain object, so typing `constructor` resolved to an inherited
  // FUNCTION, which is truthy — makeLabel then threw and killed the session.
  for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(L.keyToLabel(evil), null, `${evil} is not a label`);
  }
  assert.equal(L.keyToLabel("t"), "true_positive");
  assert.equal(L.keyToLabel(" F "), "false_positive", "trimmed and case-insensitive, as the prompt implies");
  assert.equal(L.keyToLabel("u"), "undecidable");
  assert.equal(L.keyToLabel(""), null);
  assert.equal(Object.getPrototypeOf(L.KEYS), null, "a prototype-less map has nothing to inherit");
});

test("REGRESSION: the resume set covers lead_key, so a re-detected lead is not relabelled", () => {
  // main() built the set from label IDS only, so filterUnlabeled's key path — which
  // a test already asserted — was never exercised in production: a purged and
  // re-detected lead was presented again and got a second, independent label.
  const records = [{ lead_id: "old-uuid", lead_key: "NETWORK_HUB|X" }, { lead_id: "plain" }];
  const ids = L.labeledIdentifiers(records);
  assert.deepEqual([...ids].sort(), ["NETWORK_HUB|X", "old-uuid", "plain"]);

  const leads = [lead({ id: "new-uuid", key: "NETWORK_HUB|X" }), lead({ id: "plain", key: "K|p" }), lead({ id: "fresh", key: "K|f" })];
  assert.deepEqual(L.filterUnlabeled(leads, ids).map((l) => l.id), ["fresh"]);
  assert.equal(L.strataCounts(leads, ids).labelled, 2);
});
