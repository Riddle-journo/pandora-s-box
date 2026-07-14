# Government-Action Data Expansion Plan

Goal: move beyond politician-centric data into the full **lifecycle of a government
action** (intent → procurement → allocation → disbursement → people → oversight),
because corruption shows up in the *seams between stages*. All sources below are NEW
(not already ingested) and were screened for **automatability** (returns real
content/files, not just a landing page) and **corruption signal**.

Already have (excluded everywhere below): CPPP award DB, a few state flood/health
tenders, CAG, electoral bonds, MPLADS, some treasury extracts, RBI state finances,
SEBI, NCLT/NCLAT/ITAT/HC/IBBI judgments, KA/TS/Kerala-VACB/J&K ACB caches, REC/RBI
banned lists, ICIJ, MyNeta, Wikidata, Tofler directors.

Legend — Automatability: EASY (API/CKAN/OCDS/bulk) · MEDIUM (deterministic scrape) ·
HARD (JS/CAPTCHA/login). Fit = which existing plumbing it reuses.

---

## The lifecycle map

| Stage | Corruption signal | New sources (this plan) |
|---|---|---|
| 1 Intent (orders/gazette) | backdated/midnight GOs, de-notifications | Maharashtra GRs, eGazette (35 states), AP/TS/TN GO registers |
| 2 Procurement | single-bidder, repeat winner, bid-rigging | Assam OCDS, GePNIC state AOC, GeM, IREPS, CPWD, NTPC, CPPP debarment |
| 3 Allocation | favoritism, undervaluation, clearance despite objection | PARIVESH, coal blocks, IBM mining leases, SEZ, RERA, MSTC, Bhoomi Rashi |
| 4 Disbursement | ghost workers/beneficiaries, skimming, split bills | MGNREGA MIS, PFMS, DBT, PM-KISAN, PDS ePoS, state CFMS/iFMS, eGramSwaraj |
| 5 People | transfer-posting rackets | DoPT IAS Civil List, DoPT CCIS, state GAD transfer orders |
| 6 Oversight (ground truth) | confirmed cases → detector calibration | CCI cartel orders, CVC sanctions, ED attachments, PAC/eParlib, state ACBs |

---

## BUILD STATUS (2026-07-14)

Constraint: this build ran from a datacenter IP where only data.gov.in (OGD) is
reachable; most Indian gov portals WAF-block or don't resolve. So VERIFIED work is
the OGD/OCDS surface; scrape/browser sources are REGISTERED (correct kind + research
URL, owner runs `--refresh` from an India route). What shipped:

- **Plumbing (Phase 0): ✅ VERIFIED.** `opendata.js` (CKAN + OGD clients + `/lists`
  catalog search + pure ledger mappers), `opendata-catalog.js` discovery, 13 tests.
- **Discovery catalog: ✅ 364 verified data.gov.in datasets** (with field schemas) →
  `server/data/opendata-catalog.json`. CKAN portals blocked from here.
- **Ledger denominators (Phases 1/4): ✅ 3 VERIFIED live + wired** to the facts
  ledger — `ogd-mandi-prices` (price baseline), `ogd-mgnrega-glance` (415k-row
  district×month MGNREGA MIS, monthly-fresh — the Phase-2 crown jewel via API), and
  `ogd-scheme-expenditure` (scheme allocation-vs-actual). 1 CKAN template
  (`obi-scheme-allocations`) awaits an India-route catalog run.
- **Oversight/allocation/procurement (Phases 1/3/6): 📋 REGISTERED owner-run** —
  `cci-cartel-orders`, `cvc-reports`, `ed-press`, `cppp-debarment`,
  `coal-block-allotment`, `sez-approvals`, `ibm-mining-leases` (existing pdf-archive/
  browser-capture kinds; not sandbox-verifiable).
- **Orders/gazette/transfers (Phase 2): ⏭ DEFERRED** — need dedicated fetchers
  (`orgpedia/mahGRs` via Internet Archive API, `sushant354/egazette`, AP/TS/TN GO
  registers, DoPT IAS Civil List). Half-baked pdf-archive stubs would be low quality;
  left as the next dedicated-fetcher batch.

---

## PHASE 0 — Free plumbing (do first: EASY, unblocks denominators)  — ✅ BUILT 2026-07-14

Connector + discovery shipped. Files:
- `server/fetchers/opendata.js` — reusable primitives: CKAN Action API
  (`ckanPackageSearch`, `ckanDatastoreSearch`) + OGD resource API (`ogdResource`,
  `ogdResourceMeta`, `ogdResourceAll`). Fail-soft, keyless CKAN, OGD key from
  `OGD_API_KEY` (falls back to data.gov.in public sample key). Freshness caveat
  baked in (`ogdResourceMeta` exposes `updated_date`).
