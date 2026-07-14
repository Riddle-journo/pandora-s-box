# Production Refactor Plan — Pandoro's Box (`rate-my-rep`)

## Context

Senior-dev review of a vibe-coded codebase: ~33k lines of ESM JavaScript — Express 4 API, better-sqlite3 store, vanilla no-build SPA, 56-file green test suite. The verdict is more nuanced than "slop": the test isolation (temp-DB via `PANDOROS_DB_PATH`), dependency-injected fetchers, XSS escaping (consistent `esc()` across all 109 innerHTML sites), and detector/fetcher registries are genuinely good. What's missing is everything *around* the code: no lint, no CI, no error middleware, no process supervision, no API tests, secrets sitting in plaintext, junk committed to git, and five monolith files (app.js 3,085 lines / engine.js 2,145 / ingest.js 1,164 / store.js 1,156 / index.js 852) with heavy copy-paste duplication.

**The critical constraint shaping this plan:** it will be executed by a non-technical operator pasting tasks into AI sessions (Opus low effort / Sonnet medium). The operator cannot catch logical errors. So every task is small (≤5 files), mechanical (no open-ended judgment), self-verifying (ends in a pass/fail command), and reversible (one git commit per task). The safety net (lint, CI, smoke test, API golden-master tests) is built BEFORE any risky refactor. Several "obvious" refactors are deliberately dropped as too dangerous for this execution model.

## Key audit findings (evidence-verified)

**Security / hygiene**
- Live API keys (OpenRouter, Groq, Gemini) + admin token in plaintext `.env` on disk. Never committed to git (verified), but must be rotated by the human.
- Committed junk: `data/db.json` + `.bak` (2.93MB each, legacy pre-SQLite store), `UsersDELLAppDataLocalTemp/pb-thresh-test.db(+shm/wal)`. `.gitignore` covers `data/*.db` only, not `*.db`.
- Admin auth is a single `x-admin-token` header, timing-safe compare, fail-closed (index.js:412-421) — adequate, keep.
- SQL injection risk LOW (prepared statements throughout). XSS: GOOD. Minor: CSV export lacks formula-injection guard.

**Reliability**
- No global Express error middleware; no `unhandledRejection`/`uncaughtException` handlers; several async routes uncaught → unhandled rejections. 500s leak raw `err.message` to clients. 5 empty catch blocks.
- No `/healthz`, no supervisor, no Dockerfile, no CI. Single process; nothing restarts it on crash.
- Fetchers: no retries anywhere; 7 fetchers bypass shared http.js and lack timeouts; frontend `api()` (app.js:45) has no try/catch → network failure = stuck "Loading…".

**Config / duplication**
- ~45 env vars read ad hoc; FOUR spellings of the data.gov key (`DATA_GOV_IN_KEY` set; `DATA_GOV_KEY`/`DATA_GOV_API_KEY`/`OGD_API_KEY` silently dead in their fetchers).
- `norm()/NORM()` ~10 definitions with DIFFERENT regexes (behavior-sensitive — mostly must NOT be unified); `nameScore` 3 identical copies; `sleep` 4 copies; `num()` twice in index.js; lead approve/reject logic duplicated (index.js:478-492 vs 707-733).
- Tests cover pipeline well but: index.js API has zero HTTP-level tests (only a fragile source-grep privacy test), app.js zero, store.js thin.

**Environment facts:** Windows 11 machine, Node v24, GitHub remote `Riddle-journo/pandora-s-box` exists, working tree currently dirty with in-flight opendata work.

---

# HOW TO EXECUTE (operator manual)

Each task = one fresh AI coding session. Paste: (1) Session Preamble, (2) DO NOT DO list, (3) the Task Card. Then YOU run the Verify command in PowerShell from `C:\Users\DELL\Documents\coder pro\rate-my-rep` and check for the stated output.

**The ritual, every task:**
1. `git status --short` must print NOTHING before starting. If not, finish/rollback the previous task first.
2. Run the session with preamble + DO-NOT list + task card.
3. Run the task's **Verify** command yourself.
4. **PASS** → `git add -A` then `git commit -m "Task <ID>: <title>"`.
5. **FAIL** → `git checkout -- .` then `git clean -fd` (cannot touch `.env` or databases — both gitignored). Retry ONCE, pasting the failure output into the session. Fails again → skip, note the task ID in a local SKIPPED.md, move on.

**Session Preamble (paste at top of every session):**
> You are making one small, behavior-preserving change to a working Node.js ESM project (Express 4 + better-sqlite3, no build step, node:test suite). Follow the task instructions EXACTLY. Do not refactor, rename, reformat, or "improve" anything beyond what the task says. Do not touch files not listed in the task. Do not edit any test assertion to make it pass — if a test fails, your change is wrong. When done, state which files you changed and stop.

