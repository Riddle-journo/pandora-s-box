// Minimal JSON-file data store. Swap for Postgres/SQLite in production —
// every accessor goes through this module so the rest of the app won't change.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "db.json");

// `meta` is a small key→value bag for global cursors (e.g. last_discovery_at),
// NOT a collection — everything else is an array.
const EMPTY = { politicians: [], evidence: [], reports: [], tips: [], scandals: [], meta: {} };

function load() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return structuredClone(EMPTY);
  }
  // Backfill any keys added after this db.json was first written, so older
  // stores don't crash new accessors. Respect each default's type (array vs
  // object) — `meta` must stay an object, the rest stay arrays.
  for (const k of Object.keys(EMPTY)) {
    if (Array.isArray(EMPTY[k])) { if (!Array.isArray(db[k])) db[k] = []; }
    else if (db[k] == null || typeof db[k] !== "object" || Array.isArray(db[k])) db[k] = structuredClone(EMPTY[k]);
  }
  return db;
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

export const id = () => crypto.randomUUID();

// ---- Politicians ----
export function listPoliticians() {
  return load().politicians;
}

export function getPolitician(pid) {
  return load().politicians.find((p) => p.id === pid) ?? null;
}

// Politicians + their latest report, in a SINGLE db read. The home page calls
// this for thousands of reps; doing latestReport() per politician would re-parse
// the whole db file once per row (N+1) and hang the request.
export function listPoliticiansWithLatest() {
  const db = load();
  const latestByPol = {};
  for (const r of db.reports) {
    const cur = latestByPol[r.politician_id];
    if (!cur || r.generated_at > cur.generated_at) latestByPol[r.politician_id] = r;
  }
  return db.politicians.map((p) => {
    const r = latestByPol[p.id];
    return {
      ...p,
      latest: r ? { grade: r.overall_grade, score: r.overall_score, headline: r.headline, report_tier: r.report_tier, generated_at: r.generated_at } : null,
    };
  });
}

export function upsertPolitician(p) {
  const db = load();
  const existing = db.politicians.findIndex((x) => x.id === p.id);
  if (existing >= 0) db.politicians[existing] = { ...db.politicians[existing], ...p };
  else db.politicians.push({ id: id(), created_at: new Date().toISOString(), ...p });
  save(db);
  return existing >= 0 ? db.politicians[existing] : db.politicians.at(-1);
}

// Bulk insert: ONE file read + ONE file write for the entire batch.
// Deduplicates on (name, constituency). Returns the newly added rows only.
export function batchUpsertPoliticians(politicians) {
  const db = load();
  const existingKeys = new Set(
    db.politicians.map((p) => `${p.name.toLowerCase()}|${(p.constituency ?? "").toLowerCase()}`)
  );
  const added = [];
  for (const p of politicians) {
    const key = `${(p.name ?? "").toLowerCase()}|${(p.constituency ?? "").toLowerCase()}`;
    if (existingKeys.has(key)) continue;
    const row = { id: id(), created_at: new Date().toISOString(), ...p };
    db.politicians.push(row);
    existingKeys.add(key);
    added.push(row);
  }
  if (added.length) save(db);
  return added;
}

// ---- Evidence ----
export function listEvidence(pid) {
  return load()
    .evidence.filter((e) => e.politician_id === pid)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

export function addEvidence(items) {
  const db = load();
  const added = [];
  for (const item of items) {
    // Dedupe on (politician, url)
    if (item.url) {
      const idx = db.evidence.findIndex((e) => e.politician_id === item.politician_id && e.url === item.url);
      if (idx >= 0) {
        // Upgrade in place: a content-bearing item supersedes an earlier
        // pointer with the same URL (e.g. full affidavit > affidavit link).
        if (item.content && !db.evidence[idx].content) {
          db.evidence[idx] = { ...db.evidence[idx], ...item };
          added.push(db.evidence[idx]);
        }
        continue;
      }
    }
    const row = { id: id(), fetched_at: new Date().toISOString(), ...item };
    db.evidence.push(row);
    added.push(row);
  }
  save(db);
  return added;
}

// ---- Reports ----
// Latest report for a politician. Pass `tier` (1 or 2) to get the latest of
// that specific tier — used both for the report-page tier toggle and so an
// incremental run updates from the prior report of the SAME tier.
export function latestReport(pid, tier = null) {
  return (
    load()
      .reports.filter((r) => r.politician_id === pid && (tier == null || r.report_tier === tier))
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0] ?? null
  );
}

// The latest report of EACH tier the politician has, e.g. { 1: {...}, 2: {...} }.
export function latestReportsByTier(pid) {
  const out = {};
  for (const r of load().reports.filter((r) => r.politician_id === pid)) {
    const t = r.report_tier ?? 2;
    if (!out[t] || r.generated_at > out[t].generated_at) out[t] = r;
  }
  return out;
}