- `server/opendata-catalog.js` — discovery CLI (`npm run opendata:catalog`):
  searches CKAN portals by lifecycle-stage keywords, scores each dataset by
  corruption-signal, dedupes, writes `server/data/opendata-catalog.json`.
- `test/opendata.test.js` — 6 pure tests + 3 live smoke tests (gated on
  `OPENDATA_LIVE=1`). All green; live-verified against Justice Hub + data.gov.in.

Verified reachable from a normal route:
- **data.gov.in OGD API** — `api.data.gov.in/resource/{id}` — ✅ live-tested (pulls
  rows + `updated_date`). CAVEAT confirmed: resources are uploaded snapshots, not
  live feeds — `ogdResourceMeta` surfaces the timestamp; schedule freshness checks.
- **Justice Hub** — `justicehub.in` — CKAN — ✅ live-tested (201 datasets). Note:
  aggressively rate-limits a hammering IP (pacing + retry added to the crawler).
- **Open Budgets India** — `openbudgetsindia.org` — CKAN — ⚠️ WAF 403s datacenter
  IPs; connector is identical/correct, run from an India/residential route. THE
  budget-vs-actual baseline.
- **NDAP (NITI Aayog)** — `ndap.niti.gov.in` — host resolves but public data needs
  login/registration; no clean keyless API → deferred (not wired). The normalized
  per-district denominator layer once credentials exist.
- Git mirrors (curl-able, clean, TODO next): SHRUG (devdatalab), PRS mptrack
  (`Vonter/india-representatives-activity`), DataMeet.

Ledger denominators WIRED (2026-07-14): `mega-ingest.js` gained two kinds —
`ogd-resource` (data.gov.in) and `ckan-datastore` (CKAN portals) — that write
`match:"none"` BASELINE FACTS straight into the `facts` ledger, keyed on a resolved
subject-entity (district/scheme/market), one fact per numeric metric per period.
Each source carries a `ledger` mapping (`subject.fields`/`kind`, `periodField`,
`metrics[]`). Pure core `rowToFactSpecs`/`composeSubject`/`coerceNumber`/
`normPeriodValue` in opendata.js, unit-tested. Seeded + VERIFIED live:
`ogd-mandi-prices` (Agmarknet daily mandi prices → `mandi_modal/min/max_price` facts
on `market_commodity` entities) — 30 facts/10 subjects on a test run, idempotent on
re-refresh (`--refresh ogd-mandi-prices`). Template `obi-scheme-allocations` awaits a
resourceId from the catalog. This mandi baseline is itself a live corruption
denominator: government purchases booked above prevailing mandi modal price = a flag.

NEXT for Phase 0: (a) run `npm run opendata:catalog` from an India route to capture
OBI + Justice Hub together; (b) fill the `obi-scheme-allocations` template's
resourceId + real column names from the catalog and `--refresh` it; (c) add
SHRUG/PRS/DataMeet git mirrors; (d) point an anomaly detector at the new baseline
facts (e.g. procurement unit-price vs `mandi_modal_price` for the same commodity).

## PHASE 1 — Highest signal-per-record (EASY/MEDIUM, low volume, named parties)

1. **Assam OCDS** — `assam.open-contracting.in` / OCP registry #131 — full OCDS JSON
   (tender→award→contract). India's ONLY full-OCDS state. Prototype the red-flag suite
   here (single-bidder rate, repeat-winner concentration, price outliers), then port to
   messier sources. Sanitize: invalid status/method codes, bad dates.
2. **CPPP debarment list** — `eprocure.gov.in/eprocure/app?page=FrontEndDebarmentList` —
   banned-vendor registry. Cross-ref against every award winner + Tofler directors.
   Reuses banned-list ledger pattern.
3. **CCI cartel / bid-rigging orders** — `cci.gov.in/antitrust/orders` — PDFs at
   `/images/antitrustorder/en/order<ts>.pdf`. GROUND TRUTH for procurement collusion +
   named companies + penalties. Feeds `l1ReadBodies`/`fetchPdfText` → collusion detector.
4. **Maharashtra GRs via orgpedia** — `github.com/orgpedia/mahGRs` + Internet Archive
   bulk API (`archive.org/advancedsearch`, ids `in.gov.maharashtra.gr.*`). Already
   OCR'd to ENGLISH, zero scraping. Highest ROI in the orders stage — ingest into
   fact/event ledger directly.
5. **Coal block allotment** — `coal.gov.in/nominated-authority` + MSTC — ~147 blocks,
   allottee+date+revenue-share. Small, structured, the Coalgate surface.
