// Guard for the Rajya Sabha importer's MyNeta match. The old fuzzy match (name
// similarity >= 0.65, no other check) handed same-named people each other's sworn
// affidavits — e.g. an RS "Anurag Sharma" got the Jhansi BJP one's asset/criminal
// record. selectMynetaMatch is the tightened, pure acceptance rule; these cases are
// the four real mis-assignments repaired by server/fix-rs-myneta-mismatch.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// import-rs.js transitively imports store.js, which opens the DB at import time.
// Point it at a throwaway DB BEFORE that import (via dynamic import), so running the
// suite never touches the real pandoros.db — exactly like the other DB-touching tests.
process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-importrs-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const { selectMynetaMatch } = await import("../server/entities/import-rs.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const row = (cname, id, year = 2024, slug = "LokSabha2024") => ({ cname, id, slug, year });

test("rejects a same-surname candidate with a DIFFERENT first name (Nitin ≠ Makrand)", () => {
  const rows = [row("Makrand Laxmanrao Jadhav (Patil)", "809", 2024, "Maharashtra2024")];
  assert.equal(selectMynetaMatch({ name: "Nitin Laxmanrao Jadhav Patil" }, rows), null);
});

test("still accepts a clean same-name match", () => {
  const best = selectMynetaMatch({ name: "Anurag Sharma" }, [row("Anurag Sharma", "7176")]);
  assert.ok(best, "identical name clears the bar");
  assert.equal(best.id, "7176");
});

test("rejects weak name overlap outright", () => {
  assert.equal(selectMynetaMatch({ name: "Rajesh Gupta" }, [row("Sunil Kumar Yadav", "1")]), null);
});

test("leading-name-token guard blocks a high-overlap but wrong-first-name match", () => {
  // 4/5 tokens overlap → score 0.8 clears the threshold, but the first name differs,
  // so the leading-token guard must still reject it.
  const rows = [row("Sunil Kumar Sinha Verma Gupta", "2")];
  assert.equal(selectMynetaMatch({ name: "Anil Kumar Sinha Verma Gupta" }, rows), null);
});

test("prefers the most recent election among valid matches", () => {
  const rows = [row("Ravi Verma", "10", 2014, "LS2014"), row("Ravi Verma", "20", 2024, "LS2024")];
  assert.equal(selectMynetaMatch({ name: "Ravi Verma" }, rows).id, "20");
});

test("no rows / empty name → no match", () => {
  assert.equal(selectMynetaMatch({ name: "Ravi Verma" }, []), null);
  assert.equal(selectMynetaMatch({ name: "" }, [row("Ravi Verma", "1")]), null);
});
