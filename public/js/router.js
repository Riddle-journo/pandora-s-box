// router.js — hash router + persistent-nav highlighting (Task 9.11),
// extracted from legacy.js. initRouter() wires the hashchange listener;
// the initial route()/syncNav() call stays with the app init.
import { showReport } from "./report.js";
import { showOrgCard } from "./report-sections.js";
import { showHome, showBrowse } from "./home.js";
import { showCompare } from "./compare.js";
import { showGovWatch, showScandal } from "./govwatch.js";
import { showScorecards } from "./scorecards.js";
import { showFunding } from "./funding.js";
import { showAdmin } from "./admin.js";
import { showLeaderboard } from "./leaderboard.js";
import { showIssues, showIssue } from "./issues.js";
import { showTips } from "./tips.js";
import { showOps } from "./ops.js";
import { showOrgsDirectory } from "./orgs.js";

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
  if (location.hash === "#/orgs") { showOrgsDirectory(); return; }
  const org = location.hash.match(/^#\/org\/(.+)$/);
  if (org) { showOrgCard("org", org[1]); return; }
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

// Highlight the active nav group (Representatives / Accountability / The Big Picture / Tip).
function syncNav() {
  const h = location.hash || "#/";
  let key = null;
  if (h.startsWith("#/browse") || h.startsWith("#/rep/") || h.startsWith("#/compare") || h.startsWith("#/leaderboard")) key = "browse";
  else if (h.startsWith("#/govwatch") || h.startsWith("#/scandal/") || h.startsWith("#/scorecards") || h.startsWith("#/ministry/") || h.startsWith("#/party/") || h.startsWith("#/orgs") || h.startsWith("#/org/")) key = "accountability";
  else if (h.startsWith("#/issues") || h.startsWith("#/issue/") || h.startsWith("#/funding")) key = "bigpicture";
  else if (h.startsWith("#/tips")) key = "tips";
  document.querySelectorAll("#appnav-links a[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
  document.querySelectorAll("#appnav-links .nav-group").forEach((g) => {
    g.classList.toggle("active", g.dataset.nav === key);
    g.removeAttribute("open"); // close dropdowns on navigate
  });
  const links = document.getElementById("appnav-links");
  if (links) links.classList.remove("open"); // close mobile menu on navigate
  const tgl = document.getElementById("appnav-toggle");
  if (tgl) tgl.setAttribute("aria-expanded", "false");
}

function initRouter() {
  window.addEventListener("hashchange", () => { route(); syncNav(); });
}

export { route, syncNav, initRouter };