6. **SEZ approvals + BoA minutes** — `sezindia.gov.in/approved-sez` — static PDFs,
   developer+LoA. **IBM mining-lease directory** — `ibm.gov.in` All-India Directory —
   ~3000 leases, lessee+grant date. Both low-volume named-party wins.

## PHASE 2 — High value, scrape-heavy (MEDIUM, big coverage)

7. **GePNIC state AOC scraper** — ONE scraper for ~30 NIC portals (mahatenders,
   etender.up.nic.in, etc.), "Tenders Awarded/AOC" pages → winner+amount at state
   scale. Also covers CPWD (`etender.cpwd.gov.in`) and NTPC award-details with the same
   pattern. Biggest coverage-per-effort in procurement.
8. **MGNREGA MIS** — `nrega.nic.in` R1–R7 reports (job cards, muster rolls, works,
   NMMS, financials). THE crown jewel for disbursement fraud: ghost workers, same
   worker two worksites/day, payments without NMMS attendance, Benford on wages.
   Deterministic URLs (state/finyear/district codes). 15yr history.
9. **PARIVESH** — env/forest/CRZ clearances. Path A: data.gov.in catalog
   "Environmental Clearance Granted – Parivesh 2.0" (resource API, not HTML). Path B:
   ASP.NET scrape; reuse `vjjan91/Environmental-Clearances`. EC/FC letter PDFs +
   EAC minutes → readBodies/OCR → proponent ledger.
10. **eGazette nationwide** — adopt `github.com/sushant354/egazette` (central + ~35
    states, OCR bundled). De-notifications / backdated notifications.
11. **AP/TS/TN GO registers** — `goir.ap.gov.in`, `goir.telangana.gov.in`,
    `tn.gov.in/go_view` — full-text GO PDFs with named beneficiaries.
12. **DoPT IAS Civil List** — `iascivillist.dopt.gov.in` — officer posting-history →
    transfer-racket detection (short tenures, lucrative-posting parking, election-timed
    transfers). + DoPT CCIS OM/circular repo (stable PDF URLs).
13. **CVC** — annual reports + CTE reports + sanction-for-prosecution-pending lists
    (`cvc.gov.in/cte-corner/cte-reports`). **ED press releases** (flaky — build with
    retry; @dir_ed fallback). **eParlib/SansadLocal** PAC/committee reports (DSpace
    OAI-PMH if live; SansadLocal ships pre-built JSON).
14. **State treasuries** — AP/TS **CFMS**, Odisha **iFMS** are the most open bill-level
    portals → split-purchase / repeat-vendor / round-number-bill detection. Expand
    state-by-state.
15. **PM-KISAN + PDS ePoS + eGramSwaraj** — beneficiary/shop/panchayat-level ghost
    detection. **State ACBs** not yet cached (Maharashtra ACB DA cases first).

## PHASE 3 — Hard / frontier (HARD, invest once detectors proven)

- **GeM** — `gem.gov.in` — biggest procurement channel, NO open API/OCDS → headless
  scrape of contracts/PO + bid results. Highest-value gap once worth the cost.
- **IREPS** (Railways) — login-gated, huge standardized procurement.
- **RERA** per-state adapters (Karnataka `viewAllProjects`, UP, Telangana first) —
  promoter names → benami real-estate cross-ref.
- **MSTC mineral/sand auctions**, **Bhoomi Rashi** NH land acquisition (enumerable
  `notification_id`), **NHAI/ONGC/Coal India** PSU portals.

## ENRICHMENT-ONLY (never bulk crawl — CAPTCHA/per-record)

- Land records (Bhulekh/DILRMP), IGRS registration (Kaveri/SARATHI). Use for targeted
  verification of a lead only. Exception: guidance-value/circle-rate tables ARE
  scrapeable → undervaluation baseline.

## DEAD-ENDS (don't sink time)

GST return/bill-level data (only aggregate collections public) · PM-JAY claims
(non-public) · DDL judicial (anonymized, already resolved) · NSWS · india.gov.in ·
official CPPP/GeM bulk API (don't exist) · CBI charge-sheets (use courts+news) ·
MyNeta official API (media-only — use community mirrors).

---

## Cross-stage joins = where the real leads are

A lead is not "single bidder found." It's: single-bidder award AND winner debarred
last quarter AND winner's director donated to incumbent AND a favorable GO/clearance
issued 2 weeks prior. The typed ledger store (facts/claims/events/FTS5) is already the
right substrate — every source above should extract EVERY named entity (universal
subjects rule), not just politician-name matches, so these joins are possible.

Stage 6 (CCI/CVC/ED/PAC) = confirmed corruption → use as labels to calibrate and
validate the L1 detectors, not merely as leads.
