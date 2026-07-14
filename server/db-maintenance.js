// Database maintenance & robustness toolkit. One place for the operational
// hygiene the 346 MB pandoros.db needs: safe rotating backups, integrity +
// orphan checks, a WAL-shrinking vacuum, and a "doctor" preflight that tells
// unconfigured sources apart from genuinely-rare ones.
//
// Everything here is deliberately dependency-free (reuses better-sqlite3 via the
// shared store handle) and honours PANDOROS_DB_PATH exactly like store.js. It is
// read-only except `backup` (writes a copy) and `vacuum` (rewrites in place, and
// only after taking a backup first).
//
// Usage:
//   node server/db-maintenance.js backup   [--keep 5]     rotating VACUUM INTO backup
//   node server/db-maintenance.js check     [--json]      integrity + orphan report (exit 1 on problems)
//   node server/db-maintenance.js doctor    [--days 30]   config/health preflight (unconfigured vs rare sources)
//   node server/db-maintenance.js vacuum                  backup, then VACUUM + ANALYZE + WAL checkpoint
//   node server/db-maintenance.js all                     backup → check → doctor (the nightly routine)
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./store.js";
import { dataGovKey } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PANDOROS_DB_PATH || path.join(__dirname, "..", "data", "pandoros.db");
const DATA_DIR = path.dirname(DB_PATH);
const BACKUP_DIR = path.join(DATA_DIR, "backups");

