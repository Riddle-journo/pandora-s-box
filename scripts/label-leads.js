// Lead LABELING CLI — the human half of the investigation-quality eval loop.
// (scripts/eval-investigator.js is the scoring half; it imports the label store
// and the DB readers from here, so the two never drift apart.)
//
// WHY: the repo tests CODE, not INVESTIGATION QUALITY. Without a labelled set,
// every prompt tweak / model swap / threshold change is an unmeasured bet. This
// tool produces that set: one line of JSON per human judgement in
// eval/labels.jsonl, keyed by lead id.
//
// HARD CONSTRAINTS
//   - The live DB is opened READ-ONLY. This tool never writes a row to SQLite;
//     the only file it mutates is eval/labels.jsonl.
//   - labels.jsonl is APPEND-ONLY and flushed after every single decision, so a
//     Ctrl-C (or a crash) never loses work and a re-run resumes where it stopped.
//   - Seeding maps only HUMAN decisions from lead_feedback. The GLM's own
//     glm_proposed/glm_dismissed rows are the PREDICTION, never the label —
//     seeding them would make the eval circular and it would score 100%.
//
// USAGE
//   node scripts/label-leads.js --seed                 import human lead_feedback as labels
//   node scripts/label-leads.js --dry-run --limit 20   preview the sample, prompt nothing
//   node scripts/label-leads.js --limit 20             label 20 leads interactively
//   node scripts/label-leads.js --detector conflict    stratify by detector
//   node scripts/label-leads.js --verdict SUGGESTIVE   stratify by stored verdict
//                                --verdict none        leads with no verdict yet
//   flags: --labels <path> --random [--seed-n <int>] --width <cols>
//
// dotenv is loaded FIRST, like every other script in this directory: without it
// AI_API_KEY / PANDOROS_DB_PATH from .env are invisible, so --live would refuse
// to run ("needs AI_API_KEY in your .env") while the .env sat there unread, and a
// PANDOROS_DB_PATH set in .env would be ignored — silently scoring the LIVE DB
// while the run file claimed otherwise. dotenv never overrides an already-set
// variable, so an inline `PANDOROS_DB_PATH=... node ...` still wins.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, "..");
export const EVAL_DIR = path.join(REPO_ROOT, "eval");
export const DEFAULT_LABELS_PATH = path.join(EVAL_DIR, "labels.jsonl");

export const LABEL_VALUES = ["true_positive", "false_positive", "undecidable"];
export const SEED_LABELER = "seed:lead_feedback";
export const VERDICT_TIERS = ["SUBSTANTIATED", "SUGGESTIVE", "COINCIDENCE"];

// ---- args (same shape as server/synthesis/investigate.js so the CLIs feel alike) ----
export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return flags;
}

/**
 * Numeric flag value, or the default when the flag is absent.
 *
 * A value-less flag (`--min-sample` with nothing after it) is stored as boolean
 * `true` by parseArgs, and `Number(true)` is 1 — so the old
 * `Number(flags["min-sample"]) || DEFAULT` silently turned the small-sample
 * honesty guard into a floor of ONE, which is the exact lie the harness exists to
 * prevent. `--limit` degraded the same way (one lead). A flag the operator typed
 * but did not fill in is a mistake, so say so instead of guessing.
 * @param {Record<string, any>} flags @param {string} key @param {number} dflt
 * @param {{ min?: number, integer?: boolean }} [opts]
 */
