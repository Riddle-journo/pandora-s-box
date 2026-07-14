// writeFileAtomic: replaces content atomically, works when target exists,
// cleans its temp file on failure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileAtomic } from "../server/util/fs-atomic.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-atomic-"));

test("writes a new file and replaces an existing one", () => {
  const f = path.join(dir, "a.json");
  writeFileAtomic(f, '{"v":1}');
  assert.equal(fs.readFileSync(f, "utf8"), '{"v":1}');
  writeFileAtomic(f, '{"v":2}');
  assert.equal(fs.readFileSync(f, "utf8"), '{"v":2}');
  // no temp files left behind
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
});

test("failure (bad target dir) leaves no temp file and throws", () => {
  const f = path.join(dir, "missing-subdir", "b.json");
  assert.throws(() => writeFileAtomic(f, "x"));
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
});
