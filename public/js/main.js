// main.js — frontend entry point (Task 9.12). Bootstraps the app: loads the
// roster/methodology, wires the global delegated handlers, filters, theme,
// command palette and mobile nav, then routes. core.js evaluates first via the
// import graph, so its theme IIFE still runs before first paint (no flash).
// The old app.js monolith is gone — every view lives in its own module.
import { $, toggleTheme, syncThemeToggle } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { exportEvidenceCsv, exportEvidenceBibtex, copyCiteLink } from "./export.js";
import { renderHome, buildFilters, setBrowseChip, getBrowseChip, growBrowse } from "./home.js";
import { wireComparePicker } from "./compare.js";
import { renderGovList, getScandalsCache } from "./govwatch.js";
import { renderScorecardTab, setScActiveTab } from "./scorecards.js";
import { renderFundingOverview, setFundActiveTab } from "./funding.js";
import {
  loadAdminQueue, adminToken, setAdminTab, loadDirectorshipNetwork,
  loadAllLeads, loadStories, setLeadStatusFilter, setStoryStatusFilter,
  decideLead, decideProposal,
} from "./admin.js";
import { renderLeaderboard, setLbMetric } from "./leaderboard.js";
import { wireTipPicker, submitPageTip, submitReportTip } from "./tips.js";
import { attachAutocomplete, repSuggestions, scandalSuggestions } from "./search.js";
import { route, syncNav, initRouter } from "./router.js";
import { initCmdk } from "./cmdk.js";

initRouter();

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
  // Global command-palette search (button, Ctrl/Cmd-K, list interaction)
  initCmdk();
  // Mobile nav toggle
  $("#appnav-toggle")?.addEventListener("click", () => {
    const links = $("#appnav-links");
    const open = links.classList.toggle("open");
    $("#appnav-toggle").setAttribute("aria-expanded", String(open));
  });
  route();
  syncNav();
})();