**DO NOT DO list (paste after the preamble, every session):**
```
FORBIDDEN in this session, no matter what seems helpful:
- No TypeScript, no React/Vue, no bundler/build step, no ORM, no new frameworks.
- No new npm dependencies unless the task explicitly names one.
- Never rewrite a file from scratch; only the edits the task specifies.
- Do not reformat, re-indent, or "clean up" code you aren't asked to change. No Prettier.
- Do not rename variables, functions, files, or routes unless the task says so.
- Do not edit or delete any existing test assertion. If a test fails, your change is wrong.
- Do not touch .env or .env.example; never print or hardcode any secret/token value.
- Do not mass-replace console.* calls or add a logging library (the ops console
  streams job logs by capturing console output — replacing it breaks the ops UI).
- Do not unify or "fix" the various norm()/NORM name-normalization functions in
  server/data/*, server/mega-ingest.js, server/extractors/*, server/sources/wikipedia.js —
  their regex differences are intentional-until-proven-otherwise.
- Do not change any User-Agent string in server/fetchers/* (some sites require specific UAs).
- Do not split public/app.js into modules or merge its render helpers.
- Do not run git push, git rebase, git reset --hard, git filter-repo, npm audit fix,
  or dependency upgrades.
- Do not delete files from disk; git rm --cached only when a task says so.
- Do not add routes, features, or "improvements" beyond the task text.
- If any instruction seems to conflict with making the verification pass, STOP and report.
```

---

# PHASE 0 — Repo hygiene + secrets (mostly human, do first)

### 0.1 — Commit the in-flight work *(HUMAN — no AI session)*
Working tree has uncommitted opendata work (`server/opendata-catalog.js`, `server/fetchers/opendata.js`, `server/data/opendata-catalog.json`, `test/opendata.test.js`, `GOVACTION-SOURCES-PLAN.md`, modified `package.json`).
- Run `npm test` (must be green) then `git add -A; git commit -m "WIP: opendata catalog work"`.
- **Verify:** `git status --short` prints nothing.

### 0.2 — Untrack committed junk + tighten .gitignore
- **Model:** Sonnet-medium. **Files:** `.gitignore` (+ `git rm --cached` ops).
- **Task:** Append to `.gitignore`: `*.db`, `*.db-shm`, `*.db-wal`, `UsersDELLAppDataLocalTemp/`, `eng.traineddata`, `data/db.json`, `data/db.json.bak`, `logs/`. Then `git rm --cached data/db.json data/db.json.bak eng.traineddata` and `git rm -r --cached UsersDELLAppDataLocalTemp`. Do NOT delete files from disk. Leave `engineering_patterns.json` tracked (may be read by code).
- **Verify:** `git ls-files | Select-String -Pattern "db.json|traineddata|Temp"` prints nothing, AND `Test-Path data/db.json` prints `True`, AND `npm test` green.
- **Risk:** AI uses `git rm` without `--cached` → the `Test-Path` check catches it (recoverable from history anyway).
- **Permanent note:** git history still contains ~11MB of these blobs. Accepted — do NOT attempt filter-repo/BFG (history rewrite is too dangerous for this workflow).

### 0.3 — Rotate all live secrets *(HUMAN — never paste keys into an AI chat)*
Rotate at each dashboard: OpenRouter, Groq, Google AI Studio, data.gov.in. Generate a new long random `ADMIN_TOKEN`. Edit `.env` yourself in a text editor.
- **Verify:** `npm start`, open `http://localhost:3000/#/ops`, log in with the new token, queue a small job — works.

**Regression point:** `npm test` green, `git status --short` empty.

---

# PHASE 1 — Tooling safety net (build the net before walking the wire)

### 1.1 — Smoke-test script
- **Model:** Sonnet-medium. **Files:** `scripts/smoke.js` (new), `package.json`.
- **Task:** Create ESM `scripts/smoke.js`: (1) `fs.mkdtempSync` temp dir; (2) spawn `node server/index.js` with env `{PORT:"3999", PANDOROS_DB_PATH:<tmp>/smoke.db, OPS_INPROC_WORKER:"0", ADMIN_TOKEN:"smoke-test-token"}`; (3) poll `http://127.0.0.1:3999/api/parameters` every 500ms up to 30s until 200; (4) GET `/api/politicians` → 200 + JSON; (5) GET `/api/admin/tips` with NO token → must be 401; (6) kill child (in a `finally` — always), print exactly `SMOKE PASS` exit 0, or `SMOKE FAIL: <reason>` exit 1. Add script `"smoke": "node scripts/smoke.js"`.
- **Verify:** `npm run smoke` → `SMOKE PASS`.
- **Risk:** orphaned node process if script crashes; if port stuck: `Get-Process node | Stop-Process` and retry.

