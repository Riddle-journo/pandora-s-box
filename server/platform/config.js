// Central config helper — one place to read env vars that have accumulated
// multiple historical aliases across the codebase.
//
// Everything here reads process.env AT CALL TIME (lazy), never at import time:
// the test harness (test/helpers/server.js) sets env vars before dynamically
// importing the server, and lazy getters make import order irrelevant.
export function dataGovKey() {
  return process.env.DATA_GOV_IN_KEY || process.env.DATA_GOV_API_KEY || process.env.DATA_GOV_KEY || process.env.OGD_API_KEY || "";
}

export function adminToken() { return process.env.ADMIN_TOKEN || ""; }
export function aiKey()      { return process.env.AI_API_KEY || ""; }
export function port()       { return Number(process.env.PORT) || 3000; }
export function dbPath()     { return process.env.PANDOROS_DB_PATH || ""; }

// Startup preflight — called from the listen branch only (never under
// PB_NO_LISTEN=1, so tests skip it). A missing ADMIN_TOKEN used to fail
// silently: the server booted fine and every admin route just 401'd.
// Now it's said out loud — and refuses to boot in production.
export function validateStartupConfig(env = process.env) {
  const fatal = [];
  const warnings = [];

  if (!env.ADMIN_TOKEN) {
    const msg = "ADMIN_TOKEN is not set — every admin/ops route will return 401.";
    if (env.NODE_ENV === "production") fatal.push(msg);
    else warnings.push(msg);
  }
  if (!env.AI_API_KEY) {
    warnings.push("AI_API_KEY is not set — report generation and investigator LLM jobs will fail.");
  }
  if (env.PORT && !Number(env.PORT)) {
    fatal.push(`PORT="${env.PORT}" is not a number.`);
  }

  return { fatal, warnings };
}
