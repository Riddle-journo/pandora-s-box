# Critique Assessment

Three external reviews of this codebase arrived in close succession. Two of them
were written against an **older layout** of the repository — before `server/` was
split into component folders — so much of their file-path evidence no longer
resolves, and some of their conclusions were drawn from files they never found.

This document is the durable record of what those reviews got right, what they
got wrong, and what is actually being done about the parts that landed. Every
factual assertion below carries a **current** file path, verified against the
working tree at the time of writing. Where a number is quoted, it came either
from a static read of the source or from a **read-only** query against
`data/pandoros.db`.

See `ARCHITECTURE.md` for how the system is wired, `RUNBOOK.md` for operating it,
and `REFACTOR-PLAN.md` for the refactor that invalidated the older paths.

---

## ⚠️ CORRECTIONS — read before trusting any "currently absent" claim below

This document was written **while the fixes it describes were still landing**, so
several sections assert that something is missing when it had already shipped
minutes earlier. That is a flaw in how the work was sequenced, not in the reviews.
The verdicts on the three critiques stand; the "current state" notes do not. Until
this file gets a full re-verification pass, the following corrections override the
body text:

| Body text claims | Actually true (verified 2026-07-27, after the work landed) |
| --- | --- |
| §3.1 the abstain-first linker is "not yet in the tree"; `server/util/linker.js` does not exist | **It exists and is wired.** `l1Match` in `server/orchestration/ingest.js` and the mega matcher both route through it. Abstentions are filed as `proposed` rows in `entity_assertions`. |
| §1.3 route-parameter validation is missing / should be built | **Built and wired**, `vParam` in `server/routes/util.js` across ~25 handlers, with a distinct `ref` kind for the id-OR-key routes (flag keys reach 735 chars, lead keys 595). |
| §1.8 "no `/api/v1` prefix, no `API_VERSION` constant, no version header" | **All three present** in `server/index.js`; `/api` remains a permanent alias and the SPA now calls `/api/v1`. |
| §3.6 `STRICT_TLS` / `insecureTlsInventory` are referenced nowhere outside `tls-policy.js` | **The fetchers are migrated onto it.** Verified-TLS-first with a cert-trust-only downgrade, and the unverified-host inventory surfaces in the health output. |
| §1.4 / §1.5 quote three raw `writeFileSync` calls and a tolerant-reader gap as present | **Both fixed**; the mega truncation writes use the atomic helper and the JSONL rematch readers skip-and-count corrupt lines. |
| Row 5 describes an empty catch as a `JSON.parse` guard | It is a **swallowed DB query error**, which is a different (and more reportable) thing. |
| Various counts (test totals, index counts, detector count) | Stale. Current: **756 tests / 753 pass / 3 skipped / 0 fail**, eslint 0 errors, `tsc` clean including `server/detectors/**`. |

**The one number worth carrying forward:** the abstain-first linker's read-only
audit re-decided 240 stored bulk-source evidence rows and found **34 defensibly
attributed / 178 abstain / 28 no-match — about 86% not defensibly attributed**.
(An earlier run read 52/160/28; tightening two false corroboration signals — a
state field that is a constant of a state-scoped dataset, and 3-letter party
abbreviations colliding with ordinary words — correctly moved 18 rows out of
"match".) Quarantining those rows is a pending owner decision; nothing has been
quarantined.

---

## How to read this document

| Verdict | Meaning |
| --- | --- |
| **FALSE** | The claim is contradicted by code in the tree. Usually the reviewer looked in the wrong place, or looked at a pre-refactor path. |
| **PARTIALLY TRUE** | The mechanism the reviewer described exists, but it is narrower than claimed, already mitigated, or a deliberate trade-off rather than an oversight. |
| **TRUE** | The claim holds. Either it is being fixed, or it was consciously declined. |

A note on fairness: the reviews' own wording is not stored in the repository, so
each row below records the **substance** of a claim in paraphrase. Where a
paraphrase compresses several related complaints into one row, that is called
out.

---

## Verified baseline (the ground truth these critiques should have been measured against)

Re-confirmed for this document, not inherited from anyone's summary:

| Fact | Where | Verified value |
| --- | --- | --- |
| SQLite store with WAL (write-ahead logging — a journal mode that lets readers work while a writer commits) | `server/store/db.js` | `journal_mode = WAL`, `busy_timeout = 15000`, 32 MB page cache, 256 MB mmap |
| Indices | `server/store/db.js`, `server/store/content.js`, `server/store/store.js`, `server/store/cppp-index.js` | **44** `CREATE INDEX` / `CREATE UNIQUE INDEX` statements, 29 of them in `db.js` |
| FTS5 full-text index (a SQLite extension that makes "find every document mentioning X" an indexed lookup instead of a scan) | `server/store/db.js` — `evidence_fts` | virtual table, `tokenize = 'unicode61'` |
| Separate typed ledgers (append-only tables of one measurement per row) | `server/store/db.js` — `facts`, `claims`, `events` | three distinct tables, not one blob |
| Reified relationship edges (each link is its own row carrying its own provenance, rather than a foreign key) | `server/store/db.js` — `relationships` | carries `confidence`, `evidence_id`, `source`, `detector_version`, `valid_from`, `valid_to` |
| Append-only identity audit log | `server/store/db.js` — `entity_assertions` | every name→entity decision recorded with `method`, `confidence`, `evidence_url` |
| Test suite | `test/` | **81** `*.test.js` files; 491 tests, 488 pass, 3 skipped |
| Structured logging (log lines emitted as JSON objects instead of free text, so they can be filtered by field) | `server/util/log.js` | pino, with per-job mirroring into the ops-console ring buffer |
| Job queue with exponential backoff and dead-lettering (failed work is retried after doubling delays, then parked instead of retried forever) | `server/store/jobs.js` | `run_at = now + 60s * 2^attempts`; `status='dead'` at `max_attempts` |
| Recurring scheduler | `server/orchestration/scheduler.js` | one `setInterval`, cursors in the `meta` table, no cron dependency |
| Lint | `eslint.config.js` | ESLint 9 flat config, 10 correctness rules + `no-console: warn` |
| Typecheck | `tsconfig.json` | `checkJs` over `server/store/**`, `server/util/**`, `server/synthesis/llm.js`, `server/fetchers/http.js`, `server/platform/config.js` |
| Frontend | `public/js/` | **24** vanilla ES modules, central mutable state in `public/js/state.js`, hash router in `public/js/router.js` (**68** lines) |
| Deployment | `ecosystem.config.cjs`, `RUNBOOK.md` | PM2 single instance, `autorestart`, rotating log files |
| Live database | `data/pandoros.db` | ~423 MB (444,080,128 bytes) |

