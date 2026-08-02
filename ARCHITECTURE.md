# Architecture

A map of how a request/job/detector actually moves through this codebase. See
`README.md` for usage and `RUNBOOK.md` for operating the running site.

---

## 1. Request flow

```
public/ (static SPA, hash-routed: #/, #/scandals, #/admin, #/ops, …)
        │  fetch() calls to /api/*
        ▼
server/index.js  ── core routes registered directly (health, parameters,
│                    politicians, compare, leaderboard, pow-challenge, generate)
│                    + mounts the split routers, + the error middleware LAST
├── server/routes/content.js    (mounted)  — public content: scandals, issues,
│                                             funding, scorecards, ministry/party
│                                             cards. Facet routes (e.g.
│                                             /api/scandals/facets) are
│                                             registered BEFORE their
│                                             corresponding /:slug route so the
│                                             literal path wins the match.
├── server/routes/admin.js      (mounted)  — /api/admin/* CRUD (requireAdmin)
└── server/routes/admin-ops.js  (mounted)  — /api/admin/ops/* (Ops Console API,
                                              requireAdmin): DB overview,
                                              pipeline commands, engine tuning,
                                              flags/leads, roster/jobs.
        │
        ▼
server/store/store.js  — the FACADE (see Rules below). Every route/job/detector
        │            imports from here, never from server/store/* directly.
        ▼
server/store/{db,jobs,politicians,content}.js — the actual domain modules:
    db.js          bootstraps the better-sqlite3 connection + schema/migrations
    jobs.js        job queue reads/writes (claim/complete/fail/enqueue/pause)
    politicians.js politicians/evidence/reports domain
    content.js     scandals/stories/leads/tips domain
        │
        ▼
SQLite file at PANDOROS_DB_PATH (default data/pandoros.db)
```

`server/platform/auth.js` holds `requireAdmin` (ADMIN_TOKEN check), imported by every
router that needs it. `server/routes/util.js` holds small shared route helpers
(`asyncH` error-wrapping, `decideLeadShared`).

---

## 2. Job system

```
enqueueJob(type, payload)  →  jobs table (server/store/jobs.js)
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                  ▼
        server/orchestration/worker.js (standalone:          startInProcessWorker()
        `node server/orchestration/worker.js` /              called from server/index.js
        `--once` for drain-then-exit)           at boot when the server
                    │                            itself is the worker host
                    └────────────────┬────────────────┘
                                     ▼
                         claim → dispatch via HANDLERS[job.type]
                         → calls a real exported fn (ingestFor, runEngine,
                           summarizeOne, generateReport, …) — a handler never
                           reimplements logic, it only wires the queue to it.
                         → console.log/warn/error inside the job is TEE'd by
                           teeConsole() into server/ops/ops-log.js's per-job ring
                           buffer for the duration of the job, then restored.
                                     │
                                     ▼
                         server/ops/ops-log.js push()/tail() — in-memory, bounded
                         (per-job + total), polled by the Ops Console UI to
                         stream live logs.
```

- **OPS_INPROC_WORKER** (default on) — when the server boots via `npm run ops`
  (`node server/index.js`), it also starts `startInProcessWorker()` from
  `worker.js` so one process serves HTTP and drains the queue. Set `0` to run
  `node server/orchestration/worker.js` as a separate process instead.
- **OPS_SCHEDULER** (default off) — `startScheduler()` (`server/orchestration/scheduler.js`)
  enqueues recurring jobs (auto-ingest, auto-discovery) on a timer; off means
  nothing runs unless a human clicks it in the Ops Console.
- **MIN_GAP_MS** in `worker.js` rate-limits repeated starts of the same job
  type (protects the paid GLM budget on `generate_report`/`investigate_*`).
- Some handlers are **spawn-based** (`roster_update`, `mega_refresh`,
  `repair_myneta`, `reset_data`): they `spawn()` an existing standalone CLI
  script under `server/` as a child process and stream its stdout/stderr into
  the job log line-by-line via `pushLog`, rather than re-implementing the CLI
  in-process.

**console usage inside job code is load-bearing — do not replace with a
logger.** The Ops Console's live-log streaming for a running job depends on
job code writing to `console.log`/`warn`/`error`; `teeConsole()` intercepts the
*global* console object for the duration of the job specifically so that
existing, unmodified `console.*` calls anywhere in the call graph (fetchers,
extractors, detectors, generators) become visible in the UI. Swapping any of
that to a logging library would silently break Ops Console log streaming.

---

## 3. Detector engine

