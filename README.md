# Pandoro's Box

Citation-backed accountability report cards on India's elected representatives
(MPs, MLAs, MLCs), ministries, and parties + a Government Watch layer on scandals —
and a **private AI Investigator desk** that surfaces leads for real journalists.
Built only from public records; every adverse line is a sourced fact, never an accusation.

> **Design principle: aggregation + citation, not accusation.** The site never asserts
> "X is corrupt." It presents the documents — "CAG Report 4/2023 flagged ₹62 cr [link];
> two cases pending per X's sworn affidavit [link]" — and lets the citizen conclude.

## Architecture: two branches after ingest

```
                     ┌─ SUMMARIZER (public, ~free)
ingest.js/fetchers ──┤   cards.js → report cards for politicians/ministries/parties
(evidence.numbers)   │   all numbers computed in code; a FREE model chain writes
                     │   only connective prose (cards work with zero LLM calls)
                     │
                     └─ AI INVESTIGATOR (private, admin-only — the GLM budget)
                         investigate.js → conflict/anomaly/collusion detectors (code)
                         → L2/L3 AI investigation → synthesis → story drafts
                         reviewed at #/admin, shared with journalists OFF-platform
```

- **Summarizer engine:** deterministic code + a rotating chain of free models (`free-chain.js`).
- **Investigator engine:** GLM-5.2 via OpenRouter — its output is never public.
- **Store:** SQLite (`data/pandoros.db`, better-sqlite3) — indexed, row-level.
- **Server:** Express, serves `public/` + a JSON API. Local only (not hosted yet).

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the request/job/detector/fetcher
flow and the facade rules to keep in mind when editing, and
**[RUNBOOK.md](RUNBOOK.md)** for operating the running site (start/stop,
backups, health checks, incident response).

---

## 1. Setup (one time)

```bash
npm install      # express, openai, better-sqlite3, pdf-parse, playwright, dotenv
```

Create `.env` in the project root:

```ini
AI_API_KEY=sk-or-...              # OpenRouter key (required for reports & scandals)
AI_MODEL=z-ai/glm-5.2             # optional override
ADMIN_TOKEN=choose-a-long-secret  # required for the in-site admin page
PORT=3000                         # website port
DATA_GOV_IN_KEY=...               # for MCA directorship download (optional)
# Optional free-chain fallback slots — Summarizer prose polish only (cards.js
# ships fine with plain template prose if these are blank). OpenRouter's free
# models alone get rate-limited under shared load; Groq/Gemini rarely do.
# GROQ_API_KEY=...                 # free: https://console.groq.com/keys
# GEMINI_API_KEY=...               # free: https://aistudio.google.com/apikey
# Optional source tuning:
# INDIAN_KANOON_KEY=...           # court judgments via API (free web-scrape fallback works without it)
# MCA_DB_PATH=data/mca.db         # directorship DB (build with mca-index.js)
# CPPP_DB_PATH=...                # govt procurement SQLite (opt-in)
# NEWS_LANGS=hi,ta,te             # override the auto Hindi+state-language news set
# SANSAD_FULLTEXT_LIMIT=0         # 0 = fast (skip verbatim Q&A PDFs); default 8
```

> Windows / PowerShell: if `npm.ps1` is blocked, run `node …` directly (every command below is `node`).

### `npm run` scripts

| Script | Effect |
|---|---|
| `npm start` / `npm run ops` | `node server/index.js` — website (`ops` also runs the job worker in-process, see §8b) |
| `npm test` | `node --test test/*.test.js` |
| `npm run smoke` | `node scripts/smoke.js` — post-start smoke check |
| `npm run lint` | `eslint .` |
| `npm run check` | lint + test + smoke, in order — the one command to run before shipping a change |
| `npm run prod:start` / `prod:stop` / `prod:status` / `prod:logs` | PM2 process control (`ecosystem.config.cjs`) — see `RUNBOOK.md` |
| `npm run db:backup` / `db:check` / `db:doctor` / `db:vacuum` / `db:maintain` | `server/platform/db-maintenance.js` subcommands — see `RUNBOOK.md` |
| `npm run worker` / `worker:once` | `node server/orchestration/worker.js` standalone (long-running / drain-and-exit) |
| `npm run reingest:party-finance` | `node scripts/reingest-party-finance.js` |