Live row counts (read-only query, for scale context):

```
politicians   4,559      facts          86,579     fetch_runs    38,845
evidence     49,860      claims          4,644     jobs           1,849
entities     12,667      events          5,205     cards          9,120
relationships 9,612      leads           3,016     flags          7,274
entity_assertions 6,582  evidence_fts   39,802     lead_feedback      2
```

**One correction to the internal record too:** the detector registry is no
longer "23 detectors". `test/detector-registry.test.js` pins the exact ordered
list, and it is **49** — 40 general/statistical/nexus detectors plus 9
procurement detectors appended at import time from
`server/detectors/cppp-detectors.js`. Any document still saying 23 is stale.

---

# Section 1 — The "20 Biggest Weaknesses" critique

**Score: 13 FALSE, 5 PARTIALLY TRUE, 2 TRUE.**

This was the weakest of the three reviews. It reads as though it was produced
from a directory listing and a few opened files rather than from the code that
actually runs. Most of its severe findings assert the *absence* of something that
is present and, in several cases, has dedicated tests.

## 1.1 Verdict table

| # | Claim (paraphrased) | Verdict | Current evidence |
| --- | --- | --- | --- |
| 1 | No production database — data lives in JSON files | **FALSE** | `server/store/db.js` opens `better-sqlite3` against `PANDOROS_DB_PATH` (default `data/pandoros.db`, ~423 MB live). WAL, busy timeout, page cache and mmap are all pragma-tuned. |
| 2 | No test suite | **FALSE** | 81 files in `test/`, 491 tests. `npm test` = `node --test test/*.test.js`. Includes a golden-master API suite (`test/api-public.test.js`), a registry snapshot (`test/detector-registry.test.js`) and store isolation tests (`test/store.test.js`, `test/ledgers.test.js`). |
| 3 | No database indices — every query is a scan | **FALSE** | 44 index statements. The ones that matter for the hot paths: `idx_ev_pol` on `evidence(politician_id)`, `idx_facts_subject` on `facts(entity_id, metric, as_of_date)`, `idx_rel_src`/`idx_rel_dst` on `relationships`, `idx_jobs_claim` on `jobs(status, priority DESC, run_at)`. |
| 4 | Work is driven by hand-run scripts; there is no fault-tolerant queue | **FALSE** | `server/store/jobs.js` is a SQLite-backed queue with atomic claim, attempt counting, exponential backoff and dead-lettering. `server/orchestration/worker.js` consumes it with per-type concurrency lanes and mutex groups; `server/orchestration/scheduler.js` enqueues recurring work. Tests: `test/jobs.test.js`, `test/worker-pool.test.js`. |
| 5 | Errors are silently suppressed throughout | **FALSE** as stated | 247 `catch` sites in `server/`; exactly **3** are genuinely empty (`server/publishing/cards.js:435`, `:453`, `server/routes/content.js:147`) and all three are inner `JSON.parse` guards on an optional blob. 34 more are commented no-ops whose failure is *recorded elsewhere* (the enclosing operation logs or persists the failure). Fail-soft here is deliberate and documented; see 1.2. |
| 6 | Data models are coupled to API handlers | **FALSE** | The store is a facade: every route, job and detector imports from `server/store/store.js`, never from a store internal. Route modules (`server/routes/content.js`, `admin.js`, `admin-ops.js`) contain no SQL and no schema knowledge. The rule is stated in `ARCHITECTURE.md` §1. |
| 7 | The frontend mutates globals extensively | **FALSE** | There are **zero** `window.*` assignments across `public/js/`. Shared mutable state is one exported object of five fields in `public/js/state.js`, mutated in place because ES-module import bindings are read-only for importers. `public/js/core.js` is pure helpers by contract. |
| 8 | No linting | **FALSE** | `eslint.config.js` (ESLint 9 flat config) with 10 enabled correctness rules plus `no-console: warn`; wired into `npm run lint` and `npm run check`, and enforced in CI (`.github/workflows/ci.yml`). Current state: 0 errors. |
| 9 | No structured logging | **FALSE** | `server/util/log.js` is a pino wrapper; `logger("name")` returns a child logger whose every level is mirrored into the running job's ops-console buffer via `server/util/job-context.js`. Tested in `test/log.test.js`, `test/als-log.test.js`. See 1.2 for the honest caveat. |
| 10 | The custom hash router reinvents the wheel, poorly | **FALSE** | `public/js/router.js` is 68 lines total, including nav highlighting and mobile-menu close. It handles 10 literal routes and 6 parameterised ones. There is no measured defect and no dependency to justify. A router library would add build tooling to a project that currently ships static files with no build step. |
| 11 | Linear array scans on the request path | **FALSE** as a general claim | Two in-memory filters exist on public list endpoints (`/api/scandals`, `/api/issues` in `server/routes/content.js`) — over **69** scandals and **8** issues. Everything at real scale is an indexed query. The name-matching that *could* have been quadratic is not: `server/publishing/graph.js` gathers candidates through an inverted token index (`candidateTokens`) rather than comparing every pair. |
| 12 | Filesystem lookups on the request path | **FALSE** | `grep` for `readFileSync`, `readdirSync` and `existsSync` across `server/routes/*.js` and `server/index.js` returns **nothing**. All filesystem cache reading lives in the batch ingest path (`server/orchestration/ingest.js`), which runs as a queued job, never inside a request. |
| 13 | This is a prototype, not a system — no operational tooling | **FALSE** | `RUNBOOK.md` is a full operator manual; `ecosystem.config.cjs` is the PM2 process definition; `server/platform/db-maintenance.js` provides three scheduled maintenance tiers (nightly / weekly / monthly) with integrity checks, orphan checks, rotating `VACUUM INTO` backups and backup verification; `/healthz` is served from `server/index.js`; `express-rate-limit` guards `/api` and `/api/admin`; an Express error middleware is registered last. |
| 14 | Route parameters are not validated | **PARTIALLY TRUE** | See 1.3. |
| 15 | File writes are not atomic | **PARTIALLY TRUE** | See 1.4. |
| 16 | Large JSON caches are parsed whole into memory | **PARTIALLY TRUE** | See 1.5. |
| 17 | Migrations have no down-path | **PARTIALLY TRUE** | See 1.6. |
| 18 | One enormous stylesheet | **PARTIALLY TRUE** | See 1.7. |
| 19 | No API versioning | **TRUE** | See 1.8. |
| 20 | No Dockerfile | **TRUE** | See 1.9. |