export function numFlag(flags, key, dflt, { min = 0, integer = true } = {}) {
  const raw = flags?.[key];
  if (raw === undefined) return dflt;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw usageError(`--${key} needs a number (e.g. --${key} ${dflt}); it was passed with no value.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min) {
    throw usageError(`--${key} must be ${integer ? "an integer" : "a number"} >= ${min}; got "${raw}".`);
  }
  return n;
}

/** A typo in a flag deserves one clear line, not a stack trace. */
export function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

/** Shared CLI exit path for both scripts. */
export function reportFatal(err) {
  console.error(err?.usage ? `error: ${err.message}` : String(err?.stack ?? err));
  process.exit(1);
}

// ---- DB access (READ-ONLY) ---------------------------------------------------
// Deliberately NOT server/store/store.js: importing that opens the live file
// read-write and runs import-time DDL/migrations. An eval tool must be incapable
// of changing the data it measures. PANDOROS_DB_PATH is honoured so the owner can
// point this at a copy or a test fixture.
/** The one real database. Exported so the --live guard can refuse to touch it. */
export const LIVE_DB_PATH = path.join(REPO_ROOT, "data", "pandoros.db");

export function dbPath(env = process.env) {
  return env.PANDOROS_DB_PATH || LIVE_DB_PATH;
}

/**
 * True when two paths name the same file. Compared as RESOLVED absolute paths —
 * `data/pandoros.db`, `./data/../data/pandoros.db` and the absolute form are all
 * the live DB — and case-insensitively on Windows, where they are.
 */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function openReadOnly(file = dbPath()) {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    // A hot WAL that needs recovery cannot be opened read-only. Say so instead of
    // failing with SQLITE_CANTOPEN and no explanation.
    throw new Error(
      `cannot open ${file} read-only: ${err.message}\n` +
      `If a writer is mid-transaction, stop the ops worker (or run against a copy: ` +
      `npm run db:backup, then set PANDOROS_DB_PATH).`);
  }
}

const J = (row) => { if (!row?.data) return null; try { return JSON.parse(row.data); } catch { return null; } };

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** Every lead, parsed. 3k rows of small blobs — cheaper than N+1 lookups. */
export function loadLeads(db) {
  return db.prepare("SELECT data FROM investigation_leads ORDER BY signal_score DESC").all().map(J).filter(Boolean);
}

export function loadLead(db, leadId) {
  return J(db.prepare("SELECT data FROM investigation_leads WHERE id = ? OR key = ? LIMIT 1").get(leadId, leadId));
}

/** Human + GLM decisions already recorded for a lead (newest first). */
export function loadFeedback(db, lead) {
  if (!tableExists(db, "lead_feedback")) return [];
  return db.prepare(
    "SELECT lead_id, lead_key, vector, detector, decision, source, at FROM lead_feedback WHERE lead_id = ? OR lead_key = ? ORDER BY at DESC"
  ).all(lead?.id ?? null, lead?.key ?? null);
}

export function loadAllFeedback(db) {
  if (!tableExists(db, "lead_feedback")) return [];
  return db.prepare(
    "SELECT lead_id, lead_key, vector, detector, decision, source, signal_score, at, data FROM lead_feedback ORDER BY at ASC"
  ).all();
}

/** The evidence rows a lead actually cites, so a labeller can check citability. */
export function loadLeadEvidence(db, lead, cap = 6) {
  const urls = [...new Set([
    ...(lead?.evidence_urls ?? []),
    ...((lead?.data?.evidence ?? []).map((e) => e?.url)),
    ...((lead?.data?.flags ?? []).flatMap((f) => (f?.evidence ?? []).map((e) => e?.url))),
  ].filter(Boolean))].slice(0, cap);
  if (!urls.length) return [];
  const qs = urls.map(() => "?").join(",");
  const rows = lead?.actor_id
    ? db.prepare(`SELECT data FROM evidence WHERE politician_id = ? AND url IN (${qs})`).all(lead.actor_id, ...urls)
    : db.prepare(`SELECT data FROM evidence WHERE url IN (${qs}) LIMIT ${cap}`).all(...urls);
  return rows.map(J).filter(Boolean);
}

// ---- lead → detector attribution -------------------------------------------
// Mirrors store/content.js recordLeadFeedback: a cluster lead lists its
// contributing detectors, a promoted big flag carries its flag key (detector is
// the prefix), otherwise fall back to the vector. Kept in sync deliberately —
// per-detector precision must bucket leads the same way the feedback ledger does.
export function detectorsForLead(lead) {
  const out = new Set();
  const d = lead?.data ?? {};
  if (Array.isArray(d.flags)) for (const f of d.flags) if (f?.detector) out.add(String(f.detector));
  if (d.engine_flag_key) out.add(String(d.engine_flag_key).split("|")[0]);
  if (!out.size && lead?.vector) out.add(String(lead.vector).toLowerCase());
  return [...out];
}

/** The persisted investigation state, whichever level it was written at. */
export function investigationOf(lead) {
  return lead?.investigation ?? lead?.data?.investigation ?? null;
}

// Models are told "confidence":0 without a stated scale, so both 0.82 and 82
// occur in the wild. Normalise to 0..1; anything unparseable is "no confidence"
// rather than a silent 0, which would poison the calibration table.
export function normalizeConfidence(raw) {
  // Number(null) and Number("") are both 0, which would read as "certain it is
  // innocent" once flipped for a COINCIDENCE verdict. Only real numbers count.
  const n = confidenceNumber(raw);
  if (n == null) return null;
  const p = n > 1 ? n / 100 : n;
  return p > 1 ? null : p;
}

function confidenceNumber(raw) {
  const n = typeof raw === "number" ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** Top of the range where a percent reading is indistinguishable from a 1–10 scale. */
export const AMBIGUOUS_CONFIDENCE_MAX = 10;

/**
 * True when the raw confidence could be either scale and we GUESSED percent.
 * The prompt states no scale, so a model answering `7` on an implicit 1–10 scale
 * is read as 0.07 — "almost certainly innocent" — which would report catastrophic
 * under-confidence on a model that was in fact confident. The value is still
 * normalised (the heuristic is right for 82, the case that occurs today), but the
 * guess is COUNTED so the operator sees it instead of trusting the calibration row.
 */
export function isAmbiguousConfidenceScale(raw) {
  const n = confidenceNumber(raw);
  return n != null && n > 1 && n <= AMBIGUOUS_CONFIDENCE_MAX;
}

// ---- labels.jsonl -----------------------------------------------------------
export function parseLabelsJsonl(text) {
  const labels = [], malformed = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { malformed.push({ line: i + 1, text: line.slice(0, 120), why: "not JSON" }); continue; }
    if (!rec || typeof rec.lead_id !== "string" || !rec.lead_id) { malformed.push({ line: i + 1, text: line.slice(0, 120), why: "missing lead_id" }); continue; }
    if (!LABEL_VALUES.includes(rec.label)) { malformed.push({ line: i + 1, text: line.slice(0, 120), why: `unknown label "${rec.label}"` }); continue; }
    // A hand-edited `"detectors": "conflict"` is a STRING, and a string has
    // .length and iterates by character — scoreDetectors would invent seven
    // detectors named c, f, i, l, n, o, t. Hand-editing is invited by the rubric,
    // so this must land in the reported malformed list, not in the label set.
    if (rec.detectors !== undefined && rec.detectors !== null && !Array.isArray(rec.detectors)) {
      malformed.push({ line: i + 1, text: line.slice(0, 120), why: "detectors is not an array" });
      continue;
    }
    rec.detectors = Array.isArray(rec.detectors) ? rec.detectors.map(String) : [];
    labels.push(rec);
  }
  return { labels, malformed };
}

/**
 * Append-only file, so a lead can appear more than once (a relabel). LAST line
 * wins — the newest judgement is the operative one, and the earlier ones stay on
 * disk as an audit trail of the rubric changing under the labeller.
 * @returns {{ byLeadId: Map<string, any>, all: any[], malformed: any[] }}
 */
export function readLabels(file = DEFAULT_LABELS_PATH) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); }
  catch (err) {
    if (err.code !== "ENOENT") throw err;
    return { byLeadId: new Map(), all: [], malformed: [] };
  }
  const { labels, malformed } = parseLabelsJsonl(text);
  const byLeadId = new Map();
  for (const rec of labels) byLeadId.set(rec.lead_id, rec);
  return { byLeadId, all: labels, malformed };
}

export function makeLabel({ lead_id, label, note = "", labeler, lead_key = null, vector = null, detectors = [], at = null }) {
  if (!lead_id) throw new Error("makeLabel: lead_id is required");
  if (!LABEL_VALUES.includes(label)) throw new Error(`makeLabel: unknown label "${label}"`);
  return {
    lead_id, label, note: String(note ?? ""),
    labeled_at: at ?? new Date().toISOString(),
    labeler: labeler || process.env.EVAL_LABELER || "human",
    lead_key, vector, detectors,
  };
}

export function appendLabels(file, records) {
  if (!records.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return records.length;
}

// ---- seeding from the human-decision ledger ---------------------------------
// Vocabulary verified in server/routes/util.js (approved | rejected) and
// server/routes/admin-ops.js (dismissed); server/synthesis/investigator.js writes
// glm_proposed | glm_dismissed with source 'glm'.
//   approved  → true_positive   (a human published it: real, right person, citable)
//   rejected  → false_positive  (a human rejected a PROPOSED lead outright)
//   dismissed → false_positive  (a human parked a detected lead as not worth it —
//                                a WEAKER signal than 'rejected'; noted per row)
//   glm_*     → not a label at all (that is the model's own verdict)
export function mapFeedbackDecision(decision, source) {
  if (String(source ?? "").toLowerCase() === "glm") return null;
  switch (String(decision ?? "")) {
    case "approved": return "true_positive";
    case "rejected": return "false_positive";
    case "dismissed": return "false_positive";
    default: return null; // glm_proposed / glm_dismissed / anything new
  }
}

const DECISION_RANK = { approved: 3, rejected: 3, dismissed: 1 };

const SEED_NOTE = {
  approved: "seeded from lead_feedback: a human APPROVED and published this lead.",
  rejected: "seeded from lead_feedback: a human REJECTED this proposed lead.",
  dismissed: "seeded from lead_feedback: a human DISMISSED this detected lead without pursuing it. Weaker signal than an outright reject — a dismiss can also mean 'not now'. Re-label by hand if it matters.",
};

/**
 * Collapse the feedback ledger (one row per lead PER DETECTOR) to one seed label
 * per lead. Explicit approve/reject outranks a dismiss; among equals the newest
 * decision wins, because that is the operator's latest view.
 * @param {Array<{lead_id?:string, lead_key?:string, vector?:string, detector?:string, decision?:string, source?:string, at?:string}>} rows
 */
export function seedRowsFromFeedback(rows) {
  const byLead = new Map();
  for (const r of rows ?? []) {
    const label = mapFeedbackDecision(r.decision, r.source);
    if (!label) continue;
    const key = r.lead_id || r.lead_key;
    if (!key) continue;
    const cur = byLead.get(key);
    const rank = DECISION_RANK[r.decision] ?? 0;
    const at = String(r.at ?? "");
    if (cur && !(rank > cur.rank || (rank === cur.rank && at >= cur.at))) {
      if (r.detector) cur.detectors.add(r.detector);
      continue;
    }
    byLead.set(key, {
      rank, at, label, decision: r.decision,
      lead_id: key, lead_key: r.lead_key ?? null, vector: r.vector ?? null,
      detectors: new Set([...(cur?.detectors ?? []), ...(r.detector ? [r.detector] : [])]),
    });
  }
  return [...byLead.values()].map((s) => makeLabel({
    lead_id: s.lead_id, lead_key: s.lead_key, vector: s.vector,
    detectors: [...s.detectors], label: s.label, labeler: SEED_LABELER,
    at: s.at || new Date().toISOString(),
    note: SEED_NOTE[s.decision] ?? `seeded from lead_feedback decision "${s.decision}".`,
  }));
}

/**
 * Every identifier a label claims, so the resume is complete. filterUnlabeled
 * matches on lead id OR lead key; a set built from label ids alone (the old
 * `new Set(byLeadId.keys())`) therefore never exercised the key path, and a lead
 * that was purged and re-detected under a new id was presented for labelling
 * again — producing two independent labels for one underlying lead.
 * @param {Iterable<{lead_id?:string, lead_key?:string}>} records
 */
export function labeledIdentifiers(records) {
  const out = new Set();
  for (const rec of records ?? []) {
    if (rec?.lead_id) out.add(rec.lead_id);
    if (rec?.lead_key) out.add(rec.lead_key);
  }
  return out;
}

/** Seed labels not already present in labels.jsonl. Returns what it wrote. */
export function seedLabels({ db, file = DEFAULT_LABELS_PATH } = {}) {
  const rows = loadAllFeedback(db);
  const candidates = seedRowsFromFeedback(rows);
  const { byLeadId } = readLabels(file);
  // Deduped on BOTH identifiers: a re-detected lead has a new id but the same key,
  // and seeding it again would double-count one human decision.
  const known = labeledIdentifiers(byLeadId.values());
  const fresh = candidates.filter((c) => !known.has(c.lead_id) && !(c.lead_key && known.has(c.lead_key)));
  appendLabels(file, fresh);
  return { feedbackRows: rows.length, candidates: candidates.length, written: fresh.length, skipped: candidates.length - fresh.length, records: fresh };
}

// ---- sampling ---------------------------------------------------------------
export function filterUnlabeled(leads, labeledIds) {
  return leads.filter((l) => !labeledIds.has(l.id) && !labeledIds.has(l.key));
}

// Deterministic PRNG so `--random --seed-n 7` gives the same sample twice; a
// reproducible sample is the difference between a measurement and an anecdote.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(items, seed = 1) {
  const out = items.slice();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Stratified sample of leads still needing a label.
 * @param {{ leads: any[], labeledIds: Set<string>, detector?: string, verdict?: string,
 *           limit?: number, random?: boolean, seed?: number }} opts
 */
export function selectSample({ leads, labeledIds, detector, verdict, limit = 20, random = false, seed = 1 }) {
  let pool = filterUnlabeled(leads, labeledIds);
  if (detector) {
    const want = String(detector).toLowerCase();
    pool = pool.filter((l) =>
      detectorsForLead(l).some((d) => d.toLowerCase() === want) || String(l.vector ?? "").toLowerCase() === want);
  }
  if (verdict) {
    const want = String(verdict).toUpperCase();
    pool = pool.filter((l) => {
      const v = String(investigationOf(l)?.verdict ?? "").toUpperCase();
      return want === "NONE" ? !v : v === want;
    });
  }
  if (random) pool = shuffled(pool, seed);
  return pool.slice(0, Math.max(0, limit));
}

/** Counts that show the owner which strata are thin. */
export function strataCounts(leads, labeledIds) {
  const byVerdict = {}, byDetector = {}, labelled = { total: 0 };
  for (const l of leads) {
    const done = labeledIds.has(l.id) || labeledIds.has(l.key);
    if (done) labelled.total++;
    const v = String(investigationOf(l)?.verdict ?? "NONE").toUpperCase();
    const vb = (byVerdict[v] ??= { verdict: v, total: 0, labelled: 0 });
    vb.total++; if (done) vb.labelled++;
    for (const d of detectorsForLead(l)) {
      const db_ = (byDetector[d] ??= { detector: d, total: 0, labelled: 0 });
      db_.total++; if (done) db_.labelled++;
    }
  }
  return {
    leads: leads.length,
    labelled: labelled.total,
    byVerdict: Object.values(byVerdict).sort((a, b) => b.total - a.total),
    byDetector: Object.values(byDetector).sort((a, b) => b.total - a.total),
  };
}

// ---- terminal presentation --------------------------------------------------
// Hard-bounded by `width`, including the indent: a lead's evidence body routinely
// contains a URL longer than the line budget, and the old Math.max(20, ...) floor
// plus the unbreakable-token path let single lines run to ~150 columns on an 88
// column terminal, wrecking the review screen this function exists to lay out.
export function wrapText(text, width = 88, indent = "") {
  const src = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!src) return "";
  const room = Math.max(1, width - indent.length);
  const out = [];
  let line = "";
  const flush = () => { if (line) { out.push(indent + line); line = ""; } };
  for (let word of src.split(" ")) {
    // A token that cannot fit on a line of its own is hard-broken rather than
    // allowed to overflow (a 200-char URL is still readable in slices).
    while (word.length > room) {
      flush();
      out.push(indent + word.slice(0, room));
      word = word.slice(room);
    }
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= room) line += " " + word;
    else { flush(); line = word; }
  }
  flush();
  return out.join("\n");
}

const rule = (w, ch = "-") => ch.repeat(Math.max(10, w));

/** Everything a labeller needs to judge ONE lead, in one screen of text. */
export function formatLeadForReview(ctx, { width = 88, index = 1, total = 1 } = {}) {
  const { lead, evidence = [], feedback = [] } = ctx;
  const inv = investigationOf(lead);
  const L = [];
  L.push(rule(width, "="));
  L.push(`LEAD ${index}/${total}  ${lead.vector ?? "?"}  score ${Math.round(Number(lead.signal_score) || 0)}  [${lead.severity ?? "?"}]`);
  L.push(`id ${lead.id}`);
  L.push(`key ${String(lead.key ?? "").slice(0, width - 4)}`);
  L.push(`subject: ${lead.actor_name ?? "(no named person — entity/hub lead)"}${lead.actor_id ? ` (${lead.actor_id})` : ""}`);
  L.push(`detectors: ${detectorsForLead(lead).join(", ") || "(none)"}`);
  L.push(rule(width));
  L.push("HEADLINE");
  L.push(wrapText(lead.headline, width, "  "));
  if (lead.detail) { L.push("DETAIL"); L.push(wrapText(lead.detail, width, "  ")); }
  if (lead.instrument || lead.beneficiary) {
    L.push(`INSTRUMENT: ${lead.instrument ?? "-"}`);
    L.push(`BENEFICIARY: ${lead.beneficiary ?? "-"}${lead.beneficiary_kind ? ` [${lead.beneficiary_kind}]` : ""}`);
  }

  const flags = lead.data?.flags ?? [];
  if (flags.length) {
    L.push(rule(width));
    L.push(`CLUSTER — ${flags.length} contributing flag(s)`);
    for (const f of flags.slice(0, 8)) L.push(wrapText(`[${f.severity} · ${f.detector} · ${Math.round(Number(f.score) || 0)}] ${f.headline}`, width, "  "));
  }

  L.push(rule(width));
  if (evidence.length) {
    L.push(`CITED EVIDENCE — ${evidence.length} row(s) found for the lead's URLs`);
    for (const e of evidence) {
      L.push(`  [${e.source_type ?? "?"}] ${String(e.title ?? "").slice(0, width - 8)}`);
      L.push(`    ${e.url ?? ""}`);
      const body = String(e.content ?? e.summary ?? "");
      if (body) L.push(wrapText(body.slice(0, 500), width, "    "));
    }
  } else {
    L.push("CITED EVIDENCE — none of the lead's URLs resolved to a stored evidence row.");
    L.push("  (A claim with no readable source is at best undecidable — see eval/README.md.)");
  }

  L.push(rule(width));
  if (inv?.verdict) {
    const conf = normalizeConfidence(inv.confidence);
    L.push(`INVESTIGATOR VERDICT: ${inv.verdict}  confidence ${conf == null ? "n/a" : conf.toFixed(2)}  model ${inv.model ?? "?"}  at ${inv.investigated_at ?? "?"}`);
    if (inv.summary) L.push(wrapText(`summary: ${inv.summary}`, width, "  "));
    if (inv.mechanism) L.push(wrapText(`mechanism: ${inv.mechanism}`, width, "  "));
    for (const x of (inv.evidence_for ?? []).slice(0, 6)) L.push(wrapText(`FOR:     ${x}`, width, "  "));
    for (const x of (inv.evidence_against ?? []).slice(0, 6)) L.push(wrapText(`AGAINST: ${x}`, width, "  "));
    if (inv.timeline) L.push(wrapText(`timeline: ${inv.timeline}`, width, "  "));
    if (inv.confirming_record) L.push(wrapText(`would settle it: ${inv.confirming_record}`, width, "  "));
    if (inv.referee) L.push(wrapText(`REFEREE (defence): fully_explainable=${inv.referee.fully_explainable} — ${inv.referee.innocent_explanation ?? ""}`, width, "  "));
    if (Array.isArray(inv.steps) && inv.steps.length) L.push(`  tool steps: ${inv.steps.length}`);
  } else {
    L.push("INVESTIGATOR VERDICT: (none — this lead has not been through L2/L3)");
  }

  if (feedback.length) {
    L.push(rule(width));
    L.push("PRIOR DECISIONS ON THIS LEAD");
    for (const f of feedback.slice(0, 6)) L.push(`  ${f.at} ${f.decision} (source ${f.source}, detector ${f.detector})`);
    L.push("  Your label is INDEPENDENT of these. Disagree if the record says so.");
  }
  L.push(rule(width, "="));
  return L.join("\n");
}