---

## 2. Start / stop the website

```bash
node server/index.js              # → http://localhost:3000   (npm start also works)
```

Kill the site only (PowerShell — leaves any running jobs alone):

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | %{Stop-Process -Id $_.OwningProcess -Force}
```

Kill every Node process (nuclear — also stops ingest/report jobs):

```powershell
Get-Process node -EA SilentlyContinue | Stop-Process -Force
```

---

## 3. Ingest evidence — `server/orchestration/ingest.js`

Pulls every source into the DB (affidavits, news EN + regional-language, court, Sansad,
party funding, MPLADS, MCA…). **No GLM cost.** Dedupes on URL, so re-runs add only new rows.
Prints elapsed time.

```bash
node server/orchestration/ingest.js                       # all real reps
node server/orchestration/ingest.js --office MP           # Lok Sabha
node server/orchestration/ingest.js --office RS           # Rajya Sabha
node server/orchestration/ingest.js --state Maharashtra   # one state
```

| Flag | Effect |
|------|--------|
| `--office MP\|RS\|MLA` | restrict to one house/type |
| `--state <Name>` | restrict to one state |

---

## 4. Summarizer — public report cards (`server/publishing/summarize.js`, ~free)

Builds the public report card for each politician: every number computed **in code**
from the evidence corpus (affidavits, MPLADS, MCA, Sansad, Wikidata), scored by the
transparent flags→baseline formula in `scoring.js`/`analyzer.js`. A rotating chain of
**free** models (`free-chain.js`) writes short connective prose; if every free model is
rate-limited the card ships with template prose — **a card never needs a paid LLM call**.

```bash
node server/publishing/summarize.js --all                    # card every real rep
node server/publishing/summarize.js --all --office MP        # filter by office
node server/publishing/summarize.js --all --state Bihar      # one state
node server/publishing/summarize.js --id <politician-id>     # a single rep
node server/publishing/summarize.js --all --no-prose         # pure templates, zero LLM
node server/publishing/summarize.js --all --no-ingest        # card existing evidence only
```

Ministry & party cards (`/api/ministries/*/card`, `/api/parties/*/card?scope=<State>`)
are pure aggregation computed on request — scandal buckets, roster grade distributions,
electoral-bond funding. Canonical subjects live in `server/data/ministries.js`.

## 4b. AI Investigator — private leads desk (`server/synthesis/investigate.js`, the GLM budget)

Finds leads worth a real journalist's follow-up. **Nothing here is ever public** — leads
live behind the admin token, reviewed at `#/admin`, and shared off-platform.

```bash
node server/synthesis/investigate.js                      # L1 detectors (free) + L2/L3 on top 50 leads (paid)
node server/synthesis/investigate.js --id <politician>    # one rep
node server/synthesis/investigate.js --l1-only            # detectors/statistics only — zero LLM
node server/synthesis/investigate.js --top 20             # cap the paid L2/L3 spend
node server/synthesis/investigate.js --stories            # also draft journalist-handoff narratives (paid)
```

Layers: L1 the **Anomaly Engine** (below) → L2 agentic investigator +
L3 skeptical referee (`investigator.js`, GLM) → L4 `synthesis.js` network hubs (code, part of
L1 synthesis) → L5 `story-generator.js` drafts (GLM). The L2 investigator now **follows the
trail**: the engine's structured citations are fed into its prompt, and it has free internal
tools to read a cited evidence row (`read_evidence`), pull sibling flags on the same subject
(`related_flags`), walk the entity's relationship graph (`entity_relations`), and full-text
search the whole corpus (`search_corpus`) — before spending any network tool. Concrete links
it establishes are written back as low-confidence relationship edges, so every investigation
grows the graph the next engine run reads. And when it surfaces a **new** suspicious entity
(a shell company, a co-director), it spawns a fresh `TRAIL_DISCOVERY` lead for that entity —
so investigation feeds discovery, not just verdicts. Its budgets are DB-tunable
(`engine.investigator.*`). Lead flow: `detected → proposed →
cleared | dismissed` ("cleared" = vetted for external sharing; it never publishes anything).

