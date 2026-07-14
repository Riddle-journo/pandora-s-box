// Mega-dataset importer (PLAN-L1-FETCHERS.md Step 6). Owner-run, on demand:
//   node server/mega-ingest.js [--refresh all|<id>]
// Downloads oversized level-1 datasets, pre-filters rows to those mentioning
// any politician/party in the roster, and writes small caches that ingest.js
// matches per politician. Raw downloads kept under server/data/mega/ so a
// roster-only re-match (--rematch) needs no re-download.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import readline from "node:readline";
import { listPoliticians, recordFetchRun, db } from "./store.js";
import { ensureEntity } from "./entities.js";
import { upsertFact } from "./ledger.js";
import { UA, htmlToText, fetchPdfText, fetchText, fetchJson, sleep } from "./fetchers/http.js";
import { renderPageText, closeBrowser } from "./fetchers/playwright-portal.js";
import { ogdResourceAll, ogdResourceMeta, ckanDatastoreSearch, CKAN_PORTALS, rowToFactSpecs } from "./fetchers/opendata.js";
import { buildTranslitNeedles, textMatchesTranslit } from "./fetchers/translit.js";
import { consoleStyle } from "./util/log.js";
const clog = consoleStyle("mega-ingest");

const MEGA_DIR = path.join(process.cwd(), "server", "data", "mega");
const CACHE_DIR = path.join(process.cwd(), "server", "data", "l1-cache");