/**
 * Two-line entry used by --dry-run: a fixed-width metadata row, then the headline
 * indented under it. One line cannot hold both a full lead id and a readable
 * headline at 88 columns, and a truncated headline is useless for sampling.
 */
export function formatLeadLine(lead, width = 88) {
  const inv = investigationOf(lead);
  const conf = normalizeConfidence(inv?.confidence);
  const head = [
    String(lead.id ?? "").slice(0, 8),
    String(lead.vector ?? "-").padEnd(24).slice(0, 24),
    String(inv?.verdict ?? "-").padEnd(13).slice(0, 13),
    (conf == null ? "    -" : conf.toFixed(2).padStart(5)),
    String(Math.round(Number(lead.signal_score) || 0)).padStart(5),
    String(lead.actor_name ?? "-").slice(0, 22),
  ].join(" ");
  return `${head}\n    ${String(lead.headline ?? "").slice(0, Math.max(20, width - 4))}`;
}

// ---- interactive loop -------------------------------------------------------
// Object.create(null): with a plain object literal, typing `constructor` or
// `toString` at the prompt resolves to an INHERITED function, which is truthy —
// makeLabel then threw on a non-label and the whole labelling session died on a
// typo. A prototype-less map has no inherited keys, so an unknown key is just
// unknown. (The Object.hasOwn check below is the belt to this braces.)
export const KEYS = Object.assign(Object.create(null), {
  t: "true_positive", f: "false_positive", u: "undecidable",
});

