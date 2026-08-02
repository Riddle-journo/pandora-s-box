import test from "node:test";
import assert from "node:assert/strict";
import { dataGovKey } from "../server/platform/config.js";

const VARS = ["DATA_GOV_IN_KEY", "DATA_GOV_API_KEY", "DATA_GOV_KEY", "OGD_API_KEY"];
let saved = {};

test.beforeEach(() => {
  saved = {};
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
});

test.afterEach(() => {
  for (const v of VARS) {
    if (saved[v] == null) delete process.env[v]; else process.env[v] = saved[v];
  }
});

test("dataGovKey returns empty string when no env var is set", () => {
  assert.equal(dataGovKey(), "");
});

test("dataGovKey prefers DATA_GOV_IN_KEY over all others", () => {
  process.env.DATA_GOV_IN_KEY = "in-key";
  process.env.DATA_GOV_API_KEY = "api-key";
  process.env.DATA_GOV_KEY = "plain-key";
  process.env.OGD_API_KEY = "ogd-key";
  assert.equal(dataGovKey(), "in-key");
});

test("dataGovKey falls back to DATA_GOV_API_KEY when DATA_GOV_IN_KEY unset", () => {
  process.env.DATA_GOV_API_KEY = "api-key";
  process.env.DATA_GOV_KEY = "plain-key";
  process.env.OGD_API_KEY = "ogd-key";
  assert.equal(dataGovKey(), "api-key");
});

test("dataGovKey falls back to DATA_GOV_KEY when the first two are unset", () => {
  process.env.DATA_GOV_KEY = "plain-key";
  process.env.OGD_API_KEY = "ogd-key";
  assert.equal(dataGovKey(), "plain-key");
});

test("dataGovKey falls back to OGD_API_KEY when the first three are unset", () => {
  process.env.OGD_API_KEY = "ogd-key";
  assert.equal(dataGovKey(), "ogd-key");
});

// ---- validateStartupConfig (takes an env object — no process.env juggling) ----
test("validateStartupConfig: missing ADMIN_TOKEN warns in dev, fatal in production", async () => {
  const { validateStartupConfig } = await import("../server/platform/config.js");
  const dev = validateStartupConfig({});
  assert.equal(dev.fatal.length, 0);
  assert.ok(dev.warnings.some((w) => w.includes("ADMIN_TOKEN")));

  const prod = validateStartupConfig({ NODE_ENV: "production" });
  assert.ok(prod.fatal.some((f) => f.includes("ADMIN_TOKEN")));
});

test("validateStartupConfig: missing AI_API_KEY is always only a warning", async () => {
  const { validateStartupConfig } = await import("../server/platform/config.js");
  const out = validateStartupConfig({ NODE_ENV: "production", ADMIN_TOKEN: "x" });
  assert.equal(out.fatal.length, 0);
  assert.ok(out.warnings.some((w) => w.includes("AI_API_KEY")));
});

test("validateStartupConfig: non-numeric PORT is fatal; clean env passes", async () => {
  const { validateStartupConfig } = await import("../server/platform/config.js");
  assert.ok(validateStartupConfig({ PORT: "abc" }).fatal.some((f) => f.includes("PORT")));
  const clean = validateStartupConfig({ ADMIN_TOKEN: "x", AI_API_KEY: "y", PORT: "3000" });
  assert.equal(clean.fatal.length, 0);
  assert.equal(clean.warnings.length, 0);
});