## 1.2 On "silent error suppression" — the honest caveat

The claim is false as written, but there is a real, narrower version of it worth
keeping on the record.

The repo convention is that **fail-soft is deliberate, but a failure must always
be recorded**. Most `catch { /* … */ }` sites satisfy that because the enclosing
operation records the outcome: a fetch failure lands a row in `fetch_runs`
(`source`, `ok`, `items`, `error`, `at`); a job failure lands in
`jobs.last_error` with its attempt count; an LLM failure lands in `llm_usage`
with `ok = 0`.

Where the critique has a point is **log-channel migration debt**. There are
still **236** raw `console.*` calls under `server/`, against **18** modules that
have adopted `server/util/log.js`. Those console lines are visible in PM2's log
files and in the ops console's live job log, so nothing is *lost* — but they are
not structured, so they cannot be filtered by field. `no-console` is set to
`warn` precisely to keep that debt visible rather than to pretend it is gone.
That is a real long tail, and it is smaller and more specific than "errors are
silently suppressed throughout".

## 1.3 Route parameters (PARTIALLY TRUE)

There is no schema-validation layer (a declarative check that rejects malformed
input before it reaches handler code — the job a library like Zod or Joi would
do). Handlers take `req.params.slug`, `req.params.id`, `req.params.party` and
pass them into store calls.

What makes this a bounded problem rather than an injection risk: every store
query is a **prepared statement with bound parameters** (the value travels
separately from the SQL text, so it can never be read as SQL). Examples:
`server/store/politicians.js` `findByUrl`, `server/entities/relations.js`
`relationsOf`. A hostile `:slug` produces a 404, not a query.

Numeric query parameters *are* clamped where they control work: `pageParams` in
`server/routes/util.js` floors `page` at 1 and caps `pageSize` at `maxLimit`.

Remaining exposure: an unvalidated parameter can still reach a handler that does
something expensive or that echoes it into a 404 message. This is worth a small
shared validator; it is not the vulnerability the critique implied.

## 1.4 Non-atomic file writes (PARTIALLY TRUE)

`server/util/fs-atomic.js` exists exactly for this: `writeFileAtomic` writes to a
PID-suffixed temp file then `renameSync`s over the target, so a crash mid-write
can never leave truncated JSON that poisons every later read.

It is used by `server/orchestration/ingest.js`,
`server/orchestration/mega-ingest.js` and `server/catalogue/opendata-catalog.js`.
Tested in `test/fs-atomic.test.js`.

Three raw `writeFileSync` calls remain, all in
`server/orchestration/mega-ingest.js` (lines 699, 860, 918) and all writing an
**empty string** to truncate a raw-dump or index file before rewriting it. A
crash between the truncate and the rewrite loses a rebuildable cache, not data.
`server/orchestration/worker.js:111` documents this as a known reason certain job
types are kept in an exclusive lane.

Verdict stands as partially true: the mechanism is right, the coverage is not
100%, and the gap is in the cheapest-to-lose files.

## 1.5 Whole-file JSON parsing (PARTIALLY TRUE)

`server/orchestration/ingest.js:161` is the whole of it:

```js
function l1Read(id) { try { return JSON.parse(fs.readFileSync(l1Path(id), "utf8")); } catch { return null; } }
```

