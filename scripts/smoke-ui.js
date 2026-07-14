// scripts/smoke-ui.js
//
// Browser smoke test: boots the real server against a throwaway temp SQLite
// DB (same pattern as smoke.js), then drives a headless Chromium through
// every public hash route and fails on ANY page error or console error.
// This is the regression net for the frontend module split — the node:test
// suite never loads the frontend at all.
//
//   npm run smoke:ui
//
// Skips gracefully (exit 0, "SMOKE-UI SKIP") if Playwright's Chromium isn't
// installed on this machine — it's a heavy optional install and CI omits it.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

const PORT = "3998";
const BASE_URL = `http://127.0.0.1:${PORT}`;

// route hash → a selector that must be visible once the view renders
const ROUTES = [
  { hash: "#/",           sel: "#home-view" },
  { hash: "#/browse",     sel: "#browse-view" },
  { hash: "#/compare",    sel: "#compare-view" },
  { hash: "#/govwatch",   sel: "#govwatch-view" },
  { hash: "#/scorecards", sel: "#scorecards-view" },
  { hash: "#/issues",     sel: "#issues-view" },
  { hash: "#/leaderboard", sel: "#leaderboard-view" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.log("SMOKE-UI SKIP: playwright not installed");
    process.exit(0);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-smoke-ui-"));
  const dbPath = path.join(tmpDir, "smoke-ui.db");

  const child = spawn("node", ["server/index.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT,
      PANDOROS_DB_PATH: dbPath,
      OPS_INPROC_WORKER: "0",
      ADMIN_TOKEN: "smoke-ui-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (d) => { childOutput += d.toString(); });
  child.stderr.on("data", (d) => { childOutput += d.toString(); });

  let browser = null;
  let failureReason = null;

  try {
    // wait for /healthz
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE_URL}/healthz`);
        if (res.status === 200 && (await res.json()).ok === true) { ready = true; break; }
      } catch { /* not up yet */ }
      await sleep(500);
    }
    if (!ready) throw new Error(`server not healthy within 30s. Child output:\n${childOutput}`);

    try {
      browser = await chromium.launch();
    } catch (err) {
      // Chromium binary missing (playwright installed but browsers not downloaded)
      console.log(`SMOKE-UI SKIP: chromium not available (${err.message.split("\n")[0]})`);
      return;
    }

    const page = await browser.newPage();
    const problems = [];
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

    for (const { hash, sel } of ROUTES) {
      await page.evaluate((h) => { window.location.hash = h; }, hash);
      try {
        await page.waitForSelector(`${sel}:not([hidden])`, { timeout: 5000 });
      } catch {
        problems.push(`route ${hash}: ${sel} never became visible`);
      }
    }

    // let any late async errors surface
    await sleep(500);

    if (problems.length > 0) {
      throw new Error(`\n  - ${problems.join("\n  - ")}`);
    }
  } catch (err) {
    failureReason = err.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  }

  if (failureReason === null) {
    console.log("SMOKE-UI PASS");
    process.exit(0);
  } else {
    console.log(`SMOKE-UI FAIL: ${failureReason}`);
    process.exit(1);
  }
}

main();