/** The label a keypress means, or null. Never returns an inherited property. */
export function keyToLabel(ans) {
  const k = String(ans ?? "").trim().toLowerCase();
  return Object.hasOwn(KEYS, k) && LABEL_VALUES.includes(KEYS[k]) ? KEYS[k] : null;
}

async function labelInteractively(db, sample, { file, width, labeler }) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let written = 0, skipped = 0;
  try {
    for (let i = 0; i < sample.length; i++) {
      const lead = sample[i];
      const ctx = { lead, evidence: loadLeadEvidence(db, lead), feedback: loadFeedback(db, lead) };
      console.log("\n" + formatLeadForReview(ctx, { width, index: i + 1, total: sample.length }));
      let choice = "";
      while (!choice) {
        const ans = (await rl.question("[t]rue positive / [f]alse positive / [u]ndecidable / [s]kip / [q]uit > ")).trim().toLowerCase();
        if (ans === "q") { console.log(`\nstopped. ${written} label(s) written to ${file}, ${skipped} skipped.`); return { written, skipped }; }
        if (ans === "s") { skipped++; choice = "skip"; break; }
        const label = keyToLabel(ans);
        if (label) choice = label;
        else console.log("  unrecognised — press t, f, u, s or q.");
      }
      if (choice === "skip") continue;
      const note = (await rl.question("note (why — one line, optional) > ")).trim();
      // Flush per decision: the file IS the progress bar, so a crash costs at
      // most the lead currently on screen.
      appendLabels(file, [makeLabel({
        lead_id: lead.id, lead_key: lead.key, vector: lead.vector,
        detectors: detectorsForLead(lead), label: choice, note, labeler,
      })]);
      written++;
      console.log(`  → ${choice} (${written} written)`);
    }
  } finally {
    rl.close();
  }
  console.log(`\ndone. ${written} label(s) written to ${file}, ${skipped} skipped.`);
  return { written, skipped };
}