Some of those caches are genuinely large (`maxRows` on several L1 sources is
60,000–150,000). Parsing one whole is a real memory spike.

Two things bound it. First, this is **batch-path only** — `l1Read` is called from
`l1Match`/`refreshL1Source` inside ingest jobs, never from a request handler
(confirmed: no filesystem calls in `server/routes/`). Second, ingest runs in the
worker process under a concurrency lane, so the spike is one file at a time, not
189 simultaneously.

Streaming these would be a genuine improvement. It is a batch-throughput
optimisation, not a correctness or availability issue.

## 1.6 No down-migrations (PARTIALLY TRUE)

Accurate as a fact, wrong as a criticism, for two documented reasons.

**Rebuildable by design.** The analysis ledgers are derived data. The comment
block in `server/store/db.js` states the contract: blobs are the source of truth,
the ledgers are always rebuildable (delete by `extractor_version`, re-extract),
so improving an extractor never risks raw data. That is why the facts/claims
shape change at the top of `db.js` **drops and recreates** rather than `ALTER`s.

**Backups are the rollback.** `server/platform/db-maintenance.js` takes rotating
`VACUUM INTO` backups (a SQLite command that writes a fully consistent,
defragmented copy with no separate `-wal`/`-shm` files to reconcile) and then
verifies them. `backup` + `backup_verify` are in the **nightly** tier and again
in **monthly**; `scheduler.js` enqueues all three tiers.

The genuine risk is narrower and is carried in Section 3: a runtime
`DROP TABLE` fires at *import time* on a schema-shape mismatch, so a botched
schema edit can destroy a rebuildable table before anyone reads a migration
plan. An explicit, versioned migration step is the fix — not a down-path for
every up-path.

## 1.7 One large stylesheet (PARTIALLY TRUE)

`public/styles.css` is 1,065 lines — one file, no build step. But it is not
undisciplined: it declares **54** CSS custom properties (design tokens — named
values like `--good`, `--bad`, `--na` that every rule references instead of
hard-coding a colour), and both themes are driven from them. `public/js/core.js`
returns `var(--good)` / `var(--mid)` / `var(--bad)` from `barColor` rather than
literals, so the theme system actually holds.

1,065 token-driven lines in a project with no bundler is a reasonable place to
be. Splitting it would require adding build tooling whose only benefit is file
count.

## 1.8 No API versioning (TRUE — being fixed)

Verified absent: no `/api/v1` prefix, no `API_VERSION` constant, no version
header, and no deprecation mechanism anywhere in `server/routes/` or
`server/index.js`.

This matters more here than in a typical app because the SPA and the golden-
master tests (`test/api-public.test.js`, `test/api-pagination.test.js`) are
pinned to exact payload shapes. The existing opt-in pagination in
`server/routes/util.js` (`maybePaginate` — no `page`/`pageSize` in the query
returns the bare legacy array) is the pattern that *should not have been
necessary*: it is a version negotiation wearing a query-parameter costume.

A versioning change is in flight in a parallel workstream. Until it lands, this
row is simply TRUE.

## 1.9 No Dockerfile (TRUE — declined)

Verified absent: no `Dockerfile`, no `docker-compose.yml`, no `.dockerignore`.

This was a decision, not an omission. The deployment story is PM2 plus
`RUNBOOK.md`: `ecosystem.config.cjs` defines one `pandoros` app with
`autorestart`, `max_restarts: 10`, `min_uptime: "10s"` and merged log files;
`RUNBOOK.md` gives an operator a copy-pasteable PowerShell command and the exact
expected output for start, stop, status and logs.

For a single-node, single-writer SQLite application whose entire state is one
file plus a cache directory, a container adds a build artefact, an image
registry and a volume-mount story in exchange for nothing this deployment needs.
`VACUUM INTO` backups already give a portable, consistent snapshot. Revisit if
and when a second node exists.

---

# Section 2 — The architectural critique

This review was much better informed and much more ambitious. It prescribed a
graph database (Neo4j or ArangoDB), a message broker (Kafka or RabbitMQ), object
storage (S3 or MinIO), a workflow engine (Temporal or LangGraph), a vector
database (pgvector) and "delete 80% of the UI".

**Its factual premises are mostly wrong. Several of its observations about the
model are exactly right and have been adopted.** Both halves matter, so both are
recorded.

## 2.1 Where the premises fail

