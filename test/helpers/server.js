// Integration test harness: boots the real Express app on an ephemeral port
// against a throwaway SQLite DB in the OS temp dir. Env-first dynamic-import
// pattern — all env vars are set BEFORE importing server/index.js so the app
// and its store pick them up at import time. Only ONE test file may import
// server/index.js per process (node:test isolates each file), so each test
// FILE must call startTestServer() exactly once.
import fs from "fs";
import os from "os";
import path from "path";

export async function startTestServer() {
  process.env.PB_NO_LISTEN = "1";
  process.env.PANDOROS_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pb-api-")), "test.db");
  process.env.ADMIN_TOKEN = "test-admin-token";
  process.env.RATE_LIMIT ??= "0"; // default OFF (suite hits the app from one IP); api-ratelimit.test.js forces it on

  const mod = await import("../../server/index.js");
  const server = mod.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    baseUrl: "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((r) => server.close(r)),
    adminToken: "test-admin-token",
  };
}