### The Anomaly Engine — `server/detectors/engine.js` (L1, code-only, free)

One registry of **46 detectors** across 13 categories runs over everything the store knows and
emits **flags**: `small` (context; feeds clusters) and `big` (lead-worthy alone). Every flag
carries evidence citations and a rationale with the actual numbers. `lead-synthesis.js` then
promotes big flags and multi-detector clusters into `investigation_leads` — same admin-gated
GLM funnel as always. Every detector's thresholds are **DB-backed and editable live** from the
ops console Tuning tab — including the wrapped legacy vectors (conflict, collusion, statistical
outliers), whose constants are now exposed as tunables too.

**The general / catch-all detectors** (find anomalies nobody wrote a rule for):
- **`generic_outlier`** — z-scores *every* numeric metric against the subject's cohort
  (robust median+MAD modified z, signed-log space), both tails. Covers any new metric the
  moment it lands in the ledger.
- **`multivariate_outlier`** — catches a rep unremarkable on every *single* metric but whose
  whole *profile* is unusual (e.g. moderate assets + low income + high spend together).
  Robust Mahalanobis-style distance over the full metric vector vs the office cohort.
- **`metric_changepoint`** — finds the year a trajectory *broke* (a step-change a
  consecutive-year ratio misses), on any series with enough points.

**The nexus net** (government–business–entity corruption shapes):
- **`nexus_triangle`** — a politician whose office covers a sector + a private interest in it
  + a government benefit to a connected entity. Two legs = candidate, all three = big.
- **`ownership_chain`** — follows director/owner edges multiple hops to an ultimate
  controller; flags deep layering chains and sets of companies tracing to one controller
  ("independent bidders secretly one group").
- **`tender_capacity_mismatch`** — a company on a government award whose paid-up capital is
  implausibly small (the "tiny shell wins a big tender" shape).

**Cross-source contradiction** (the sworn-declaration-vs-reality shapes — a genuine gap the
engine previously lacked):
- **`undeclared_criminal_case`** — declares zero (or fewer) criminal cases, yet ≥N independent
  court/CBI records name the rep. Every flag is explicitly a lead to verify identity on.
- **`vanishing_asset_item`** — a specific property/interest disappears between affidavits with
  no matching fall in total assets (the silent-omission / moved-to-family shape).
- **`copy_paste_affidavit`** — core figures identical to the rupee across different election
  years (real wealth never repeats exactly).

**Deeper wealth forensics**: `net_worth_reconciliation` (sources-and-uses flow of funds, nets
out leverage so it beats a gross-asset test), `liability_writeoff` (debt that vanishes with no
sale or income to clear it — loan-waiver shape), `zero_liability_implausibility` (large assets
+ businesses beside zero declared debt).

**Procurement forensics — the CPPP suite** (`server/detectors/cppp-detectors.js`, 9 detectors over the
**4.9M-award** Central Public Procurement Portal corpus): `cppp_single_bidder` (uncontested
wins — the #1 Open-Contracting red flag), `cppp_supplier_capture` (one firm dominates a
buyer), `cppp_contract_splitting` (values hugging just under approval thresholds),
`cppp_short_window`, `cppp_repeat_winner`, `cppp_benford_values`, `cppp_fy_end_bunching`,
`cppp_date_integrity` (contracts dated before publication — backdating), `cppp_anonymous_winner`
(materially-paid bidder with no address). These emit **company/buyer** flags with a synthetic
entity id so a supplier tripping several detectors **stacks** into one big lead — which the
investigator's Tofler tool then expands to directors and links to politicians. The 6.6 GB CPPP
DB is flattened once (`cppp-index.js`) into a lean indexed table; the detectors are **opt-in**
(they scan millions of rows) and run as their own ops job, never slowing a normal engine pass.

All general/nexus/contradiction detectors are small-flag-dominant (they earn weight inside
clusters); only the strongest go big.

**The feedback loop** — every approve / reject / dismiss decision (and each GLM verdict) is
logged to a `lead_feedback` ledger, attributed back to the contributing detector(s). The ops
console **Engine → Detector precision** panel shows each detector's reject rate and suggests
raising thresholds for detectors whose leads you mostly reject (and lowering for ones you
mostly approve). Suggestion-only — nothing auto-tunes.

