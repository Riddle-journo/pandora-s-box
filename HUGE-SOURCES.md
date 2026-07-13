# Huge / heavy data sources — not downloaded by default

These are the sources from `server/mega-ingest.js` that are deliberately **not**
part of a routine `--refresh all` pass, because each one is either genuinely
large (GB–TB scale) or takes hours to crawl. Each needs an explicit, owner-approved
decision before pulling. The 10 small PDF-archive sources (title+body-text only,
a few MB total) were downloaded separately — see the mega cache status
(`node server/mega-ingest.js`) for those.

---

## 1. `hc-judgments-s3` — Indian High Court judgments (AWS Open Data)

- **Size: ~1 TB** (the full corpus). Explicitly marked in code: *"Do NOT sync the
  full ~1TB."*
- **What it contains:** Every published judgment from India's High Courts,
  scraped from eCourts and mirrored as an open AWS S3 dataset
  (`s3://indian-high-court-judgments/`), organized by court and year. Includes
  the judgment PDFs themselves plus Parquet metadata (case number, parties,
  court, date, disposition).
- **Why it matters:** This is the single richest source of *named* litigation —
  civil suits, criminal appeals, writ petitions — naming both petitioners and
  respondents, which is exactly the kind of record that surfaces undisclosed
  litigation involving a politician or their associates.
- **How it would actually be pulled (targeted, not a full sync):**
  1. `aws s3 ls --no-sign-request s3://indian-high-court-judgments/` to see the
     court/year structure.
  2. Either (a) targeted `aws s3 cp --no-sign-request s3://.../<court>/<year>/
     ./server/data/mega/hc-judgments/ --recursive` for specific courts/years, or
     (b) run Athena SQL over the Parquet metadata first to find which
     court/year/case-number combinations are worth pulling, *then* fetch only
     those PDFs.
- **Decision needed:** which courts/years matter most (e.g. start with the High
  Courts of states with the most politicians in the roster), and a disk budget
  — even a "small" targeted slice (a few courts, a few years) could still be
  tens of GB.

---

## 2. `daksh-hc-bulk` — DAKSH High Court bulk datasets

- **Size: unknown but substantial** (a zip download from Dropbox; not yet pulled
  so the exact size is unverified — likely several hundred MB to a few GB given
  the row count).
- **What it contains:** 927,000+ case records extracted from eCourts High Court
  data by DAKSH (a judicial-reform research org) — bail cases plus writ/tax case
  extracts, with structured fields (not just PDFs).
- **Why it matters:** A pre-cleaned, structured alternative to scraping
  `hc-judgments-s3` PDFs directly — faster to search, at the cost of coverage
  (DAKSH's own sampling, not the full corpus).
- **How it would be pulled:** Single `zip-csv` download from the DAKSH Dropbox
  link (may need re-resolving via database.dakshindia.org if the link rotated),
  then unzip + parse.
- **Decision needed:** none blocking except confirming the current Dropbox link
  is live — this is a candidate for a normal `--refresh daksh-hc-bulk` once the
  size is deemed acceptable.

---

## 3. `maharera-projects` — MahaRERA registered real-estate projects

- **Size: moderate on disk** (structured table rows, not PDFs) **but ~2 hours
  of crawl time** — 4,900 paginated pages at a mandatory 1.5s politeness delay
  per page (real-estate regulator, deliberately slow to avoid hammering it).
- **What it contains:** 48,800+ Maharashtra real-estate projects: developer/
  promoter name, RERA registration number, project status, location.
- **Why it matters:** Promoter names are a direct cross-reference point against
  political donors and known associates — real estate is one of the most common
  vehicles for undisclosed wealth in India.
- **How it would be pulled:** `node server/mega-ingest.js --refresh
  maharera-projects`, optionally with `--max N` to cap pages for a partial pull
  (the code comment explicitly suggests this — e.g. `--max 500` for a ~12-minute
  partial run covering the most recent/relevant pages first).
- **Decision needed:** full 2-hour crawl vs. a bounded `--max` partial pull.

---

## 4. `ddl-judicial` — DDL Judicial Data (81M district-court cases) — RESOLVED, do not re-download

- **Size: ~20–27 GB** (already pulled once, inspected, and **deleted** — nothing
  currently on disk for this).
- **What it contains:** Development Data Lab's bulk district-court case records,
  2010–2018, from eCourts.
- **Why it's excluded:** Already downloaded and fully inspected (2026-07-11).
  The dataset is **deliberately anonymized by DDL** — it contains no party
  names, no litigant names, and no judge names anywhere; only case-type codes,
  district/court codes, and boolean-ish demographic flags. It **cannot** be
  matched to an individual politician by name, structurally, no matter how the
  matching code is written.
- **If ever revisited:** the only viable use is an aggregate/statistical angle
  (e.g. district-level case-backlog rates cross-referenced against an MP's
  district) — a different feature, not a fix to the current per-politician
  matcher. Not recommended unless that specific feature is wanted.

---

## 5. `rbi-state-finances` — RBI State Finances: Study of Budgets

- **Size: small-to-moderate** (a set of XLSX statements, likely tens of MB),
  but currently **unconfigured** — the download URLs are blank in code.
- **What it contains:** 37 longitudinal fiscal-indicator statements per year,
  per state (RBI's annual "State Finances" study) — revenue, expenditure,
  deficits, debt.
- **Why it matters:** A baseline for spotting election-year spending anomalies
  (e.g. an unusual spike in a state's discretionary spending right before a
  vote) — context data, not itself politician-matched (`match: "none"`).
- **What's blocking it:** Someone needs to open RBI's Annual Publications page,
  find the current edition's direct XLSX links, and hard-code them into the
  source config (a 10-minute manual step, not a download-size problem).

---

## Already downloaded for context (not "pending," just noting the footprint)

- **CPPP procurement DB** — 6.1 GB, on `D:/pandoros-data/cppp/aoc_tenders.db`
  (government contract-award trail; backs the `cppp` fetcher). Already in place,
  not part of this list.

## Summary table

| Source | Size | Blocker | Recommended next step |
|---|---|---|---|
| `hc-judgments-s3` | ~1 TB (full); targeted slice = tens of GB | Needs court/year scope decision | Pick 3–5 states' High Courts + recent years, pull via AWS CLI |
| `daksh-hc-bulk` | Unknown, likely GB-scale | None — just needs the download run | `node server/mega-ingest.js --refresh daksh-hc-bulk` |
| `maharera-projects` | Moderate disk, ~2h crawl | Time, not size | Run with `--max 500` for a bounded first pass |
| `ddl-judicial` | Resolved (deleted) | Structurally unusable for per-politician matching | Skip, unless pursuing an aggregate-stats feature |
| `rbi-state-finances` | Small | URLs not yet configured | 10-min manual URL lookup, then a normal refresh |
