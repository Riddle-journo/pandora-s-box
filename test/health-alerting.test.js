// Regression suite for the false-alarm class of bug in the pipeline-health
// instrumentation.
//
// The organising principle: MOST of these cases assert that NOTHING fires. An
// alert that cries wolf on normal operation is worse than no alert, because it
// trains the operator to ignore the report — and this report is the automation
// gate (health.js exits 1 on ROTTED / VOLUME_DROP). Every "does not fire" test
// below corresponds to a path that DID fire on ordinary, healthy operation:
//
//   1. `<source>#<phase>` telemetry rows written into fetch_runs, where
//      sourceHealth() reads every distinct value as a configured source and
//      classifyHealth() classifies a 0%-ok one as ROTTED. One transient 503
//      permanently reddened the gate.
//   2. fetchText/fetchJson/fetchPdfText defaulting the ledger key to the URL's
//      hostname, so article-body.js's arbitrary news outlets became hundreds of
//      brand-new 0%-ok "sources".
//   3. A SEBI parse-miss on "this politician has no enforcement orders" — the
//      normal case for essentially the whole 4,559-politician roster.
//   4. A pdf_text_layer parse-miss per scanned PDF while PDF_OCR is off, which
//      is the documented default.
//   5. VOLUME_DROP on a change in the COHORT of politicians ingested (an ops
//      console run-on-a-SET over 6 MLAs) rather than a change in the source.
//
// Synthetic data only: no network, no LLM, temp DB.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-healthalert-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
// This suite asserts on the persistent ledger, so it opts telemetry IN — against
// the temp DB above, never data/pandoros.db.
process.env.PANDOROS_FETCH_TELEMETRY = "1";
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch { /* nothing to clean */ }
}

const {
  noteFetchFailure, noteParseMiss, noteTruncation,
  fetchFailureInventory, resetFetchFailureInventory, telemetryEnabled,
} = await import("../server/fetchers/observe.js");
const { fetchPdfText, resetPdfOcrNotice } = await import("../server/fetchers/http.js");
const { shouldFlagMissingOrderLinks } = await import("../server/fetchers/sebi-orders.js");
const {
  classifyVolume, classifyHealth, volumeThresholds, detectVolumeDrops,
} = await import("../server/platform/health.js");
const {
  recordFetchRun, sourceHealth, fetchFailureHealth, fetchRunSourceCounts,
} = await import("../server/store/store.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* handle not released yet */ }
  }
});

const keys = () => fetchFailureInventory().map((f) => f.key);

// ── 1. Phase telemetry must not enter the SOURCE vocabulary ─────────────

test("normal operation's phase telemetry does NOT create pseudo-sources or fake rot", async () => {
  resetFetchFailureInventory();
  // Exactly the notes ordinary operation produces in a 14-day window:
  await noteParseMiss("sebi", "order_links", { url: "https://sebi.gov.in/s", bytes: 9000, expected: "order PDF links" });
  await noteFetchFailure("cag.gov.in", "http_text", "HTTP 503", { url: "https://cag.gov.in/x", ledger: false });
  await noteTruncation("cppp", "search", { got: 74, cap: 50 });
  // …plus two genuinely healthy sources with real runs.
  for (let i = 0; i < 20; i++) {
    recordFetchRun({ source: "sebi", politician_id: `p${i}`, ok: 1, items: 0 });
    recordFetchRun({ source: "news", politician_id: `p${i}`, ok: 1, items: 5 });
  }

  const health = sourceHealth(1);
  assert.deepEqual(health.map((h) => h.source).sort(), ["news", "sebi"],
    "the source vocabulary is exactly the two sources that actually ran");

  const { rotted, quiet } = classifyHealth(health, ["news", "sebi"], []);
  assert.deepEqual(rotted, [], "NOTHING is rotted — the instrument does not manufacture rot");
  assert.deepEqual(quiet.map((q) => q.source), ["sebi"],
    "sebi is QUIET (ran clean, zero items) — reported, but never treated as broken");

  // The findings are not lost, they live in their own ledger under their own key.
  const persisted = fetchFailureHealth({ days: 1 }).map((f) => f.key);
  assert.ok(persisted.includes("sebi#order_links"));
  assert.ok(persisted.includes("cppp#search_page_cap"));
  assert.equal(persisted.includes("cag.gov.in#http_text"), false,
    "an unattributed hostname failure is in-process only");
  assert.ok(keys().includes("cag.gov.in#http_text"), "…but still visible to the operator now");
});

