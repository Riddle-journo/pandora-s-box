// ops.js — entry point for the local admin ops console (#/ops). Owns the view
// registration, the token/connect handshake, the Overview summary, the tab
// switchboard and the delegated event wiring; each tab's rendering lives in its
// own ops-*.js module (jobs, health, roster, tuning) behind those seams.
import { $, esc } from "./core.js";
import { hideAllViews, registerView } from "./views.js";
import { opsToken, opsFetch, opsWhen } from "./ops-shared.js";
import {
  renderOpsCommands, opsRunPreset, opsRun, loadOpsJobs, opsTogglePause, opsReclaim,
  opsTrim, opsJobCancel, opsJobRequeue, opsJobBump, opsJobEdit,
  openOpsDrawer, stopOpsDrawer,
} from "./ops-jobs.js";
import { loadOpsHealth, loadOpsMaint } from "./ops-health.js";
import {
  opsSelected, opsRosterLastRows, loadOpsRoster, opsBatchRun, loadOpsFlags,
  loadOpsLeads, opsLeadAction, opsUpdateSelCount, rosterPage, flagsPage, leadsPage,
} from "./ops-roster.js";
import { loadOpsEngine, loadOpsTuning, opsEngineRun, opsSaveTuning } from "./ops-tuning.js";

// Auto-refresh poll handle (the log drawer's own handle lives in ops-jobs.js).
let opsTimer = null;

// Leaving the ops view (any navigation) stops the auto-refresh + log polling —
// registered as this view's teardown in the views.js registry; showOps restarts it.
registerView("ops", {
  el: "#ops-view",
  teardown: () => {
    if (opsTimer) { clearInterval(opsTimer); opsTimer = null; }
    stopOpsDrawer();
  },
});

function showOps() {
  hideAllViews();
  $("#ops-view").hidden = false;
  window.scrollTo(0, 0);
  const saved = localStorage.getItem("pb_admin_token");
  if (saved && !$("#ops-token").value) $("#ops-token").value = saved;
  renderOpsCommands();
  if (saved) opsConnect();
}

