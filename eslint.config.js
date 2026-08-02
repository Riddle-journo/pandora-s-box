// Minimal ESLint flat config (Task 1.2). Only ten specific correctness rules
// are enabled — no eslint:recommended, no no-unused-vars, no no-undef, no no-empty.

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  fetch: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  AbortSignal: "readonly",
  AbortController: "readonly",
  structuredClone: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  queueMicrotask: "readonly",
  crypto: "readonly",
  Response: "readonly",
  Request: "readonly",
  Headers: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  performance: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
};

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  localStorage: "readonly",
  fetch: "readonly",
  location: "readonly",
  history: "readonly",
  navigator: "readonly",
  console: "readonly",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  alert: "readonly",
  confirm: "readonly",
  prompt: "readonly",
  requestAnimationFrame: "readonly",
  IntersectionObserver: "readonly",
  CustomEvent: "readonly",
  Node: "readonly",
  HTMLElement: "readonly",
};

const coreRules = {
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-unreachable": "error",
  "no-const-assign": "error",
  "no-redeclare": "error",
  "valid-typeof": "error",
  "use-isnan": "error",
  "no-func-assign": "error",
  "no-obj-calls": "error",
  "no-sparse-arrays": "error",
};

export default [
  {
    ignores: [
      "node_modules/",
      "graphify-out/",
      "data/",
      "coverage/",
      "UsersDELLAppDataLocalTemp/",
    ],
  },
  {
    files: ["server/**/*.js", "scripts/**/*.js", "test/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: coreRules,
  },
  {
    // New server code should use util/log.js (structured, ops-console-mirrored)
    // instead of raw console. Warn-only: the long tail migrates incrementally,
    // and worker.js's console patch depends on console existing.
    //
    // SCOPE, stated precisely because it is easy to get wrong: this is the ONLY
    // block that enables no-console, and it matches server/** and nothing else.
    // scripts/**, test/** and public/** are therefore never counted — for CLI
    // scripts stdout IS the interface, so a console call there is intent, not
    // debt, and no "no-console: off" override is needed (adding one changes no
    // count: `npx eslint scripts` reports 0 problems with or without it).
    // The whole warning count of this repo is therefore server/** no-console
    // debt (run `npx eslint server` for today's figure — it moves with every
    // commit, so it is deliberately not pinned here). Shrinking it needs real
    // migration to util/log.js; no config change elsewhere can move it.
    files: ["server/**/*.js"],
    rules: { "no-console": "warn" },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
    },
    rules: coreRules,
  },
];