const MEGA_SOURCES = [
  {
    id: "assam-tenders-ocds",
    title: "CivicDataLab Assam Tenders (OCDS)",
    tier: 5, match: "name",
    summary: "45,000+ Assam e-tenders (2016-2022) mapped to OCDS: buyer, supplier/bidder, award value.",
    kind: "zip-xlsx",
    url: "https://raw.githubusercontent.com/CivicDataLab/assam-tenders-data/main/data/ProcessedData/ocds-mapped-data/current/ocds_mapped_data.xlsx.zip",
    note: "On 404 try branch master, or list the tree: https://api.github.com/repos/CivicDataLab/assam-tenders-data/git/trees/main?recursive=1",
  },
  {
    id: "pocso-tracking-zip",
    title: "Data4Justice POCSO case tracking (Assam/Delhi/Haryana)",
    tier: 5, match: "name",
    summary: "19,783 POCSO cases (2012-2020) from eCourts with party/act/section fields.",
    kind: "zip-csv",
    url: "https://justicehub.in/dataset/5467514c-1714-483d-8b82-2fb3984a0cf9/resource/f667d254-0f39-4bd3-8f6a-e3043d0991f1/download/pocso_analysis_datasets_1221.zip",
  },
  {
    id: "budgets-for-justice",
    title: "Budgets for Justice — union law-and-justice budget datasets",
    tier: 5, match: "name",
    summary: "Union budget line items (2015-16 to 2022-23) for law/justice/police/WCD schemes.",
    kind: "csv-multi",
    urls: [
      "https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/datasets/union-budget/master-file/home.csv",
      "https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/datasets/union-budget/master-file/law.csv",
      "https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/datasets/union-budget/master-file/police.csv",
      "https://raw.githubusercontent.com/justicehub-in/budgets-for-justice-datasets/main/datasets/union-budget/master-file/wcd.csv",
    ],
  },
  {
    id: "ddl-judicial",
    title: "DDL Judicial Data (81M district-court cases, 2010-2018)",
    tier: 5, match: "none",
    summary: "Development Data Lab bulk court-case records — anonymized, no party/litigant names.",
    kind: "csv-stream",
    urls: [],
    skipped: "DOWNLOADED AND INSPECTED (2026-07-11), NOT WIRED: pulled the real ~20GB dataset (Dropbox link at devdatalab.org/judicial-data → csv/{cases,judges_clean,acts_sections,keys}) and read every column. It contains NO party/litigant names and NO judge names anywhere — cases_*.csv only has ddl_case_id/state/district/court codes, judge_position (role, not name), boolean-ish demographic flags (female_defendant etc. as counts, not identities), type/purpose/disposition CODES, and dates; judges_clean.csv has judge IDs + gender + tenure dates, never a name; acts_sections.csv is case_id→act/section codes only. This is intentional on DDL's part (privacy), but it means the dataset structurally CANNOT be matched to an individual politician by name — wiring it in with match:\"name\" would stay permanently at 0 items no matter the code. If ever revisited, the only viable use is AGGREGATE/statistical (e.g. district-level case-backlog rates cross-referenced against an MP's district via state_code/dist_code + the keys/*.csv lookups), not per-politician evidence — a materially different feature, not a fix for this fetcher. Local copy at D:/pandoros-data/ddl-judicial-raw/ (~27GB incl. the original zip) — delete if not pursuing the aggregate angle.",
  },
  {
    id: "ibbi-cirp", title: "IBBI CIRP public announcements", tier: 6, match: "name",
    summary: "8,900+ corporate insolvency announcements: debtor, applicant, insolvency professional, dates. A name match is a LEAD ONLY — verify identity (address, company, role) before treating as a finding.",
    kind: "paged-html-table", maxPages: 460, headerRows: 1,
    url: "https://ibbi.gov.in/public-announcement?ann=Public+Announcement+of+Corporate+Insolvency_Resolution+Process&page={page}",
    note: "Verify the page param by fetching page 1 and reading pagination hrefs; adjust template if it differs.",
  },
  {
    // RBI mandates every bank publish its own wilful-defaulter list (₹25L+ suits)
    // for public disclosure — CIBIL's own suit.cibil.com is bank/FI-only (403 for
    // us, confirmed 2026-07-05), but the underlying bank-published PDFs are free,
    // public, and text-extractable. Each row carries the borrower + up to 20
    // directors (name/DIN/PAN) — DIN lets this cross-ref mca-directors.js later.
    // Verified live 2026-07-12: BoB's page links its April-2026 PDF directly.
    id: "rbi-wd-bob", title: "Bank of Baroda — Wilful Defaulters list", tier: 6, match: "name",
    summary: "RBI-mandated public disclosure: borrowers + up to 20 directors (name/DIN/PAN) suit-filed as wilful defaulters. A name match against this list is a LEAD ONLY — common Indian names collide across a 4,000+ borrower list; verify address/DIN/PAN against the politician's own affidavit before treating as a finding.",
    kind: "pdf-archive", maxDocs: 5, docChars: 60000,
    url: "https://bankofbaroda.bank.in/personal-banking/other-services/wilful-defaulter",
    linkRe: "wilful-defaulter",
  },
  {
    // PNB's live page renders its current PDF via JS (not in static HTML), but
    // the archive page lists real historical PDFs (2014-2016) as plain <a href>
    // links — stale but genuine RBI-mandated disclosures, kept honestly labelled.
    id: "rbi-wd-pnb", title: "Punjab National Bank — Wilful Defaulters list (archive)", tier: 6, match: "name",
    summary: "RBI-mandated public disclosure (2014-2016 archive; PNB's current list is JS-rendered, not yet crawlable): borrowers + directors suit-filed as wilful defaulters. A name match is a LEAD ONLY — verify address/DIN/PAN before treating as a finding.",
    kind: "pdf-archive", maxDocs: 10, docChars: 60000,
    url: "https://pnb.bank.in/Wilful-Defaulters-Archive.html",
    linkRe: "wilful",
    note: "current pnb.bank.in/wilful-defaulters.html list is JS-rendered — add once a static link or API is found",
  },
  {
    id: "ibbi-orders", title: "IBBI disciplinary orders", tier: 6, match: "name",
    summary: "833 disciplinary/administrative orders against insolvency professionals.",
    kind: "paged-html-table", maxPages: 45, headerRows: 1,
    url: "https://ibbi.gov.in/orders/ibbi?page={page}",
  },
  {
    id: "maharera-projects", title: "MahaRERA registered projects", tier: 5, match: "name",
    summary: "48,800+ Maharashtra real-estate projects: promoter, registration, status — promoter names cross-ref donors.",
    kind: "paged-html-table", maxPages: 4900, delayMs: 1500, headerRows: 1,
    url: "https://maharera.maharashtra.gov.in/projects-search-result?page={page}",
    note: "LONG crawl (~2h at 1.5s/page). Verify the pagination param on page 1 first. Owner may cap maxPages lower for a partial pull.",
  },
  {
    id: "rbi-state-finances", title: "RBI State Finances: Study of Budgets", tier: 5, match: "none",
    summary: "Longitudinal state fiscal indicators (37 statements/year) — election-year spending anomaly baseline.",
    kind: "xlsx-multi", urls: [],
    note: "EXECUTOR: fetch https://www.rbi.org.in/Scripts/AnnualPublications.aspx?head=State+Finances+%3A+A+Study+of+Budgets , regex the latest edition's statement XLSX hrefs (direct rbidocs.rbi.org.in links), and hard-code them into urls. If the archive page needs postback navigation to reach them, leave unconfigured and note it as pending.",
  },
  {
    id: "daksh-hc-bulk", title: "DAKSH High Court bulk datasets (Dropbox)", tier: 5, match: "name",
    summary: "927k+ bail cases and writ/tax case extracts from eCourts High Court data.",
    kind: "zip-csv",
    url: "https://www.dropbox.com/sh/hltawtctmdfyri3/AADm_s6VDmbk1_NCz7Vh02xHa?dl=1",
    note: "Dropbox shared folders download as a zip with dl=1. If the link has rotated, get the current one from https://database.dakshindia.org/ Resources section.",
  },

  // ==== L3 Step 4 — heavy no-JS crawls (R7), paged-html-table ====
  { id: "ctri-trials", title: "CTRI — Clinical Trials Registry India", tier: 5, match: "name",
    summary: "Registered clinical trials: investigators, sponsors, sites (form-POST search).",
    kind: "paged-html-table", maxPages: 300, delayMs: 1500,
    url: "https://ctri.nic.in/Clinicaltrials/advancesearchmain.php?page={page}",
    note: "This portal is POST-search; if {page} GET returns nothing, this belongs in a future form-post kind — mark not-configured and move on." },
  { id: "maha-police-firs", title: "Maharashtra Police — published FIRs", tier: 6, match: "name",
    summary: "Published FIRs by police station (ASPX form-POST, 90-day windows since 2017).",
    kind: "paged-html-table", maxPages: 200, delayMs: 1500,
    url: "https://citizen.mahapolice.gov.in/citizen/mh/PublishedFIRs.aspx?page={page}",
    note: "ASPX postback likely — if empty, requires the R9 browser kind; mark not-configured." },
  { id: "haryana-egazette", title: "Haryana e-Gazette notifications", tier: 6, match: "name",
    summary: "Gazette notifications (appointments, orders) — form-search + PDF.",
    kind: "paged-html-table", maxPages: 100, delayMs: 1200,
    url: "https://www.egazetteharyana.gov.in/?page={page}",
    note: "If search is POST-only, mark not-configured." },

  // ==== L3 Step 5b — browser & S3 kinds (R9/R10); owner installs playwright first ====
  { id: "sagarmala-tracker", title: "Sagarmala project tracker", tier: 5, match: "name",
    kind: "browser-render", waitFor: "table",
    url: "https://sagarmala.gov.in/project/project-tracker",
    summary: "845+ port-led infra projects: name, cost, status, state." },
  { id: "agmarknet", title: "Agmarknet 2.0 mandi prices", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://agmarknet.gov.in/",
    summary: "Commodity/mandi price tables (ASP.NET postback — browser only)." },
  { id: "rti-raj-appeals", title: "RTI Rajasthan — second-appeal status (SPA)", tier: 5, match: "name",
    kind: "browser-render", waitFor: "table", url: "https://rti.rajasthan.gov.in/websecondappealreport",
    summary: "RTI second-appeal decisions (Angular SPA)." },
  { id: "koshvani-up", title: "Koshvani UP — finance/expenditure", tier: 5, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://koshvani.up.nic.in/",
    summary: "District/department expenditure tables (ASP.NET postback)." },
  { id: "ftddp-trade", title: "DGCIS FTDDP — foreign trade (guest)", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://ftddp.dgciskol.gov.in/dgcis/guestindex.html",
    summary: "HS-code/state export-import figures (Angular SPA, guest tier)." },
  { id: "hc-judgments-s3", title: "Indian High Court judgments (AWS Open Data)", tier: 5, match: "name",
    kind: "s3-sync",
    note: "aws s3 ls --no-sign-request s3://indian-high-court-judgments/ then targeted: aws s3 cp --no-sign-request s3://indian-high-court-judgments/<court>/<year>/ ./data/mega/hc-judgments/ --recursive ; or Athena over the Parquet metadata to filter by court/date before pulling PDFs. Do NOT sync the full ~1TB.",
    summary: "eCourts High Court judgment corpus (targeted pulls only)." },

  // ==== L3 Step 5c-3 — pdf-archive kind (search-by-harvest for name-in-body docs) ====
  // BROKEN (confirmed 2026-07-13): /ofms/uploads/ 403s — it's a bare directory-
  // index URL and this server has directory listing disabled (confirmed: same
  // 403 with a full browser UA; the app root /ofms/ itself returns 200 fine).
  // This was never a valid crawl target — needs the real in-app document listing
  // path found first (open the /ofms/ app and locate its report/upload list page).
  { id: "odisha-ofms-uploads", title: "Odisha OFMS — district report PDFs", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://odishaforestgis.in/ofms/uploads/", linkRe: "\\.pdf", maxDocs: 2000,
    summary: "CA Landbank / district forest report PDFs; body-text names matched." },
  { id: "ric-raj-decisions", title: "Rajasthan RIC — RTI decision PDFs", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://ric.rajasthan.gov.in/", linkRe: "\\.pdf", maxDocs: 2000,
    summary: "RTI second-appeal decision PDFs; complainant/PIO/department names in body." },
  { id: "dda-awards-index", title: "DDA land-acquisition award PDFs (index)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://dda.gov.in/land-management/land_acquisition_awards?page={page}",
    pages: [0, 180], titleOnly: true, maxDocs: 4000,
    summary: "Award/village titles are name-bearing → title-only match; scanned bodies need the L4 OCR pass." },
  // BROKEN (confirmed 2026-07-13): the site restructured — /judgment-orders now
  // 404s. Found the new nav path /judgementOrder/zonalbenchwise (note the
  // British "judgement" spelling), but that page returns 0 PDF links on a plain
  // fetch too — it's a zonal-bench FILTER form, its results are likely rendered
  // client-side (JS), not present in the raw HTML. Needs either the browser-
  // render kind or a discovered JSON endpoint behind the filter — not a plain
  // pdf-archive fix.
  { id: "ngt-recent-orders", title: "NGT recent orders (supplement to Kanoon)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://www.greentribunal.gov.in/judgment-orders?page={page}",
    pages: [1, 30], linkRe: "\\.pdf", maxDocs: 1500,
    summary: "Very recent NGT orders not yet indexed by Indian Kanoon; body-text party match." },

  // ==== L4 fix — name-in-PDF-BODY archives. html-list (link-text only) never
  // matched because names live in the PDF body; pdf-archive downloads + extracts
  // + name-filters. Owner-run. These REPLACE the broken L1 html-list entries. ====
  { id: "itat-orders", title: "ITAT order PDFs (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://itat.gov.in/", linkRe: "\\.pdf", maxDocs: 200,
    summary: "ITAT orders — assessee/party names extracted from PDF bodies. (Verified: 11/58 matched.)" },
  { id: "nclat-orders", title: "NCLAT judgement/order PDFs (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://nclat.gov.in/", linkRe: "\\.pdf", maxDocs: 200,
    summary: "NCLAT judgements/daily orders — party names from PDF bodies." },
  { id: "nclt-orders", title: "NCLT order PDFs (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://nclt.gov.in/order-date-wise-search", linkRe: "\\.pdf", maxDocs: 200,
    summary: "NCLT orders/notices — corporate-debtor/party names from PDF bodies." },
  { id: "atfp-orders-body", title: "SAFEMA/PMLA/FEMA appellate orders (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://atfp.gov.in/orders.asp", linkRe: "\\.pdf", maxDocs: 400,
    summary: "Money-laundering/FEMA appellate order PDFs — party names + amounts from bodies." },
  { id: "mp-lfa-body", title: "MP Local Fund Audit reports (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://lfa.mp.gov.in/", linkRe: "\\.pdf", maxDocs: 300,
    summary: "Local-body audit reports — embezzlement/official names from PDF bodies (Hindi)." },
  // insecure:true — this site serves a broken TLS chain (confirmed via a live
  // fetch-failed probe, 2026-07-13); the L1 engine's wb-mines-rfp entry already
  // needed the same workaround for this exact host.
  { id: "wb-mines-body", title: "WB mining RFP/DSR PDFs (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://www.wbindustries.gov.in/whats_current.html", linkRe: "\\.pdf", maxDocs: 500,
    insecure: true,
    summary: "Mine RFP/DSR/EOI PDFs — bidder/MDO-awardee names from bodies." },
  { id: "ric-raj-body", title: "Rajasthan RIC RTI decisions (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://ric.rajasthan.gov.in/", linkRe: "\\.pdf", maxDocs: 400,
    summary: "RTI second-appeal decision PDFs — complainant/PIO/department names from bodies." },
  { id: "ka-lokayukta-body", title: "Karnataka Lokayukta reports/cause-lists (body-text)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://lokayukta.karnataka.gov.in/casestatus.php", linkRe: "\\.pdf", maxDocs: 300,
    summary: "Lokayukta cause-lists/reports — respondent-official names from PDF bodies." },

  // ==== L4 Group 2 — SPA hidden-API DISCOVERY (browser-capture). Owner runs
  // once to dump endpoints.json, then promotes a stable URL into a json-api
  // L1_SOURCES entry. No access control is bypassed — reads the public XHRs. ====
  { id: "kppp-tenders", title: "Karnataka Public Procurement Portal (KPPP) API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://kppp.karnataka.gov.in/", settleMs: 5000,
    summary: "Tender/award JSON behind the KPPP SPA (winner + value name-matchable once promoted)." },
  { id: "ceo-punjab-dash", title: "CEO Punjab candidate dashboard API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://elections.punjab.gov.in/Election/Public/CandidateDashboard", settleMs: 5000,
    summary: "Candidate/vote-share JSON behind the district+constituency dropdown SPA." },
  { id: "nhai-datalake", title: "NHAI Data Lake GIS dashboard API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://datalakeg.nhai.gov.in/nhai/mISC/DataLakeGISDashboard", settleMs: 6000,
    summary: "Project/contractor JSON feeding the GIS map+table." },
  { id: "abdm-nhpr", title: "ABDM National Health Providers Registry API", tier: 4, match: "none",
    kind: "browser-capture", url: "https://nhpr.abdm.gov.in/", settleMs: 5000,
    summary: "Health-provider search JSON behind the NHPR SPA." },
  { id: "mstc-eauctions", title: "MSTC multi-vertical e-auctions API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://www.mstcindia.co.in/content/Forthcoming_e_Auctions_For_All_regions.aspx", settleMs: 5000,
    summary: "Auction JSON feeding the Angular {{y.*}} bindings (scrap/ore/timber/property lots)." },
  { id: "ejagriti", title: "e-Jagriti / CONFONET (consumer disputes) API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://e-jagriti.gov.in/", settleMs: 6000,
    summary: "Consumer-case JSON behind the e-Jagriti SPA (repeat-offender corporate patterns)." },
  { id: "cat-casestatus", title: "Central Administrative Tribunal (CAT) API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://cgat.gov.in/", settleMs: 5000,
    summary: "Case-search JSON behind the CAT SPA." },
  { id: "rti-raj-api", title: "Rajasthan RTI second-appeal report API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://rti.rajasthan.gov.in/websecondappealreport", settleMs: 6000,
    summary: "GetAgingCumPendencySecondAppealsReport JSON (rtiapi/api/...) behind the Angular SPA." },

  // ==== Remaining L3/L4 browser/form portals (the '~27 left') as browser-capture
  // discovery targets. Each: owner runs --refresh, reads endpoints.json, promotes
  // the data endpoint to a json-api L1 entry. GePNIC AOC results + tribunal/portal
  // XHRs surface here without touching any CAPTCHA/login. ====
  { id: "aft-cap", title: "Armed Forces Tribunal case search API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://aft.gov.in/case-status", settleMs: 5000,
    summary: "AFT case-search XHR (no CAPTCHA per catalogue)." },
  { id: "defproc-cap", title: "Defence eProc results/debarment API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://defproc.gov.in/nicgep/app", settleMs: 5000,
    summary: "GePNIC awarded-tender/debarment XHRs (winner+value public)." },
  { id: "mahatenders-cap", title: "MahaTenders AOC results API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://mahatenders.gov.in/nicgep/app?page=WebTenderStatusLists&service=page", settleMs: 5000,
    summary: "GePNIC AOC results XHRs (L1 bidder + award value)." },
  { id: "wb-tenders-cap", title: "WB eProc AOC results API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://tenders.wb.gov.in/nicgep/app?page=WebTenderStatusLists&service=page", settleMs: 5000,
    summary: "GePNIC AOC results XHRs (winner+value; per-tender doc page stays CAPTCHA'd, listing does not)." },
  { id: "mp-tenders-cap", title: "MP eProc AOC results API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://mptenders.gov.in/nicgep/app", settleMs: 5000,
    summary: "GePNIC AOC results XHRs." },
  { id: "odisha-tenders-cap", title: "Odisha eProc AOC results API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://tendersodisha.gov.in/nicgep/app", settleMs: 5000,
    summary: "GePNIC AOC results XHRs." },
  { id: "dot-row-cap", title: "DoT Gati Shakti RoW pendency API", tier: 4, match: "none",
    kind: "browser-capture", url: "https://eservices.dot.gov.in/right-of-way-permissions", settleMs: 6000,
    summary: "State/ministry RoW pendency dashboard XHRs (aggregate)." },
  { id: "eci-contribution-cap", title: "ECI contribution reports index API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://www.eci.gov.in/candidate-political-parties/contribution-reports/contribution-reports/", settleMs: 6000,
    summary: "Contribution-report file-index XHR behind the JS index (donor PDFs)." },
  { id: "igr-maha-cap", title: "IGR Maharashtra stamp-duty stats API", tier: 4, match: "none",
    kind: "browser-capture", url: "https://igrmaharashtra.gov.in/", settleMs: 5000,
    summary: "Stamp-duty collection stats XHRs (public aggregate layer)." },
  { id: "jhla-neva-cap", title: "Jharkhand NeVA Q&A API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://jhla.neva.gov.in/", settleMs: 5000,
    summary: "Assembly question/answer XHRs (MLA names)." },
  { id: "gidc-cap", title: "GIDC estate/allotment API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://gidc.gujarat.gov.in/", settleMs: 5000,
    summary: "Estate allotment XHRs (allottee names)." },
  { id: "cg-eproc-cap", title: "Chhattisgarh CHEPS tender-results API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://eproc.cgstate.gov.in/", settleMs: 6000,
    summary: "CHEPS tender-result XHRs (winner+value)." },
  { id: "khanij-cap", title: "Chhattisgarh Khanij lease/auction API", tier: 5, match: "name",
    kind: "browser-capture", url: "https://www.khanij.cgstate.gov.in/", settleMs: 5000,
    summary: "Mineral lease/e-auction XHRs (lease-holder names)." },

  // ==== L4 Group 2/3 — SPAs whose TABLE renders in-DOM (browser-render). No
  // API discovery needed; render + name-filter directly. ====
  { id: "aicte-dashboard", title: "AICTE institutions approval dashboard", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://facilities.aicte-india.org/dashboard/pages/dashboardaicte.php",
    summary: "Institution approval stats (aggregate context)." },
  { id: "vsk-cg", title: "Vidya Samiksha Kendra (Chhattisgarh) dashboard", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://vsk.cg.gov.in/",
    summary: "State education KPI dashboard (aggregate; other states are sibling subdomains)." },
  { id: "npp-india", title: "National Power Portal (public aggregate)", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://npp.gov.in/",
    summary: "State/national power dashboards (aggregate; plant-level is login-gated)." },
  { id: "auditonline-mopr", title: "AuditOnline (Panchayati Raj) public drill-down", tier: 5, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://auditonline.gov.in/",
    summary: "Public audit-observation/KPI drill-down (state>district>block>GP); full audit is login-gated." },
  { id: "upadhi-cea", title: "CEA UPADHI distribution monitoring", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://upadhi.cea.gov.in/",
    summary: "Distribution policy/monitoring dashboard (aggregate context)." },
  { id: "enam-market", title: "e-NAM agriculture market (needs Indian IP)", tier: 4, match: "none",
    kind: "browser-render", waitFor: "table", url: "https://enam.gov.in/web/",
    note: "Refuses connection (ECONNREFUSED) from non-Indian IPs — owner runs from an Indian-IP host/proxy or it skips cleanly.",
    summary: "Mandi trade volumes/prices (aggregate)." },

  // ==== Phase 0 — open-data LEDGER DENOMINATORS (match:"none" → facts, not roster
  // caches). These write baseline facts the anomaly engine divides against. Each
  // carries a `ledger` mapping (subject entity + numeric metrics + period). Add new
  // ones from `npm run opendata:catalog` output. See GOVACTION-SOURCES-PLAN.md P0. ====
  { id: "ogd-mandi-prices", title: "Agmarknet daily mandi commodity prices (OGD)", tier: 4, match: "none",
    kind: "ogd-resource", resourceId: "9ef84268-d588-465a-a308-a864a43d0070", maxRows: 4000,
    ledger: {
      subject: { fields: ["state", "district", "market", "commodity", "variety", "grade"], kind: "market_commodity" },
      periodField: "arrival_date", periodFormat: "dmy",
      metrics: [
        { field: "modal_price", metric: "mandi_modal_price", unit: "INR/quintal" },
        { field: "min_price", metric: "mandi_min_price", unit: "INR/quintal" },
        { field: "max_price", metric: "mandi_max_price", unit: "INR/quintal" },
      ],
    },
    summary: "Daily min/max/modal mandi prices per commodity — price baseline to flag government purchases above prevailing market rate (VERIFIED live via api.data.gov.in)." },
  // District×month MGNREGA MIS at-a-glance — 415k rows, refreshed monthly (the Phase-2
  // 'crown jewel' via a clean API instead of scraping nrega.nic.in). Denominators for
  // ghost-workers (active job cards vs workers), wage-rate outliers, delayed payments.
  { id: "ogd-mgnrega-glance", title: "District-wise MGNREGA data at a glance (OGD)", tier: 4, match: "none",
    kind: "ogd-resource", resourceId: "ee03643a-ee4c-48c2-ac30-9f2ff26ab722", maxRows: 20000,
    ledger: {
      subject: { fields: ["state_name", "district_name"], kind: "district" },
      periodFields: ["fin_year", "month"],
      metrics: [
        { field: "Total_Exp", metric: "mgnrega_total_expenditure", unit: "INR lakh" },
        { field: "Average_Wage_rate_per_day_per_person", metric: "mgnrega_avg_wage_rate", unit: "INR/day" },
        { field: "Persondays_of_Central_Liability_so_far", metric: "mgnrega_persondays", unit: "days" },
        { field: "Number_of_Completed_Works", metric: "mgnrega_completed_works", unit: "count" },
        { field: "Total_No_of_Active_Job_Cards", metric: "mgnrega_active_job_cards", unit: "count" },
        { field: "Total_No_of_Active_Workers", metric: "mgnrega_active_workers", unit: "count" },
        { field: "percentage_payments_gererated_within_15_days", metric: "mgnrega_pct_paid_15d", unit: "%" },
      ],
    },
    note: "415k rows. The public sample OGD key returns only 10 rows/request — set a private OGD_API_KEY (free at data.gov.in) to raise the page cap, else a full pull is thousands of slow requests. Raise maxRows once keyed.",
    summary: "MGNREGA district-month MIS (expenditure, wage rate, persondays, works, job cards, payment timeliness) — ghost-worker + wage-skim denominators (VERIFIED live, ~monthly)." },
  // Central scheme allocation vs actual expenditure — the budget-vs-actual gap per scheme.
  { id: "ogd-scheme-expenditure", title: "Scheme-wise allocated fund and expenditure (OGD)", tier: 4, match: "none",
    kind: "ogd-resource", resourceId: "d28b5212-c833-4331-ae9a-5726a397ffaa", maxRows: 5000,
    ledger: {
      subject: { fields: ["programme_schemes"], kind: "scheme" }, period: "2020-21",
      metrics: [
        { field: "allocated_fund", metric: "scheme_allocated_fund", unit: "INR crore" },
        { field: "expenditure_", metric: "scheme_expenditure", unit: "INR crore" },
      ],
    },
    summary: "Per-scheme allocation vs actual spend — over/under-spend gap denominator (VERIFIED live)." },

  // TEMPLATES — fill resourceId/portal from the discovery catalog, then --refresh.
  // Open Budgets India WAF-403s datacenter IPs; run from an India/residential route.
  { id: "obi-scheme-allocations", title: "Open Budgets India — scheme allocation vs expenditure (CKAN)", tier: 4, match: "none",
    kind: "ckan-datastore", portal: "openbudgetsindia", resourceId: null, maxRows: 20000,
    ledger: {
      subject: { fields: ["scheme"], kind: "scheme" }, periodField: "year",
      metrics: [
        { field: "budget_estimate", metric: "scheme_budget_estimate", unit: "INR" },
        { field: "actuals", metric: "scheme_actual_expenditure", unit: "INR" },
      ],
    },
    note: "Pick a datastore_active resource id from `npm run opendata:catalog` (openbudgetsindia) and set resourceId + confirm the real column names (subject.fields / periodField / metrics[].field) against ckanDatastoreSearch fields[].",
    summary: "Union/state scheme budget-estimate vs actuals per year — the budget-vs-actual gap denominator." },

  // ==== Phase 2 — orders/gazette (dedicated fetcher). VERIFIED reachable: Internet
  // Archive is a global CDN, not IP-blocked. mahGRs = orgpedia's mirror of 169k
  // Maharashtra GRs with OCR. ====
  { id: "mahgrs-archive", title: "Maharashtra Government Resolutions (Internet Archive OCR)", tier: 5, match: "name",
    kind: "archive-org", iaQuery: "identifier:in.gov.maharashtra.gr.*", iaSort: "addeddate desc",
    textFormat: "DjVuTXT", maxDocs: 2000, delayMs: 400,
    translit: true,
    note: "169k GRs on Internet Archive via orgpedia — zero-scrape (advancedsearch + download API, VERIFIED live). The IA _djvu.txt is MARATHI original OCR (orgpedia's English translations are in its GitHub repo, not the IA items). translit:true romanizes the Devanagari body + folds it to a match skeleton so English roster names hit approximately; the full corpus is also persisted to docs.jsonl for FTS. Bounded to recent maxDocs.",
    summary: "Maharashtra GRs (sanctions, land, transfers, tender exemptions) — OCR bodies captured; roster name-match via transliteration skeleton." },
  // Gazette of India (central + ALL states) on Internet Archive — bilingual OCR
  // (eng+regional), so English roster names match directly. Covers the eGazette
  // portal (blocked from datacenter IPs) AND the state gazettes, via the same
  // verified archive-org path. Identifiers: in.gazette.<state|central>.<date>...
  { id: "gazette-india-archive", title: "Gazette of India + state gazettes (Internet Archive OCR)", tier: 5, match: "name",
    kind: "archive-org", iaQuery: "collection:gazetteofindia", iaSort: "addeddate desc",
    textFormat: "DjVuTXT", maxDocs: 3000, delayMs: 350, translit: true,
    note: "794k gazette items (central + every state) via IA (VERIFIED live) — the eGazette/state-gazette Phase-2 win instead of the blocked egazette.gov.in. Real-data check: the OCR body is often Hindi/regional Devanagari (English fragments too), so translit:true adds the romanized-skeleton match alongside direct English matching. Backdated/midnight notifications + de-notifications live here. Narrow iaQuery (e.g. ' AND identifier:in.gazette.maharashtra*') for a state slice.",
    summary: "Central + state gazette notifications (appointments, de-notifications, land, rules) — OCR bodies name-matched to the roster." },

  // ==== Gov-action phases 1/3/6 — OWNER-RUN scrape/PDF targets (see GOVACTION-
  // SOURCES-PLAN.md). Registered with the correct existing kind + the research-
  // verified URL, but NOT sandbox-verified (these hosts WAF-block / don't resolve
  // from a datacenter IP). Owner runs `--refresh <id>` from an India route; each
  // plugs into the existing pdf-archive/browser-capture plumbing. Confirm the
  // listing path + pagination on first run (same as every scrape source here). ====

  // Phase 6 oversight — CONFIRMED-corruption ground truth (calibrates L1 detectors).
  { id: "cci-cartel-orders", title: "CCI antitrust / cartel & bid-rigging orders", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://www.cci.gov.in/antitrust/orders", linkRe: "antitrustorder.*\\.pdf", maxDocs: 500,
    note: "Listing is an AJAX-filtered table (Section/year); a plain fetch may need the results endpoint. PDFs live at /images/antitrustorder/en/order<ts>.pdf. Named companies + govt tenders + GeM bid-rigging + penalties → procurement-collusion detector.",
    summary: "Cartel/bid-rigging order PDFs — collusive-tendering evidence (named firms, penalties)." },
  { id: "cvc-reports", title: "CVC annual reports + CTE + sanction-for-prosecution", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://cvc.gov.in/cte-corner/cte-reports", linkRe: "\\.pdf", maxDocs: 300,
    note: "Also harvest annual-report PDFs (penalties, sanction-for-prosecution-pending>1yr lists name departments). Static PDF listing; table extraction needed for the sanction lists.",
    summary: "Vigilance CTE reports + sanction-for-prosecution data — procurement fraud + named public servants." },
  { id: "ed-press", title: "Enforcement Directorate press releases (attachments/arrests)", tier: 6, match: "name",
    kind: "pdf-archive", url: "https://www.enforcementdirectorate.gov.in/press-release", linkRe: "\\.pdf", maxDocs: 400,
    note: "Listing path is intermittently broken (confirmed flaky) — build with retry; @dir_ed on X posts the same PDFs as a fallback. PMLA attachment orders name politicians/associates + amounts.",
    summary: "ED PMLA attachment/arrest press-release PDFs — money-laundering signals (names + amounts)." },

  // Phase 1 procurement — banned-vendor cross-reference (highest signal-per-record).
  { id: "cppp-debarment", title: "CPPP debarment / blacklisted-bidder list", tier: 6, match: "name",
    kind: "browser-capture", url: "https://eprocure.gov.in/eprocure/app?page=FrontEndDebarmentList&service=page", settleMs: 5000,
    note: "GePNIC debarment listing — capture the XHR behind it, then promote to a json-api/paged-html entry. Cross-ref debarred firms (+ Tofler directors) against award winners = near-certain lead.",
    summary: "Firms/individuals debarred from govt bidding (authority, reason, period) — blacklist-evasion detector." },

  // Phase 3 allocation — discretionary resource grants (named allottee + date).
  { id: "coal-block-allotment", title: "Ministry of Coal — coal block auction/allotment", tier: 5, match: "name",
    kind: "pdf-archive", url: "https://coal.gov.in/en/major-statistics/coal-block-allocation", linkRe: "\\.pdf", maxDocs: 200,
    note: "Small, structured (tranche-wise PDFs: allottee, date, revenue-share bid). The Coalgate surface — track direct-allotment vs auction + near-zero/round revenue-share bids. Confirm the current allocation page path.",
    summary: "Coal block allottee/auction PDFs — direct-allotment favoritism + odd revenue-share bids." },
  { id: "sez-approvals", title: "SEZ India — approved developers + Board of Approval minutes", tier: 5, match: "name",
    kind: "pdf-archive", url: "https://sezindia.gov.in/board-of-approval", linkRe: "\\.pdf", maxDocs: 300,
    note: "BoA agendas/minutes name who requested approvals/extensions/de-notifications; formal-approval list PDFs name developers. Small volume, static PDFs. Confirm the BoA-minutes listing path.",
    summary: "SEZ developer approvals + BoA minutes — discretionary concessional-land allotment + de-notification scams." },
  { id: "ibm-mining-leases", title: "IBM — All-India Directory of Mining Leases", tier: 5, match: "name",
    kind: "pdf-archive", url: "https://ibm.gov.in/IBMPortal/pages/All_India_Directory_of_Mining_Leases", linkRe: "\\.pdf", maxDocs: 200,
    note: "~3000 leases: lessee name+address, area, grant/execution date, period. 'Fully computerised' → published files. Confirm whether the directory is PDF or a table (may need paged-html-table/browser-render instead).",
    summary: "Major-mineral mining-lease directory (named lessees + grant dates) — lease favoritism / below-auction grants." },

  // Phase 2 — state GO registers + civil-service postings (gov hosts blocked from
  // datacenter IPs; browser-capture discovery targets, owner-run from an India route).
  { id: "ap-go-register", title: "Andhra Pradesh Government Orders (GOIR)", tier: 5, match: "name",
    kind: "browser-capture", url: "https://goir.ap.gov.in/", settleMs: 5000,
    note: "Full-text GO PDFs, dept/date/number search (ASP.NET viewstate POST). Capture the search XHR then promote to json-api/paged-html. Mirror https://www.govtorders.in/ap flattens it. GOs = discretionary land/contract/appointment/pension sanctions to named parties; GO-number-vs-issue-date gaps expose backdating.",
    summary: "AP full-text Government Orders (named beneficiaries) — discretionary-favor + backdating surface. TS/TN registers mirror this (goir.telangana.gov.in, tn.gov.in/go_view)." },
  { id: "dopt-ias-civillist", title: "DoPT IAS Civil List — officer posting history", tier: 5, match: "name",
    kind: "browser-capture", url: "https://iascivillist.dopt.gov.in/", settleMs: 5000,
    note: "Structured per-officer cadre/posting-history DB (also easy.nic.in/civilListIAS). Capture the officer-search XHR. Posting-history timelines → transfer-racket detection (abnormally short tenures, repeat parking in lucrative postings, election-timed transfers).",
    summary: "IAS officer posting histories — transfer-posting-racket detection (short tenures, lucrative-posting parking)." },
];

