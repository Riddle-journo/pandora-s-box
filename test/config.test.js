import test from "node:test";
import assert from "node:assert/strict";
import { dataGovKey } from "../server/config.js";

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