```bash
node server/detectors/engine.js                       # full ledger scan → flags → leads (writes; procurement OFF)
node server/detectors/engine.js --dry-run             # preview under current thresholds, writes nothing
node server/detectors/engine.js --detector da_ratio   # one detector
node server/detectors/engine.js --id <politician>     # scope to one rep
node server/store/cppp-index.js                    # (one-time) flatten the 4.9M-award CPPP DB → indexed table
# procurement scan is opt-in: run it via the ops console "Engine · procurement scan (CPPP)"
# job, or runEngine({ procurement: true }); it scans millions of rows so it's kept separate.
```

Detector families: wrapped legacy vectors (conflict, collusion, statistical outliers,
multi-source corroboration) + disproportionate-assets check-period, liability spikes,
criminal-case escalation, election-spend-vs-cap tails (ADR bunching), assets-vs-income
mismatch, young wealth, Benford first-digit screens (Nigrini MAD bands), parliamentary
inactivity, MPLADS completion gaps, nominee-director/shell markers, award concentration,
family adverse links, party income spikes, party spend-vs-donations. Thresholds are
DB-backed and editable live from the ops console (`#/ops` → Tuning); enrichment
(Tofler directors + director-link) is free-only and records everything it learns as
evidence. Flags live in the `flags` table; re-runs are idempotent, and a full run marks
no-longer-supported flags `stale`.

## 4c. Legacy dossiers — `server/publishing/report-generator.js` (retired)

The old one-GLM-call-per-rep public dossier is retired in favour of the Summarizer card;
existing reports are kept as a frozen archive. The CLI still works during the transition.

---

## 5. Government Watch (scandals) — the "editorial" bucket

Public, GLM-written, and always human-gated (discovery only queues proposals; the GLM
analysis runs when you approve one at `#/admin`). Standalone commands:

```bash
node server/publishing/scandal-generator.js seed           # analyses for all built-in seeds
node server/publishing/scandal-generator.js seed --force   # regenerate even if present
node server/publishing/scandal-generator.js <slug>         # one scandal by slug
node server/synthesis/scandal-discovery.js                # find NEW scandals from the news → review queue
node server/synthesis/scandal-discovery.js --days 30      # widen the news window
node server/synthesis/scandal-discovery.js --list         # show pending proposals
```

Discovered scandals are **proposals** — review/approve at **`#/admin`** in the site (enter your
`ADMIN_TOKEN`). Economic scandals not already nationally-named must clear a ₹5 cr loss threshold.

---

## 6. Rosters & extra data

```bash
node server/entities/update-roster.js --apply     # refresh ALL MPs (LS + RS) in one go; add --mla for MLAs
node server/entities/import-ls.js                  # just Lok Sabha (Sansad API)
node server/entities/import-rs.js                  # just Rajya Sabha
node server/entities/bulk-import.js                # MLAs from MyNeta (per state)
node server/mca-index.js --download       # build data/mca.db (directorships) — needs DATA_GOV_IN_KEY
node server/entities/repair-myneta.js --apply      # validate/repair affidavit URLs
```

## 6b. Issues — "Where India Stands" (task #5)

```bash
node server/synthesis/issue-analyzer.js seed        # generate all 8 issue analyses (also runs inside report-generator)
node server/synthesis/issue-analyzer.js <slug>      # one issue (e.g. press-freedom)
node server/synthesis/issue-analyzer.js seed --force
```
Edit the issue list in `server/data/issues.js`; new issues are analysed automatically on the next report run.

---

## 7. Maintenance

```bash
node server/orchestration/reset-data.js                # DRY RUN — preview what would be deleted
node server/orchestration/reset-data.js --apply        # delete ALL reports + remove demo reps
node server/orchestration/reset-data.js --reports --apply    # only wipe reports
node scripts/migrate-to-sqlite.js         # one-time db.json → SQLite (already done)
```

One-off / occasional scripts live in **`scripts/`** (moved out of `server/` in
Task 5.13 so `server/` holds only code the running app imports):