function opsShowTab(tab) {
  document.querySelectorAll("#ops-tabs .ops-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".ops-tabpane").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  // Lazy-load per tab so switching is instant and cheap.
  if (tab === "engine") loadOpsEngine();
  if (tab === "tuning") loadOpsTuning();
  if (tab === "flags") loadOpsFlags(1);
  if (tab === "leads") loadOpsLeads(1);
  if (tab === "roster") loadOpsRoster(1);
  if (tab === "jobs") loadOpsJobs();
  if (tab === "health") loadOpsMaint();
}

async function opsConnect() {
  const token = opsToken();
  if (!token) { $("#ops-status").textContent = "Enter your admin token to connect."; return; }
  localStorage.setItem("pb_admin_token", token);
  $("#ops-status").textContent = "Loading…";
  const ok = await loadOpsSummary();
  if (!ok) return; // auth/network failed; message already set
  $("#ops-body").hidden = false;
  $("#ops-status").textContent = "Connected.";
  loadOpsHealth();
  loadOpsCounts();
  opsShowTab("overview");
  if (opsTimer) clearInterval(opsTimer);
  opsTimer = setInterval(() => {
    if ($("#ops-view").hidden || !$("#ops-auto").checked) return;
    loadOpsSummary();
    loadOpsJobs();
    loadOpsCounts();
  }, 3000);
}

// Tab-badge counts (active big flags, leads awaiting decision) — cheap polls.
async function loadOpsCounts() {
  const f = await opsFetch("/api/admin/ops/flags?pageSize=1");
  if (f && !f.error) $("#ops-flagcount").textContent = f.counts ? `${f.counts.big}` : "";
  const l = await opsFetch("/api/admin/ops/leads?pageSize=1");
  if (l && !l.error) $("#ops-leadcount").textContent = `${(l.byStatus?.proposed ?? 0) + (l.byStatus?.detected ?? 0)}`;
}

async function loadOpsSummary() {
  const d = await opsFetch("/api/admin/ops/summary");
  if (!d || d.error) return false;
  const c = d.counts || {}, m = d.missing || {};
  const tiles = [
    { n: c.politicians, l: "reps" }, { n: c.evidence, l: "evidence rows" }, { n: c.reports, l: "reports" },
    { n: d.leads?.published ?? 0, l: "published leads" }, { n: c.scandals, l: "scandals" },
    { n: m.noReport, l: "reps w/o report", warn: true }, { n: m.noEvidence, l: "reps w/o evidence", warn: true },
  ];
  $("#ops-tiles").innerHTML = tiles.map((t) => `<div class="ops-tile${t.warn ? " warn" : ""}"><div class="n">${esc(t.n ?? 0)}</div><div class="l">${esc(t.l)}</div></div>`).join("");
  const cov = d.coverage || [];
  const maxRows = Math.max(1, ...cov.map((r) => r.rows));
  $("#ops-coverage").innerHTML = `<table class="ops-table"><thead><tr><th>source</th><th>rows</th><th>with content</th><th>last fetched</th></tr></thead><tbody>${cov.map((r) => `<tr><td>${esc(r.source_type)}</td><td>${esc(r.rows)} <span class="ops-bar" style="width:${Math.round(60 * r.rows / maxRows)}px"></span></td><td>${esc(r.with_content)}</td><td>${esc(opsWhen(r.last_fetched))}</td></tr>`).join("")}</tbody></table>`;
  return true;
}

// Ops wiring — elements exist at load (script is at end of body).
$("#ops-load").addEventListener("click", opsConnect);
$("#ops-token").addEventListener("keydown", (e) => { if (e.key === "Enter") opsConnect(); });
$("#ops-health-days").addEventListener("change", loadOpsHealth);
$("#ops-rsearch").addEventListener("click", () => loadOpsRoster(1));
$("#ops-rq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsRoster(1); });
$("#ops-drawer-close").addEventListener("click", () => { $("#ops-drawer").hidden = true; stopOpsDrawer(); });
$("#ops-view").addEventListener("click", (e) => {
  const tab = e.target.closest(".ops-tab"); if (tab) { opsShowTab(tab.dataset.tab); return; }
  const preset = e.target.closest(".ops-preset-run"); if (preset) { opsRunPreset(preset.closest(".ops-cmd")); return; }
  const run = e.target.closest(".ops-run"); if (run) { opsRun(run.closest(".ops-cmd")); return; }
  const detRun = e.target.closest(".ops-det-run"); if (detRun) { opsEngineRun({ detector: detRun.closest(".ops-cmd").dataset.detector }); return; }
  const detDry = e.target.closest(".ops-det-dry"); if (detDry) { opsEngineRun({ detector: detDry.closest(".ops-cmd").dataset.detector, dryRun: true }); return; }
  const reset = e.target.closest(".ops-tune-reset");
  if (reset) {
    const input = document.querySelector(`#ops-tuning [data-key="${reset.dataset.key}"]:not(button)`);
    if (input) {
      if (input.tagName === "SELECT") input.value = input.dataset.def;
      else input.value = input.dataset.def;
      input.dataset.reset = "1";
    }
    return;
  }
  const lact = e.target.closest(".ops-lact"); if (lact) { opsLeadAction(lact); return; }
  const log = e.target.closest(".ops-joblog"); if (log) { openOpsDrawer(log.dataset.id, log.dataset.type); return; }
  // Queue control + batch run
  if (e.target.closest("#ops-pause")) { opsTogglePause(); return; }
  if (e.target.closest("#ops-reclaim")) { opsReclaim(); return; }
  const trim = e.target.closest(".ops-trim"); if (trim) { opsTrim(trim.dataset.older ? { olderThanDays: Number(trim.dataset.older) } : { status: trim.dataset.status }); return; }
  const jcancel = e.target.closest(".ops-jcancel"); if (jcancel) { opsJobCancel(jcancel.dataset.id); return; }
  const jrequeue = e.target.closest(".ops-jrequeue"); if (jrequeue) { opsJobRequeue(jrequeue.dataset.id); return; }
  const jbump = e.target.closest(".ops-jbump"); if (jbump) { opsJobBump(jbump.dataset.id, Number(jbump.dataset.dir)); return; }
  const jedit = e.target.closest(".ops-jedit"); if (jedit) { opsJobEdit(jedit.dataset.id); return; }
  if (e.target.closest("#ops-brun-sel")) { opsBatchRun("selected"); return; }
  if (e.target.closest("#ops-brun-filter")) { opsBatchRun("filter"); return; }
  if (e.target.closest(".ops-rprev")) { loadOpsRoster(Math.max(1, rosterPage() - 1)); return; }
  if (e.target.closest(".ops-rnext")) { loadOpsRoster(rosterPage() + 1); return; }
  if (e.target.closest(".ops-fprev")) { loadOpsFlags(Math.max(1, flagsPage() - 1)); return; }
  if (e.target.closest(".ops-fnext")) { loadOpsFlags(flagsPage() + 1); return; }
  if (e.target.closest(".ops-lprev")) { loadOpsLeads(Math.max(1, leadsPage() - 1)); return; }
  if (e.target.closest(".ops-lnext")) { loadOpsLeads(leadsPage() + 1); return; }
});
// Roster batch selection (checkboxes fire change, not click).
$("#ops-view").addEventListener("change", (e) => {
  const rsel = e.target.closest(".ops-rsel");
  if (rsel) { if (rsel.checked) opsSelected.add(rsel.dataset.id); else opsSelected.delete(rsel.dataset.id); opsUpdateSelCount(); return; }
  if (e.target.id === "ops-rall") {
    for (const p of opsRosterLastRows) { if (e.target.checked) opsSelected.add(p.id); else opsSelected.delete(p.id); }
    document.querySelectorAll(".ops-rsel").forEach((cb) => { cb.checked = e.target.checked; });
    opsUpdateSelCount();
  }
});
// Any manual edit to a tuning input cancels a pending reset for that key.
$("#ops-tuning").addEventListener("input", (e) => { if (e.target.dataset) delete e.target.dataset.reset; });
$("#ops-engine-run").addEventListener("click", () => opsEngineRun({}));
$("#ops-engine-dryrun").addEventListener("click", () => opsEngineRun({ dryRun: true }));
$("#ops-engine-synth").addEventListener("click", async () => {
  const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type: "engine_synthesis", payload: {} }) });
  $("#ops-engine-status").textContent = res && !res.error ? `synthesis queued ${String(res.id).slice(0, 8)}` : "✗ failed";
  if (res && !res.error) openOpsDrawer(res.id, "engine_synthesis");
});
$("#ops-tuning-save").addEventListener("click", opsSaveTuning);
$("#ops-fsearch").addEventListener("click", () => loadOpsFlags(1));
$("#ops-fq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsFlags(1); });
$("#ops-lsearch").addEventListener("click", () => loadOpsLeads(1));
$("#ops-lq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsLeads(1); });

export { showOps };
