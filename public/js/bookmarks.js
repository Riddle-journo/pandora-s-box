// bookmarks.js — bookmarks + recently-viewed rails (Task 9.4/9.5), extracted
// from legacy.js. localStorage-backed; upgradeable to accounts later.
import { $, esc, GRADE_COLORS } from "./core.js";

// ── Bookmarks + recently-viewed (localStorage; upgradeable to accounts later) ──
const BOOKMARK_KEY = "pb_bookmarks", RECENT_VIEW_KEY = "pb_recent_views";
function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } }
function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
function isBookmarked(id) { return lsGet(BOOKMARK_KEY).some((b) => b.id === id); }
function toggleBookmark(item) {
  const cur = lsGet(BOOKMARK_KEY);
  const idx = cur.findIndex((b) => b.id === item.id);
  if (idx >= 0) cur.splice(idx, 1); else cur.unshift(item);
  lsSet(BOOKMARK_KEY, cur.slice(0, 40));
  return idx < 0; // true if now bookmarked
}
function recordRecentView(item) {
  const cur = lsGet(RECENT_VIEW_KEY).filter((r) => r.id !== item.id);
  cur.unshift(item);
  lsSet(RECENT_VIEW_KEY, cur.slice(0, 12));
}
function railCardHTML(it) {
  const g = it.grade ?? "INSUFFICIENT_DATA";
  return `<a class="rail-card" href="#/rep/${esc(it.id)}">
    <span class="rail-grade" style="background:${esc(GRADE_COLORS[g] ?? "#97a0ad")}">${g === "INSUFFICIENT_DATA" ? "?" : esc(g)}</span>
    <span class="rail-body"><span class="rail-name">${esc(it.name)}</span><span class="rail-sub">${esc(it.sub ?? "")}</span></span>
  </a>`;
}
function renderHomeRails() {
  const saved = lsGet(BOOKMARK_KEY), recent = lsGet(RECENT_VIEW_KEY);
  const sr = $("#saved-rail"), rr = $("#recent-rail");
  if (sr) {
    sr.hidden = saved.length === 0;
    if (saved.length) $("#saved-cards").innerHTML = saved.slice(0, 8).map(railCardHTML).join("");
  }
  if (rr) {
    // don't show items already in saved to avoid duplication noise
    const savedIds = new Set(saved.map((s) => s.id));
    const rec = recent.filter((r) => !savedIds.has(r.id)).slice(0, 8);
    rr.hidden = rec.length === 0;
    if (rec.length) $("#recent-cards").innerHTML = rec.map(railCardHTML).join("");
  }
}

export { lsGet, lsSet, BOOKMARK_KEY, RECENT_VIEW_KEY, isBookmarked, toggleBookmark, recordRecentView, railCardHTML, renderHomeRails };