```
server/detectors/engine.js — the registry + orchestration (buildCtx, resolveSettings,
                    runEngine). Detectors run over a cached per-run context
                    (politicians/facts/entities memoized once) and emit FLAGS
                    ('small' = context, feeds clusters; 'big' = lead-worthy
                    alone), each with evidence citations + a rationale.
        │
        ├── server/detectors/helpers.js   — shared run()-body helpers
        │                                    (meanStd, benfordStats,
        │                                    evidenceRef, BASE_TUNABLES),
        │                                    re-exported from engine.js so
        │                                    external importers of those
        │                                    three names keep working.
        ├── server/detectors/batch-a.js   — DETECTORS_A (Task 5.11 split)
        ├── server/detectors/batch-b.js   — DETECTORS_B (Task 5.12 split)
        ├── server/detectors/conflict.js, anomaly.js, ledger-detectors.js, collusion.js
        │       — wrapped LEGACY detector vectors (conflict-of-interest,
        │         asset/utilization/timing anomalies, income/spend/multi-
        │         source ledger checks, collusion) kept in their own modules;
        │         the engine adds enabled/bigAt tunables on top of their
        │         existing in-module defaults.
        └── server/detectors/engine-groups.js       — ENGINE_GROUPS (category rollups
                                              used by the Ops Console UI)
        │
        ▼
server/detectors/cppp-detectors.js — the CPPP procurement suite (9 detectors: single-
    bidder, supplier-capture, contract-splitting, short-window, repeat-winner,
    Benford values, FY-end bunching, date-integrity, anonymous-winner) over
    the flattened Central Public Procurement Portal award table
    (server/store/cppp-index.js builds it). Opt-in (`procurement: true` /
    `cppp_scan` job) — it scans millions of rows, so it never rides along
    with a normal engine pass.
        │
        ▼
server/detectors/engine-settings.js — resolveSettings()/setSetting()/coerceValue():
    every detector's thresholds/weights/on-off are DB-backed (engine_settings
    table) and editable live from the Ops Console Tuning tab; a blank/reset
    value falls back to the code default declared alongside the detector.
        │
        ▼
server/detectors/flags.js (upsertFlag/markStaleExcept/flagCounts) → flags table
        ▼
server/synthesis/lead-synthesis.js → investigation_leads (same admin-gated GLM funnel)
```

---

## 4. Fetcher layer

```
server/orchestration/ingest.js
    FETCHERS      — array of per-source fetcher configs/fns, one entry per
                    evidence source (affidavits, news, court, Sansad, party
                    funding, MPLADS, MCA/Tofler, …). ingestFor(p) runs the
                    applicable ones per politician via mapLimit for bounded
                    concurrency.
    L1_SOURCES    — registry of list/detail "L1" web sources (news portals,
                    government listing pages) with shared read/match/refresh
                    machinery: l1ReadBodies (download + read the linked PDF
                    body, not just the list title, cached by href), l1Match,
                    refreshL1Source/refreshL1Caches.
        │
        ▼
server/fetchers/http.js — shared low-level helpers used by fetchers across
    the codebase:
      fetchText/fetchJson  — timeout via AbortSignal.timeout, opt-in retries
                              (retries/retryDelayMs, default OFF — off unless
                              a fetcher explicitly asks for backoff)
      fetchInsecureBuffer   — classic `https` module fallback for the rare
                              government site with a broken TLS chain
                              (insecure: true, opt-in per call)
      fetchPdfText          — pdf-parse v2 (optional dep) + OCR fallback
                              (server/fetchers/pdf-ocr.js, PDF_OCR=1) for
                              scanned PDFs with no text layer
      htmlToText, contextAround, mapLimit
```

Per-fetcher `User-Agent` strings are **intentional** — each identifies this
project as public-accountability research to the specific government/news
site it targets, sometimes tuned per-site for that site's bot rules. **Do not
unify them into one shared constant beyond the common `UA` default** in
`fetchers/http.js`; fetchers that set their own header are doing so on
purpose.

---

## 5. Environment variables

Grepped from `process.env.*` across `server/` on 2026-07-14. `dataGovKey()`
in `server/platform/config.js` centralizes the four data.gov.in key aliases into one
row below.