// --- roster needles ---------------------------------------------------------
function buildNeedles() {
  const ps = listPoliticians().filter((p) => !p.is_demo);
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const set = new Set();
  for (const p of ps) { const n = norm(p.name); if (n.length >= 4) set.add(n); }
  return [...set];
}
const normLine = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");

// --- helpers ----------------------------------------------------------------
async function downloadToFile(url, dest, { timeoutMs = 1800000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, fs.createWriteStream(dest));
  return dest;
}
function writeMegaCache(cfg, rows, totalScanned) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const out = {
    fetched_at: new Date().toISOString(),
    count: rows.length, total: totalScanned,
    meta: { id: `mega-${cfg.id}`, title: cfg.title, summary: cfg.summary, match: cfg.match, tier: cfg.tier, url: cfg.url || cfg.urls?.[0] || null },
    rows,
  };
  fs.writeFileSync(path.join(CACHE_DIR, `mega-${cfg.id}.json`), JSON.stringify(out));
  clog.log(`[mega] ${cfg.id}: ${rows.length} politician-matching rows kept (of ${totalScanned} scanned)`);
  // Single funnel every successful refreshOne() branch returns through — record
  // it here so mega sources show up in the SAME Source Health ledger/Ops Console
  // as the 22 per-politician fetchers (they previously had zero visibility there).
  recordFetchRun({ source: `mega:${cfg.id}`, ok: 1, items: rows.length, ms: Date.now() - (cfg.__t0 ?? Date.now()) });
}
// --- Phase-0 open-data LEDGER writer (denominators, match:"none") ------------
// The open-data kinds (ogd-resource / ckan-datastore) don't produce per-politician
// evidence rows — they produce BASELINE FACTS the anomaly engine divides against
// (per-district spend, per-market price, scheme allocation). So instead of a roster
// cache they write straight into the facts ledger, one fact per numeric metric per
// subject per period, keyed on a resolved subject-entity (universal-subjects rule:
// the district/market/scheme IS the named entity). Idempotent — upsertFact dedupes
// on (metric, entity, as_of_date, extractor_version), so a re-refresh is a no-op.
const LEDGER_VERSION = "opendata-ledger@1";