### 1.2 — ESLint, minimal corruption-catching rules only
- **Model:** Sonnet-medium. **Files:** `eslint.config.js` (new), `package.json`, `package-lock.json`.
- **Task:** `npm install --save-dev eslint@^9`. Flat config: ignore `node_modules/`, `graphify-out/`, `data/`, `UsersDELLAppDataLocalTemp/`; one block for `server/**`, `scripts/**`, `test/**`, root `*.js` (`sourceType:"module"`, hand-written node globals list — do NOT add the `globals` package); one block for `public/**/*.js` (`sourceType:"script"`, browser globals). Rules — EXACTLY these ten, `"error"`: `no-dupe-keys, no-dupe-args, no-unreachable, no-const-assign, no-redeclare, valid-typeof, use-isnan, no-func-assign, no-obj-calls, no-sparse-arrays`. Do NOT enable eslint:recommended / no-unused-vars / no-undef / no-empty. If a rule fires on existing code, turn THAT rule off with a `// TODO(pre-existing)` comment — never edit source to satisfy lint. Add `"lint": "eslint ."`.
- **Verify:** `npm run lint` exits 0; `npm test` green; `git status` shows only the 3 expected files.
- **Why so minimal:** `no-undef`/`no-unused-vars` would fire hundreds of times and invite mass edits. These 10 rules only catch genuine corruption — which is what we need during the Phase 5 file splits.

### 1.3 — `npm run check` composite + GitHub Actions CI
- **Model:** Sonnet-medium. **Files:** `package.json`, `.github/workflows/ci.yml` (new).
- **Task:** Add `"check": "npm run lint && npm test && npm run smoke"`. CI workflow: on push + pull_request, single job on ubuntu-latest: checkout → setup-node 20 + npm cache → `npm ci` with env `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"` → lint → test → smoke. Nothing else, no matrix.
- **Verify:** `npm run check` locally ends `SMOKE PASS`; commit, push, confirm green run at github.com/Riddle-journo/pandora-s-box/actions.
- **Risk:** Linux `npm ci` may fail on optional native deps (tesseract/canvas) — if install-only failure, change to `npm ci --omit=optional`, push again.

**Regression point:** `npm run check` green locally AND in Actions. This is every later task's minimum bar.

---

# PHASE 2 — Reliability hardening

### 2.1 — Central config helper + data.gov key alias fix
- **Model:** Sonnet-medium. **Files:** `server/config.js` (new), `server/fetchers/company-registry.js`, `server/db-maintenance.js`, `server/fetchers/opendata.js`, `test/config.test.js` (new).
- **Task:** Create `server/config.js`: `export function dataGovKey() { return process.env.DATA_GOV_IN_KEY || process.env.DATA_GOV_API_KEY || process.env.DATA_GOV_KEY || process.env.OGD_API_KEY || ""; }`. Replace the ad-hoc env reads: company-registry.js (~:66, ~:96), db-maintenance.js (~:153). In opendata.js:33, `ogdKey` becomes `process.env.OGD_API_KEY || dataGovKey() || OGD_SAMPLE_KEY` (OGD_API_KEY must stay first — an existing test pins that precedence). Do NOT touch ingest.js here. Write `test/config.test.js` asserting precedence (save/restore env).
- **Verify:** `npm run check` green (opendata.test.js is the tripwire).

### 2.2 — ingest.js json-api batches actually get the key
- **Model:** Opus. **Files:** `server/ingest.js` only.
- **Task:** Find where FETCHERS entries' `apiKeyEnv` is consumed. When the named var is unset AND the name is one of the four data.gov spellings, fall back to `dataGovKey()` from `./config.js`. Don't change the `apiKeyEnv` strings themselves; don't change behavior when the var IS set.
- **Verify:** `npm run check` green + `node -e "process.env.DATA_GOV_IN_KEY='x123'; import('./server/ingest.js').then(()=>console.log('IMPORT OK'))"` prints `IMPORT OK`.
- **Risk:** wrong edit site in a 1,164-line file — low blast radius (previous behavior was already silently keyless); import check + suite catch breakage.

### 2.3 — Global error middleware + async wrapper + stop leaking err.message
- **Model:** Opus. **Files:** `server/index.js` only.
- **Task:** (1) Add `const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);` near the top. (2) Wrap ONLY these currently-unprotected async handlers in `asyncH(...)`: `GET /api/issues`, `/api/issues/:slug`, `/api/funding/overview`, `/api/funding/party/:party`, `/api/politicians/:id/funding`, `/api/scorecards`, `/api/ministries`, `/api/ministries/:key(*)/card`, `/api/parties`, `/api/parties/:key/card`, `/api/politicians/:id/scandals`, `POST /api/politicians/:id/generate`, `POST /api/admin/scandal-proposals/:slug/approve`, `GET /api/admin/ops/health`, `POST /api/admin/ops/engine/dryrun`. (3) Just BEFORE the `const PORT =` block add the 4-arg error middleware: log `console.error("[http]", req.method, req.path, err)`, respond `500 {ok:false, error:"internal error"}`. (4) In existing catches (~:407, ~:448, ~:653) and 404s (~:326-327, ~:346-347): keep status codes and JSON key names, replace `err.message` in response bodies with fixed `"internal error"` / `"not found"`, add `console.error(err)` where not logged.
- **Verify:** `npm run check` green.

