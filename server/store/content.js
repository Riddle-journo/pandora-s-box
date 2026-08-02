// Content domain extracted from store.js: scandals / policy-failure records,
// investigation leads (+ the lead-feedback precision ledger), stories, and
// anonymous tips. Re-exported through the store.js facade. `insScandal` is
// exported so store.js's migrateFromJson (which stays there) can reuse it.
// store/* modules never import store.js — only ./db.js and ./shared.js.
import { db } from "./db.js";
import { id, J } from "./shared.js";

// ---- Anonymous tips ----
// Privacy invariant unchanged: tips store only the ISO week, never IP/UA/time.
export function addTip({ politician_id, category, text }) {
  const now = new Date();
  const week = `${now.getUTCFullYear()}-W${String(Math.ceil(((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7)).padStart(2, "0")}`;
  const row = { id: id(), politician_id, category, text, week, status: "pending", corroborated: false };
  db.prepare("INSERT INTO tips (id, politician_id, status, data) VALUES (?, ?, ?, ?)").run(row.id, politician_id, "pending", JSON.stringify(row));
  return row;
}

/** @param {{ politician_id?: string, status?: string }} [filter] */
export function listTips({ politician_id, status } = {}) {
  let sql = "SELECT data FROM tips", where = [], args = [];
  if (politician_id) { where.push("politician_id = ?"); args.push(politician_id); }
  if (status)        { where.push("status = ?"); args.push(status); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  return db.prepare(sql).all(...args).map(J);
}

export function reviewTip(tipId, { status, corroborated }) {
  const tip = J(db.prepare("SELECT data FROM tips WHERE id = ?").get(tipId));
  if (!tip) return null;
  if (status) tip.status = status;
  if (typeof corroborated === "boolean") tip.corroborated = corroborated;
  db.prepare("UPDATE tips SET status = ?, data = ? WHERE id = ?").run(tip.status, JSON.stringify(tip), tipId);
  return tip;
}

// ---- Scandals / policy-failure accountability records ----
export const insScandal = db.prepare(`INSERT OR REPLACE INTO scandals
  (id, slug, status, date, discovered_at, data) VALUES (@id, @slug, @status, @date, @discovered_at, @data)`);

// Published scandals only (excludes auto-discovered proposals awaiting review).
export function listScandals() {
  return db.prepare("SELECT data FROM scandals WHERE status IS NULL OR status != 'proposed'").all().map(J)
    .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

export function listProposals() {
  return db.prepare("SELECT data FROM scandals WHERE status = 'proposed'").all().map(J)
    .sort((a, b) => String(b.discovered_at ?? "").localeCompare(String(a.discovered_at ?? "")));
}

export function deleteScandal(slug) {
  const r = db.prepare("DELETE FROM scandals WHERE slug = ?").run(slug);
  return r.changes;
}

export function getScandal(idOrSlug) {
  return J(db.prepare("SELECT data FROM scandals WHERE id = ? OR slug = ? LIMIT 1").get(idOrSlug, idOrSlug));
}

export function upsertScandal(s) {
  const existing = s.slug ? J(db.prepare("SELECT data FROM scandals WHERE slug = ?").get(s.slug)) : null;
  const row = existing
    ? { ...existing, ...s, updated_at: new Date().toISOString() }
    : { id: id(), created_at: new Date().toISOString(), ...s };
  if (!row.id) row.id = id();
  insScandal.run({ id: row.id, slug: row.slug ?? null, status: row.status ?? null, date: row.date ?? "", discovered_at: row.discovered_at ?? "", data: JSON.stringify(row) });
  return row;
}

// ---- Investigation leads (conflict-of-interest candidates; SEPARATE collection
// from scandals). A lead is a CANDIDATE, gated behind admin review — it is never
// public until status='published'. status flow: detected → investigated →
// proposed (survived the AI referee) → published | dismissed. ----
const insLead = db.prepare(`INSERT OR REPLACE INTO investigation_leads
  (id, key, status, vector, actor_id, signal_score, detected_at, data)
  VALUES (@id, @key, @status, @vector, @actor_id, @signal_score, @detected_at, @data)`);

// A REVIEWER'S DECISION IS TERMINAL. The merge below lets an incoming status win,
// and three re-detection paths pass status:'detected' EXPLICITLY
// (enrichment/director-link.js, synthesis/investigate.js detectFor, and the
// investigator's malformed-response reset). Without this guard the next scan would
// drag a human-rejected lead back into the queue — re-spending paid LLM calls to
// re-decide what a human already killed, and re-proposing it forever — and would
// silently UN-PUBLISH an approved lead. Detector candidates omit status entirely,
// so they were never the risk; explicit resetters are. A deliberate human reversal
// passes forceStatus:true (see decideLeadShared).
const TERMINAL_LEAD_STATUS = new Set(["published", "rejected"]);

// Dedupe on key = vector|actor_id|beneficiary. Re-detection refreshes the
// detector fields; a terminal human status survives it.
export function upsertLead(lead) {
  const key = lead.key ?? `${lead.vector}|${lead.actor_id}|${lead.beneficiary}`;
  const now = new Date().toISOString();
  const existing = J(db.prepare("SELECT data FROM investigation_leads WHERE key = ?").get(key));
  // forceStatus is a control flag for this call only — never persisted into the blob.
  const { forceStatus, ...incoming } = lead;
  const row = existing
    ? { ...existing, ...incoming, key, updated_at: now }
    : { ...incoming, id: id(), key, status: incoming.status ?? "detected", detected_at: now };
  if (existing && !forceStatus && TERMINAL_LEAD_STATUS.has(existing.status)) row.status = existing.status;
  if (!row.id) row.id = id();
  insLead.run({
    id: row.id, key: row.key, status: row.status ?? "detected", vector: row.vector ?? null,
    actor_id: row.actor_id ?? null, signal_score: Number(row.signal_score) || 0,
    detected_at: row.detected_at ?? now, data: JSON.stringify(row),
  });
  return row;
}

export function getLead(idOrKey) {
  return J(db.prepare("SELECT data FROM investigation_leads WHERE id = ? OR key = ? LIMIT 1").get(idOrKey, idOrKey));
}

// Rejected leads are SOFT-deleted (kept for the eval/label corpus), so the
// unfiltered listing hides them — that is exactly what callers already assume,
// because a rejection used to DELETE the row outright. This matters beyond
// cosmetics: publishing/story-generator.js and synthesis/synthesis.js both build
// output from listLeads({}), and a human-rejected lead resurfacing in a generated
// story would be a serious editorial failure. Pass includeRejected for the eval
// harness, or ask for { status: "rejected" } explicitly to read the corpus.
/** @param {{ status?: string, includeRejected?: boolean }} [filter] */
export function listLeads({ status, includeRejected = false } = {}) {
  const rows = status
    ? db.prepare("SELECT data FROM investigation_leads WHERE status = ? ORDER BY signal_score DESC").all(status)
    : includeRejected
      ? db.prepare("SELECT data FROM investigation_leads ORDER BY signal_score DESC").all()
      : db.prepare("SELECT data FROM investigation_leads WHERE coalesce(status,'') <> 'rejected' ORDER BY signal_score DESC").all();
  return rows.map(J);
}

// Leads that survived the AI Investigator + Referee and await human approval.
export function listLeadProposals() {
  return db.prepare("SELECT data FROM investigation_leads WHERE status = 'proposed' ORDER BY signal_score DESC").all().map(J);
}

export function deleteLead(idOrKey) {
  return db.prepare("DELETE FROM investigation_leads WHERE id = ? OR key = ?").run(idOrKey, idOrKey).changes;
}

// ---- Lead feedback ledger (the human-decision signal for precision reporting) ----
// `decision`: approved | rejected | dismissed | glm_proposed | glm_dismissed.
// `detector` is derived from the lead's data.engine_flag_key / data.flags when
// present so cluster leads attribute back to their contributing detectors.
// Table created HERE (not in the later flags/engine_settings db.exec block) —
// module top-level code runs in order, so the CREATE TABLE must precede this
// db.prepare() of an INSERT against it, or every import of this module throws
// "no such table: lead_feedback" before a single line of app code runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_feedback (
    id TEXT PRIMARY KEY, lead_key TEXT, lead_id TEXT, vector TEXT, detector TEXT,
    decision TEXT, source TEXT, signal_score REAL, at TEXT, data TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_vector ON lead_feedback(vector, decision);
  CREATE INDEX IF NOT EXISTS idx_feedback_detector ON lead_feedback(detector, decision);
`);
const insFeedback = db.prepare(`INSERT INTO lead_feedback
  (id, lead_key, lead_id, vector, detector, decision, source, signal_score, at, data)
  VALUES (@id, @lead_key, @lead_id, @vector, @detector, @decision, @source, @signal_score, @at, @data)`);

export function recordLeadFeedback(lead, decision, { source = "admin" } = {}) {
  if (!lead) return null;
  // Attribute to contributing detectors: a cluster lead lists them; a promoted big
  // flag carries its flag key (detector is the prefix); else fall back to the vector.
  const detectors = new Set();
  if (Array.isArray(lead.data?.flags)) for (const f of lead.data.flags) if (f.detector) detectors.add(f.detector);
  if (lead.data?.engine_flag_key) detectors.add(String(lead.data.engine_flag_key).split("|")[0]);
  if (!detectors.size && lead.vector) detectors.add(String(lead.vector).toLowerCase());
  const now = new Date().toISOString();
  for (const detector of detectors) {
    insFeedback.run({
      id: id(), lead_key: lead.key ?? null, lead_id: lead.id ?? null,
      vector: lead.vector ?? null, detector, decision, source,
      signal_score: Number(lead.signal_score) || 0, at: now,
      data: JSON.stringify({ headline: lead.headline, actor_name: lead.actor_name }),
    });
  }
  return { decision, detectors: [...detectors] };
}

// Per-detector precision: approvals vs rejections/dismissals, with a suggestion
// when the reject rate is high on a meaningful sample. Suggestion-only — the ops
// console shows it; nothing auto-changes a threshold.
export function detectorPrecision({ minSample = 5 } = {}) {
  const rows = db.prepare(`
    SELECT detector, decision, COUNT(*) n, AVG(signal_score) avg_score
    FROM lead_feedback GROUP BY detector, decision
  `).all();
  const byDetector = {};
  for (const r of rows) {
    const d = (byDetector[r.detector] ??= { detector: r.detector, approved: 0, rejected: 0, dismissed: 0, glm_proposed: 0, glm_dismissed: 0, avg_score: 0, total: 0 });
    d[r.decision] = (d[r.decision] ?? 0) + r.n;
    d.total += r.n;
  }
  const out = [];
  for (const d of Object.values(byDetector)) {
    const judged = d.approved + d.rejected + d.dismissed; // human-decided only
    const rejectRate = judged >= 1 ? (d.rejected + d.dismissed) / judged : null;
    let suggestion = null;
    if (judged >= minSample && rejectRate != null) {
      if (rejectRate >= 0.8) suggestion = `High reject rate (${Math.round(rejectRate * 100)}% of ${judged}) — consider RAISING this detector's thresholds (fewer, stronger flags).`;
      else if (rejectRate <= 0.2 && d.approved >= minSample) suggestion = `Low reject rate (${Math.round(rejectRate * 100)}% of ${judged}) — this detector is reliable; you could LOWER thresholds to surface more.`;
    }
    out.push({ ...d, judged, reject_rate: rejectRate, suggestion });
  }
  out.sort((a, b) => (b.reject_rate ?? -1) - (a.reject_rate ?? -1));
  return out;
}