// Turn fetched rows into facts per the source's `ledger` mapping (rowToFactSpecs is
// the pure, unit-tested core). Wrapped in one better-sqlite3 transaction (thousands
// of tiny writes → one commit). Returns via the same recordFetchRun funnel as
// writeMegaCache so it shows in Source Health. as_of_date carries the period — it's
// the field in idx_facts_uniq, so a time series (one value per date) doesn't
// collapse to a single row; `period` keeps the human label too.
function writeLedgerFacts(cfg, rows, meta = {}) {
  const L = cfg.ledger;
  if (!L?.subject || !L.metrics?.length) {
    clog.log(`[mega] ${cfg.id}: no ledger mapping — nothing to write`);
    return recordFetchRun({ source: `mega:${cfg.id}`, ok: 0, items: 0, error: "missing cfg.ledger", ms: Date.now() - (cfg.__t0 ?? Date.now()) });
  }
  let facts = 0, skipped = 0;
  const subjects = new Set();
  const run = db.transaction((batch) => {
    for (const row of batch) {
      const specs = rowToFactSpecs(row, L);
      if (!specs.length) { skipped++; continue; }
      for (const sp of specs) {
        const entity_id = ensureEntity({ kind: sp.kind, name: sp.name, source: `mega:${cfg.id}` });
        subjects.add(entity_id);
        const res = upsertFact({
          entity_id, subject_kind: sp.kind, metric: sp.metric, value: sp.value, unit: sp.unit,
          as_of_date: sp.period, period: sp.period, source_type: `mega:${cfg.id}`, tier: cfg.tier,
          extractor_version: LEDGER_VERSION,
          data: { resource: cfg.resourceId ?? cfg.dataset ?? null, subject: sp.name },
        });
        if (res.inserted) facts++;
      }
    }
  });
  run(rows);
  // Reuse the mega cache shape (count/total/fetched_at) so the status listing +
  // Ops Console read it uniformly; store the snapshot freshness for the caveat.
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `mega-${cfg.id}.json`), JSON.stringify({
    fetched_at: new Date().toISOString(), count: facts, total: rows.length,
    meta: { id: `mega-${cfg.id}`, title: cfg.title, summary: cfg.summary, match: "none", tier: cfg.tier,
      ledger: true, subjects: subjects.size, source_updated: meta.updated ?? null, extractor_version: LEDGER_VERSION },
  }));
  clog.log(`[mega] ${cfg.id}: ${facts} facts written across ${subjects.size} subjects (of ${rows.length} rows, ${skipped} cells skipped)${meta.updated ? `  [source updated ${meta.updated}]` : ""}`);
  recordFetchRun({ source: `mega:${cfg.id}`, ok: 1, items: facts, ms: Date.now() - (cfg.__t0 ?? Date.now()) });
}