| Premise | Verdict | Current evidence |
| --- | --- | --- |
| Facts and unverified claims are lumped into one undifferentiated store | **FALSE** | `server/store/db.js` declares `facts` and `claims` as separate tables with different columns and different semantics. `facts` holds measured quantities (`metric`, `value`, `unit`, `tier`). `claims` holds asserted allegations with `status DEFAULT 'unverified'` and a `confidence`. The comment in `db.js` states the reason: "Kept separate from facts so an unverified news claim never mixes into a tier-1 affidavit number." |
| Relationships are implicit, with no confidence or provenance | **FALSE** | `relationships` is a reified edge table: `src_entity_id`, `dst_entity_id`, `rel_type`, `valid_from`, `valid_to`, `confidence`, `evidence_id`, `source`, `detector_version`. A unique index over `(src, dst, rel_type, source, coalesce(valid_from,''))` makes re-derivation idempotent. |
| There is no adversarial / devil's-advocate check on LLM output | **FALSE** | The L3 referee in `server/synthesis/investigator.js` is exactly that: a second model pass given the allegation, the investigator's own reasoning, the evidence it cited and the records, and asked for the *innocent* explanation. If it returns `fully_explainable === true`, the verdict is forced to `COINCIDENCE` and the lead is dismissed. The pipeline is documented in `server/synthesis/investigate.js` as L1 (code detectors) → L2 (agentic tool loop) → L3 (skeptical referee) → L4 (code synthesis) → L5 (story draft). |
| LLM investigations run inline on the request path and cannot survive a restart | **FALSE** | `investigate_lead`, `investigate_politician` and `investigate_all` are job types in `server/orchestration/worker.js`, each with a 30-second minimum spacing to protect the paid budget. `investigator.js` persists after **every tool step** (`persist()`, called inside the loop) and rebuilds its bookkeeping from `state.steps` on entry — a crash mid-investigation loses nothing and a restart resumes. Duplicate tool+args calls are skipped, and per-tool call budgets are enforced. |
| Deep multi-hop graph traversal is being attempted with recursive SQL joins | **FALSE** | It is not attempted in SQL at all. `relationsOf` in `server/entities/relations.js` is a single-hop indexed query over `relationships`; multi-hop walking is composed in JavaScript at a bounded depth in `server/publishing/graph.js`. That file also carries a hard identity guard — a `COMMON` set of high-frequency Indian name tokens, with `identityStrong()` requiring ≥2 distinctive shared tokens (or 1 among ≥3) — because a false dynasty claim on a public accountability site is defamation. |

## 2.2 Why each infrastructure prescription is declined

The constraints that make these prescriptions wrong *for this system* are worth
stating once, plainly, so the argument does not have to be re-had.

**The four constraints.** (a) The whole database is **~423 MB** and fits on one
node with room to spare. (b) The project is **local-first and free-tier** —
there is no cloud budget, and the LLM budget is metered in `llm_usage` because
it is genuinely scarce. (c) There is exactly **one writer** (the worker process);
WAL plus a 15-second busy timeout serialises the rare overlap. (d) The **public
UI is half the product**, not decoration — the deterministic Summarizer branch
*is* a published deliverable.

| Prescription | Why it is declined |
| --- | --- |
| **Neo4j / ArangoDB** | The graph is 12,667 entities and 9,612 edges. Traversals are single-hop indexed lookups (`idx_rel_src`, `idx_rel_dst`) composed in code. A graph database earns its operational cost at variable-depth traversal over millions of edges; here it would add a second daemon, a second backup story, and a second consistency boundary between the graph and the evidence rows that justify each edge. The temporal question the critique cared about — "who owned this company *when* the tender was awarded" — is already answerable: `relationsOf(id, { at })` filters on `valid_from`/`valid_to`. |
| **Kafka / RabbitMQ** | There is one producer process and one consumer process on one machine. `server/store/jobs.js` already provides the properties a broker is bought for: atomic claim (`UPDATE … SET status='running'` guarded on `status='queued'`), at-least-once delivery, exponential backoff, dead-lettering, and — because it is a table in the same database — **transactional visibility with the data the job produced**. A broker would put the queue in a different consistency domain from the results, which is a downgrade, not an upgrade. All 1,849 historical jobs are `done`. |
| **S3 / MinIO** | The only blob-shaped data is the ingest cache: rebuildable JSON dumps of public bulk sources, written atomically via `server/util/fs-atomic.js` and pruned by the `cache_prune` maintenance task. Losing the whole cache directory costs a re-fetch, not data. Object storage would add credentials, egress and a network hop to files that exist to *avoid* network hops. |
| **Temporal / LangGraph** | The specific guarantee wanted here is durable resumption of a multi-step LLM investigation, and it already exists: step-level checkpointing into the lead's `investigation` blob, resume-from-`state.steps`, idempotent tool-call skipping, per-tool budgets, and an error path (`fail()`) that returns the lead to `detected` rather than stranding it. A workflow engine would replace ~40 lines of understood code with a service, a worker SDK and a new deployment. |
| **pgvector (semantic / embedding search)** | Retrieval here must be **citable**. Every public claim has to trace to a named source, and the investigator's `search_corpus` tool returns `evidence_id` plus an FTS5 `snippet()` with the matched span highlighted — a reader can open the exact record. Embedding search returns "similar", which cannot be footnoted. FTS5 over 39,802 indexed documents also costs nothing per query, whereas embedding 49,860 records has a real bill against constraint (b). The right first move is to fix FTS **coverage** (Section 3), not to add a second, less citable index alongside a half-populated one. |
| **"Delete 80% of the UI"** | This misreads the product. There are two branches by design: a **public deterministic Summarizer** (report cards, scorecards, the funding and issues views) and a **private AI Investigator** whose leads are admin-gated and never auto-published — `server/routes/content.js` carries an explicit comment that Investigator output is never public. Deleting the public UI would delete the shipped half. The 24 modules in `public/js/` are 68-to-a-few-hundred lines each; there is no measured maintenance problem to solve. |

## 2.3 Where this critique landed — five findings adopted

These were correct, are confirmed here with numbers, and are on the roadmap.

**1. The claims ledger's `status` never transitions.** `claims.status` defaults
to `'unverified'` and no code path anywhere in `server/` or `scripts/` ever
issues an `UPDATE` against it. Every extractor inserts `status: "unverified"` —
`server/extractors/financial-links.js`, `insolvency-defaulters.js`,
`audit-regulatory.js`, `indian-kanoon.js`. Live: **4,644 of 4,644 claims are
`unverified`**. A state machine with no transitions is a comment, not a state
machine. The same is true one layer down: **6,582 of 6,582 `entity_assertions`
are `accepted`** — the schema has a `status` column and an abstain state has
never been recorded.