### 2.4 — Process-level handlers + /healthz + store.pingDb()
- **Model:** Sonnet-medium. **Files:** `server/index.js`, `server/store.js`, `scripts/smoke.js`.
- **Task:** (1) store.js: `export function pingDb() { return db.prepare("SELECT 1 AS ok").get().ok === 1; }`. (2) index.js: `process.on("unhandledRejection", err => console.error(...))` and `process.on("uncaughtException", err => { console.error(...); process.exit(1); })` (exit-on-uncaught is deliberate — PM2 in Phase 7 restarts clean). (3) Route `GET /healthz` → `{ok: pingDb(), uptime}` with try/catch → 500 `{ok:false}`. (4) smoke.js: poll `/healthz` instead, require body contains `"ok":true`.
- **Verify:** `npm run check` → `SMOKE PASS`.

### 2.5 — Request logging (tee-safe, no library)
- **Model:** Sonnet-medium. **Files:** `server/index.js` only.
- **Task:** One middleware after `express.static`: on res "finish", `console.log("[req] METHOD url status Nms")`. Skip `/healthz` and non-`/api` paths. Plain `console.log` — NO logging library, NO changes to ops-log.js or any existing console call (ops console log streaming depends on console inside jobs).
- **Verify:** `npm run check`; then `npm start`, hit `/api/politicians`, see one `[req]` line, Ctrl+C.

**Regression point:** `npm run check` + CI green + 2-minute manual click-through of `/#/ops` with the new ADMIN_TOKEN.

---

# PHASE 3 — API integration tests (golden master BEFORE any splitting)

### 3.1 — Make the server importable without listening
- **Model:** Sonnet-medium. **Files:** `server/index.js` only.
- **Task:** At the bottom: `export { app };` and wrap the whole `const PORT ... app.listen(...)` block (including in-process worker startup) in `if (process.env.PB_NO_LISTEN !== "1") { ... }`. Nothing inside the block changes.
- **Verify:** `npm run check` green + import probe: set `PB_NO_LISTEN=1` + temp `PANDOROS_DB_PATH`, dynamic-import server/index.js, assert `typeof app.listen === "function"`, prints `IMPORT OK`.