export function reportHistory(pid) {
  return load()
    .reports.filter((r) => r.politician_id === pid)
    .sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

export function addReport(report) {
  const db = load();
  const row = { id: id(), generated_at: new Date().toISOString(), ...report };
  db.reports.push(row);
  save(db);
  return row;
}

// ---- Anonymous tips ----
// Privacy invariant: tips NEVER store IP, user agent, cookies, or precise
// timestamps. Only the ISO week is kept, so a tip can't be correlated with
// server access logs to deanonymize the sender.
export function addTip({ politician_id, category, text }) {
  const db = load();
  const now = new Date();
  const week = `${now.getUTCFullYear()}-W${String(Math.ceil(((now - new Date(Date.UTC(now.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7)).padStart(2, "0")}`;
  const row = {
    id: id(),
    politician_id,
    category,
    text,
    week,
    status: "pending", // pending -> approved | rejected ; never auto-published
    corroborated: false,
  };
  db.tips.push(row);
  save(db);
  return row;
}

export function listTips({ politician_id, status } = {}) {
  return load().tips.filter(
    (t) =>
      (politician_id ? t.politician_id === politician_id : true) &&
      (status ? t.status === status : true)
  );
}

export function reviewTip(tipId, { status, corroborated }) {
  const db = load();
  const tip = db.tips.find((t) => t.id === tipId);
  if (!tip) return null;
  if (status) tip.status = status;
  if (typeof corroborated === "boolean") tip.corroborated = corroborated;
  save(db);
  return tip;
}

// ---- Scandals / policy-failure accountability records ----
// A scandal is a documented governance failure (scam, accident, policy failure)
// keyed to the minister/ministry responsible, with the analysis layer attached
// (action taken, Indian precedents, international precedents). `slug` is a stable
// human id so seeds can be re-run idempotently.
// Published scandals only (excludes auto-discovered proposals awaiting review).
export function listScandals() {
  return load().scandals
    .filter((s) => s.status !== "proposed")
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

// Auto-discovered scandal seeds awaiting human review (neutrality gate).
export function listProposals() {
  return load().scandals
    .filter((s) => s.status === "proposed")
    .sort((a, b) => String(b.discovered_at ?? "").localeCompare(String(a.discovered_at ?? "")));
}

export function deleteScandal(slug) {
  const db = load();
  const before = db.scandals.length;
  db.scandals = db.scandals.filter((s) => s.slug !== slug);
  if (db.scandals.length !== before) save(db);
  return before - db.scandals.length;
}

export function getScandal(idOrSlug) {
  const db = load();
  return db.scandals.find((s) => s.id === idOrSlug || s.slug === idOrSlug) ?? null;
}

export function upsertScandal(s) {
  const db = load();
  const idx = db.scandals.findIndex((x) => x.slug && x.slug === s.slug);
  if (idx >= 0) { db.scandals[idx] = { ...db.scandals[idx], ...s, updated_at: new Date().toISOString() }; save(db); return db.scandals[idx]; }
  const row = { id: id(), created_at: new Date().toISOString(), ...s };
  db.scandals.push(row);
  save(db);
  return row;
}

// ---- Global meta (cursors like last_discovery_at) ----
export function getMeta(key, fallback = null) {
  const v = load().meta?.[key];
  return v === undefined ? fallback : v;
}

export function setMeta(key, value) {
  const db = load();
  db.meta = db.meta && typeof db.meta === "object" ? db.meta : {};
  db.meta[key] = value;
  save(db);
  return value;
}

// ---- Maintenance / reset helpers ----
// Wipe every generated report (the user regenerates from scratch). Evidence and
// politicians are untouched. Returns how many reports were removed.
export function deleteAllReports() {
  const db = load();
  const n = db.reports.length;
  db.reports = [];
  save(db);
  return n;
}

// Remove the fictional demo/seed politicians and everything attached to them
// (their reports + evidence). Returns counts removed.
export function removeDemoPoliticians() {
  const db = load();
  const demoIds = new Set(db.politicians.filter((p) => p.is_demo).map((p) => p.id));
  if (!demoIds.size) return { politicians: 0, reports: 0, evidence: 0 };
  const before = { politicians: db.politicians.length, reports: db.reports.length, evidence: db.evidence.length };
  db.politicians = db.politicians.filter((p) => !demoIds.has(p.id));
  db.reports = db.reports.filter((r) => !demoIds.has(r.politician_id));
  db.evidence = db.evidence.filter((e) => !demoIds.has(e.politician_id));
  save(db);
  return {
    politicians: before.politicians - db.politicians.length,
    reports: before.reports - db.reports.length,
    evidence: before.evidence - db.evidence.length,
  };
}