test("no fetch_runs.source value is ever a composite or a hostname", () => {
  for (const r of fetchRunSourceCounts()) {
    assert.equal(String(r.source).includes("#"), false, `composite key leaked: ${r.source}`);
    assert.doesNotMatch(String(r.source), /\.[a-z]{2,}$/i, `hostname key leaked: ${r.source}`);
  }
});

// ── 2. Message honesty (findings 4b and 8) ─────────────────────────────

test("a truncation row does not claim an exactness the caller cannot deliver", async () => {
  resetFetchFailureInventory();
  // cppp pushes up to 25 rows per search term BEFORE testing `>= 50`, so `got`
  // legitimately lands anywhere in 50..74. "exactly the requested cap of 50"
  // beside got=74 left an operator unable to tell which number was the cap.
  await noteTruncation("cppp", "search", { got: 74, cap: 50 });
  const msg = fetchFailureInventory()[0].last_message;
  assert.match(msg, /took 74 row\(s\), at or past the cap of 50/);
  assert.doesNotMatch(msg, /exactly/, "no false claim of exactness");
});

test("a parse miss reports the character count it actually got", async () => {
  resetFetchFailureInventory();
  await noteParseMiss("x", "pdf_text_layer", { bytes: 4096, got: 25, expected: "characters" });
  assert.match(fetchFailureInventory()[0].last_message, /parsed 25 characters from 4096 bytes/,
    "a row reading 'parsed 0' next to a 25-character return value is unactionable");
  // The zero default still reads correctly for a true zero.
  resetFetchFailureInventory();
  await noteParseMiss("x", "rows", { bytes: 10, expected: "rows" });
  assert.match(fetchFailureInventory()[0].last_message, /parsed 0 rows from 10 bytes/);
});

// ── 3. SEBI: "no orders for this politician" is not a parse failure ─────

test("SEBI: the normal no-orders case does NOT flag a parse miss", () => {
  // The overwhelmingly common case: the search page loads (200, non-empty) and
  // simply has no order rows, so the politician's name is nowhere in the rendered
  // listing text and pageCtx is null. Flagging this fired once per politician per
  // run — thousands of rows describing normal operation.
  const html = "<html><body><table><tr><td>SEBI Orders</td></tr></table></body></html>";
  assert.equal(shouldFlagMissingOrderLinks(html, null), false);
  // Explicit "no records found" is likewise the correct answer, not a failure.
  assert.equal(
    shouldFlagMissingOrderLinks("<div>No records found for your search.</div>", "…Some Netaji…"),
    false);
  assert.equal(
    shouldFlagMissingOrderLinks("<p>Search returned no results.</p>", "…Some Netaji…"),
    false);
});

test("SEBI: a redesign that surfaces the person but yields no document links DOES flag", () => {
  // The signature we actually want: SEBI matched this person (their name is in
  // the rendered listing, which is why a fallback excerpt exists) and yet we
  // extracted no order PDF. That is "we failed to parse what upstream returned".
  const html = "<html><body><div class='result'>Order against Some Netaji dated 2024</div></body></html>";
  assert.equal(shouldFlagMissingOrderLinks(html, "…Order against Some Netaji dated 2024…"), true);
});

// ── 4. Scanned PDFs while OCR is off (the documented default) ──────────