### 3.2 — Integration test harness
- **Model:** Opus. **Files:** `test/helpers/server.js` (new), `test/api-public.test.js` (new).
- **Task:** `startTestServer()`: set `PB_NO_LISTEN=1`, fresh-temp `PANDOROS_DB_PATH`, `ADMIN_TOKEN="test-admin-token"` BEFORE `await import("../../server/index.js")` (env-first pattern, same as existing store tests); then `app.listen(0)`, return `{baseUrl, close}`. Plain `fetch`, no new deps. First tests: `/healthz` 200 ok:true; `/api/politicians` 200 array; `/api/politicians/nonexistent-id` → pin the OBSERVED status (don't "fix" anything); `/api/methodology` has `parameters` + `scoring`; `/api/parameters` 200. Close in `after()`.
- **Note:** node:test runs each test file in its own process, so one server import per file is safe — all HTTP tests must go through this helper.
- **Verify:** `npm test` green, `npm run check`.

### 3.3 — Golden-master the content/list routes
- **Model:** Sonnet-medium. **Files:** `test/api-content.test.js` (new).
- **Task:** Pin status + top-level JSON shape (not exact data; empty DB fine) for: `/api/scandals`, `/api/scandals/facets`, `/api/leaderboard`, `/api/leaderboard?limit=5`, `/api/issues`, `/api/funding/overview`, `/api/scorecards`, `/api/ministries`, `/api/parties`, `/api/compare?ids=a,b`. Pin whatever it returns TODAY.
- **Verify:** `npm test` green.

### 3.4 — Admin auth + privacy at HTTP level
- **Model:** Sonnet-medium. **Files:** `test/api-admin.test.js` (new).
- **Task:** (a) `/api/admin/tips`: no header → 401, wrong token → 401, right token → 200. (b) 401 checks for `/api/admin/ops/summary`, `/api/admin/stories`, `/api/admin/investigation-leads`, `/api/admin/conflicts`, `/api/admin/ops/leads`. (c) Privacy: `/api/conflicts`, `/api/stories`, `/api/politicians/some-id/conflicts` → 404. (d) `POST /api/admin/ops/jobs` valid token, `{"type":"nonsense_type"}` → non-2xx.
- **Verify:** `npm test` green.

### 3.5 — Error-path tests
- **Model:** Sonnet-medium. **Files:** `test/api-errors.test.js` (new).
- **Task:** `GET /api/ministries/definitely%2Fnot%2Freal/card`, `GET /api/parties/notreal/card` → pin observed status; assert body contains no `"at "` / `".js:"` (no stack traces) and error strings are the generic ones from Task 2.3.
- **Verify:** `npm test` green.

**Regression point:** `npm run check` green → `git tag golden-master`. Phases 4–5 are measured against these tests.

---

# PHASE 4 — Mechanical dedup (test-guarded)

### 4.1 — Shared NORM + nameScore for the three clone scripts
- **Model:** Sonnet-medium. **Files:** `server/util/names.js` (new), `server/import-ls.js`, `server/import-rs.js`, `server/repair-myneta.js`, `test/names-util.test.js` (new).
- **Task:** FIRST diff the three `NORM` (import-ls:27 / import-rs:24 / repair-myneta:26) and `nameScore` (28/25/27) definitions. If NOT character-identical → STOP and report differences, do not unify. If identical: move to `server/util/names.js`, import in all three, write 6+ characterization cases (input→output pairs computed by running the ORIGINAL function via `node -e` before editing).
- **Verify:** `npm test` green (import-rs.test.js is the real tripwire).
- **Decision:** the ~7 OTHER `norm()` definitions (data/, extractors/, sources/, mega-ingest) are intentionally LEFT ALONE — different regexes, behavior-sensitive. On the DO-NOT list.

### 4.2 — Single `sleep`
- **Model:** Sonnet-medium. **Files:** `server/util/timing.js`, `server/fetchers/http.js`, `server/bulk-import.js`, `server/worker.js`, `server/sources/gdelt-fetch.js`.
- **Task:** Add `sleep` export to util/timing.js. http.js:7 becomes `export { sleep } from "../util/timing.js";` (KEEP the re-export — others import sleep from http.js). Delete local copies in the other three, import instead (correct relative path each).
- **Verify:** `npm run check` green AND `(Get-ChildItem server -Recurse -Filter *.js | Select-String "const sleep = \(ms\)").Count` prints `1`.

### 4.3 — index.js `num()` dedupe
- **Model:** Sonnet-medium (trivial). **Files:** `server/index.js`.
- **Task:** Confirm the two `num()` helpers (~:136, ~:236) are identical; keep one near the top, delete the other.
- **Verify:** `npm run check` green.

### 4.4 — Lead approve/reject dedupe (pin-first)
- **Model:** Opus. **Files:** `server/index.js`, `test/api-admin.test.js`.
- **Task:** FIRST add pinned tests: `POST /api/admin/investigation-leads/xyz/approve` and `POST /api/admin/ops/leads/xyz/action` (`{"action":"approve"}`) with valid token on empty DB — pin observed statuses/bodies, run green. THEN extract shared `decideLead(id, decision, extras)` from the duplicated blocks (~:478-492 vs ~:707-733) and call from both routes. Byte-identical responses.
- **Verify:** `npm run check` green.

### 4.5 — Pagination clamp helper (pin-first)
- **Model:** Opus. **Files:** `server/index.js`, `test/api-content.test.js`.
- **Task:** FIRST pin edge cases: `limit=0`, `limit=99999`, `limit=-5`, `offset=-1` on `/api/leaderboard`, `/api/scandals`, `/api/admin/ops/jobs` (with token). THEN extract `pageParams(query, {defLimit, maxLimit})` and use it in exactly the routes where the `Math.min/Math.max` clamp is copy-pasted.
- **Verify:** `npm run check` green.

### 4.6 — Timeouts for the 7 raw-fetch fetchers (2 sessions)
- **Model:** Sonnet-medium. Batch A: `sebi-disclosures.js`, `nse-deals.js`, `icij.js`, `opendata.js`; Batch B: `indian-kanoon.js`, `sec-edgar.js`, `opencorporates.js`.
- **Task (each):** These bypass http.js intentionally (special UAs, injectable fetch). Do NOT migrate them, do NOT change UA strings. Only: add `signal: AbortSignal.timeout(20000)` to each direct fetch call lacking a `signal`.
- **Verify:** `npm test` + `npm run lint` green (DI-based fetcher tests fail loudly if signatures change).

### 4.7 — Retry/backoff in http.js (opt-in, default OFF)
- **Model:** Opus. **Files:** `server/fetchers/http.js`, `test/http-retry.test.js` (new).
- **Task:** Add `retries = 0` option to `fetchText`/`fetchJson`: retry on network error or 5xx up to N times with `sleep(1000 * 2**attempt)`; never on 4xx; default 0 = byte-identical behavior. Add optional `fetchImpl = fetch` param for testability. Tests with fake fetchImpl: retries:0 + 500 → called once; retries:2 + 500,500,200 → success, 3 calls; 404 + retries:2 → 1 call.
- **Verify:** `npm test` green. (Enabling retries at call sites is deliberately deferred — later, one flaky fetcher at a time.)

### 4.8 — Fill the 5 empty catch blocks
- **Model:** Sonnet-medium. **Files:** `server/fetchers/cppp-procurement.js` (~:37, ~:69), `server/mega-ingest.js` (~:548, ~:550, ~:656).
- **Task:** In each empty catch add one `console.warn("[<file>] <what failed>:", err?.message ?? err);` (bind err if unbound). Control flow unchanged — still swallows.
- **Verify:** `npm run check` green.

**Regression point:** `npm run check` + CI green → `git tag phase-4-done`.

---

# PHASE 5 — Monolith splits (facades, STRICTLY SERIAL, `npm run check` after every task)

A "facade" = the old file keeps re-exporting everything from the new files, so no other file's imports ever change.

### 5.1 — Rewrite privacy.test.js off source-grepping (MUST precede any index.js split)
- **Model:** Sonnet-medium. **Files:** `test/privacy.test.js`.
- **Task:** Replace the read-index.js-source regex test with harness-based HTTP checks: `/api/conflicts`, `/api/politicians/x/conflicts`, `/api/stories`, `/api/stories/some-slug` → 404; explicit list of 13 admin paths (tips, scandal-proposals, investigation-leads, conflicts, stories, ops/summary, ops/roster, ops/jobs, ops/engine, ops/flags, ops/leads, ops/queue, ops/precision) GET without token → all 401.
- **Verify:** `npm test` green. Strictly stronger than the regex version, and won't break when routes move files.

### 5.2 — Extract `requireAdmin` → server/auth.js
- **Model:** Sonnet-medium. **Files:** `server/auth.js` (new), `server/index.js`.
- **Task:** Move `requireAdmin` (index.js:412-421) verbatim; named export; import `node:crypto` there; index.js imports it. Nothing else.
- **Verify:** `npm run check` green.

### 5.3 — Routes split 1: `/api/admin/ops/*` → server/routes/admin-ops.js
- **Model:** Opus. **Files:** `server/routes/admin-ops.js` (new), `server/index.js`.
- **Task:** `express.Router()`; move VERBATIM (cut-paste, zero body edits) all ~20 ops routes + their private helpers (`OPS_JOB_TYPES`, `OPS_DANGER`, `BATCH_ACTIONS`, `rosterRows`, `decideLead`) + exactly the imports those bodies need. KEEP FULL PATH STRINGS (`/api/admin/ops/...`) and mount with `app.use(router)` — no path-prefix math. `requireAdmin` per-route from `../auth.js`. In index.js: delete moved code, `app.use(adminOpsRouter)` at the position of the first old ops route (error middleware must stay last).
- **Verify:** `npm run check` green — privacy 401s, api-admin tests, jobs flow, smoke all guard this.
- **Risk:** missing import → boot crash → smoke fails instantly; dropped route → 404 where 401 expected → test fails. Both loud. Riskiest task type in the plan — hence Opus + tests-first ordering.

### 5.4 — Routes split 2: remaining `/api/admin/*` → server/routes/admin.js
- **Model:** Opus. Same recipe: tips, tips/:id/review, scandal-proposals*, investigation-leads*, conflicts, directorship-network, stories, stories/:id/status, plus admin-gated `/api/politicians/:id/report(+s)`.
- **Verify:** `npm run check` green.

### 5.5 — Routes split 3: public content → server/routes/content.js
- **Model:** Opus. Same recipe: scandals (3), issues (2), funding (3), scorecards, ministries (2), parties (2), politicians/:id/scandals. Move `asyncH` to `server/routes/util.js` (index.js imports it from there too). **Ordering caution:** `/api/scandals/facets` must stay registered before `/api/scandals/:slug` — preserve source order exactly.
- **Verify:** `npm run check` green (golden masters are the tripwire).
- **After 5.3–5.5 index.js is ~300 coherent lines (setup, static, request log, politicians/compare/leaderboard/tips/pow, healthz, error mw, listen). STOP — do not split further.**

### 5.6 — store.js split 1: db bootstrap → server/store/db.js
- **Model:** Opus. **Files:** `server/store/db.js` (new), `server/store.js`.
- **Task:** Move verbatim: `PANDOROS_DB_PATH` resolution, `new Database(...)`, pragmas, the ENTIRE import-time DDL block (store.js:45-237). Export `db`. store.js: `import { db } from "./store/db.js";` as FIRST local import; everything else untouched.
- **Verify:** `npm run check` green — all 56 test files exercise this path; any DDL-order mistake fails the whole suite instantly.

### 5.7 — store.js split 2: jobs domain → server/store/jobs.js
- **Model:** Opus. **Task:** Move verbatim every function touching the `jobs` table (enqueueJob, getJob, listJobs, claimJob, failJob ~:858, completeJob, updateJob, cancelJob, requeueJob, trimJobs, reclaim, queue-pause state). store.js keeps a facade line: `export { ... } from "./store/jobs.js";` with every moved name. NO other file's imports change.
- **Verify:** `npm run check` green (jobs.test.js targets exactly this domain).

### 5.8 / 5.9 — store.js splits 3–4
- **Model:** Opus, one session each. 5.8: politicians/evidence/reports → `server/store/politicians.js`. 5.9: scandals/stories/leads/tips → `server/store/content.js`. store.js remains the permanent facade (the public API). Stop after these; the remainder (settings, misc) stays.
- **Verify each:** `npm run check` green.

### 5.10 — engine.js prep: shared-helper extraction (ABORTABLE)
- **Model:** Opus. **Files:** `server/detectors/helpers.js` (new), `server/engine.js`.
- **Task:** Inventory every module-scope function/constant referenced inside DETECTORS `run()` bodies but defined outside the array. Move them verbatim to `server/detectors/helpers.js`; engine.js imports them by name AND re-exports (`export { ... } from ...`) so externals keep working. Do NOT move any detector yet.
- **ABORT RULE:** if the session finds >~25 shared helpers or tangled mutual references → rollback, mark 5.10–5.12 SKIPPED. The registry already structures engine.js internally; splitting it is nice-to-have, not need-to-have.
- **Verify:** `npm run check` green (engine.test.js runs the registry).

### 5.11 / 5.12 — engine.js: move detectors in two batches
- **Model:** Opus, one session each. **Step 1 of 5.11:** add `test/detector-registry.test.js` snapshotting the ORDERED list of all 49 detector ids BEFORE moving anything. **Then:** mirror the existing cppp-detectors.js pattern (9 detectors already live outside engine.js, appended ~:1973): move ~half the DETECTORS entries verbatim to `server/detectors/batch-a.js` (`export const DETECTORS_A = [...]`), replace in engine.js with `...DETECTORS_A` spread at the exact same array position. **Registry order must be element-for-element identical.** 5.12: same for the rest → batch-b.js.
- **Verify:** `npm run check` green — the id-order snapshot test catches any drop/reorder.

### 5.13 — Move one-off scripts out of server/ (2 sessions)
- **Model:** Sonnet-medium. Batch A: `git mv` backfill-entities/backfill-fts/backfill-relations/fix-rs-myneta-mismatch/reset-data/migrate-to-sqlite/reingest-party-finance → `scripts/`. Batch B: split-shared-entities/update-roster/entities-review + root add-politician.js → `scripts/`.
- **Task (each):** `git mv` only. Fix each moved file's relative imports (`./store.js` → `../server/store.js`). Update `package.json` scripts referencing old paths. `git grep` for old paths — only doc hits allowed (update those too). **Do NOT move** import-ls.js / import-rs.js / repair-myneta.js (a test imports import-rs.js) nor anything imported by worker.js/index.js/tests — `git grep` each file before moving; leave it if imported.
- **Verify:** `npm run check` green + grep gate clean.
- **Risk:** a moved maintenance script silently broken — low blast radius (app unaffected); import-probe only scripts known to gate on argv (some run work at import time).

**Regression point:** `npm run check` after EVERY task; at the end full manual ops-console click-through → `git tag phase-5-done`.

---

# PHASE 6 — Frontend (deliberately minimal)

### 6.1 — api() network-failure handling
- **Model:** Sonnet-medium. **Files:** `public/app.js`.
- **Task:** Wrap app.js:45 in try/catch returning `null` on throw. Nothing else — every caller already handles `null` (the existing `!r.ok` path).
- **Verify:** `npm run lint` + `npm run smoke` green; manual: `npm start`, load site, STOP the server, click a nav item — page shows its empty/fallback state instead of hanging on "Loading…".

### 6.2 — CSV formula-injection guard
- **Model:** Sonnet-medium. **Files:** `public/app.js`.
- **Task:** In `csvCell`, if stringified value matches `/^[=+\-@]/`, prefix a single `'` before quoting. Touch BibTeX only if it emits user data unquoted; otherwise leave and say so.
- **Verify:** `npm run lint` green; manual CSV export → text editor: names unchanged, `=...` values now `'=...`.

### EXPLICIT DECISION — NO app.js module split, NO frontend dedups
3,085 lines of classic script: one global scope, shared mutable state, hash-router if-ladder, 15 views, ZERO tests, no build step. Splitting into multiple `<script>` files creates an implicit load-order + cross-file-globals contract that a low-effort AI session will violate invisibly — and nothing automated would catch it. Same reasoning kills the repCardHTML/railCardHTML merge, pager/tab-wiring dedups, and api/adminFetch/opsFetch unification (the admin helpers already catch errors; unifying risks changing admin error UX for zero user value). **Skip all of it.** If the frontend ever needs real work, that's a separate project that starts with a test harness.

---

# PHASE 7 — Ops (Windows-local; EXPLICIT DECISION: no Docker)

Native deps (better-sqlite3, playwright, optional tesseract/canvas OCR) make a correct image a multi-gotcha build, and this runs on one Windows machine. PM2 (a process manager that restarts the app when it crashes and keeps log files) gives restart-on-crash + logs with three commands. Docker adds risk, not value, here.

### 7.1 — PM2 setup
- **Model:** Sonnet-medium. **Files:** `ecosystem.config.cjs` (new), `package.json`.
- **Task:** `npm install --save-dev pm2`. Ecosystem file: one app `{name:"pandoros", script:"server/index.js", instances:1, autorestart:true, max_restarts:10, min_uptime:"10s", out_file:"logs/out.log", error_file:"logs/err.log", merge_logs:true, time:true}` (no env config needed — the app loads its own dotenv at index.js:5). Scripts: `prod:start`, `prod:stop`, `prod:status`, `prod:logs`.
- **Verify:** `npm run prod:start` → `curl.exe http://localhost:3000/healthz` prints `{"ok":true,...}` → `npm run prod:status` shows online → `npm run prod:stop`.
- **Note:** exit-on-uncaughtException (Task 2.4) + autorestart = self-healing. PM2 Windows boot persistence is flaky — RUNBOOK documents `pm2 resurrect` after reboot instead of automating it.

### 7.2 — Scheduled DB backup
- **Model:** Sonnet-medium. **Files:** `scripts/backup.ps1` (new).
- **Task:** PowerShell script: cd repo root → `node server/db-maintenance.js backup` → fail on non-zero → prune `data/backups` to last 14. Do NOT register the Windows scheduled task in-session — RUNBOOK gives the human the one-line `schtasks /Create /SC DAILY /ST 03:00 ...` command (machine-level change, human runs it).
- **Verify:** `powershell -File scripts/backup.ps1` exits 0, new file in `data/backups`.

---

# PHASE 8 — Docs

### 8.1 — RUNBOOK.md (the operator's own manual)
- **Model:** Sonnet-medium. Sections, each one copy-pasteable command + expected output: Start / Stop / Status / Health / Logs / Run tests (`npm run check` → SMOKE PASS) / Backup now / Restore from backup (exact paths per db-maintenance.js naming, while stopped) / After reboot (`pm2 resurrect`) / Rotate keys (which dashboards, which .env lines — NO values) / When something is red (the rollback ritual) / Register daily backup (schtasks line).
- **Verify:** the HUMAN executes every RUNBOOK command top to bottom once; each matches its documented output. That execution IS the verification.

### 8.2 — ARCHITECTURE.md + README refresh
- **Model:** Sonnet-medium. ARCHITECTURE.md: request flow (SPA → index.js + routes/* → store.js facade → store/* → SQLite), job system (worker, in-proc flag, **ops-log console-tee is load-bearing**), detector registry (engine.js + detectors/*), fetcher registry (+ intentional per-fetcher UAs), env-var table, and the facade rule: "external code imports store.js/engine.js only, never store/* or detectors/* directly." README: update moved-script paths, add check/smoke/prod:* scripts.
- **Verify:** `npm run check` green + human skim.

---

# Sequencing & dependency map

```
Phase 0: 0.1 → 0.2 → 0.3                (serial)
Phase 1: 1.1 → 1.2 → 1.3                (serial; 1.3 composes 1.1+1.2)
Phase 2: 2.1 → 2.2 ; then 2.3 → 2.4 → 2.5   (all index.js tasks serial)
Phase 3: 3.1 → 3.2 → {3.3, 3.4} → 3.5
Phase 4: 4.1, 4.2, 4.3, 4.6, 4.7, 4.8 independent (still one at a time);
         4.4, 4.5 require Phase 3 harness
Phase 5: STRICTLY SERIAL 5.1 → … → 5.13; (5.10–5.12 abortable as a unit)
Phase 6: any time after Phase 1 (different files)
Phase 7: 7.1 needs 2.4 (/healthz); 7.2 independent
Phase 8: last

FULL REGRESSION POINTS (npm run check + CI green + manual /#/ops click-through + git tag):
  end of Phase 0, 2, 3 (tag golden-master), 5 (tag phase-5-done), 7
```

**Effort:** ~40 AI sessions + 3 human-only tasks (0.1, 0.3, 8.1-verification). Sonnet-medium suffices for ~28; Opus for the 12 flagged (2.2, 2.3, 3.2, 4.4, 4.5, 4.7, 5.3–5.12). Only 5.10–5.12 are genuinely risky and carry an explicit abort-and-skip clause — the project is production-ready without them.

**Dropped by design (senior judgment, do not revisit without a reason):** global norm() unification · app.js module split · frontend render dedups · console→logger migration · Dockerfile · git history rewrite · CORS config (same-origin SPA, no cross-origin consumers) · validation library (hand-rolled checks + prepared statements adequate at this surface) · admin-token-in-localStorage rework (server-side auth is real).

# Verification (end-to-end)

1. After every task: the task's own Verify command.
2. At each regression point: `npm run check` (lint + 56-file suite + smoke) locally AND green GitHub Actions run.
3. After Phases 2, 5, 7: manual click-through — home, a politician page, leaderboard, `#/ops` login with token, queue+watch one small job, `/healthz` in browser.
4. Final acceptance: RUNBOOK.md executed top-to-bottom by the human with every output matching.