// ---- Stories (incident-centric narrative articles built from verified leads) ----
// A story is generated as status:'draft' and advances draft → proposed →
// published (or rejected) through the admin gate — never public until published.
const insStory = db.prepare(`INSERT OR REPLACE INTO stories
  (id, slug, status, headline, generated_at, lead_ids, data)
  VALUES (@id, @slug, @status, @headline, @generated_at, @lead_ids, @data)`);

export function upsertStory(s) {
  const existing = s.slug ? J(db.prepare("SELECT data FROM stories WHERE slug = ?").get(s.slug)) : null;
  const row = existing ? { ...existing, ...s } : { id: id(), ...s };
  if (!row.id) row.id = id();
  if (row.status == null) row.status = "draft";
  insStory.run({
    id: row.id, slug: row.slug ?? null, status: row.status,
    headline: row.headline ?? null,
    generated_at: Number(row.generated_at) || null,
    lead_ids: JSON.stringify(row.lead_ids ?? []),
    data: JSON.stringify(row),
  });
  return row;
}

export function getStory(idOrSlug) {
  return J(db.prepare("SELECT data FROM stories WHERE id = ? OR slug = ? LIMIT 1").get(idOrSlug, idOrSlug));
}

/** @param {{ status?: string }} [filter] */
export function listStories({ status } = {}) {
  const rows = status
    ? db.prepare("SELECT data FROM stories WHERE status = ? ORDER BY generated_at DESC").all(status)
    : db.prepare("SELECT data FROM stories ORDER BY generated_at DESC").all();
  return rows.map(J);
}
