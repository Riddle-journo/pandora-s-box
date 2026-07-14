// legacy.js — the not-yet-extracted remainder of the old app.js (Task 9.1).
// Each subsequent task moves a banner-comment section out into its own module
// until this file is empty. Module scope, so nothing leaks to window.
import {
  $, currentTheme, toggleTheme, syncThemeToggle,
  GRADE_COLORS, GRADE_TEXT, CONF, AVATAR_COLORS,
  esc, avatarColor, initials, barColor, confChip, withCites,
  consequenceRank, SIGNAL_DOT, VERDICT_LABEL,
} from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { hideAllViews } from "./views.js";
import { showReport } from "./report.js";
import { showOrgCard, renderRelationGraph } from "./report-sections.js";
import { renderHomeRails } from "./bookmarks.js";
import { exportEvidenceCsv, exportEvidenceBibtex, copyCiteLink } from "./export.js";
import { showHome, showBrowse, renderHome, buildFilters, setBrowseChip, getBrowseChip, growBrowse } from "./home.js";
import { showCompare, wireComparePicker } from "./compare.js";
import { showGovWatch, renderGovList, showScandal, getScandalsCache, invalidateScandalsCache } from "./govwatch.js";
import { showScorecards, renderScorecardTab, setScActiveTab } from "./scorecards.js";
import { showFunding, renderFundingOverview, setFundActiveTab } from "./funding.js";
import {
  showAdmin, loadAdminQueue, adminToken, setAdminTab, loadDirectorshipNetwork,
  loadAllLeads, loadStories, setLeadStatusFilter, setStoryStatusFilter,
  decideLead, decideProposal,
} from "./admin.js";
import { showLeaderboard, renderLeaderboard, setLbMetric } from "./leaderboard.js";
import { showIssues, showIssue } from "./issues.js";
import { showTips, wireTipPicker, submitPageTip, submitReportTip } from "./tips.js";
import { showOps } from "./ops.js";
import { attachAutocomplete, fuzzyScore, repSuggestions, scandalSuggestions } from "./search.js";

