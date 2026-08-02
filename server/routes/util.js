// Shared route helpers extracted from server/index.js so they can be imported by
// both index.js and the split-out route modules without an import cycle.
// deleteLead is intentionally NOT imported here any more: rejecting a lead
// soft-deletes it (see decideLeadShared). deleteLead remains exported from the
// store for a genuine purge path.
import { upsertLead, recordLeadFeedback } from "../store/store.js";

// Wrap an async route handler so a rejected promise is forwarded to Express's
// error middleware instead of hanging the request.
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// OPT-IN pagination for public list endpoints. No page/pageSize in the query →
// the exact legacy payload (a bare array), so existing clients, the SPA, and
// the golden-master tests see zero change. Either param present → the list
// envelope { items, page, pageSize, total }.
export function maybePaginate(items, query, { defLimit = 25, maxLimit = 100 } = {}) {
  if (query.page === undefined && query.pageSize === undefined) return items;
  const { page, pageSize } = pageParams(query, { defLimit, maxLimit });
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length };
}

// Clamped ?page/?pageSize parsing shared by every paginated list endpoint
// (ops-console lists and the opt-in public pagination).
export function pageParams(query, { defLimit, maxLimit }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.max(1, Math.min(maxLimit, Number(query.pageSize) || defLimit));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ── Path-parameter validation (defense in depth) ─────────────────────────────
// Every store read is a prepared statement, so injection is already impossible;
// this exists so a malformed id fails fast with a 400 instead of travelling
// through the store and coming back as a confusing 404 (or, for the path-key
// card routes, a caught exception). A false 400 on real data is strictly worse
// than the loose behavior this replaces, so the KIND CHOSEN PER ROUTE has to
// match what that route's store lookup actually accepts. Three shapes exist:
//   * id-only          getPolitician/getJob/reviewTip → "WHERE id = ?"    → id
//   * id-OR-slug       getStory/getScandal/getIssue   → "id = ? OR slug = ?" → slug
//   * id-OR-engine-key getFlag/getLead                → "id = ? OR key = ?"  → ref
// Checked against the live DB (readonly): 4,559 politician ids, 1,850 job ids,
// 7,274 flag ids, 3,016 lead ids, 69 scandal slugs (maxlen 51), 8 issue slugs,
// 213 ministry keys, 286 org keys, 18 party keys, 131 party names — plus the two
// key columns the first pass missed: 7,274 flags.key (maxlen 735) and 3,016
// investigation_leads.key (maxlen 595). Zero currently-working values rejected.
const PARAM_PATTERNS = {
  // crypto.randomUUID() ids AND legacy slug-style ids.
  id: /^[A-Za-z0-9_-]{1,64}$/,
  // Also covers a uuid, so it is the right kind for every id-OR-slug lookup.
  // 128 chars because slugify() (story-generator.js) slices at 80 and scandal
  // seed slugs reach 51.
  slug: /^[a-z0-9][a-z0-9._-]{0,127}$/i,
  key: /^[a-z0-9_.-]{1,64}$/i,
  // Ministry/org card keys are hierarchical ("union/finance", "psu/nhai") and
  // are matched with :key(*), so "/" must be legal here.
  pathkey: /^[a-z0-9][a-z0-9._/-]{0,127}$/i,
  // Flags and leads are addressable by their STABLE ENGINE KEY as well as their
  // uuid (engine.js builds "<detector>|<subject>|<fingerprint>" and the store is
  // "WHERE id = ? OR key = ?"). The fingerprint is derived from free text, so
  // the live keys carry "|", "/", spaces, "&()%=;+,@*:~?[]" and non-ASCII ("→")
  // and run to 735 characters — no charset can describe them. Bound the length
  // (1024, ~40% headroom over the longest live key) and reject control chars.
  ref: /^[^\u0000-\u001f\u007f]{1,1024}$/,
};

// Party names legitimately contain spaces, dots, ampersands, parentheses,
// hyphens and en dashes ("Nationalist Congress Party – Sharadchandra Pawar"),
// so charset-matching them would reject real data. Bound the length and reject
// control characters only.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PARAM_CHECKS = {
  ...Object.fromEntries(Object.entries(PARAM_PATTERNS).map(([k, re]) => [k, (v) => re.test(v)])),
  party: (v) => v.length > 0 && v.length <= 100 && !CONTROL_CHARS.test(v),
};

export { PARAM_PATTERNS, PARAM_CHECKS };

// Reject a malformed :param before the handler runs. Responds with the house
// error shape ({ error }) that every other 400 on this surface uses. The kind is
// resolved at registration time so a typo is a startup crash, not a silent
// always-pass middleware.
export function vParam(name, kind) {
  const check = PARAM_CHECKS[kind];
  if (!check) throw new Error(`vParam: unknown param kind "${kind}"`);
  return (req, res, next) => {
    const raw = req.params[name];
    // The value is already percent-decoded by Express, so "%00" arrives as a
    // real NUL and is caught by the charset/control-character checks.
    if (typeof raw !== "string" || !check(raw)) {
      return res.status(400).json({ error: `invalid ${name}` });
    }
    next();
  };
}

// Shared approve/reject mutation for a lead, used by both the #/admin lead
// routes and the ops-console action route. The caller fetches `lead` and
// enforces its own existence/status guards (which differ between routes);
// this performs the common state change and feedback record.
//
// Reject SOFT-deletes (status:'rejected') rather than dropping the row. A human
// rejection is the strongest false-positive signal the system has, and the row is
// where the learnable part lives: the detector attribution (data.flags /
// data.engine_flag_key), the cited evidence_urls, and the persisted L2/L3
// `investigation` blob with its verdict and confidence. Deleting it left
// lead_feedback holding a label with nothing to score against — so the eval
// harness could not measure detector precision on rejections, and --live mode
// could never re-investigate a rejected lead to check whether a prompt change
// fixed it. Both decisions pass forceStatus so a reviewer can also overturn an
// earlier terminal decision; store/content.js keeps them sticky against the
// re-detection paths that would otherwise resurrect them.
// Returns the updated lead for both decisions (reject previously returned null).
export function decideLeadShared(lead, decision, source) {
  const now = new Date().toISOString();
  if (decision === "approve") {
    const published = upsertLead({ ...lead, status: "published", published_at: now, forceStatus: true });
    recordLeadFeedback(lead, "approved", { source });
    return published;
  }
  const rejected = upsertLead({ ...lead, status: "rejected", rejected_at: now, forceStatus: true });
  recordLeadFeedback(lead, "rejected", { source });
  return rejected;
}
