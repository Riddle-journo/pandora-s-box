// AsyncLocalStorage log routing: two jobs running CONCURRENTLY must each get
// only their own console output in their ops-log buffer, across await points.
// Also: console.log outside any job still reaches the real console untouched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-alslog-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch {}
}

const { enqueueJob, claimNextJob } = await import("../server/store.js");
const { runJob } = await import("../server/worker.js");
const opsLog = await import("../server/ops-log.js");
const { sleep } = await import("../server/util/timing.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

test("two concurrent jobs' console lines land only in their own buffers", async () => {
  const handlers = {
    async chatty_a() {
      console.log("A-one");
      await sleep(20);
      console.warn("A-two");
      await sleep(20);
      console.log("A-three");
      return { ok: 1 };
    },
    async chatty_b() {
      console.log("B-one");
      await sleep(30);
      console.error("B-two");
      return { ok: 1 };
    },
  };
  enqueueJob({ type: "chatty_a" });
  enqueueJob({ type: "chatty_b" });
  const jobA = claimNextJob();
  const jobB = claimNextJob();
  assert.ok(jobA && jobB, "both claimed");

  // Run truly concurrently — their awaits interleave.
  await Promise.all([runJob(jobA, handlers), runJob(jobB, handlers)]);

  const linesA = opsLog.tail(jobA.id).lines.map((l) => l.line ?? l.text ?? l);
  const linesB = opsLog.tail(jobB.id).lines.map((l) => l.line ?? l.text ?? l);
  const textA = JSON.stringify(linesA);
  const textB = JSON.stringify(linesB);

  for (const m of ["A-one", "A-two", "A-three"]) assert.ok(textA.includes(m), `A buffer has ${m}`);
  for (const m of ["B-one", "B-two"]) assert.ok(textB.includes(m), `B buffer has ${m}`);
  assert.ok(!textA.includes("B-one") && !textA.includes("B-two"), "no B lines leaked into A");
  assert.ok(!textB.includes("A-"), "no A lines leaked into B");
  // The done-line lands in the right buffer too.
  assert.ok(textA.includes(jobA.id), "A outcome line in A buffer");
  assert.ok(!textA.includes(jobB.id), "B outcome line not in A buffer");
});

test("console output outside any job does not enter job buffers", async () => {
  const handlers = { quiet: async () => ({}) };
  enqueueJob({ type: "quiet" });
  const job = claimNextJob();
  await runJob(job, handlers);
  const before = opsLog.tail(job.id).lines.length;
  console.log("outside-any-job marker"); // patched console, but no ALS store
  const after = opsLog.tail(job.id).lines.length;
  assert.equal(after, before, "outside-line did not enter the finished job's buffer");
});