// ---- main -------------------------------------------------------------------
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const file = typeof flags.labels === "string" ? path.resolve(flags.labels) : DEFAULT_LABELS_PATH;
  const width = numFlag(flags, "width", 88, { min: 20 });
  const limit = numFlag(flags, "limit", 20);
  const seedN = numFlag(flags, "seed-n", 1);
  const db = openReadOnly();
  try {
    if (flags.seed) {
      const r = seedLabels({ db, file });
      console.log(`[label] lead_feedback rows: ${r.feedbackRows}; human-decision seeds: ${r.candidates}; written: ${r.written}; already present: ${r.skipped}`);
      for (const rec of r.records) console.log(`  + ${rec.lead_id} ${rec.label} (${rec.vector ?? "?"})`);
      if (!flags["dry-run"] && !flags.limit && !flags.detector && !flags.verdict) return r;
    }

    const leads = loadLeads(db);
    const { byLeadId, malformed } = readLabels(file);
    if (malformed.length) {
      // A bad line is a data-quality failure, not something to swallow silently.
      console.warn(`[label] WARNING: ${malformed.length} unusable line(s) in ${file}:`);
      for (const m of malformed.slice(0, 5)) console.warn(`  line ${m.line}: ${m.why} — ${m.text}`);
    }
    const labeledIds = labeledIdentifiers(byLeadId.values());
    const sample = selectSample({
      leads, labeledIds,
      detector: typeof flags.detector === "string" ? flags.detector : null,
      verdict: typeof flags.verdict === "string" ? flags.verdict : null,
      limit, random: !!flags.random, seed: seedN,
    });
    const strata = strataCounts(leads, labeledIds);

    console.log(`[label] db ${dbPath()}`);
    console.log(`[label] leads ${strata.leads}; already labelled ${strata.labelled}; sample ${sample.length}`);
    console.log(`[label] by stored verdict: ${strata.byVerdict.map((v) => `${v.verdict}=${v.total}(${v.labelled} labelled)`).join("  ")}`);
    console.log(`[label] detector volume, top 10 (total/labelled): ${strata.byDetector.slice(0, 10).map((d) => `${d.detector}=${d.total}/${d.labelled}`).join("  ")}`);

    if (flags["dry-run"]) {
      console.log(`\nid       vector                   verdict        conf score subject`);
      for (const l of sample) console.log(formatLeadLine(l, width));
      console.log(`\n[label] --dry-run: nothing written. Drop --dry-run to label these ${sample.length} lead(s).`);
      return { sample: sample.length, strata };
    }
    if (!sample.length) {
      console.log("[label] nothing left to label with these filters.");
      return { sample: 0, strata };
    }
    if (!process.stdin.isTTY) {
      // Blocking on a pipe that will never answer looks like a hang. Fail loudly.
      throw new Error("stdin is not a TTY — interactive labelling needs a terminal. Use --dry-run to preview, or run this in a real shell.");
    }
    return await labelInteractively(db, sample, { file, width, labeler: typeof flags.labeler === "string" ? flags.labeler : undefined });
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(reportFatal);
}
