// Shared route helpers extracted from server/index.js so they can be imported by
// both index.js and the split-out route modules without an import cycle.
import { upsertLead, recordLeadFeedback, deleteLead } from "../store.js";

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

// Shared approve/reject mutation for a lead, used by both the #/admin lead
// routes and the ops-console action route. The caller fetches `lead` and
// enforces its own existence/status guards (which differ between routes);
// this performs the common state change and feedback record. On "approve" it
// returns the published lead; on "reject" it deletes and returns null.
export function decideLeadShared(lead, decision, source) {
  if (decision === "approve") {
    const published = upsertLead({ ...lead, status: "published", published_at: new Date().toISOString() });
    recordLeadFeedback(lead, "approved", { source });
    return published;
  }
  recordLeadFeedback(lead, "rejected", { source });
  deleteLead(lead.id);
  return null;
}