const fmtBytes = (n) => {
  if (n == null) return "?";
  const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

// ── Backup ──────────────────────────────────────────────────────────────────
// VACUUM INTO writes a fully-consistent, de-fragmented copy with NO -wal/-shm
// sidecars — safer than a raw file copy (which can catch a mid-write WAL) and it
// compacts free pages on the way out. Backups land in data/backups/ with a
// timestamped name; the oldest are pruned so the folder can't grow unbounded.
export function backup({ keep = 5, quiet = false } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `pandoros-${nowStamp()}.db`);
  const t0 = Date.now();
  db.prepare("VACUUM INTO ?").run(dest);
  const size = fs.statSync(dest).size;

  // Prune: keep the newest `keep` timestamped backups, delete the rest.
  const existing = fs.readdirSync(BACKUP_DIR)
    .filter((n) => /^pandoros-.*\.db$/.test(n))
    .map((n) => ({ n, p: path.join(BACKUP_DIR, n), t: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const pruned = existing.slice(keep);
  for (const f of pruned) fs.rmSync(f.p, { force: true });

  const out = { dest, size, ms: Date.now() - t0, kept: Math.min(existing.length, keep), pruned: pruned.length };
  if (!quiet) {
    console.log(`[backup] wrote ${path.relative(DATA_DIR, dest)} (${fmtBytes(size)}) in ${out.ms}ms`);
    if (pruned.length) console.log(`[backup] pruned ${pruned.length} old backup(s), keeping newest ${keep}`);
  }
  return out;
}

// Report on the legacy scattered .bak files in data/ (from ad-hoc manual copies)
// so the owner can see how much stale backup weight is sitting in the data dir.
export function legacyBackups() {
  const out = [];
  for (const n of fs.readdirSync(DATA_DIR)) {
    if (/\.(bak|bak-[^/]*)$/.test(n) || n.includes(".bak")) {
      const p = path.join(DATA_DIR, n);
      try { out.push({ name: n, size: fs.statSync(p).size }); } catch { /* skip */ }
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

// ── Integrity + referential checks ────────────────────────────────────────────
// SQLite has no enforced foreign keys here (rows carry ids as plain TEXT), so a
// deleted politician can leave orphaned evidence/reports/cards, and a rebuilt
// entity table can strand ledger rows. These queries surface every dangling
// reference so a cleanup pass has an exact target list.
const ORPHAN_CHECKS = [
  { name: "evidence→politician",     sql: "SELECT COUNT(*) c FROM evidence e   WHERE e.politician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = e.politician_id)" },
  { name: "reports→politician",      sql: "SELECT COUNT(*) c FROM reports r    WHERE r.politician_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = r.politician_id)" },
  { name: "cards→politician",        sql: "SELECT COUNT(*) c FROM cards c2     WHERE c2.kind = 'politician' AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id = c2.subject_key)" },
  { name: "facts→entity",            sql: "SELECT COUNT(*) c FROM facts f      WHERE f.entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = f.entity_id)" },
  { name: "claims→subject_entity",   sql: "SELECT COUNT(*) c FROM claims c     WHERE c.subject_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = c.subject_entity_id)" },
  { name: "relationships→src_entity",sql: "SELECT COUNT(*) c FROM relationships r WHERE r.src_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.src_entity_id)" },
  { name: "relationships→dst_entity",sql: "SELECT COUNT(*) c FROM relationships r WHERE r.dst_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = r.dst_entity_id)" },
  { name: "entity_aliases→entity",   sql: "SELECT COUNT(*) c FROM entity_aliases a WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = a.entity_id)" },
];

export function check() {
  // PRAGMA integrity_check returns a single 'ok' row when the file is sound,
  // else one row per problem. quick_check is the fast structural pass.
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check);
  const integrityOk = integrity.length === 1 && integrity[0] === "ok";

  const orphans = ORPHAN_CHECKS.map((chk) => {
    try { return { name: chk.name, count: db.prepare(chk.sql).get().c }; }
    catch (e) { return { name: chk.name, count: -1, error: e.message }; }
  });
  const totalOrphans = orphans.reduce((s, o) => s + Math.max(0, o.count), 0);
  return { integrityOk, integrity, orphans, totalOrphans, ok: integrityOk && totalOrphans === 0 };
}

// ── Doctor: config/health preflight ───────────────────────────────────────────
// The health CLI already flags QUIET sources (0 items), but it can't tell an
// UNCONFIGURED source (needs a one-time dataset/key that was never set up) from
// a genuinely rare-hit one. This resolves that: it probes the optional local
// datasets and reports exactly which setup steps are still pending.
export async function optionalDatasets() {
  const checks = [];

  // Director names — the FREE system. There is NO freely-available MCA bulk
  // Director dataset (data.gov.in exposes Company Master Data, not directors),
  // so director names come from Tofler, fetched per FLAGGED company and cached
  // in tofler_companies. This reports the real posture and is ALWAYS ok — it
  // never recommends the (nonexistent) bulk download. Enable live fetching with
  // TOFLER_ENRICH=1; without it, the cache still serves whatever was gathered.
  let toflerRows = 0;
  try { toflerRows = db.prepare("SELECT COUNT(*) c FROM tofler_companies").get().c; } catch { /* table absent */ }
  const toflerOn = process.env.TOFLER_ENRICH === "1";
  checks.push({
    id: "director_names", ok: true,
    detail: `Tofler (free, per flagged company) — ${toflerRows} company(ies) cached; live fetch ${toflerOn ? "ON" : "OFF (set TOFLER_ENRICH=1)"}`,
    feeds: "director→politician leads, investigator directorships",
  });

  // PDF OCR — the fallback that reads SCANNED/image-only PDFs (no text layer).
  // Optional deps + off by default; report whether it's installed and enabled.
  let ocrDeps = true;
  try { await import("tesseract.js"); await import("pdf-to-img"); } catch { ocrDeps = false; }
  const ocrOn = process.env.PDF_OCR === "1";
  checks.push({
    id: "pdf_ocr", ok: true,
    detail: ocrDeps
      ? `deps installed; fallback ${ocrOn ? "ON" : "OFF (set PDF_OCR=1)"}${ocrOn ? ` — langs ${process.env.PDF_OCR_LANGS || "eng"}` : ""}`
      : "deps not installed (npm i tesseract.js pdf-to-img @napi-rs/canvas) — scanned PDFs skipped",
    feeds: "scanned-PDF text (press releases, audit reports, affidavits)",
  });

  // CPPP procurement index — backs the cppp fetcher (env CPPP_DB_PATH).
  const cpppPath = process.env.CPPP_DB_PATH || path.join(DATA_DIR, "cppp.db");
  checks.push({
    id: "cppp", ok: fs.existsSync(cpppPath),
    detail: fs.existsSync(cpppPath) ? `present (${fmtBytes(fs.statSync(cpppPath).size)})` : "cppp.db missing",
    fix: "node server/cppp-ingest.js   (builds the local CPPP procurement DB)",
    feeds: "cppp",
  });

  // data.gov.in key — unlocks the json-api L1 sources (FCI, PMFBY, DILRMP, AQI…).
  const dgiKey = dataGovKey();
  checks.push({
    id: "data_gov_key", ok: !!dgiKey,
    detail: dgiKey ? "set" : "no data.gov.in key",
    fix: "register free at data.gov.in → set DATA_GOV_IN_KEY",
    feeds: "company_registry (name→CIN/status) + l1 json-api sources (fci-stock, pmfby-claims, dilrmp-progress, cpcb-aqi)",
  });
  return checks;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };

async function doctor(days) {
  const { sourceHealth } = await import("./store.js");
  const health = sourceHealth(days);
  const quiet = health.filter((h) => h.runs > 0 && h.ok_rate >= 0.5 && h.total_items === 0).map((h) => h.source);
  const datasets = await optionalDatasets();

  console.log(`\n── Doctor (last ${days}d) ────────────────────────────────────────────\n`);
  console.log("Optional datasets / keys:");
  for (const d of datasets) {
    console.log(`  ${d.ok ? "✓" : "✗"} ${pad(d.id, 16)} ${d.detail}`);
    if (!d.ok) console.log(`      feeds: ${d.feeds}\n      fix:   ${d.fix}`);
  }

  // Cross-reference: which QUIET sources are QUIET *because* they're unconfigured.
  const unconfiguredFeeds = new Set(datasets.filter((d) => !d.ok).flatMap((d) => d.feeds.split(",").map((s) => s.trim())));
  const explained = quiet.filter((s) => unconfiguredFeeds.has(s));
  const genuinelyRare = quiet.filter((s) => !unconfiguredFeeds.has(s));
  console.log(`\nZero-item sources this window: ${quiet.length}`);
  if (explained.length) console.log(`  unconfigured (fixable): ${explained.join(", ")}`);
  if (genuinelyRare.length) console.log(`  rare-hit or worth a look: ${genuinelyRare.join(", ")}`);

  const legacy = legacyBackups();
  if (legacy.length) {
    const total = legacy.reduce((s, f) => s + f.size, 0);
    console.log(`\nLegacy .bak files in data/: ${legacy.length} using ${fmtBytes(total)} — consider moving to data/backups/ and pruning:`);
    for (const f of legacy.slice(0, 6)) console.log(`  ${pad(fmtBytes(f.size), 9)} ${f.name}`);
  }
  console.log("");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "all";
  const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const keep = Number(flag("--keep", 5)) || 5;
  const days = Number(flag("--days", 30)) || 30;

  if (cmd === "backup") { backup({ keep }); return process.exit(0); }

  if (cmd === "check") {
    const r = check();
    if (argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return process.exit(r.ok ? 0 : 1); }
    console.log(`\n── Integrity check ──────────────────────────────────────────────\n`);
    console.log(`  integrity_check: ${r.integrityOk ? "ok" : "FAILED — " + r.integrity.slice(0, 5).join("; ")}`);
    console.log(`\n  Orphaned references:`);
    for (const o of r.orphans) {
      const mark = o.count > 0 ? "✗" : o.count < 0 ? "?" : "✓";
      console.log(`  ${mark} ${pad(o.name, 28)} ${o.error ? "ERR " + o.error : o.count}`);
    }
    console.log(`\n  ${r.ok ? "✓ clean" : `✗ ${r.totalOrphans} orphaned row(s)` + (r.integrityOk ? "" : " + integrity failure")}\n`);
    return process.exit(r.ok ? 0 : 1);
  }

  if (cmd === "doctor") { await doctor(days); return process.exit(0); }

  if (cmd === "vacuum") {
    console.log("[vacuum] taking a safety backup first…");
    backup({ keep });
    console.log("[vacuum] VACUUM…"); db.prepare("VACUUM").run();
    console.log("[vacuum] ANALYZE…"); db.prepare("ANALYZE").run();
    console.log("[vacuum] WAL checkpoint (TRUNCATE)…"); db.pragma("wal_checkpoint(TRUNCATE)");
    console.log(`[vacuum] done. DB now ${fmtBytes(fs.statSync(DB_PATH).size)}`);
    return process.exit(0);
  }

  if (cmd === "all") {
    backup({ keep });
    const r = check();
    console.log(`[check] integrity ${r.integrityOk ? "ok" : "FAILED"}, ${r.totalOrphans} orphan(s)`);
    await doctor(days);
    return process.exit(r.ok ? 0 : 1);
  }

  console.log(`Unknown command "${cmd}". Use: backup | check | doctor | vacuum | all`);
  process.exit(1);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("db-maintenance.js");
if (invokedDirectly) main();
