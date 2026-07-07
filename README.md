# Pandoro's Box

AI-generated, citation-backed accountability dossiers on India's elected representatives
(MPs, MLAs, MLCs) + a Government Watch layer on scandals, ministers, and governments.
Built only from public records; every adverse line is a sourced fact, never an accusation.

> **Design principle: aggregation + citation, not accusation.** The site never asserts
> "X is corrupt." It presents the documents — "CAG Report 4/2023 flagged ₹62 cr [link];
> two cases pending per X's sworn affidavit [link]" — and lets the citizen conclude.

- **Engine:** GLM-5.2 via OpenRouter (the investigative journalist).
- **Store:** SQLite (`data/pandoros.db`, better-sqlite3) — indexed, row-level.
- **Server:** Express, serves `public/` + a JSON API. Local only (not hosted yet).

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
# Optional source tuning:
# INDIAN_KANOON_KEY=...           # court judgments via API (free web-scrape fallback works without it)
# MCA_DB_PATH=data/mca.db         # directorship DB (build with mca-index.js)
# CPPP_DB_PATH=...                # govt procurement SQLite (opt-in)
# NEWS_LANGS=hi,ta,te             # override the auto Hindi+state-language news set
# SANSAD_FULLTEXT_LIMIT=0         # 0 = fast (skip verbatim Q&A PDFs); default 8
```

> Windows / PowerShell: if `npm.ps1` is blocked, run `node …` directly (every command below is `node`).

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

## 3. Ingest evidence — `server/ingest.js`

Pulls every source into the DB (affidavits, news EN + regional-language, court, Sansad,
party funding, MPLADS, MCA…). **No GLM cost.** Dedupes on URL, so re-runs add only new rows.
Prints elapsed time.

```bash
node server/ingest.js                       # all real reps
node server/ingest.js --office MP           # Lok Sabha
node server/ingest.js --office RS           # Rajya Sabha
node server/ingest.js --state Maharashtra   # one state
```

| Flag | Effect |
|------|--------|
| `--office MP\|RS\|MLA` | restrict to one house/type |
| `--state <Name>` | restrict to one state |

---

## 4. Generate reports — `server/report-generator.js`

GLM writes **one report per politician** (auto-ingesting first). The scandal generator +
auto-discovery run **as part of this** (scandals are GLM work, not ingest). Prints elapsed time.

```bash
node server/report-generator.js all                  # everyone (incremental)
node server/report-generator.js all --office MP       # all MPs
node server/report-generator.js all --state Bihar     # one state
node server/report-generator.js all --limit 20        # first 20 (good for testing)
node server/report-generator.js <politician-id>       # a single rep
```

**Update mode — you choose (default `incremental`):**

| Mode | Sent to GLM | Use when |
|------|-------------|----------|
| `--mode incremental` | prior-findings digest + **only new** evidence; skips reps with nothing new | routine refresh, cheapest |
| `--mode full` | the **whole** raw corpus, **no** memory of past findings | clean-slate rebuild |
| `--mode recheck` | the **whole** raw corpus **again** + the prior digest, told to confirm known patterns and hunt for **new** ones | periodic deep re-investigation |
| `--full` | alias for `--mode full` | — |

**Other flags:** `--new-only` (only reps with no report yet — pure resume), `--force` (regen
even if incremental finds nothing new), `--no-scandals` (skip the GLM scandal step).

**Reprocess-on-change:** reports are stamped with `PIPELINE_VERSION` (in `report-generator.js`).
Bump it whenever you add a source/field/issue or materially change the prompt — the next run then
auto-re-investigates the **whole back-catalogue** once in `recheck` mode, so nothing is left behind.

---

## 5. Government Watch (scandals)

Run automatically inside `report-generator.js`; also available standalone:

```bash
node server/scandal-generator.js seed           # analyses for all built-in seeds
node server/scandal-generator.js seed --force   # regenerate even if present
node server/scandal-generator.js <slug>         # one scandal by slug
node server/scandal-discovery.js                # find NEW scandals from the news → review queue
node server/scandal-discovery.js --days 30      # widen the news window
node server/scandal-discovery.js --list         # show pending proposals
```

Discovered scandals are **proposals** — review/approve at **`#/admin`** in the site (enter your
`ADMIN_TOKEN`). Economic scandals not already nationally-named must clear a ₹5 cr loss threshold.

---

## 6. Rosters & extra data

```bash
node server/update-roster.js --apply     # refresh ALL MPs (LS + RS) in one go; add --mla for MLAs
node server/import-ls.js                  # just Lok Sabha (Sansad API)
node server/import-rs.js                  # just Rajya Sabha
node server/bulk-import.js                # MLAs from MyNeta (per state)
node server/mca-index.js --download       # build data/mca.db (directorships) — needs DATA_GOV_IN_KEY
node server/repair-myneta.js --apply      # validate/repair affidavit URLs
```

## 6b. Issues — "Where India Stands" (task #5)

```bash
node server/issue-analyzer.js seed        # generate all 8 issue analyses (also runs inside report-generator)
node server/issue-analyzer.js <slug>      # one issue (e.g. press-freedom)
node server/issue-analyzer.js seed --force
```
Edit the issue list in `server/data/issues.js`; new issues are analysed automatically on the next report run.

---

## 7. Maintenance

```bash
node server/reset-data.js                # DRY RUN — preview what would be deleted
node server/reset-data.js --apply        # delete ALL reports + remove demo reps
node server/reset-data.js --reports --apply    # only wipe reports
node server/migrate-to-sqlite.js         # one-time db.json → SQLite (already done)
```

---

## 8. Admin page

In the running site, click **"Admin · review queue"** (home footer) or open **`#/admin`**.
Enter your `ADMIN_TOKEN` to review auto-discovered scandal proposals and approve/reject them.

---

## Typical workflows

**First full build of all MPs:**
```bash
node server/ingest.js --office MP                    # pull sources (free)
node server/ingest.js --office RS
node server/report-generator.js all --office MP      # write reports (GLM)
node server/report-generator.js all --office RS
```

**Weekly refresh (cheap):**
```bash
node server/report-generator.js all                  # incremental; skips unchanged reps
```

**After adding a new source/field (bump PIPELINE_VERSION first):**
```bash
node server/report-generator.js all --mode recheck   # re-investigate everyone, with memory
```

---

## Anti-abuse / privacy

Anonymous citizen tips use proof-of-work + rate-limiting + a honeypot, and store only the ISO
week (never IP/User-Agent/precise time) so a tip can't be correlated with server logs. Tips are
human-reviewed and never auto-published.
