// views.js — view registry (Task 9.2). Every hash-routed <section id="*-view">
// is registered here; showing one hides the rest and runs the outgoing view's
// teardown (e.g. the ops console stops its polling timers when you leave).
import { $ } from "./core.js";

const views = new Map();
let current = null;

export function registerView(name, { el, teardown } = {}) {
  views.set(name, { el, teardown });
}

// Show exactly one registered view: hide all, run the outgoing view's
// teardown (if any), then unhide the named one.
export function showView(name) {
  for (const v of views.values()) { const e = $(v.el); if (e) e.hidden = true; }
  views.get(current)?.teardown?.();
  current = name;
  const v = views.get(name);
  const el = v && $(v.el);
  if (el) el.hidden = false;
}

// Legacy contract (thin wrapper over the registry): hide every registered view
// and run every teardown — the old hideAllViews cleared the ops timers
// unconditionally on each navigation, so this preserves that exactly.
export function hideAllViews() {
  for (const v of views.values()) { const e = $(v.el); if (e) e.hidden = true; }
  for (const v of views.values()) v.teardown?.();
  current = null;
}

// ── Register the app's views (selectors from the old hideAllViews body) ──
for (const [name, el] of Object.entries({
  home: "#home-view", browse: "#browse-view", report: "#report-view",
  compare: "#compare-view", govwatch: "#govwatch-view", scandal: "#scandal-view",
  scorecards: "#scorecards-view", funding: "#funding-view", admin: "#admin-view",
  leaderboard: "#leaderboard-view", issues: "#issues-view",
  issueDetail: "#issue-detail-view", tips: "#tips-view", org: "#org-view",
})) registerView(name, { el });

// The ops view registers itself (with its polling-teardown) from ops.js.