**2. There is no run-id or prompt-version provenance on LLM output.** The
*deterministic* side has this: `server/detectors/engine.js` mints a `runId` per
scan and stamps it onto every flag, and `markStaleExcept(detector, runId)` in
`server/detectors/flags.js` uses it to retire flags a newer run did not
reproduce. The *LLM* side does not. `investigator.js` records `state.model` and
`state.investigated_at` but no run id and no prompt version — so when a prompt
changes, there is no way to ask "which verdicts came from the old prompt?" and no
way to retire them the way stale flags are retired.

**3. The timing detector measures proximity, not causal ordering.**
`detectTimingCorrelation` in `server/detectors/anomaly.js` computes
`Math.abs(new Date(aw.at) - new Date(bp.at))` — so a tender awarded 40 days
*before* a bond purchase scores identically to one awarded 40 days *after*. The
detector's own prose is honest ("Temporal proximity is a candidate for review,
not a finding") and both raw dates are preserved in `data.bond_purchase_at` /
`data.award_at`, so ordering is recoverable. But the score is order-blind, and
for a donation→award mechanism the direction is most of the signal.

**4. There is no per-job heartbeat.** The `jobs` table has `started_at` but no
`heartbeat_at`. Liveness is inferred from age: `reclaimRunningJobs({ olderThanMs })`
in `server/store/jobs.js`, exposed as `reclaimZombies({ minutes = 30 })` in
`server/platform/db-maintenance.js`, called on worker startup
(`server/orchestration/worker.js`) and in the weekly maintenance tier. That is
self-healing but coarse: a job that is legitimately slower than the threshold can
be reclaimed while still running, and a job that hangs is invisible until the
threshold passes. Attempts are deliberately *not* reset on reclaim, so a job that
keeps zombie-ing still dead-letters — that part is right.

**5. The investigator has no cross-lead memory of prior human verdicts.**
`recordLeadFeedback` in `server/store/content.js` writes to `lead_feedback`, and
`investigator.js` calls it to log the model's own verdict as a cheap automatic
label. Nothing ever reads `lead_feedback` *back into a prompt*. Every
investigation starts from zero, so a pattern a human already rejected five times
gets investigated a sixth time at full token cost.

---

# Section 3 — The panel self-audit (accepted roadmap)

The third review was an internal panel audit. It was accurate, and it is now the
accepted roadmap. This section records its findings and their verified current
state.

## 3.1 The central finding: entity resolution is the real bottleneck

Everything else in the system is downstream of one question: *is this the same
person?* And for bulk sources, the answer was being decided by a normalised
substring test.

The matcher in `server/orchestration/ingest.js`:

```js
const l1Norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
…
const hits = cache.rows.filter((row) => l1Norm(row.join(" | ")).includes(needle));
```

`l1Match` lowercases, strips punctuation, collapses whitespace, and asks whether
the **entire joined row** contains the politician's name as a substring. The only
guard is a length floor (`needle.length < 4`).

Exact scope, counted from the source rather than assumed:

| Source table | Total sources | `match: "name"` | `match: "party"` | `match: "none"` |
| --- | --- | --- | --- | --- |
| `L1_SOURCES` in `server/orchestration/ingest.js` | 189 | 45 | 1 | 143 |
| `MEGA_SOURCES` in `server/orchestration/mega-ingest.js` | 78 | 59 | — | 19 |

So **104 bulk sources** attribute records to a named individual through this
test, and 162 do not attribute to a person at all (they are ingested as context —
consistent with the keep-all-data rule). That is the blast radius.

Why this is the worst failure mode in the system and not merely a precision
problem: a substring hit on a common Indian name pattern attaches an adverse
public record to the wrong person. `server/publishing/graph.js` already
demonstrates the right instinct at a different layer — its `COMMON` token set and
`identityStrong()` predicate exist because "two unrelated *Sunil Kumar*s among
4,500+ reps" is a coin flip, and it says so in a comment that ends with the word
"defamation".

**Current state, verified:** the abstain-first linker is **not yet in the tree**.
`server/util/linker.js` does not exist; no module references a `linker`; and
`l1Match` is unchanged. The design is agreed — a linker that scores a candidate
match and **abstains** rather than guessing when the score is ambiguous, writing
an `entity_assertions` row with a non-`accepted` status so the abstention is
auditable rather than invisible — and the schema already supports it
(`entity_assertions.status`, `confidence`, `method`). What does not exist yet is
the code. The 6,582-of-6,582-`accepted` figure in §2.3 is the measure of how much
this matters: right now nothing ever declines to decide.

The building blocks that *do* exist and that the linker should reuse:
`server/util/names.js`, the transliteration matching tested in
`test/translit.test.js`, `candidateTokens` / `identityStrong` in
`server/publishing/graph.js`, and the `strongIdsConflict` guard in
`server/entities/entities.js` (which already refuses to merge two entities whose
strong identifiers disagree, rather than corrupting identity).

## 3.2 Eval-set-first doctrine

491 tests measure **code**. Not one measures **investigation quality**.

`test/detector-registry.test.js` pins that the registry has exactly 49 detectors
in a fixed order. It does not — cannot — say whether any of them is right. There
is no labelled set of "this lead was real / this lead was noise" against which a
detector change can be scored, so every threshold edit is a guess and every
prompt edit is unfalsifiable.