| Name | Consumed in | Required? |
|---|---|---|
| `ADMIN_TOKEN` | `server/platform/auth.js` (requireAdmin), admin/ops routes | Yes — for `#/admin` and `#/ops` |
| `AI_API_KEY` | `server/synthesis/llm.js` / report-generator / investigator | Yes — for any paid GLM call (reports, scandals, investigation) |
| `AI_BASE_URL` | `server/synthesis/llm.js` | No — OpenRouter base URL override |
| `AI_MODEL` | `server/synthesis/llm.js` | No — model override (default `z-ai/glm-5.2`) |
| `AI_STYLE_ENABLED` | prose/style toggles | No |
| `COMPANY_REGISTRY_DISABLE` | `server/fetchers/company-registry.js` | No — kill switch |
| `CONFLICT_TOP_N` | `server/detectors/conflict.js` | No |
| `CPPP_DB_PATH` | `server/store/cppp-index.js` / `cppp-ingest.js` | No — path to the 6.6GB source CPPP DB (opt-in feature) |
| `CPPP_FLAT_PATH` | `server/store/cppp-index.js` / `cppp-detectors.js` | No — flattened award index path |
| `DATA_GOV_IN_KEY` / `DATA_GOV_API_KEY` / `DATA_GOV_KEY` / `OGD_API_KEY` | `server/platform/config.js` `dataGovKey()` (aliased, first match wins), used across `ingest.js`/`mega-ingest.js` data.gov.in fetchers | No — MCA directorship download + several JSON-API sources; skipped silently without it |
| `FACTCHECK_DISABLE` | `server/fetchers/factcheck.js` | No — kill switch |
| `GEMINI_API_KEY` | `server/synthesis/free-chain.js` | No — free-chain fallback slot |
| `GROQ_API_KEY` | `server/synthesis/free-chain.js` | No — free-chain fallback slot |
| `INDIAN_KANOON_FULLTEXT_LIMIT` | `server/fetchers/indian-kanoon.js` | No |
| `INDIAN_KANOON_KEY` | `server/fetchers/indian-kanoon.js` | No — API key; free web-scrape fallback works without it |
| `INVESTIGATOR_MOCK` | `server/synthesis/investigator.js` | No — test/dev mock mode |
| `NEWS_ALL_LANGS` | `server/fetchers/news-multilingual.js` | No |
| `NEWS_INTL_DISABLE` / `NEWS_INTL_LIMIT` | `server/sources/news.js` | No |
| `NEWS_LANGS` | `server/fetchers/news-multilingual.js` | No — override auto Hindi+state-language set |
| `NSE_DEALS_DISABLE` | `server/fetchers/nse-deals.js` | No — kill switch |
| `OPENCORPORATES_API_TOKEN` / `OPENCORPORATES_DISABLE` | `server/fetchers/opencorporates.js` | No |
| `OPS_INPROC_WORKER` | `server/index.js` boot | No — default on; `0` disables in-process worker |
| `OPS_SCHEDULER` | `server/index.js` / `server/orchestration/scheduler.js` | No — default off |
| `PANDOROS_DB_PATH` | `server/store/db.js` | No — default `data/pandoros.db` |
| `PB_NO_LISTEN` | `server/index.js` | No — test harness flag: build the app without binding a port |
| `PDF_OCR` / `PDF_OCR_LANGS` / `PDF_OCR_MAX_PAGES` | `server/fetchers/pdf-ocr.js` | No — opt-in OCR for scanned PDFs |
| `PIB_FULLTEXT_LIMIT` / `PIB_LIST_URL` / `PIB_PROJECTS_DISABLE` | `server/fetchers/pib-projects.js` | No |
| `PORT` | `server/index.js` | No — default 3000 |
| `POW_DIFFICULTY_BITS` | `server/platform/safeguards.js` | No — anonymous-tip proof-of-work difficulty |
| `SANSAD_ALL_TERMS` / `SANSAD_DISABLE` / `SANSAD_FULLTEXT_LIMIT` | `server/fetchers/sansad-mp.js` | No |
| `SEBI_DISCLOSURES_ENABLE` / `SEBI_FULLTEXT_LIMIT` | `server/fetchers/sebi-disclosures.js` / `sebi-orders.js` | No |
| `SEC_EDGAR_DISABLE` | `server/fetchers/sec-edgar.js` | No — kill switch |
| `TOFLER_DELAY_MS` / `TOFLER_ENRICH` / `TOFLER_TTL_DAYS` | `server/fetchers/tofler.js` / `server/enrichment/tofler-enrich.js` | No — director enrichment, off by default (`TOFLER_ENRICH=1` to enable) |
| `WIKIDATA_DISABLE` | `server/extractors/wikidata.js` / `server/sources/wikidata.js` | No |

---

## 6. Rules (do not violate these when editing)

- **`server/store/store.js` and `server/detectors/engine.js` are permanent facades.** External
  code (routes, jobs, scripts, tests) imports from these two modules only —
  never reach into `server/store/*.js` or `server/detectors/*.js` /
  `server/detectors/conflict.js` / `server/detectors/anomaly.js` / `server/detectors/ledger-detectors.js` /
  `server/detectors/collusion.js` / `server/detectors/cppp-detectors.js` directly. The facade is
  what let the 5.6–5.12 splits happen without touching a single call site
  elsewhere in the codebase; keep it that way for future splits too.
- **The error-handling middleware in `server/index.js` must stay registered
  last** (`app.use((err, req, res, next) => …)`), after every route and
  router mount, so Express treats it as the catch-all error handler.
- **Route registration order matters**: a facet/collection route
  (`/api/scandals/facets`) must be registered before the corresponding
  parameterized route (`/api/scandals/:slug`), or Express matches `:slug`
  first and the facet route becomes unreachable.