// ================= ROUTER =================
function route() {
  if (location.hash === "#/admin") { showAdmin(); return; }
  if (location.hash === "#/browse") { showBrowse(); return; }
  if (location.hash === "#/leaderboard") { showLeaderboard(); return; }
  if (location.hash === "#/issues") { showIssues(); return; }
  if (location.hash === "#/tips") { showTips(); return; }
  if (location.hash === "#/funding") { showFunding(); return; }
  if (location.hash === "#/scorecards") { showScorecards(); return; }
  if (location.hash === "#/govwatch") { showGovWatch(); return; }
  if (location.hash === "#/ops") { showOps(); return; }
  const iss = location.hash.match(/^#\/issue\/(.+)$/);
  if (iss) { showIssue(iss[1]); return; }
  const sc = location.hash.match(/^#\/scandal\/(.+)$/);
  if (sc) { showScandal(sc[1]); return; }
  const cmp = location.hash.match(/^#\/compare(?:\/([^/]+)\/([^/]+))?$/);
  if (cmp) { showCompare(cmp[1] === "_" ? null : cmp[1], cmp[2] === "_" ? null : cmp[2]); return; }
  const mi = location.hash.match(/^#\/ministry\/(.+)$/);
  if (mi) { showOrgCard("ministry", decodeURIComponent(mi[1])); return; }
  const pa = location.hash.match(/^#\/party\/([^/]+)(?:\/(.+))?$/);
  if (pa) { showOrgCard("party", pa[1], pa[2] ? decodeURIComponent(pa[2]) : "union"); return; }
  const m = location.hash.match(/^#\/rep\/(.+)$/);
  if (m) showReport(m[1]); else showHome();
}

// Highlight the active section in the persistent nav (browse+rep+compare all map to Representatives).
function syncNav() {
  const h = location.hash || "#/";
  let key = null;
  if (h.startsWith("#/browse") || h.startsWith("#/rep/") || h.startsWith("#/compare") || h.startsWith("#/leaderboard")) key = "browse";
  else if (h.startsWith("#/ministry/") || h.startsWith("#/party/")) key = "scorecards";
  else if (h.startsWith("#/govwatch") || h.startsWith("#/scandal/")) key = "govwatch";
  else if (h.startsWith("#/scorecards")) key = "scorecards";
  else if (h.startsWith("#/funding")) key = "funding";
  else if (h.startsWith("#/issues") || h.startsWith("#/issue/")) key = "issues";
  else if (h.startsWith("#/tips")) key = "tips";
  else if (h.startsWith("#/ops")) key = "ops";
  document.querySelectorAll("#appnav-links a").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
  const links = document.getElementById("appnav-links");
  if (links) links.classList.remove("open"); // close mobile menu on navigate
  const tgl = document.getElementById("appnav-toggle");
  if (tgl) tgl.setAttribute("aria-expanded", "false");
}
window.addEventListener("hashchange", () => { route(); syncNav(); });

// ================= GLOBAL SEARCH (command palette) =================
let cmdkScandals = null, cmdkIssues = null, cmdkActive = -1, cmdkRows = [];
const RECENT_KEY = "pb_recent_searches";
function getRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } }
function pushRecent(item) {
  const cur = getRecent().filter((r) => !(r.type === item.type && r.id === item.id));
  cur.unshift(item);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 6))); } catch {}
}
async function openCmdk() {
  const ov = $("#cmdk"); if (!ov) return;
  ov.hidden = false;
  // lazy-load government + issues data once
  if (cmdkScandals === null) cmdkScandals = (await api("/api/scandals")) ?? [];
  if (cmdkIssues === null) { const iss = await api("/api/issues"); cmdkIssues = Array.isArray(iss) ? iss : (iss ? Object.values(iss) : []); }
  const inp = $("#cmdk-input"); inp.value = ""; inp.focus();
  cmdkRender("");
}
function closeCmdk() { const ov = $("#cmdk"); if (ov) ov.hidden = true; cmdkActive = -1; }
function cmdkGather(q) {
  q = q.trim().toLowerCase();
  const groups = [];
  if (!q) {
    const recent = getRecent();
    if (recent.length) groups.push({ label: "Recent", items: recent.map((r) => ({ ...r, recent: true })) });
    return groups;
  }
  const people = state.reps.map((p) => [fuzzyScore(`${p.name} ${p.constituency ?? ""} ${p.party ?? ""} ${p.state ?? ""}`, q) + (p.latest ? 5 : 0), p])
    .filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 6)
    .map(([, p]) => ({ type: "rep", id: p.id, label: p.name, sub: [p.office, p.party, p.constituency || p.state].filter(Boolean).join(" · ") }));
  if (people.length) groups.push({ label: "Representatives", items: people });
  const gov = (cmdkScandals ?? []).map((s) => [fuzzyScore(`${s.title} ${s.party ?? ""} ${s.minister ?? ""} ${s.sector ?? ""}`, q), s])
    .filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, 5)
    .map(([, s]) => ({ type: "scandal", id: s.slug, label: s.title, sub: [s.sector, s.minister].filter(Boolean).join(" · ") }));
  if (gov.length) groups.push({ label: "Government Watch", items: gov });
  const issues = (cmdkIssues ?? []).filter((i) => `${i.title ?? i.name ?? ""} ${i.summary ?? ""}`.toLowerCase().includes(q))
    .slice(0, 4).map((i) => ({ type: "issue", id: i.slug ?? i.id, label: i.title ?? i.name, sub: "Where India Stands" }));
  if (issues.length) groups.push({ label: "Issues", items: issues });
  return groups;
}
function cmdkGoto(item) {
  pushRecent({ type: item.type, id: item.id, label: item.label, sub: item.sub });
  closeCmdk();
  if (item.type === "rep") location.hash = `#/rep/${item.id}`;
  else if (item.type === "scandal") location.hash = `#/scandal/${item.id}`;
  else if (item.type === "issue") location.hash = `#/issue/${item.id}`;
}
function cmdkRender(q) {
  const box = $("#cmdk-results");
  const groups = cmdkGather(q);
  cmdkRows = [];
  if (!groups.length) { box.innerHTML = `<div class="cmdk-empty">${q ? "No matches." : "Type to search people, scandals and issues."}</div>`; return; }
  let html = "";
  groups.forEach((g) => {
    html += `<div class="cmdk-group">${esc(g.label)}</div>`;
    g.items.forEach((it) => {
      const idx = cmdkRows.length; cmdkRows.push(it);
      const icon = it.type === "rep" ? "🧑‍⚖️" : it.type === "scandal" ? "🏛️" : "🧭";
      html += `<div class="cmdk-item" role="option" data-idx="${idx}"><span class="cmdk-ic">${icon}</span><span class="cmdk-main">${esc(it.label)}</span><span class="cmdk-sub">${esc(it.sub ?? "")}</span></div>`;
    });
  });
  box.innerHTML = html;
  cmdkActive = cmdkRows.length ? 0 : -1;
  cmdkPaint();
}
function cmdkPaint() {
  document.querySelectorAll("#cmdk-results .cmdk-item").forEach((el, i) => {
    const on = i === cmdkActive; el.classList.toggle("active", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  });
}

$("#tip-form").addEventListener("submit", submitReportTip);

// ================= INIT =================
// Browse-page filters re-render the directory (reset pagination each change).
["#browse-search","#f-state","#f-party","#f-office","#f-sort"].forEach((sel) =>
  $(sel)?.addEventListener("input", () => renderHome(true))
);
$("#f-clear")?.addEventListener("click", () => {
  ["#browse-search","#f-state","#f-party","#f-office"].forEach(s => { const e = $(s); if (e) e.value = ""; });
  const so = $("#f-sort"); if (so) so.value = "relevance";
  setBrowseChip(null);
  renderHome(true);
});
// Quick-filter chips (toggle on/off)
document.querySelectorAll(".qchip").forEach((c) => c.addEventListener("click", () => {
  setBrowseChip(getBrowseChip() === c.dataset.chip ? null : c.dataset.chip);
  renderHome(true);
}));
// Load more — grow the rendered slice without resetting.
$("#load-more")?.addEventListener("click", () => { growBrowse(); renderHome(false); });
// Landing search jumps to the browse page, carrying the query.
$("#landing-search")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search").value;
  location.hash = "#/browse";
  setTimeout(() => { const b = $("#browse-search"); if (b) { b.value = q; renderHome(); } }, 0);
});