The doctrine adopted: **build the eval set before building the next feature.**
A held-out set of hand-labelled leads, versioned in the repo, scored on every
detector and prompt change. Until it exists, "we improved the engine" is an
opinion.

## 3.3 `confirming_record` — produced, surfaced, then dropped

The L2 prompt in `server/synthesis/investigator.js` asks the model for
`confirming_record`: "the single record that would confirm or kill this". It is
extracted (`state.confirming_record = verdictObj?.confirming_record ?? ""`) and it
*is* rendered in the admin UI (`public/js/admin.js`, two places).

What never happens is anything **actionable**. The model names the one document
that would settle the question, and the system does not queue a fetch for it,
does not check whether the corpus already contains it, and does not carry it
forward to the next investigation of the same entity. The most valuable single
sentence the LLM produces is treated as display text.

Contrast with the mechanism that *does* close the loop: `spawnFollowupLeads` takes
`discovered_relations` from a surviving verdict and enqueues a fresh
`TRAIL_DISCOVERY` lead per named entity, capped and tunable. That pattern is
right; `confirming_record` should get the same treatment.

## 3.4 Confidence is never calibrated

`facts`, `claims`, `relationships`, `entity_assertions` and the LLM verdict all
carry a `confidence`. No number in that column has ever been compared against an
outcome.

The calibration data would come from `lead_feedback`. Live, that table has **2
rows**, and `detectorPrecision` in `server/store/content.js` requires
`minSample = 5` before it will even report on a detector. Lead statuses tell the
same story: **3,012 `detected`, 4 `dismissed`, 0 approved or published**.

So the honest statement is not "the confidence is miscalibrated" — it is that
**there is nothing yet to calibrate against**. The scoring machinery
(`detectorPrecision`, the per-detector approve/reject tallies, the ops-console
surface for them) is built and correct; it is starved. Generating human labels is
therefore not a nice-to-have — it is the input to everything in §3.2 and §3.4.

Note that `detectorPrecision` is suggestion-only by design: the ops console shows
a high reject rate, and nothing auto-changes a threshold. That is the right
default and should survive calibration.

## 3.5 Schema gaps

**No content hashing.** `evidence` has `id`, `politician_id`, `url`, `date`,
`has_content`, `fetched_at`, `data` — and no hash of the fetched bytes. The only
`createHash` in `server/` is in `server/platform/safeguards.js`, for the
proof-of-work tip challenge. Dedup is therefore by `(politician_id, url)`
(enforced by `idx_ev_uniq`), which cannot tell that two URLs served the same
document, and cannot tell that a URL's content *changed* except through the
`richness()` heuristic in `addEvidence`. A `content_hash` column would give
cheap change detection and cross-URL dedup.

**FTS is manually backfilled and is stale right now.** `evidence_fts` is
populated only by `scripts/backfill-fts.js`. `addEvidence` in
`server/store/politicians.js` inserts into `evidence` and never touches
`evidence_fts`. The live gap: **evidence = 49,860 rows, evidence_fts = 39,802
rows — 10,058 documents are not searchable.**