// A 1-page PDF with no text content stream: pdf-parse extracts (almost) nothing,
// exactly like the scanned government PDFs the OCR fallback exists for.
const TEXTLESS_PDF = (() => {
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (const o of objs) { offsets.push(body.length); body += o; }
  const xref = body.length;
  let out = body + `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
})();

const pdfRes = (buf) => ({
  ok: true, status: 200, headers: new Map(),
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
});

test("with PDF_OCR off (the default), scanned PDFs record ONE capability finding, not one per document", async () => {
  resetFetchFailureInventory();
  resetPdfOcrNotice();
  const prev = process.env.PDF_OCR;
  delete process.env.PDF_OCR;
  try {
    for (const n of [1, 2, 3]) {
      const text = await fetchPdfText(`https://cag.gov.in/scan${n}.pdf`, {
        source: "cag", fetchImpl: async () => pdfRes(TEXTLESS_PDF),
      });
      // pdf-parse yields only its page separator here — under the 40-char floor,
      // i.e. the no-text-layer branch, and a real illustration of why the
      // hardcoded "parsed 0 characters" message was wrong.
      assert.ok(text.length < 40, `no usable text layer (got ${text.length} chars)`);
    }
    // ONE finding about our own configuration, not three about the upstream.
    assert.deepEqual(keys(), ["pdf_ocr#capability_disabled"]);
    assert.equal(fetchFailureInventory()[0].count, 1, "recorded once per process, like pdfWarned");
    assert.equal(keys().includes("cag#pdf_text_layer"), false,
      "a globally-off capability is not a per-document parse miss");
    assert.match(fetchFailureInventory()[0].last_message, /PDF_OCR is not set to 1/,
      "the message names the fix, not the document");
  } finally {
    if (prev === undefined) delete process.env.PDF_OCR; else process.env.PDF_OCR = prev;
  }
});

test("a PDF that downloads but 404s/errors is still recorded per document", async () => {
  resetFetchFailureInventory();
  const text = await fetchPdfText("https://cag.gov.in/gone.pdf", {
    source: "cag", fetchImpl: async () => ({ ok: false, status: 404, headers: new Map() }),
  });
  assert.equal(text, "");
  assert.deepEqual(keys(), ["cag#pdf_download"], "a real transport failure is not suppressed");
});

// ── 5. VOLUME_DROP must track the SOURCE, not the operator's cohort ────

const day = (source, dayIdx, oks, avg) => ({
  source, day: `2026-07-${String(dayIdx).padStart(2, "0")}`,
  runs: oks, oks, items: oks * avg, avg_items: avg,
});

test("an ops-console run over 6 MLAs does NOT accuse a healthy MP-only source", () => {
  // FETCHERS is a flat registry: sansad runs for every politician and returns []
  // for an MLA (no MP directory entry) while still recording ok=1, items=0. The
  // operator selects 6 state MLAs in run-on-a-SET, and nothing else runs that day.
  // Before the cohort guard: oks=6 clears minRuns=5, avg=0 vs baseline 8, ratio 0
  // → VOLUME_DROP → CLI exit 1. Nothing upstream changed at all.
  const series = [
    day("sansad", 1, 300, 8), day("sansad", 2, 300, 8),
    day("sansad", 3, 300, 8), day("sansad", 4, 300, 8),
    day("sansad", 5, 6, 0),
  ];
  const v = classifyVolume(series);
  assert.equal(v.status, "INCOMPARABLE_SAMPLE",
    "a 6-run day is not a comparable sample to a 300-run day, so no verdict is issued");
  assert.equal(v.ratio, null, "and no ratio is offered as if it meant something");
  assert.equal(v.latest_oks, 6);
  assert.equal(v.baseline_oks, 300);
  assert.ok(v.run_ratio < 0.5, "the arithmetic behind the suppression is shown");

  // It must not reach the gate through detectVolumeDrops or classifyHealth either.
  assert.deepEqual(detectVolumeDrops(series).drops, []);
  assert.deepEqual(classifyHealth([], [], series).volumeDrops, []);
});