// Same minimal CSV parser as ingest.js (kept local: this file must stand alone).
function parseCsv(text, maxRows = 2000000) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((f) => f !== "")) rows.push(row); }
  return rows;
}
// Local HTML-table parser (mirror of ingest.js l1HtmlTables).
function parseHtmlTables(html) {
  const tables = [];
  for (const t of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const tr of t[0].matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells = [...tr[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => htmlToText(m[1], 500));
      if (cells.some((c) => c)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}
const matchRow = (needles, row) => { const t = normLine(row.join(" | ")); return needles.some((n) => t.includes(n)); };
const CAP = 5000; // max kept rows per dataset — evidence content is capped anyway

// A source awaiting owner setup (e.g. cfg.urls left empty pending a manual
// download link) is NOT a failure — it ran cleanly and correctly found nothing
// to do. Recording it as ok:1/items:0 lands it in QUIET, not a false ROTTED
// alarm (see server/health.js classifyHealth).
function notConfigured(cfg) {
  clog.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
  recordFetchRun({ source: `mega:${cfg.id}`, ok: 1, items: 0, ms: Date.now() - (cfg.__t0 ?? Date.now()) });
}

// --- per-kind refreshers ----------------------------------------------------
async function refreshOne(cfg, needles, { rematchOnly = false } = {}) {
  cfg.__t0 = Date.now(); // read by writeMegaCache() for the fetch_runs ms field
  const rawDir = path.join(MEGA_DIR, cfg.id);
  try {
    if (cfg.kind === "zip-xlsx" || cfg.kind === "zip-csv") {
      if (!cfg.url) return notConfigured(cfg);
      const zipPath = path.join(rawDir, "data.zip");
      if (!rematchOnly || !fs.existsSync(zipPath)) await downloadToFile(cfg.url, zipPath);
      const { unzipSync } = await import("fflate");
      const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      const rows = []; let total = 0;
      for (const [name, data] of Object.entries(files)) {
        if (cfg.kind === "zip-xlsx" && name.endsWith(".xlsx")) {
          const X = await import("xlsx");
          const wb = X.read(Buffer.from(data), { type: "buffer" });
          for (const sn of wb.SheetNames) {
            for (const r of X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: "" })) {
              total++;
              if (rows.length < CAP && r.some((c) => String(c).trim()) && matchRow(needles, r.map(String))) rows.push(r.map(String));
            }
          }
        } else if (cfg.kind === "zip-csv" && name.endsWith(".csv")) {
          for (const r of parseCsv(Buffer.from(data).toString("utf8"))) {
            total++;
            if (rows.length < CAP && matchRow(needles, r)) rows.push(r);
          }
        }
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "csv-multi") {
      if (!cfg.urls?.length) return notConfigured(cfg);
      const rows = []; let total = 0;
      for (const u of cfg.urls) {
        const f = path.join(rawDir, u.split("/").pop());
        if (!rematchOnly || !fs.existsSync(f)) await downloadToFile(u, f);
        for (const r of parseCsv(fs.readFileSync(f, "utf8"))) {
          total++;
          if (rows.length < CAP && matchRow(needles, r)) rows.push(r);
        }
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "csv-stream") {
      if (!cfg.urls?.length) return notConfigured(cfg);
      const rows = []; let total = 0;
      for (const u of cfg.urls) {
        const f = path.join(rawDir, u.split("/").pop().split("?")[0] || "part.csv");
        if (!rematchOnly || !fs.existsSync(f)) {
          clog.log(`[mega] ${cfg.id}: downloading ${u} (large — be patient)…`);
          await downloadToFile(u, f);
        }
        // Line-streamed filter: never loads the file into memory. Naive comma
        // split is fine — kept lines only feed substring matching + display.
        const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
        for await (const line of rl) {
          total++;
          if (rows.length < CAP && needles.some((n) => normLine(line).includes(n))) rows.push(line.split(","));
        }
        clog.log(`[mega] ${cfg.id}: scanned ${total} lines so far, kept ${rows.length}`);
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "paged-html-table") {
      // Polite sequential page crawl; keeps politician-matching rows, and
      // appends EVERY page's rows to raw pages.jsonl for the investigator.
      fs.mkdirSync(rawDir, { recursive: true });
      const rawFile = path.join(rawDir, "pages.jsonl");
      if (!rematchOnly) fs.writeFileSync(rawFile, "");
      const rows = []; let total = 0, emptyStreak = 0;
      if (rematchOnly && fs.existsSync(rawFile)) {
        for (const line of fs.readFileSync(rawFile, "utf8").split("\n").filter(Boolean)) {
          for (const r of JSON.parse(line).rows) { total++; if (rows.length < CAP && matchRow(needles, r)) rows.push(r); }
        }
        return writeMegaCache(cfg, rows, total);
      }
      for (let pg = cfg.startPage ?? 1; pg <= (cfg.maxPages ?? 500); pg++) {
        let html = "";
        try {
          const res = await fetch(cfg.url.replaceAll("{page}", String(pg)), { headers: UA, signal: AbortSignal.timeout(30000) });
          if (res.ok) html = await res.text();
        } catch { /* treat as empty page */ }
        const tables = parseHtmlTables(html);
        const t = tables.length ? tables.reduce((a, b) => (b.length > a.length ? b : a)) : [];
        const body = t.slice(cfg.headerRows ?? 1);
        if (!body.length) { if (++emptyStreak >= 3) { clog.log(`[mega] ${cfg.id}: stopping at page ${pg} (3 empty pages)`); break; } continue; }
        emptyStreak = 0;
        fs.appendFileSync(rawFile, JSON.stringify({ pg, rows: body }) + "\n");
        for (const r of body) { total++; if (rows.length < CAP && matchRow(needles, r)) rows.push(r); }
        if (pg % 25 === 0) clog.log(`[mega] ${cfg.id}: page ${pg}, ${total} rows scanned, ${rows.length} kept`);
        await new Promise((r) => setTimeout(r, cfg.delayMs ?? 1200));
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "xlsx-multi") {
      // Multiple XLSX files (e.g. per-statement/per-year) → one filtered cache.
      if (!cfg.urls?.length) return notConfigured(cfg);
      const X = await import("xlsx");
      const rows = []; let total = 0;
      for (const u of cfg.urls) {
        const f = path.join(rawDir, u.split("/").pop());
        if (!rematchOnly || !fs.existsSync(f)) await downloadToFile(u, f);
        const wb = X.read(fs.readFileSync(f), { type: "buffer" });
        for (const sn of wb.SheetNames) {
          for (const r of X.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: false, defval: "" })) {
            total++;
            if (rows.length < CAP && r.some((c) => String(c).trim()) && (cfg.match === "none" ? rows.length < CAP : matchRow(needles, r.map(String)))) rows.push(r.map(String));
          }
        }
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "browser-render") {
      // JS/SPA/ASP.NET portals: render each URL in headless Chromium, keep the
      // readable text, filter to politician-mentioning chunks. Needs playwright
      // (owner-installed); renderPageText returns "" if not — we skip cleanly.
      const urls = cfg.iterate ? cfg.iterate.map((v) => cfg.url.replaceAll("{val}", String(v))) : [cfg.url];
      const rows = []; let total = 0, blank = 0;
      for (const u of urls) {
        const text = await renderPageText(u, { waitForSelector: cfg.waitFor ?? "table", maxLen: 200000 });
        if (!text) { if (++blank >= 3) break; continue; }
        blank = 0;
        // Split into line-ish chunks so matchRow works like a row scan.
        for (const chunk of text.split(/(?<=\.)\s|\n|\s{3,}/).filter((c) => c.trim().length > 12)) {
          total++;
          if (rows.length < CAP && (cfg.match === "none" ? false : matchRow(needles, [chunk]))) rows.push([u, chunk]);
        }
        await new Promise((r) => setTimeout(r, cfg.delayMs ?? 1500));
      }
      await closeBrowser().catch(() => {});
      if (!total) return clog.log(`[mega] ${cfg.id}: no content (playwright not installed, or page empty) — skipped`);
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "s3-sync") {
      // Cloud bulk corpus. We do NOT pull 1TB — record the access recipe and,
      // if the AWS CLI is present, list the top prefixes so the owner can target.
      clog.log(`[mega] ${cfg.id}: bulk S3 corpus. Manual/targeted pull only:\n  ${cfg.note}`);
      return; // intentionally no cache — this is a documented access pointer
    }
    if (cfg.kind === "browser-capture") {
      // Hidden-API DISCOVERY (PLAN-L4 Step 5). Load a JS-SPA in headless Chromium
      // and record every XHR/fetch JSON RESPONSE the app fires — the exact same
      // calls the public browser makes, so no access control is defeated. Dumps
      // {url,status,sample} to endpoints.json; the owner then promotes a stable
      // endpoint into a plain json-api L1_SOURCES entry (cheap cached retrieval,
      // no browser at run time). Discovery only — writes NO politician cache.
      const { getBrowser } = await import("./fetchers/playwright-portal.js");
      const browser = await getBrowser();
      if (!browser) return clog.log(`[mega] ${cfg.id}: playwright not installed — skipped`);
      fs.mkdirSync(rawDir, { recursive: true });
      const captured = [];
      let page;
      try {
        page = await browser.newPage({ userAgent: "Mozilla/5.0 (PandorosBox research)" });
        page.on("response", async (res) => {
          try {
            const ct = res.headers()["content-type"] || "";
            const u = res.url();
            if (!/json/i.test(ct) && !/\/api\/|\.json(\?|$)/i.test(u)) return;
            if (/google|gstatic|analytics|recaptcha|font|\.css|\.js(\?|$)/i.test(u)) return;
            let sample = ""; try { sample = (await res.text()).slice(0, 600); } catch (err) { clog.warn("[mega-ingest] response body read failed:", err?.message ?? err); }
            captured.push({ url: u, status: res.status(), sample });
          } catch (err) { clog.warn("[mega-ingest] response capture failed:", err?.message ?? err); }
        });
        await page.goto(cfg.url, { waitUntil: "networkidle", timeout: cfg.timeoutMs ?? 45000 }).catch(() => {});
        for (const sel of (cfg.clicks ?? [])) { await page.click(sel).catch(() => {}); await page.waitForTimeout(1500).catch(() => {}); }
        await page.waitForTimeout(cfg.settleMs ?? 3000).catch(() => {});
      } catch (e) { clog.error(`[mega] ${cfg.id}: capture error — ${e.message}`); }
      finally { if (page) await page.close().catch(() => {}); await closeBrowser().catch(() => {}); }
      const seen = new Set();
      const uniq = captured.filter((c) => !seen.has(c.url) && seen.add(c.url));
      fs.writeFileSync(path.join(rawDir, "endpoints.json"), JSON.stringify(uniq, null, 2));
      clog.log(`[mega] ${cfg.id}: captured ${uniq.length} JSON endpoint(s) → server/data/mega/${cfg.id}/endpoints.json`);
      for (const c of uniq.slice(0, 8)) clog.log(`  [${c.status}] ${c.url}`);
      if (!uniq.length) clog.log(`  (none — page may need a click/interaction; set cfg.clicks or cfg.settleMs, or the app renders server-side)`);
      return; // discovery only — no politician cache
    }
    if (cfg.kind === "pdf-archive") {
      // Search-by-harvest: crawl listing → download PDFs → extract text →
      // keep only docs naming a politician. docs.jsonl persists text so
      // --rematch re-filters offline. See PLAN-L3 Step 5c.
      fs.mkdirSync(rawDir, { recursive: true });
      const idx = path.join(rawDir, "docs.jsonl");
      const snip = (text) => {
        const t = normLine(text); const hit = needles.find((n) => t.includes(n));
        if (!hit) return "";
        const i = t.indexOf(hit); return text.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, " ").trim();
      };
      const rows = []; let total = 0;
      if (rematchOnly && fs.existsSync(idx)) {
        for (const line of fs.readFileSync(idx, "utf8").split("\n").filter(Boolean)) {
          const d = JSON.parse(line); total++;
          if (rows.length < CAP && matchRow(needles, [d.title, d.text].filter(Boolean))) rows.push([d.title, d.href, snip(d.text || d.title)]);
        }
        return writeMegaCache(cfg, rows, total);
      }
      // 1. gather PDF links across listing page(s)
      const listUrls = cfg.pages
        ? Array.from({ length: cfg.pages[1] - cfg.pages[0] + 1 }, (_, i) => cfg.url.replaceAll("{page}", String(cfg.pages[0] + i)))
        : (cfg.iterate ? cfg.iterate.map((v) => cfg.url.replaceAll("{val}", String(v))) : [cfg.url]);
      const links = []; const seen = new Set();
      for (const lu of listUrls) {
        // cfg.insecure: some gov sites (e.g. wbindustries.gov.in) serve a broken
        // TLS chain — fetchText's insecure mode routes around it via node:https
        // with rejectUnauthorized:false, same technique the L1 engine already
        // uses for this exact site (see ingest.js l1FetchInsecure).
        const html = await fetchText(lu, { timeoutMs: 30000, insecure: cfg.insecure });
        for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          let href = m[1]; const title = htmlToText(m[2], 300);
          try { href = new URL(href, lu).href; } catch { continue; }
          if (!new RegExp(cfg.linkRe ?? "\\.pdf", "i").test(href) || seen.has(href)) continue;
          seen.add(href); links.push({ title, href });
        }
        await new Promise((r) => setTimeout(r, cfg.delayMs ?? 800));
      }
      clog.log(`[mega] ${cfg.id}: ${links.length} documents found; harvesting${cfg.titleOnly ? " (title-only)" : ""}…`);
      fs.writeFileSync(idx, "");
      // 2. per doc: title match is free; body extract only when needed
      for (const { title, href } of links.slice(0, cfg.maxDocs ?? 3000)) {
        total++;
        let text = "";
        if (!cfg.titleOnly && !matchRow(needles, [title])) {
          text = await fetchPdfText(href, { maxLen: cfg.docChars ?? 20000, insecure: cfg.insecure });
          await new Promise((r) => setTimeout(r, cfg.delayMs ?? 800));
        }
        fs.appendFileSync(idx, JSON.stringify({ title, href, text }) + "\n");
        if (rows.length < CAP && matchRow(needles, [title, text].filter(Boolean))) rows.push([title, href, snip(text || title)]);
        if (total % 50 === 0) clog.log(`[mega] ${cfg.id}: ${total}/${links.length} docs, ${rows.length} kept`);
        if (rows.length >= CAP) break;
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "archive-org") {
      // Internet Archive collection harvest (Phase-2 orders/gazette). Pages item
      // identifiers via advancedsearch.php, pulls each item's OCR text file (DjVuTXT
      // — plain .txt, no PDF parse), name-matches bodies. Persists every item's text
      // to docs.jsonl so --rematch re-filters offline AND the raw corpus is captured
      // for FTS/investigator even when the name-match keeps nothing (e.g. regional-
      // language OCR that English roster needles can't hit yet). Mirrors pdf-archive.
      fs.mkdirSync(rawDir, { recursive: true });
      const idx = path.join(rawDir, "docs.jsonl");
      // translit:true (regional-language OCR) → also match a romanized consonant
      // skeleton so English roster names hit Devanagari bodies approximately.
      const tnSkel = cfg.translit ? buildTranslitNeedles(needles) : null;
      const matchDoc = (title, text) => matchRow(needles, [title, text].filter(Boolean))
        || (tnSkel && textMatchesTranslit(`${title || ""} ${text || ""}`, tnSkel));
      const snip = (text) => {
        const t = normLine(text); const hit = needles.find((n) => t.includes(n));
        if (!hit) return "";
        const i = t.indexOf(hit); return text.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, " ").trim();
      };
      const rows = []; let total = 0;
      if (rematchOnly && fs.existsSync(idx)) {
        for (const line of fs.readFileSync(idx, "utf8").split("\n").filter(Boolean)) {
          const d = JSON.parse(line); total++;
          if (rows.length < CAP && matchDoc(d.title, d.text)) rows.push([d.title, d.href, snip(d.text || d.title)]);
        }
        return writeMegaCache(cfg, rows, total);
      }
      // 1. page item identifiers (bounded by maxDocs)
      const items = []; const maxDocs = cfg.maxDocs ?? 2000; const rowsPer = 100;
      for (let page = 1; items.length < maxDocs; page++) {
        const api = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(cfg.iaQuery)}`
          + `&fl[]=identifier&fl[]=title&fl[]=date&sort[]=${encodeURIComponent(cfg.iaSort ?? "addeddate desc")}`
          + `&rows=${rowsPer}&page=${page}&output=json`;
        const j = await fetchJson(api, { timeoutMs: 30000 });
        const docs = j?.response?.docs ?? [];
        if (!docs.length) break;
        for (const d of docs) items.push({ id: d.identifier, title: d.title ?? d.identifier });
        if (items.length >= (j?.response?.numFound ?? Infinity)) break;
        await sleep(cfg.delayMs ?? 500);
      }
      const capped = items.slice(0, maxDocs);
      clog.log(`[mega] ${cfg.id}: ${capped.length} IA items; harvesting OCR text (${cfg.textFormat ?? "DjVuTXT"})…`);
      fs.writeFileSync(idx, "");
      const fmt = cfg.textFormat ?? "DjVuTXT";
      for (const it of capped) {
        total++;
        let text = "";
        try {
          const meta = await fetchJson(`https://archive.org/metadata/${it.id}`, { timeoutMs: 20000 });
          const file = (meta?.files ?? []).find((f) => f.format === fmt) ?? (meta?.files ?? []).find((f) => /_djvu\.txt$/i.test(f.name || ""));
          if (file) text = await fetchText(`https://archive.org/download/${it.id}/${encodeURIComponent(file.name)}`, { timeoutMs: 30000 });
        } catch { /* skip this item's body, keep going */ }
        const itemUrl = `https://archive.org/details/${it.id}`;
        fs.appendFileSync(idx, JSON.stringify({ title: it.title, href: itemUrl, text }) + "\n");
        if (rows.length < CAP && matchDoc(it.title, text)) rows.push([it.title, itemUrl, snip(text || it.title)]);
        if (total % 50 === 0) clog.log(`[mega] ${cfg.id}: ${total}/${capped.length} items, ${rows.length} kept`);
        await sleep(cfg.delayMs ?? 400);
        if (rows.length >= CAP) break;
      }
      return writeMegaCache(cfg, rows, total);
    }
    if (cfg.kind === "ogd-resource") {
      // data.gov.in OGD resource → ledger denominators. No roster filter (match:
      // "none"): every row is a baseline fact. Freshness probed first (the snapshot
      // caveat — an OGD resource updates on its own cadence, not live).
      if (!cfg.resourceId) return notConfigured(cfg);
      const meta = await ogdResourceMeta(cfg.resourceId);
      const rows = await ogdResourceAll(cfg.resourceId, { maxRows: cfg.maxRows ?? 20000, pageSize: cfg.pageSize ?? 1000 });
      if (!rows.length) { clog.log(`[mega] ${cfg.id}: 0 rows (blocked or empty) — check OGD_API_KEY / resource id`); return recordFetchRun({ source: `mega:${cfg.id}`, ok: 0, items: 0, error: "no rows from OGD", ms: Date.now() - (cfg.__t0 ?? Date.now()) }); }
      return writeLedgerFacts(cfg, rows, meta);
    }
    if (cfg.kind === "ckan-datastore") {
      // CKAN datastore-active resource (Open Budgets India / Justice Hub) → ledger
      // denominators. Pages via datastore_search. baseUrl from cfg.portal key or an
      // explicit cfg.baseUrl.
      const baseUrl = cfg.baseUrl ?? CKAN_PORTALS[cfg.portal];
      if (!baseUrl || !cfg.resourceId) return notConfigured(cfg);
      const rows = []; const pageSize = cfg.pageSize ?? 1000;
      for (let offset = 0; offset < (cfg.maxRows ?? 20000); offset += pageSize) {
        const { records, total } = await ckanDatastoreSearch(baseUrl, { resourceId: cfg.resourceId, limit: pageSize, offset });
        if (!records.length) break;
        rows.push(...records);
        if (rows.length >= total) break;
        await new Promise((r) => setTimeout(r, cfg.delayMs ?? 400)); // polite pacing
      }
      if (!rows.length) { clog.log(`[mega] ${cfg.id}: 0 rows (portal blocked/empty — WAF or bad resource id)`); return recordFetchRun({ source: `mega:${cfg.id}`, ok: 0, items: 0, error: "no rows from CKAN", ms: Date.now() - (cfg.__t0 ?? Date.now()) }); }
      return writeLedgerFacts(cfg, rows, {});
    }
    clog.log(`[mega] ${cfg.id}: unknown kind ${cfg.kind}`);
  } catch (e) {
    clog.error(`[mega] ${cfg.id}: FAILED — ${e.message}`);
    // A real failure (network/unzip/parse error) — this is the one path that
    // SHOULD show ROTTED in the Ops Console, unlike the notConfigured()/
    // writeMegaCache() paths above, which are clean runs (ok:1).
    recordFetchRun({ source: `mega:${cfg.id}`, ok: 0, items: 0, error: e.message, ms: Date.now() - (cfg.__t0 ?? Date.now()) });
  }
}

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "--refresh" || cmd === "--rematch") {
  const which = argv[1] ?? "all";
  const targets = which === "all" ? MEGA_SOURCES : MEGA_SOURCES.filter((s) => s.id === which);
  if (!targets.length) { clog.error(`[mega] unknown id '${which}'. Known: ${MEGA_SOURCES.map((s) => s.id).join(", ")}`); process.exit(1); }
  // --max N bounds a first-pass crawl: caps the crawl-count knobs (maxDocs for
  // pdf-archive, maxPages for paged-html) so a heavy source completes in one run.
  // It does NOT touch maxRows (single-file csv/zip datasets stay whole). Re-run
  // later without --max (or with --rematch) to deepen coverage.
  const mi = argv.indexOf("--max");
  const maxN = mi >= 0 ? Number(argv[mi + 1]) : null;
  const needles = buildNeedles();
  clog.log(`[mega] roster: ${needles.length} politician-name needles${maxN ? `  (--max ${maxN})` : ""}`);
  for (const cfg of targets) {
    const c = maxN
      ? { ...cfg, maxDocs: Math.min(cfg.maxDocs ?? maxN, maxN), maxPages: Math.min(cfg.maxPages ?? maxN, maxN) }
      : cfg;
    await refreshOne(c, needles, { rematchOnly: cmd === "--rematch" });
  }
  process.exit(0);
} else {
  for (const s of MEGA_SOURCES) {
    const f = path.join(CACHE_DIR, `mega-${s.id}.json`);
    let line = "no cache — run: node server/mega-ingest.js --refresh " + s.id;
    try { const c = JSON.parse(fs.readFileSync(f, "utf8")); line = `${c.count} matched rows (of ${c.total}), refreshed ${c.fetched_at}`; } catch (err) { clog.warn(`[mega-ingest] cache status read failed for ${s.id}:`, err?.message ?? err); }
    clog.log(`[mega] ${s.id}: ${line}`);
  }
  process.exit(0);
}