(async function init() {
  const [list, meth, cats] = await Promise.all([
    api("/api/politicians"),
    api("/api/methodology"),
    api("/api/tip-categories"),
  ]);
  state.reps = list ?? [];
  state.methodology = meth;
  $("#tip-category").innerHTML = (cats ?? []).map(c => `<option value="${c}">${c.replaceAll("_"," ")}</option>`).join("");
  buildFilters();
  wireComparePicker("a");
  wireComparePicker("b");
  ["#gw-level","#gw-sector","#gw-state","#gw-party"].forEach((s) => $(s)?.addEventListener("change", renderGovList));
  $("#gw-search")?.addEventListener("input", renderGovList);
  // Search suggestions (typeahead) on every search box, with bracket descriptors.
  attachAutocomplete("#search", "#landing-ac", repSuggestions, (it) => { location.hash = `#/rep/${it.id}`; },
    { seeAll: (q) => { location.hash = "#/browse"; setTimeout(() => { const b = $("#browse-search"); if (b) { b.value = q; renderHome(); } }, 0); } });
  attachAutocomplete("#browse-search", "#browse-ac", repSuggestions, (it) => { location.hash = `#/rep/${it.id}`; });
  attachAutocomplete("#gw-search", "#gw-ac", (q) => scandalSuggestions(q, getScandalsCache()), (it) => {
    if (it.kind === "scandal") { location.hash = `#/scandal/${it.id}`; return; }
    if (it.kind === "party") $("#gw-party").value = it.id;
    if (it.kind === "state") $("#gw-state").value = it.id;
    $("#gw-search").value = "";
    renderGovList();
  });
  // Tips page: rep picker + standalone submit form.
  wireTipPicker();
  $("#tip-page-form")?.addEventListener("submit", submitPageTip);
  document.querySelectorAll(".sc-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".sc-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    setScActiveTab(t.dataset.sc);
    renderScorecardTab();
  }));
  document.querySelectorAll(".fund-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".fund-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    setFundActiveTab(t.dataset.fund);
    renderFundingOverview();
  }));
  // Admin review queue (two tabs: scandal proposals, investigation leads)
  $("#admin-load").addEventListener("click", loadAdminQueue);
  $("#admin-token").addEventListener("keydown", (e) => { if (e.key === "Enter") loadAdminQueue(); });
  $("#dirnet-load")?.addEventListener("click", loadDirectorshipNetwork);
  $("#dirnet-pid")?.addEventListener("keydown", (e) => { if (e.key === "Enter") loadDirectorshipNetwork(); });
  document.querySelectorAll(".admin-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const adminTab = t.dataset.adminTab;
    setAdminTab(adminTab);
    $("#admin-panel-scandals").hidden = adminTab !== "scandals";
    $("#admin-panel-leads").hidden = adminTab !== "leads";
    $("#admin-panel-conflicts").hidden = adminTab !== "conflicts";
    $("#admin-panel-stories").hidden = adminTab !== "stories";
    $("#admin-panel-directorships").hidden = adminTab !== "directorships";
    if (adminToken()) loadAdminQueue();
  }));
  // Status filter tabs inside the All Leads / Story Drafts panels.
  document.querySelectorAll("#conflict-status-tabs .sc-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("#conflict-status-tabs .sc-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    setLeadStatusFilter(t.dataset.leadStatus ?? "");
    loadAllLeads();
  }));
  document.querySelectorAll("#story-status-tabs .sc-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("#story-status-tabs .sc-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    setStoryStatusFilter(t.dataset.storyStatus ?? "draft");
    loadStories();
  }));
  // "Compare with…" button on a report jumps into compare with that rep pre-filled;
  // also handles admin approve/reject clicks (delegated). Lead cards carry
  // data-id (no slug), scandal cards carry data-slug — route accordingly.
  document.addEventListener("click", (e) => {
    const cw = e.target.closest("[data-compare-with]");
    if (cw) { location.hash = `#/compare/${cw.dataset.compareWith}/_`; return; }
    const ap = e.target.closest(".adm-approve");
    if (ap) {
      const card = ap.closest(".adm-card");
      if (card.classList.contains("lead-card")) decideLead(ap.dataset.id, "approve", card);
      else decideProposal(ap.dataset.slug, "approve", card);
      return;
    }
    const rj = e.target.closest(".adm-reject");
    if (rj) {
      const card = rj.closest(".adm-card");
      if (card.classList.contains("lead-card")) decideLead(rj.dataset.id, "reject", card);
      else decideProposal(rj.dataset.slug, "reject", card);
      return;
    }
    const lb = e.target.closest(".lb-tab");
    if (lb) { setLbMetric(lb.dataset.lb); renderLeaderboard(); return; }
    const hs = e.target.closest("#how-scored");
    if (hs) {
      e.preventDefault();
      const meth = $("#methodology");
      if (meth && !meth.hidden) { meth.open = true; meth.scrollIntoView({ behavior: "smooth", block: "start" }); }
      return;
    }
    const sc = e.target.closest("[data-scroll]");
    if (sc) { e.preventDefault(); document.getElementById(sc.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  });
  // Theme toggle
  syncThemeToggle();
  $("#theme-toggle")?.addEventListener("click", toggleTheme);
  // Evidence export + cite
  $("#export-csv")?.addEventListener("click", exportEvidenceCsv);
  $("#export-bib")?.addEventListener("click", exportEvidenceBibtex);
  $("#cite-link")?.addEventListener("click", (e) => copyCiteLink(e.currentTarget));
  // Global command-palette search
  $("#global-search-btn")?.addEventListener("click", openCmdk);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); const ov = $("#cmdk"); ov && ov.hidden ? openCmdk() : closeCmdk(); }
    else if (e.key === "Escape" && !$("#cmdk").hidden) { closeCmdk(); }
  });
  $("#cmdk-input")?.addEventListener("input", (e) => cmdkRender(e.target.value));
  $("#cmdk-input")?.addEventListener("keydown", (e) => {
    if (!cmdkRows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); cmdkActive = (cmdkActive + 1) % cmdkRows.length; cmdkPaint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdkActive = (cmdkActive - 1 + cmdkRows.length) % cmdkRows.length; cmdkPaint(); }
    else if (e.key === "Enter") { e.preventDefault(); if (cmdkRows[cmdkActive]) cmdkGoto(cmdkRows[cmdkActive]); }
  });
  $("#cmdk-results")?.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".cmdk-item"); if (!el) return;
    e.preventDefault(); cmdkGoto(cmdkRows[+el.dataset.idx]);
  });
  $("#cmdk")?.addEventListener("mousedown", (e) => { if (e.target.id === "cmdk") closeCmdk(); });
  // Mobile nav toggle
  $("#appnav-toggle")?.addEventListener("click", () => {
    const links = $("#appnav-links");
    const open = links.classList.toggle("open");
    $("#appnav-toggle").setAttribute("aria-expanded", String(open));
  });
  route();
  syncNav();
})();
