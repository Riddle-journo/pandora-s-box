// Unit test for the Rajya Sabha question-PDF fulltext plumbing added to
// server/fetchers/sansad-mp.js. The RS path now reuses the SAME helper as the
// Lok Sabha path — attachQuestionFulltext — which selects up to
// SANSAD_FULLTEXT_LIMIT question records that carry a PDF path and merges their
// extracted text. The PDF fetcher is INJECTED here, so the test runs with NO
// network and never touches pdf-parse.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// sansad-mp.js transitively imports store.js (via entities.js), which opens the
// DB at import time. Point it at a throwaway DB BEFORE that import (the dynamic
// import below), so running the suite never touches the real pandoros.db —
// exactly like the other DB-touching tests. Also pin the shared fulltext cap so
// the default-limit assertion is deterministic (the module reads
// SANSAD_FULLTEXT_LIMIT once, at import time).
process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-sansadrs-${process.pid}.db`);
process.env.SANSAD_FULLTEXT_LIMIT = "2";
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const { attachQuestionFulltext } = await import("../server/fetchers/sansad-mp.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// A body comfortably over the helper's 120-char "usable text" gate.
const LONG = "This is the verbatim question and answer body text. ".repeat(6);

// n fake RS-style question records, each carrying the injected PDF-path field.
const mkRecords = (n, field = "questionsFilePath") =>
  Array.from({ length: n }, (_, i) => ({
    [field]: `https://sansad.in/rs/q${i}.pdf`,
    quesNo: i + 1,
    date: `2026-01-0${(i % 9) + 1}`,
    ministry: `Ministry ${i}`,
  }));

// A counting fake fetcher: records how many PDFs were actually fetched (proves
// the cap) and echoes a per-URL body (proves the merge). State is on the object
// so `f.calls` reads live.
function countingFetch(bodyFor = () => LONG) {
  const state = { calls: 0, urls: [] };
  state.fn = async (url) => { state.calls++; state.urls.push(url); return bodyFor(url); };
  return state;
}

test("respects an explicit cap — fetches at most `limit` PDFs", async () => {
  const f = countingFetch();
  const out = await attachQuestionFulltext(mkRecords(10), {
    pathField: "questionsFilePath", limit: 3, fetchPdf: f.fn,
  });
  assert.equal(f.calls, 3, "only `limit` PDFs are fetched even with 10 candidates");
  assert.match(out, /VERBATIM QUESTION & ANSWER TEXT \(most recent 3\)/);
});

test("defaults to the shared SANSAD_FULLTEXT_LIMIT env cap (=2 here)", async () => {
  const f = countingFetch();
  const out = await attachQuestionFulltext(mkRecords(10), {
    pathField: "questionsFilePath", fetchPdf: f.fn, // no explicit limit
  });
  assert.equal(f.calls, 2, "no explicit limit → falls back to the env cap the LS path uses");
  assert.match(out, /most recent 2/);
});

test("merges the fetched text (and header) into the returned block", async () => {
  const f = countingFetch((url) => `BODY-FOR ${url} ${LONG}`);
  const out = await attachQuestionFulltext(mkRecords(2), {
    pathField: "questionsFilePath", limit: 5, fetchPdf: f.fn,
  });
  // Header format matches the Lok Sabha path exactly, and both bodies are present.
  assert.match(out, /── Q\.1 \(2026-01-01, Ministry 0\) ──/);
  assert.match(out, /BODY-FOR https:\/\/sansad\.in\/rs\/q0\.pdf/);
  assert.match(out, /BODY-FOR https:\/\/sansad\.in\/rs\/q1\.pdf/);
});

test("selects only records that carry the PDF-path field", async () => {
  const records = [
    { quesNo: 1, date: "2026-01-01", ministry: "No PDF here" }, // no path → skipped
    { questionsFilePath: "https://sansad.in/rs/has.pdf", quesNo: 2, date: "2026-01-02", ministry: "Has PDF" },
  ];
  const f = countingFetch();
  const out = await attachQuestionFulltext(records, {
    pathField: "questionsFilePath", limit: 10, fetchPdf: f.fn,
  });
  assert.equal(f.calls, 1, "the record without the path field is not fetched");
  assert.match(out, /most recent 1/);
});

test("drops PDFs whose extracted text is too short (<=120 chars)", async () => {
  const f = countingFetch(() => "tiny"); // below the 120-char usable-text gate
  const out = await attachQuestionFulltext(mkRecords(3), {
    pathField: "questionsFilePath", limit: 3, fetchPdf: f.fn,
  });
  assert.equal(f.calls, 3, "all candidates are still fetched");
  assert.equal(out, "", "but nothing is merged when every body is too short");
});

test("limit 0 disables fulltext and fetches nothing", async () => {
  const f = countingFetch();
  const out = await attachQuestionFulltext(mkRecords(5), {
    pathField: "questionsFilePath", limit: 0, fetchPdf: f.fn,
  });
  assert.equal(f.calls, 0);
  assert.equal(out, "");
});

test("never throws when the PDF fetcher rejects — degrades to skip", async () => {
  const throwing = async () => { throw new Error("network boom"); };
  const out = await attachQuestionFulltext(mkRecords(3), {
    pathField: "questionsFilePath", limit: 3, fetchPdf: throwing,
  });
  assert.equal(out, "", "a throwing fetcher yields no fulltext, not an exception");
});

test("empty / non-array input returns an empty string", async () => {
  assert.equal(await attachQuestionFulltext([], { pathField: "questionsFilePath" }), "");
  assert.equal(await attachQuestionFulltext(null, { pathField: "questionsFilePath" }), "");
});