test("a REAL collapse over a comparable cohort still fires", () => {
  // Same numbers, same source, but today's run covered the usual roster. Yield
  // gone with the cohort held constant is exactly what VOLUME_DROP is for.
  const series = [
    day("sansad", 1, 300, 8), day("sansad", 2, 300, 8),
    day("sansad", 3, 300, 8), day("sansad", 4, 300, 8),
    day("sansad", 5, 290, 0),
  ];
  const v = classifyVolume(series);
  assert.equal(v.status, "VOLUME_DROP", "the guard suppresses noise, not signal");
  assert.equal(v.ratio, 0);
  assert.ok(v.run_ratio > 0.9);
});

test("a modestly smaller ingest day is still judged — the guard is not a blanket mute", () => {
  const series = [
    day("news", 1, 300, 50), day("news", 2, 300, 50),
    day("news", 3, 300, 50), day("news", 4, 200, 1), // 2/3 the cohort, yield gone
  ];
  assert.equal(classifyVolume(series).status, "VOLUME_DROP");
});

test("the cohort guard is env-tunable and can be disabled", () => {
  const series = [
    day("s", 1, 300, 8), day("s", 2, 300, 8), day("s", 3, 300, 8), day("s", 5, 6, 0),
  ];
  assert.equal(classifyVolume(series, { ...volumeThresholds(), minRunRatio: 0 }).status, "VOLUME_DROP",
    "minRunRatio=0 restores the old behaviour for anyone who wants it");
});

// ── Finding 7: classifyVolume is documented PURE, so it must not depend on
//    an undocumented input ordering. ─────────────────────────────────────

test("classifyVolume gives the same verdict on a newest-first series", () => {
  const asc = [day("z", 1, 30, 10), day("z", 2, 30, 10), day("z", 3, 30, 10), day("z", 4, 30, 0)];
  const a = classifyVolume(asc);
  const b = classifyVolume([...asc].reverse());
  assert.equal(a.status, "VOLUME_DROP");
  assert.equal(b.status, a.status, "a reversed series previously reported OK — inverting the verdict");
  assert.equal(b.latest_day, a.latest_day, "and named the wrong day");
  assert.equal(b.ratio, a.ratio);
  // Shuffled input too — the function sorts, it does not trust.
  const shuffled = [asc[2], asc[0], asc[3], asc[1]];
  assert.equal(classifyVolume(shuffled).latest_day, "2026-07-04");
});

// ── Finding 9: the live-DB write guard must not hinge on a runner detail ─

test("telemetry persistence is off for a test run however the runner was invoked", () => {
  const prevFlag = process.env.PANDOROS_FETCH_TELEMETRY;
  const prevCtx = process.env.NODE_TEST_CONTEXT;
  const prevEnv = process.env.NODE_ENV;
  const prevArgv = process.argv;
  try {
    delete process.env.PANDOROS_FETCH_TELEMETRY;
    // Simulate `node test/fetchers-http.test.js` — a plain run with none of
    // node --test's child-process isolation. This sailed straight through the old
    // NODE_TEST_CONTEXT-only guard and would have written to data/pandoros.db.
    delete process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_ENV;
    process.argv = ["node", "C:\\repo\\test\\fetchers-http.test.js"];
    assert.equal(telemetryEnabled(), false, "a repo test file is recognised by path, not by env");

    process.argv = ["node", "--test", "test/health-alerting.test.js"];
    assert.equal(telemetryEnabled(), false, "the --test PARENT process is covered too");

    // A real production entrypoint still persists — an opt-in flag would have
    // silently disabled the instrument in production.
    process.argv = ["node", "/srv/app/server/index.js"];
    assert.equal(telemetryEnabled(), true);

    // And the explicit flags still win in both directions.
    process.env.PANDOROS_FETCH_TELEMETRY = "0";
    assert.equal(telemetryEnabled(), false);
    process.env.PANDOROS_FETCH_TELEMETRY = "1";
    process.argv = ["node", "test/x.test.js"];
    assert.equal(telemetryEnabled(), true);
  } finally {
    process.argv = prevArgv;
    if (prevFlag === undefined) delete process.env.PANDOROS_FETCH_TELEMETRY; else process.env.PANDOROS_FETCH_TELEMETRY = prevFlag;
    if (prevCtx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = prevCtx;
    if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
  }
});