```bash
node scripts/add-politician.js            # add a single politician by hand
node scripts/backfill-entities.js         # backfill the entities table from existing evidence
node scripts/backfill-fts.js              # rebuild the FTS5 full-text index
node scripts/backfill-relations.js        # backfill the relationships graph
node scripts/entities-review.js           # review/inspect entity dedup candidates
node scripts/split-shared-entities.js     # split politicians wrongly sharing one entity
node scripts/fix-rs-myneta-mismatch.js    # fix Rajya Sabha ↔ MyNeta ID mismatches
node scripts/reingest-party-finance.js    # re-run the party-finance extractor (npm run reingest:party-finance)
node scripts/smoke.js                     # post-deploy smoke check (npm run smoke)
```

`node server/platform/db-maintenance.js {backup|check|doctor|vacuum|all}` (or the
`npm run db:*` scripts below) covers DB-file-level maintenance and is
documented in `RUNBOOK.md`.

---

## 8. Admin page

In the running site, click **"Admin · review queue"** (home footer) or open **`#/admin`**.
Enter your `ADMIN_TOKEN` to review auto-discovered scandal proposals and approve/reject them.

---

## 8b. Ops Console — monitor & control the DB from a browser

A local, admin-gated dashboard to see what's in the database and run every
DB-related command without the terminal.

```bash
npm run ops        # = node server/index.js, but also runs the job worker in-process
```

Then open **`http://localhost:3000/#/ops`** and enter your `ADMIN_TOKEN`. Tabs:

- **Overview** — reps / evidence / reports / scandals counts, per-source evidence
  coverage, coverage gaps, and source health (ROTTED / STALE / QUIET).
- **Pipeline** — one-click preset chains (ingest → extract → engine; analyze-only;
  full investigation; card refresh) plus every individual command, each queued as a
  job with **live streaming logs**. Danger zone gated behind a typed `RESET` phrase.
- **Engine** — every Anomaly Engine detector with live flag counts; run or **dry-run**
  any one detector (or the whole engine) and see what current thresholds would flag
  before writing anything.
- **Tuning** — every detector's thresholds/weights/on-off as editable fields
  (DB-backed; applies on the next run; blank/reset = code default).
- **Flags** — browse small/big flags by detector/severity/subject, each expanding to
  its rationale and clickable evidence citations.
- **Leads** — the full pipeline (`detected → proposed → published/dismissed`) with
  per-lead actions: **Investigate (GLM)** on a detected lead, **Approve / Reject** on
  proposals (same gate as `#/admin`), **Dismiss** to park.
- **Roster / Jobs** — rep browser and the job queue with logs.

How it works: the console enqueues jobs onto the existing `jobs` queue; an
**in-process worker** (started by `npm run ops`) drains them. Env toggles:

| Env | Default | Effect |
|-----|---------|--------|
| `OPS_INPROC_WORKER` | on | set `0` to NOT run the worker in-process (run `node server/orchestration/worker.js` separately instead) |
| `OPS_SCHEDULER` | off | set `1` to also run the recurring scheduler (auto-ingest/discovery). Off = nothing runs unless you click it. |

## Typical workflows

**First full build of all MPs (free):**
```bash
node server/orchestration/ingest.js --office MP                    # pull sources (free)
node server/orchestration/ingest.js --office RS
node server/publishing/summarize.js --all --office MP --no-ingest   # public report cards (free)
node server/publishing/summarize.js --all --office RS --no-ingest
```

**Weekly refresh (free):**
```bash
node server/orchestration/ingest.js                                # new evidence only (URL-deduped)
node server/publishing/summarize.js --all --no-ingest           # re-card everyone
```

**Investigation sweep (paid — your call, never automatic):**
```bash
node server/synthesis/investigate.js --top 50                  # L1 free + L2/L3 on the best 50 leads
# then review at #/admin → clear leads → optionally:
node server/synthesis/investigate.js --stories                 # journalist-handoff drafts
```

---

## Anti-abuse / privacy

Anonymous citizen tips use proof-of-work + rate-limiting + a honeypot, and store only the ISO
week (never IP/User-Agent/precise time) so a tip can't be correlated with server logs. Tips are
human-reviewed and never auto-published.
