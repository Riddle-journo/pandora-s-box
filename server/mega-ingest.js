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
import { listPoliticians } from "./store.js";
import { UA } from "./fetchers/http.js";

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
    tier: 5, match: "name",
    summary: "Development Data Lab bulk court-case records: party names, judge, acts/sections, outcomes.",
    kind: "csv-stream",
    urls: [],
    note: "OWNER ACTION: get the Dropbox bulk-download link(s) from https://www.devdatalab.org/judicial-data (open licence), convert to direct links (dl=1), and hard-code into urls. Multi-GB: files stream to disk and are line-filtered, never loaded into memory. Leave urls empty until then — the script reports 'not configured' and skips.",
  },
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
  console.log(`[mega] ${cfg.id}: ${rows.length} politician-matching rows kept (of ${totalScanned} scanned)`);
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
const matchRow = (needles, row) => { const t = normLine(row.join(" | ")); return needles.some((n) => t.includes(n)); };
const CAP = 5000; // max kept rows per dataset — evidence content is capped anyway

// --- per-kind refreshers ----------------------------------------------------
async function refreshOne(cfg, needles, { rematchOnly = false } = {}) {
  const rawDir = path.join(MEGA_DIR, cfg.id);
  try {
    if (cfg.kind === "zip-xlsx" || cfg.kind === "zip-csv") {
      if (!cfg.url) return console.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
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
      if (!cfg.urls?.length) return console.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
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
      if (!cfg.urls?.length) return console.log(`[mega] ${cfg.id}: not configured — ${cfg.note}`);
      const rows = []; let total = 0;
      for (const u of cfg.urls) {
        const f = path.join(rawDir, u.split("/").pop().split("?")[0] || "part.csv");
        if (!rematchOnly || !fs.existsSync(f)) {
          console.log(`[mega] ${cfg.id}: downloading ${u} (large — be patient)…`);
          await downloadToFile(u, f);
        }
        // Line-streamed filter: never loads the file into memory. Naive comma
        // split is fine — kept lines only feed substring matching + display.
        const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
        for await (const line of rl) {
          total++;
          if (rows.length < CAP && needles.some((n) => normLine(line).includes(n))) rows.push(line.split(","));
        }
        console.log(`[mega] ${cfg.id}: scanned ${total} lines so far, kept ${rows.length}`);
      }
      return writeMegaCache(cfg, rows, total);
    }
    console.log(`[mega] ${cfg.id}: unknown kind ${cfg.kind}`);
  } catch (e) { console.error(`[mega] ${cfg.id}: FAILED — ${e.message}`); }
}

// --- CLI ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0];
if (cmd === "--refresh" || cmd === "--rematch") {
  const which = argv[1] ?? "all";
  const targets = which === "all" ? MEGA_SOURCES : MEGA_SOURCES.filter((s) => s.id === which);
  if (!targets.length) { console.error(`[mega] unknown id '${which}'. Known: ${MEGA_SOURCES.map((s) => s.id).join(", ")}`); process.exit(1); }
  const needles = buildNeedles();
  console.log(`[mega] roster: ${needles.length} politician-name needles`);
  for (const cfg of targets) await refreshOne(cfg, needles, { rematchOnly: cmd === "--rematch" });
  process.exit(0);
} else {
  for (const s of MEGA_SOURCES) {
    const f = path.join(CACHE_DIR, `mega-${s.id}.json`);
    let line = "no cache — run: node server/mega-ingest.js --refresh " + s.id;
    try { const c = JSON.parse(fs.readFileSync(f, "utf8")); line = `${c.count} matched rows (of ${c.total}), refreshed ${c.fetched_at}`; } catch {}
    console.log(`[mega] ${s.id}: ${line}`);
  }
  process.exit(0);
}