This is not cosmetic. `search_corpus` is one of the investigator's four internal
tools, described to the model as searching "ALL ingested records"; it is
searching 80% of them, and its failure mode is a confident negative ("no records
mention X") rather than an error. The weekly `fts_verify` maintenance task does
**not** catch this: it runs FTS5's `'integrity-check'`, which validates that the
index is internally consistent — it says nothing about rows that were never
indexed. Coverage and integrity are different checks, and only one exists.

**No supports / contradicts links between assertions.** `entity_assertions` rows
are independent. There is no column and no join table expressing "assertion B
corroborates assertion A" or "assertion C contradicts it". So corroboration
across independent sources — the single strongest signal available, and the thing
the L2 prompt explicitly tells the model to look for ("corroboration across
detectors is a strong signal") — has to be recomputed in memory every time
instead of being an accumulating asset.

**Facts have no validity interval.** `facts` carries `as_of_date` and `period`
but no `valid_from`/`valid_to`, unlike `relationships`, which has both. So a fact
is a point observation with no expiry: nothing distinguishes "net worth as
declared in the 2019 affidavit, superseded in 2024" from "current net worth".
Live, **5,382 of 86,579 facts have no `as_of_date` at all** — undated point
observations in a ledger whose whole purpose is temporal comparison.

**An unindexed JSON entity array on events.** `events.entity_ids` is a `TEXT`
column holding a JSON array. `idx_events_kind` covers `(kind, at)`, and
`idx_events_uniq` includes `entity_ids` as an opaque string for idempotency —
neither makes "every event involving entity X" an indexed query. With 5,205
events it is currently cheap; it is the wrong shape for growth, and a junction
table (`event_id`, `entity_id`) would fix it without touching the blob.

**Runtime DROP-based migration.** At the top of `server/store/db.js`, before any
application code runs:

```js
for (const t of ["facts", "claims"]) {
  … if (!cols.includes("subject_kind")) db.exec(`DROP TABLE ${t}`);
}
```

The reasoning is sound (both tables are rebuildable by design). The mechanism is
not: a destructive DDL statement fires as an import side effect, on any process
that opens the database, with no versioning and no operator confirmation. The fix
is an explicit versioned migration step invoked deliberately — not a down-path
for every up-path (see §1.6).

## 3.6 TLS trust downgrades on government sources

Several Indian government hosts serve certificates that Node will not trust.
`server/fetchers/http.js` supports an `insecure: true` option that routes through
an insecure buffer fetch, and **11** sites across `server/fetchers/http.js`,
`server/orchestration/ingest.js` and `server/orchestration/mega-ingest.js`
currently set it — 7 of them in the `L1_SOURCES` table.

Blanket-disabling verification for those hosts means an attacker on the path can
substitute the content of a government record that later becomes a public claim
about a named person. That is the same failure mode as bad entity resolution,
arriving by a different route.

The shared remedy exists: **`server/util/tls-policy.js`** provides
`fetchBufferSecureFirst` (attempt verified TLS first; downgrade **only** on a
certificate-trust error, never on any other failure),
`fetchBufferInsecure`, an `insecureTlsInventory()` that records every host
actually downgraded, and `STRICT_TLS=1` to disable the fallback entirely. Tests:
`test/tls-policy.test.js`.

**Current state:** the helper and its tests are in the tree; the fetchers have
**not** yet been migrated onto it (`STRICT_TLS` and `insecureTlsInventory` are
referenced nowhere outside `tls-policy.js` itself). Wiring is a separate
workstream. The important property once wired is not "no insecure fetches" — some
of these hosts genuinely cannot be fetched otherwise — it is that every
downgrade is **recorded**, so the set of records whose transport was untrusted is
enumerable rather than guessed.

## 3.7 Per-source volume alerting on `fetch_runs`

`fetch_runs` is already the right ledger: 38,845 rows of
`(source, ok, items, ms, error, at)`, indexed by `idx_fetch_runs_src` on
`(source, at)`. `sourceHealth(days)` in `server/store/store.js` aggregates runs,
ok-rate, total items and last success per source.

The only alert built on it is binary. `server/platform/db-maintenance.js`
flags a source as *quiet* when `runs > 0 && ok_rate >= 0.5 && total_items === 0`.
A source that returned 500 rows last week and 5 this week is **healthy** by that
test: it ran, it succeeded, it returned items.

That is the most common real-world failure of a scraper against a government
site — the page still returns 200, the layout changed, the selector now matches
one row instead of five hundred. The data to catch it is already stored; what is
missing is a per-source rolling baseline and a relative-drop threshold. This is
the cheapest high-value item on the whole roadmap: one query against an existing
indexed table, and one new finding type in an existing maintenance tier.

## 3.8 The durability rule

The audit's closing formulation, which is now the standing rule for this
codebase:

> **Intelligence belongs in the model. Facts, identity, provenance and human
> labels belong in the database.**

Models get better, cheaper and replaceable; anything that lives only inside a
prompt or only inside a model's weights is rented. Anything written into
`facts`, `claims`, `events`, `relationships`, `entity_assertions` and
`lead_feedback` — with its evidence id, its source, its extractor or detector
version and its date — is owned, and survives every model swap.

This is the test to apply to any proposed change: *if the LLM provider vanished
tomorrow, what would this leave behind?* The L1 detector layer passes (49
detectors, pure code, free). Step-level investigation checkpointing passes. A
verdict with no run id or prompt version fails — it cannot even be attributed to
what produced it.

And the corollary, which is the actual strategic point: **the scarcest asset this
project can accumulate is the owner's labelled set of Indian-corruption leads.**
Compute is rentable, models are swappable, the source data is public. A curated
set of "this lead was real, this one was noise" judgements over Indian public
records exists nowhere else and cannot be bought. That is why §3.2 (eval set) and
§3.4 (calibration) sit above every infrastructure item in this document — and why
the live counts of 2 `lead_feedback` rows and 0 approved leads are the most
important numbers on this page.

---

# Not verified

Stated plainly, because a document that only lists resolved questions is
misleading.

**Detector precision and recall are unmeasured.** All 49 detectors are pinned by
`test/detector-registry.test.js` for existence and order; none is measured for
correctness. `detectorPrecision` in `server/store/content.js` exists to compute
it and has a sample of 2. There is no false-positive rate for any detector in
this repository, and no honest way to produce one before §3.2 lands.

**The live false-attribution rate is unknown.** The substring matcher in
`server/orchestration/ingest.js` runs across 104 name-matched bulk sources, and
nobody has audited a sample of its output against ground truth. The rate could be
1% or 30%; the argument in §3.1 rests on the mechanism being unsound, not on a
measured error rate. Establishing that number is the first job of the linker
work, and it should be measured **before** the replacement ships, so there is a
before-and-after.

**LLM verdict quality has never been compared against human labels.** 3,016
leads exist. 3,012 are still `detected`; 4 are `dismissed`; 0 have been approved
or published. `lead_feedback` holds 2 rows. The L2/L3 pipeline has therefore
never been scored against a human, and the automatic `glm_proposed` /
`glm_dismissed` labels it writes are the model grading its own homework — useful
as a cheap signal, worthless as validation.

**Not claimed as verified in this document:** the 491/488/3 test figure and the
"0 ESLint errors" figure are the shared baseline for the current working tree,
not results this document re-ran (the tree is being edited concurrently, and a
repo-wide run would report other people's in-flight files). The 81 test files,
44 indices, 49 detectors, 236 `console.*` calls, 189 + 78 bulk sources, 11
insecure-TLS sites and every live row count above **were** verified here.

---

*Written against the working tree on branch `refactor/component-folders`, after
the `server/` component-folder reorganisation. If a path in this document no
longer resolves, the reorganisation was not the cause — check `git log` for a
later move.*
