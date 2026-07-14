// The structured logger must keep the ops-console live-log contract:
// a log call made inside a job's async context lands in that job's ring
// buffer; outside a job it passes through without pushing anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import { logger } from "../server/util/log.js";
import { jobLogContext } from "../server/util/job-context.js";
import { tail, clear } from "../server/ops-log.js";

test("log inside a job context lands in that job's ops ring buffer", async () => {
  const log = logger("test");
  clear("job-log-test");
  await jobLogContext.run("job-log-test", async () => {
    log.info("hello from inside the job");
    log.warn({ url: "https://x.example", status: 500 }, "fetch failed");
  });
  const lines = tail("job-log-test").lines.map((l) => l.line ?? l);
  const joined = lines.join("\n");
  assert.match(joined, /hello from inside the job/);
  assert.match(joined, /fetch failed/);
  assert.match(joined, /x\.example/); // structured fields serialized into the line
});

test("log outside any job context does not throw and pushes nothing", () => {
  const log = logger("test");
  clear("job-log-none");
  log.info("outside any job");
  const lines = tail("job-log-none").lines;
  assert.equal(lines.length, 0);
});

test("different jobs' logs stay separated", async () => {
  const log = logger("test");
  clear("job-a"); clear("job-b");
  await jobLogContext.run("job-a", async () => log.info("alpha line"));
  await jobLogContext.run("job-b", async () => log.info("beta line"));
  const a = JSON.stringify(tail("job-a").lines);
  const b = JSON.stringify(tail("job-b").lines);
  assert.match(a, /alpha line/);
  assert.doesNotMatch(a, /beta line/);
  assert.match(b, /beta line/);
});
