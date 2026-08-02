// Structured logger (pino) that PRESERVES the ops-console live job-log stream.
//
// Contract: any log call made inside a running job's async context (see
// util/job-context.js) is ALSO pushed into that job's in-memory ring buffer
// (ops-log.js) — exactly what worker.js's console patch does for raw
// console.* calls. The two mechanisms coexist during the console→logger
// migration; each log line goes through exactly one of them.
//
//   import { logger } from "./util/log.js";     // or a relative path
//   const log = logger("worker");
//   log.info("plain message");
//   log.info({ url, status }, "fetch failed");  // structured fields first, pino-style
//
// Env: LOG_LEVEL (default "info"), LOG_PRETTY=1 for human-readable dev output
// (requires the pino-pretty devDependency; production stays JSON-lines on
// stdout, which pm2 captures — `npm run prod:logs` keeps working).
import pino from "pino";
import { jobLogContext } from "./job-context.js";
import { push as pushOpsLog } from "../ops/ops-log.js";

const base = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(process.env.LOG_PRETTY === "1"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

// Render a log call's args to the single text line the ops console shows.
function toLine(obj, msg) {
  if (typeof obj === "string") return obj;
  const text = msg ?? "";
  let fields = "";
  try { fields = obj && Object.keys(obj).length ? " " + JSON.stringify(obj) : ""; }
  catch { /* unserializable fields — keep the message */ }
  return text + fields;
}

function mirrored(bound, level) {
  return (obj, msg, ...rest) => {
    const jobId = jobLogContext.getStore();
    if (jobId) {
      try { pushOpsLog(jobId, toLine(obj, msg)); }
      catch { /* logging must never break a job */ }
    }
    return bound[level](obj, msg, ...rest);
  };
}

/**
 * Named child logger; every level is mirrored into the current job's
 * ops-console ring buffer when called inside a job.
 * @param {string} name
 */
export function logger(name) {
  const child = base.child({ name });
  return {
    trace: mirrored(child, "trace"),
    debug: mirrored(child, "debug"),
    info: mirrored(child, "info"),
    warn: mirrored(child, "warn"),
    error: mirrored(child, "error"),
    fatal: mirrored(child, "fatal"),
  };
}

// Console-compatible adapter for CLI-style modules with many multi-arg
// console.log("text", value, …) calls: pino drops extra args without %s
// placeholders, so this joins them space-separated exactly like console
// before forwarding — a drop-in `clog.log/warn/error` replacement that
// still gets levels, JSON output, and ops-console ring-buffer mirroring.
/** @param {string} name */
export function consoleStyle(name) {
  const log = logger(name);
  const join = (args) => args.map((x) => {
    if (typeof x === "string") return x;
    if (x instanceof Error) return x.stack ?? x.message;
    try { return JSON.stringify(x); } catch { return String(x); }
  }).join(" ");
  return {
    log: (...a) => log.info(join(a)),
    warn: (...a) => log.warn(join(a)),
    error: (...a) => log.error(join(a)),
  };
}

export default logger("app");
