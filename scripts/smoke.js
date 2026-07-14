// scripts/smoke.js
//
// Smoke test: boots the real server (server/index.js) as a child process
// against a throwaway temp SQLite DB, then hits a few HTTP endpoints to
// confirm the process actually comes up and behaves. Prints "SMOKE PASS"
// and exits 0 on success, or "SMOKE FAIL: <reason>" and exits 1 on any
// failure (including timeout).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

const PORT = "3999";
const BASE_URL = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-smoke-"));
  const dbPath = path.join(tmpDir, "smoke.db");

  const child = spawn("node", ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT,
      PANDOROS_DB_PATH: dbPath,
      OPS_INPROC_WORKER: "0",
      ADMIN_TOKEN: "smoke-test-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childOutput = "";
  child.stdout.on("data", (d) => {
    childOutput += d.toString();
  });
  child.stderr.on("data", (d) => {
    childOutput += d.toString();
  });

  let failureReason = null;

  try {
    // Poll /api/parameters until it returns HTTP 200, up to 30s.
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE_URL}/api/parameters`);
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // server not up yet; keep polling
      }
      await sleep(500);
    }

    if (!ready) {
      throw new Error(
        `server did not respond with HTTP 200 on /api/parameters within 30s. Child output:\n${childOutput}`
      );
    }

    // GET /api/politicians must return HTTP 200 and parseable JSON.
    const politiciansRes = await fetch(`${BASE_URL}/api/politicians`);
    if (politiciansRes.status !== 200) {
      throw new Error(
        `GET /api/politicians returned HTTP ${politiciansRes.status}, expected 200`
      );
    }
    const politiciansText = await politiciansRes.text();
    try {
      JSON.parse(politiciansText);
    } catch (err) {
      throw new Error(
        `GET /api/politicians returned unparseable JSON: ${err.message}`
      );
    }

    // GET /api/admin/tips with no token must return HTTP 401.
    const tipsRes = await fetch(`${BASE_URL}/api/admin/tips`);
    if (tipsRes.status !== 401) {
      throw new Error(
        `GET /api/admin/tips with no token returned HTTP ${tipsRes.status}, expected 401`
      );
    }
  } catch (err) {
    failureReason = err.message;
  } finally {
    if (process.platform === "win32") {
      // On Windows, child.kill() can trigger a libuv assertion crash in the
      // parent process when racing with other async handles. Use taskkill
      // to terminate the child (and its tree) at the OS level instead.
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      child.kill();
    }
  }

  if (failureReason === null) {
    console.log("SMOKE PASS");
    process.exit(0);
  } else {
    console.log(`SMOKE FAIL: ${failureReason}`);
    process.exit(1);
  }
}

main();
