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
import { attachAutocomplete, fuzzyScore, repSuggestions, scandalSuggestions } from "./search.js";

// ================= OPS CONSOLE =================
// One-click chains. The worker is serial, so enqueue order = run order.
const OPS_PRESETS = [
  { key: "full", label: "Fresh evidence → ledger → engine", desc: "Ingest every rep, re-extract the analysis ledgers, then run the full Anomaly Engine (flags → leads). All free.", steps: [{ type: "ingest_all" }, { type: "extract_all" }, { type: "engine_scan" }] },
  { key: "incremental", label: "Incremental refresh (new/stale reps only)", desc: "Ingest ONLY reps never fetched or stale >7 days (not a full re-scrape), then re-extract ledgers and run the engine. All free.", steps: [{ type: "ingest_all", payload: { incremental: true, staleDays: 7 } }, { type: "extract_all" }, { type: "engine_scan" }] },
  { key: "analyze", label: "Analyze existing evidence", desc: "No fetching: re-extract ledgers from stored evidence, then run the engine. Free, fast.", steps: [{ type: "extract_all" }, { type: "engine_scan" }] },
  { key: "investigate", label: "Full investigation (engine + GLM)", desc: "Engine over everyone (free), then GLM L2/L3 on the global top 50 leads (paid, capped).", steps: [{ type: "investigate_all", payload: { top: 50 } }] },
  { key: "cards", label: "Refresh public cards", desc: "Rebuild every Summarizer report card from existing evidence (free chain).", steps: [{ type: "cards_all" }] },
];
const OPS_COMMANDS = [
  // ── Summarizer (Branch 1 — free) ──
  { type: "generate_card", label: "Summarizer · card for one rep", desc: "Build the public report card (computed facts + free-chain prose).", fields: [{ k: "politicianId", ph: "politician id", type: "text" }, { k: "noProse", type: "checkbox", label: "Skip prose (pure template)" }] },
  { type: "cards_all", label: "Summarizer · card all reps", desc: "Queue one card job per rep. Free — no paid LLM.", fields: [{ k: "noProse", type: "checkbox", label: "Skip prose" }, { k: "reingest", type: "checkbox", label: "Re-ingest first" }] },
  // ── Ingest / maintenance ──
  { type: "ingest_all", label: "Ingest all reps", desc: "Queue one ingest job per rep (fetch fresh evidence). Tick Incremental to skip reps fetched within the last N days — only new/stale reps, not a full re-scrape.", fields: [{ k: "incremental", type: "checkbox", label: "Incremental (new/stale only)" }, { k: "staleDays", ph: "7", type: "number" }] },
  { type: "ingest_politician", label: "Ingest one rep", desc: "Fetch evidence for a single politician id.", fields: [{ k: "politicianId", ph: "politician id", type: "text" }] },
  { type: "source_health", label: "Source health sweep", desc: "Aggregate the fetch-run ledger + prune old rows.", fields: [{ k: "days", ph: "14", type: "number" }] },
  { type: "roster_update", label: "Roster update", desc: "Refresh MP/RS roster from Sansad (dry-run unless Apply).", fields: [{ k: "apply", type: "checkbox", label: "Apply" }, { k: "mla", type: "checkbox", label: "Incl. MLAs" }] },
  { type: "mega_refresh", label: "Mega refresh", desc: "Re-download a bulk dataset (heavy).", fields: [{ k: "id", ph: "all or source id", type: "text" }] },
  { type: "repair_myneta", label: "Repair MyNeta URLs", desc: "Validate/repair affidavit URLs (dry-run unless Apply).", fields: [{ k: "apply", type: "checkbox", label: "Apply" }, { k: "onlySuspect", type: "checkbox", label: "Only suspect" }, { k: "limit", ph: "limit", type: "number" }] },
  { type: "cppp_ingest", label: "CPPP procurement ingest", desc: "Query the local 6.6GB contract-award DB per rep → gem evidence. Resumable; slow over the whole roster.", fields: [{ k: "office", ph: "MP | RS | MLA (blank = all)", type: "text" }, { k: "state", ph: "state (optional)", type: "text" }, { k: "limit", ph: "limit", type: "number" }] },
  // ── Analysis store (free extraction + detectors) ──
  { type: "extract_all", label: "Analysis · extract + detect", desc: "Run every deterministic extractor (facts/claims/relationships) then the ledger detectors. Pure code, free.", fields: [] },
  { type: "extract_prose", label: "Analysis · prose extract (free LLM)", desc: "News/fact-check/CBI/Wikipedia → claims via the FREE model chain. Leave limit blank + tick All for the full backfill.", fields: [{ k: "source", ph: "news | fact_check | cbi_press | wikipedia (blank = all)", type: "text" }, { k: "limit", ph: "25", type: "number" }, { k: "all", type: "checkbox", label: "All rows (full backfill)" }] },
  // ── Investigator (Branch 2 — private, GLM budget) ──
  { type: "engine_scan", label: "Engine · full scan", desc: "Every detector → small/big flags → leads with evidence. Pure code + free enrichment.", fields: [{ k: "detector", ph: "detector id (blank = all)", type: "text" }, { k: "politicianId", ph: "politician id (blank = all)", type: "text" }, { k: "dryRun", type: "checkbox", label: "Dry run (write nothing)" }] },
  { type: "engine_synthesis", label: "Engine · re-synthesise leads", desc: "Re-run flags → leads only (after tuning thresholds; no re-detection).", fields: [] },
  { type: "cppp_scan", label: "Engine · procurement scan (CPPP)", desc: "Run the CPPP procurement detectors (single-bidder, capture, splitting…) over the 4.9M-award corpus. Slow. Tick Rebuild to re-flatten the index first (needs CPPP_DB_PATH).", fields: [{ k: "rebuild", type: "checkbox", label: "Rebuild index first" }] },
  { type: "investigate_politician", label: "Investigator · one rep", desc: "Engine for one rep + GLM L2/L3 on their top leads (paid).", fields: [{ k: "politicianId", ph: "politician id", type: "text" }, { k: "top", ph: "10", type: "number" }] },
  { type: "investigate_all", label: "Investigator · full sweep", desc: "Engine for everyone (free) + GLM L2/L3 on the global top leads (paid, capped).", fields: [{ k: "top", ph: "50", type: "number" }] },
  { type: "investigate_lead", label: "Investigator · one lead", desc: "GLM investigation of a single lead id (paid). Use the Leads tab's Investigate button instead when browsing.", fields: [{ k: "leadId", ph: "lead id", type: "text" }] },
  { type: "run_synthesis", label: "Investigator · network hubs", desc: "Cross-entity network-hub meta-leads (pure code, free).", fields: [] },
  { type: "draft_stories", label: "Investigator · draft stories", desc: "Write journalist-handoff narratives from vetted leads (paid).", fields: [] },
  { type: "anomaly_scan", label: "Legacy · anomaly scan", desc: "Old standalone statistical scan — superseded by Engine · full scan.", fields: [] },
  // ── Editorial (public content, GLM, human-gated) ──
  { type: "discover_scandals", label: "Editorial · discover scandals", desc: "Scan news for new scandal proposals (self rate-limited; GLM runs only on your approval).", fields: [] },
  // ── Legacy (transition only) ──
  { type: "generate_report", label: "Legacy · GLM dossier", desc: "Old expensive dossier — retired; kept during the card transition.", fields: [{ k: "politicianId", ph: "politician id", type: "text" }, { k: "mode", type: "select", opts: ["incremental", "full", "recheck"] }] },
];
const OPS_DANGER = [
  { type: "reset_data", label: "Reset data", desc: "Delete reports/evidence/demo. Type RESET to confirm.", danger: "RESET",
    fields: [{ k: "scope", type: "select", opts: ["reports", "evidence", "demo", "all"] }, { k: "apply", type: "checkbox", label: "Apply (else dry-run)" }] },
];
// ── DB maintenance (Health tab) — all POST db_maintenance with a tier or task. ──
// Tiers run a full checklist; single-task cards run one check. Destructive tasks
// (vacuum, drift-heal) go through db_maintenance_danger with the MAINTAIN phrase.
const OPS_MAINT_TIERS = [
  { type: "db_maintenance", tier: "nightly", label: "Run nightly sweep", desc: "WAL checkpoint · optimize · quick integrity · orphans · drift scan · freshness · backup + verify. Seconds.", fields: [] },
  { type: "db_maintenance", tier: "weekly",  label: "Run weekly sweep",  desc: "Full integrity · foreign keys · FTS verify · duplicate-entity scan · reclaim zombies · staleness→ingest · cache prune · drift heal.", fields: [] },
  { type: "db_maintenance", tier: "monthly", label: "Run monthly sweep", desc: "Conditional VACUUM (only if bloated) · backup + verify · duplicate-entity scan.", fields: [] },
];
const OPS_MAINT_TASKS = [
  { type: "db_maintenance", task: "integrity_quick", label: "Integrity · quick", desc: "PRAGMA quick_check — fast structural pass.", fields: [] },
  { type: "db_maintenance", task: "integrity_full", label: "Integrity · full", desc: "PRAGMA integrity_check — scans every page.", fields: [] },
  { type: "db_maintenance", task: "foreign_keys", label: "Foreign-key check", desc: "PRAGMA foreign_key_check — dangling declared references.", fields: [] },
  { type: "db_maintenance", task: "fts_verify", label: "FTS index verify", desc: "Prove the evidence_fts search index matches its content; rebuild if not.", fields: [] },
  { type: "db_maintenance", task: "wal_checkpoint", label: "WAL checkpoint", desc: "Fold the write-ahead log back in + truncate the -wal sidecar.", fields: [] },
  { type: "db_maintenance", task: "orphans", label: "Orphan scan", desc: "Integrity + every dangling cross-table reference (evidence→rep, facts→entity…).", fields: [] },
  { type: "db_maintenance", task: "duplicate_entities", label: "Duplicate-entity scan", desc: "Flag any strong id claimed by more than one entity (the 96-in-1 bug guard).", fields: [] },
  { type: "db_maintenance", task: "drift_scan", label: "Stale-JSON drift · detect", desc: "Typed ledger rows older than the evidence blob they came from (re-extraction due).", fields: [] },
  { type: "db_maintenance", task: "freshness", label: "Freshness / source health", desc: "Classify per-source fetch health (rotted / quiet / stale).", fields: [] },
  { type: "db_maintenance", task: "staleness_ingest", label: "Staleness → enqueue ingest", desc: "Queue an incremental ingest for reps never fetched or stale >7d.", fields: [] },
  { type: "db_maintenance", task: "reclaim_zombies", label: "Reclaim zombie jobs", desc: "Requeue jobs stuck 'running' from a crash/restart.", fields: [] },
  { type: "db_maintenance", task: "cache_prune", label: "Cache prune", desc: "Trim fetch-run telemetry + old finished jobs. Caches only — never ledgers.", fields: [] },
  { type: "db_maintenance", task: "optimize", label: "Optimize (ANALYZE)", desc: "Refresh the query-planner statistics. Cheap + safe.", fields: [] },
  { type: "db_maintenance", task: "backup", label: "Backup now", desc: "Rotating VACUUM INTO backup (defragmented, no -wal sidecar).", fields: [] },
  { type: "db_maintenance", task: "backup_verify", label: "Verify newest backup", desc: "Open the latest backup read-only and quick_check it — an unverified backup is a hope, not a backup.", fields: [] },
];
const OPS_MAINT_DANGER = [
  { type: "db_maintenance_danger", task: "vacuum", label: "VACUUM (full rewrite)", desc: "Backup, then rewrite the whole file to reclaim dead space. Expensive.", danger: "MAINTAIN", fields: [] },
  { type: "db_maintenance_danger", task: "drift_heal", label: "Stale-JSON drift · heal", desc: "Delete stale typed rows for drifted evidence and re-extract them from the current blob. Optionally cap how many.", danger: "MAINTAIN", fields: [{ k: "limit", ph: "limit (blank = all)", type: "number" }] },
];

const opsToken = () => ($("#ops-token").value.trim() || localStorage.getItem("pb_admin_token") || "");
let opsRosterPage = 1;

async function opsFetch(path, opts = {}) {
  const token = opsToken();
  if (!token) { $("#ops-status").textContent = "Enter your admin token to connect."; return null; }
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { "x-admin-token": token, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
  } catch { $("#ops-status").textContent = "✗ Network error."; return null; }
  if (res.status === 401) { $("#ops-status").textContent = "✗ Unauthorized — wrong admin token."; return null; }
  if (!res.ok) return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return res.json().catch(() => null);
}

function showOps() {
  hideAllViews();
  $("#ops-view").hidden = false;
  window.scrollTo(0, 0);
  const saved = localStorage.getItem("pb_admin_token");
  if (saved && !$("#ops-token").value) $("#ops-token").value = saved;
  renderOpsCommands();
  if (saved) opsConnect();
}

function opsCmdCard(c) {
  const fields = (c.fields || []).map((f) => {
    if (f.type === "checkbox") return `<label class="ck"><input type="checkbox" data-k="${f.k}" /> ${esc(f.label || f.k)}</label>`;
    if (f.type === "select") return `<select data-k="${f.k}">${f.opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    return `<input type="${f.type === "number" ? "number" : "text"}" data-k="${f.k}" placeholder="${esc(f.ph || f.k)}" />`;
  }).join("");
  const dangerInput = c.danger ? `<input type="text" data-k="confirmPhrase" placeholder="type ${esc(c.danger)}" />` : "";
  // db_maintenance cards carry their tier/task as data-* so opsRun folds it into the
  // payload (the type is shared across many cards; the tier/task selects the work).
  const extra = `${c.task ? ` data-task="${esc(c.task)}"` : ""}${c.tier ? ` data-tier="${esc(c.tier)}"` : ""}`;
  return `<div class="ops-cmd" data-type="${esc(c.type)}"${extra}>
    <h4>${esc(c.label)}</h4><p class="desc">${esc(c.desc)}</p>
    <div class="row">${fields}${dangerInput}</div>
    <button class="${c.danger ? "ghost" : "primary"} ops-run" type="button">Run</button>
    <span class="ops-run-status muted small"></span>
  </div>`;
}
function renderOpsCommands() {
  $("#ops-commands").innerHTML = OPS_COMMANDS.map(opsCmdCard).join("");
  $("#ops-danger-body").innerHTML = OPS_DANGER.map(opsCmdCard).join("");
  $("#ops-presets").innerHTML = OPS_PRESETS.map((p) => `<div class="ops-cmd" data-preset="${esc(p.key)}">
    <h4>${esc(p.label)}</h4><p class="desc">${esc(p.desc)}</p>
    <p class="muted small">${p.steps.map((s) => esc(s.type)).join(" → ")}</p>
    <button class="primary ops-preset-run" type="button">Run chain</button>
    <span class="ops-run-status muted small"></span>
  </div>`).join("");
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

async function opsRunPreset(el) {
  const preset = OPS_PRESETS.find((p) => p.key === el.dataset.preset);
  const statusEl = el.querySelector(".ops-run-status");
  statusEl.textContent = "Queuing chain…";
  let last = null, n = 0;
  for (const step of preset.steps) {
    const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type: step.type, payload: step.payload ?? {} }) });
    if (!res || res.error) { statusEl.textContent = `✗ ${res?.error ?? "failed"} at ${step.type}`; return; }
    last = res; n++;
  }
  statusEl.textContent = `queued ${n} job(s)`;
  loadOpsJobs();
  if (last) openOpsDrawer(last.id, preset.steps.at(-1).type);
}

function opsCollectPayload(cmdEl) {
  const payload = {};
  cmdEl.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.dataset.k;
    if (el.type === "checkbox") { if (el.checked) payload[k] = true; }
    else if (el.value !== "") payload[k] = el.type === "number" ? Number(el.value) : el.value;
  });
  return payload;
}

async function opsRun(cmdEl) {
  const type = cmdEl.dataset.type;
  const statusEl = cmdEl.querySelector(".ops-run-status");
  statusEl.textContent = "Queuing…";
  const payload = opsCollectPayload(cmdEl);
  if (cmdEl.dataset.task) payload.task = cmdEl.dataset.task;   // maintenance single-task cards
  if (cmdEl.dataset.tier) payload.tier = cmdEl.dataset.tier;   // maintenance tier cards
  const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type, payload }) });
  if (!res) { statusEl.textContent = "✗ failed"; return; }
  if (res.error) { statusEl.textContent = "✗ " + res.error; return; }
  statusEl.textContent = `queued ${String(res.id).slice(0, 8)}`;
  loadOpsJobs();
  openOpsDrawer(res.id, type);
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
  if (window.__opsTimer) clearInterval(window.__opsTimer);
  window.__opsTimer = setInterval(() => {
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

const opsWhen = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toISOString().slice(0, 10); };
const opsClock = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toLocaleTimeString(); };
const opsBytes = (n) => { if (n == null) return "?"; const u = ["B", "KB", "MB", "GB"]; let i = 0, v = Number(n); while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };

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

async function loadOpsHealth() {
  const days = Number($("#ops-health-days").value) || 14;
  const d = await opsFetch(`/api/admin/ops/health?days=${days}`);
  if (!d || d.error) return;
  const rows = d.rows || [], rotted = new Set((d.rotted || []).map((r) => r.source)), quiet = new Set((d.quiet || []).map((r) => r.source)), stale = new Set((d.stale || []).map((r) => r.source));
  // ROTTED = actually failing (errors). QUIET = runs clean but never finds anything —
  // NOT broken, just rare-hit or an unconfigured optional source (e.g. missing MCA_DB_PATH).
  const badge = (s) => rotted.has(s) ? `<span class="ops-badge rotted">ROTTED</span>` : stale.has(s) ? `<span class="ops-badge stale">STALE</span>` : quiet.has(s) ? `<span class="ops-badge quiet" title="runs cleanly but has found 0 items — likely rare-hit or unconfigured, not broken">QUIET</span>` : `<span class="ops-badge ok">ok</span>`;
  const sorted = [...rows].sort((a, b) => (a.ok_rate - b.ok_rate) || (a.total_items - b.total_items));
  $("#ops-health").innerHTML = (rows.length ? `<table class="ops-table"><thead><tr><th>source</th><th>status</th><th>runs</th><th>ok%</th><th>items</th><th>last ok</th></tr></thead><tbody>${sorted.map((r) => `<tr><td>${esc(r.source)}</td><td>${badge(r.source)}</td><td>${esc(r.runs)}</td><td>${Math.round((r.ok_rate ?? 0) * 100)}%</td><td>${esc(r.total_items)}</td><td>${esc(opsWhen(r.last_success_at))}</td></tr>`).join("")}</tbody></table>` : `<p class="muted small">No fetch runs recorded in this window.</p>`);
}

// ── Health tab: DB maintenance ─────────────────────────────────────────────
const OPS_MAINT_BADGE = (s) => {
  const cls = s === "red" ? "rotted" : s === "warn" ? "stale" : "ok";
  const label = s === "green" ? "ok" : s;
  return `<span class="ops-badge ${cls}">${esc((label || "ok").toUpperCase())}</span>`;
};

// Render one finding as a row: task, status badge, and a compact detail summary.
function opsMaintFinding(f) {
  const skip = { task: 1, status: 1, ms: 1 };
  const bits = Object.entries(f).filter(([k]) => !skip[k])
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 80) : esc(String(v))}`)
    .join(" · ");
  return `<tr><td>${esc(f.task)}</td><td>${OPS_MAINT_BADGE(f.status)}</td><td class="muted small">${bits}</td><td class="muted small">${f.ms ?? ""}${f.ms != null ? "ms" : ""}</td></tr>`;
}

async function loadOpsMaint() {
  // Cards render immediately (don't depend on any run existing yet).
  $("#ops-maint-tiers").innerHTML = OPS_MAINT_TIERS.map(opsCmdCard).join("");
  $("#ops-maint-tasks").innerHTML = OPS_MAINT_TASKS.map(opsCmdCard).join("");
  $("#ops-maint-danger").innerHTML = OPS_MAINT_DANGER.map(opsCmdCard).join("");

  const d = await opsFetch("/api/admin/ops/maintenance?limit=20");
  if (!d || d.error) { $("#ops-maint-report").innerHTML = `<p class="muted small">No maintenance runs yet — trigger a tier above.</p>`; return; }

  const L = d.latest;
  if (!L) {
    $("#ops-maint-latest").textContent = "";
    $("#ops-maint-report").innerHTML = `<p class="muted small">No maintenance runs recorded yet. Run a tier to populate this.</p>`;
  } else {
    const findings = L.findings || [];
    const notGreen = findings.filter((f) => f.status === "red" || f.status === "warn");
    $("#ops-maint-latest").innerHTML = `— last: ${OPS_MAINT_BADGE(L.status)} ${esc(L.tier)} · ${esc(opsBytes(L.dbSize))} · ${L.durationMs}ms`;
    // Quiet-by-default: green runs collapse to a single line; warn/red list findings.
    const table = (rows) => `<table class="ops-table"><thead><tr><th>task</th><th>status</th><th>detail</th><th>time</th></tr></thead><tbody>${rows.map(opsMaintFinding).join("")}</tbody></table>`;
    $("#ops-maint-report").innerHTML = notGreen.length
      ? `<p class="small"><strong>${notGreen.length}</strong> finding(s) need a look:</p>${table(notGreen)}<details><summary class="muted small">all ${findings.length} checks</summary>${table(findings)}</details>`
      : `<p class="small">✓ All ${findings.length} checks green on the last ${esc(L.tier)} run.</p><details><summary class="muted small">show checks</summary>${table(findings)}</details>`;
  }

  const runs = d.runs || [];
  $("#ops-maint-history").innerHTML = runs.length
    ? `<table class="ops-table"><thead><tr><th>when</th><th>tier</th><th>status</th><th>findings</th><th>db size</th><th>rows</th><th>took</th></tr></thead><tbody>${runs.map((r) => `<tr><td>${esc(opsWhen(r.at))}</td><td>${esc(r.tier)}</td><td>${OPS_MAINT_BADGE(r.status)}</td><td>${esc(r.findings)}</td><td>${esc(opsBytes(r.db_size))}</td><td>${esc(r.row_count)}</td><td class="muted small">${esc(r.duration_ms)}ms</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted small">No runs yet.</p>`;

  // Tab badge: number of warn/red findings on the latest run.
  const bad = L ? (L.findings || []).filter((f) => f.status === "red" || f.status === "warn").length : 0;
  $("#ops-maintcount").textContent = bad ? String(bad) : "";
}

// Reps ticked for a batch run. Persists across pages (a Set of ids), so you can
// filter → tick a few → filter again → tick more → run on the union.
const opsSelected = new Set();
let opsRosterLastRows = [];

function opsRosterFilter() {
  const f = {};
  const q = $("#ops-rq").value.trim(); if (q) f.q = q;
  if ($("#ops-roffice").value) f.office = $("#ops-roffice").value;
  const st = $("#ops-rstate").value.trim(); if (st) f.state = st;
  if ($("#ops-rreport").value) f.hasReport = $("#ops-rreport").value;
  if ($("#ops-rev").value) f.hasEvidence = $("#ops-rev").value;
  return f;
}

function opsUpdateSelCount() {
  $("#ops-rselcount").textContent = `${opsSelected.size} selected`;
  const pageIds = opsRosterLastRows.map((p) => p.id);
  const all = pageIds.length && pageIds.every((id) => opsSelected.has(id));
  const allBox = $("#ops-rall"); if (allBox) allBox.checked = all;
}

async function loadOpsRoster(page) {
  opsRosterPage = page || opsRosterPage || 1;
  const params = new URLSearchParams({ ...opsRosterFilter(), page: opsRosterPage, pageSize: 50 });
  const d = await opsFetch(`/api/admin/ops/roster?${params.toString()}`);
  if (!d || d.error) return;
  opsRosterLastRows = d.rows;
  $("#ops-roster").innerHTML = `<table class="ops-table"><thead><tr><th></th><th>name</th><th>office</th><th>state</th><th>grade</th><th>evidence</th><th>report</th></tr></thead><tbody>${d.rows.map((p) => `<tr><td><input type="checkbox" class="ops-rsel" data-id="${esc(p.id)}" ${opsSelected.has(p.id) ? "checked" : ""} /></td><td><a href="#/rep/${esc(p.id)}">${esc(p.name)}</a></td><td>${esc(p.office)}</td><td>${esc(p.state)}</td><td>${p.grade ? esc(p.grade) + " · " + esc(p.score) : "—"}</td><td>${esc(p.evidence)}</td><td>${esc(opsWhen(p.generated_at))}</td></tr>`).join("")}</tbody></table>`;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  $("#ops-roster-pager").innerHTML = `<button class="ghost ops-rprev" type="button" ${d.page <= 1 ? "disabled" : ""}>← prev</button> ${d.total} match(es) · page ${d.page}/${pages} <button class="ghost ops-rnext" type="button" ${d.page >= pages ? "disabled" : ""}>next →</button>`;
  opsUpdateSelCount();
}

// Run the chosen action on a set. mode:"selected" uses the ticked ids; "filter"
// sends the current filter so the SERVER resolves it to the whole matching set.
async function opsBatchRun(mode) {
  const action = $("#ops-baction").value;
  const statusEl = $("#ops-batch-status");
  const body = { action };
  if (mode === "selected") {
    if (!opsSelected.size) { statusEl.textContent = "Tick at least one rep first."; return; }
    body.politicianIds = [...opsSelected];
  } else {
    body.filter = opsRosterFilter();
  }
  const costly = action === "investigate";
  const scope = mode === "selected" ? `${opsSelected.size} selected rep(s)` : "every rep matching the current filter";
  if (!confirm(`Run "${action}" on ${scope}?${costly ? "\n\nInvestigate calls the paid GLM per rep." : ""}`)) return;
  statusEl.textContent = "Queuing…";
  const r = await opsFetch("/api/admin/ops/jobs/batch", { method: "POST", body: JSON.stringify(body) });
  if (!r || r.error) { statusEl.textContent = "✗ " + (r?.error ?? "failed"); return; }
  statusEl.textContent = `queued ${r.jobs} job(s) over ${r.reps} rep(s)`;
  loadOpsJobs();
}

let __opsPaused = false;

// Reflect worker paused-state on the Pause button (and remember it for the
// toggle), and show every job currently in flight — the pool runs several at
// once, so this is a list, not a single job.
async function loadOpsQueueState() {
  const d = await opsFetch("/api/admin/ops/queue");
  if (!d || d.error) return;
  __opsPaused = !!d.paused;
  const btn = $("#ops-pause");
  if (btn) {
    btn.textContent = __opsPaused ? "▶ Resume queue" : "⏸ Pause queue";
    btn.classList.toggle("primary", __opsPaused);
    btn.classList.toggle("ghost", !__opsPaused);
  }
  const runEl = $("#ops-running");
  if (runEl) {
    const running = d.running ?? [];
    runEl.innerHTML = running.length
      ? `▶ ${running.length} in flight: ` + running.map((j) =>
          `<a href="#" class="ops-runlink" data-id="${esc(j.id)}" data-type="${esc(j.type)}">${esc(j.type)}</a>`).join(" · ")
      : (__opsPaused ? "⏸ paused — nothing will be claimed until resumed" : "");
    runEl.querySelectorAll(".ops-runlink").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault();
      openOpsDrawer(a.dataset.id, a.dataset.type);
    }));
  }
}

// Per-job action buttons depend on status: queued jobs can be cancelled + bumped +
// edited; finished/dead jobs can be re-run. Everything keeps the log button.
function opsJobActions(j) {
  const log = `<button class="ghost small ops-joblog" data-id="${esc(j.id)}" data-type="${esc(j.type)}" type="button">log</button>`;
  if (j.status === "queued") {
    return `<button class="ghost small ops-jbump" data-id="${esc(j.id)}" data-dir="1" title="raise priority" type="button">▲</button>`
      + `<button class="ghost small ops-jbump" data-id="${esc(j.id)}" data-dir="-1" title="lower priority" type="button">▼</button>`
      + `<button class="ghost small ops-jedit" data-id="${esc(j.id)}" data-type="${esc(j.type)}" title="edit payload" type="button">edit</button>`
      + `<button class="ghost small ops-jcancel" data-id="${esc(j.id)}" type="button">cancel</button>` + log;
  }
  if (j.status === "done" || j.status === "dead") {
    return `<button class="ghost small ops-jrequeue" data-id="${esc(j.id)}" type="button">re-run</button>` + log;
  }
  return log; // running
}

async function loadOpsJobs() {
  loadOpsQueueState();
  const d = await opsFetch("/api/admin/ops/jobs");
  if (!d || d.error) return;
  const cc = d.counts || {};
  $("#ops-jobcounts").textContent = Object.keys(cc).length ? "— " + Object.entries(cc).map(([k, v]) => `${v} ${k}`).join(", ") : "";
  const jobs = (d.jobs || []).slice(0, 40);
  $("#ops-jobs").innerHTML = jobs.length
    ? `<table class="ops-table"><thead><tr><th>type</th><th>status</th><th>prio</th><th>created</th><th>error</th><th></th></tr></thead><tbody>${jobs.map((j) => `<tr><td>${esc(j.type)}</td><td><span class="ops-badge ${esc(j.status)}">${esc(j.status)}</span></td><td>${esc(j.priority ?? 0)}</td><td>${esc(opsClock(j.created_at))}</td><td class="muted small">${esc((j.last_error || "").slice(0, 60))}</td><td class="ops-jactions">${opsJobActions(j)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted small">No jobs yet. Run a command above.</p>`;
}

async function opsTogglePause() {
  const next = !__opsPaused;
  const r = await opsFetch("/api/admin/ops/queue/pause", { method: "POST", body: JSON.stringify({ paused: next }) });
  if (r && !r.error) { __opsPaused = !!r.paused; loadOpsQueueState(); loadOpsJobs(); }
}

async function opsReclaim() {
  if (!confirm("Requeue jobs stuck in 'running' for >10 min (orphaned by a past crash/restart)?")) return;
  const r = await opsFetch("/api/admin/ops/queue/reclaim", { method: "POST", body: JSON.stringify({ olderThanMinutes: 10 }) });
  if (r && !r.error) { alert(`Reclaimed ${r.reclaimed} stuck job(s) → queued.`); loadOpsJobs(); }
}

async function opsTrim(spec) {
  const label = spec.status ? `all ${spec.status} jobs` : `jobs older than ${spec.olderThanDays}d`;
  if (!confirm(`Delete ${label}? Running jobs are never touched.`)) return;
  const r = await opsFetch("/api/admin/ops/jobs/trim", { method: "POST", body: JSON.stringify(spec) });
  if (r && !r.error) loadOpsJobs();
}

async function opsJobCancel(id) {
  const r = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (r && r.reason === "running") alert("That job is already in flight — it can't be stopped mid-run. Pause the queue to stop new jobs from being claimed; the in-flight ones finish on their own.");
  loadOpsJobs();
}

async function opsJobRequeue(id) {
  const r = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}/requeue`, { method: "POST" });
  if (r && r.error) alert(r.error);
  loadOpsJobs();
}

async function opsJobBump(id, dir) {
  const job = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`);
  const cur = Number(job?.job?.priority ?? 0);
  await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ priority: cur + dir }) });
  loadOpsJobs();
}

async function opsJobEdit(id) {
  const cur = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`);
  const existing = JSON.stringify(cur?.job?.payload ?? {}, null, 0);
  const next = prompt("Edit job payload (JSON). Only queued jobs are editable.", existing);
  if (next == null) return;
  let payload;
  try { payload = JSON.parse(next); } catch { alert("Not valid JSON — nothing changed."); return; }
  const r = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ payload }) });
  if (r && r.error) alert(r.error);
  loadOpsJobs();
}

function openOpsDrawer(jobId, type) {
  $("#ops-drawer").hidden = false;
  $("#ops-drawer-title").textContent = `${type} · ${String(jobId).slice(0, 8)}`;
  $("#ops-drawer-log").textContent = "";
  let since = 0;
  const poll = async () => {
    const d = await opsFetch(`/api/admin/ops/logs/${encodeURIComponent(jobId)}?since=${since}`);
    if (!d || d.error || !d.lines?.length) return;
    since = d.last;
    const el = $("#ops-drawer-log");
    el.textContent += d.lines.map((l) => l.line).join("\n") + "\n";
    el.scrollTop = el.scrollHeight;
  };
  if (window.__opsDrawerTimer) clearInterval(window.__opsDrawerTimer);
  poll();
  window.__opsDrawerTimer = setInterval(poll, 1500);
}

// ---- Engine tab ----
let __opsEngine = null; // cached /ops/engine payload (detectors + tunables meta)

async function loadOpsEngine() {
  const d = await opsFetch("/api/admin/ops/engine");
  if (!d || d.error) return;
  __opsEngine = d;
  $("#ops-engine-totals").textContent = `— ${d.totals.big} big · ${d.totals.small} small active flag(s) · ${d.version}`;
  const card = (det) => `<div class="ops-cmd" data-detector="${esc(det.id)}">
    <h4>${esc(det.label)} ${det.settings.enabled === false ? '<span class="ops-badge stale">off</span>' : ""}</h4>
    <p class="desc">${esc(det.desc)}</p>
    <p class="small"><span class="flag-chip big">${det.flags.big} big</span> <span class="flag-chip small">${det.flags.small} small</span>${det.flags.stale ? ` <span class="muted">${det.flags.stale} stale</span>` : ""} <span class="muted">· ${esc(det.category)}</span></p>
    <button class="ghost ops-det-run" type="button">Run</button>
    <button class="ghost ops-det-dry" type="button">Dry-run</button>
    <span class="ops-run-status muted small"></span>
  </div>`;
  $("#ops-engine-detectors").innerHTML = d.detectors.map(card).join("");
  // Populate the flags-tab detector filter while we have the list.
  const sel = $("#ops-fdetector");
  const cur = sel.value;
  sel.innerHTML = `<option value="">any detector</option>` + d.detectors.map((x) => `<option value="${esc(x.id)}">${esc(x.id)}</option>`).join("");
  sel.value = cur;
  loadOpsPrecision();
}

async function loadOpsPrecision() {
  const d = await opsFetch("/api/admin/ops/precision");
  if (!d || d.error) return;
  const rows = (d.detectors || []).filter((r) => r.total > 0);
  if (!rows.length) { $("#ops-precision").innerHTML = `<p class="muted small">No decisions logged yet. Approve, reject or dismiss leads in the Leads tab and this fills in.</p>`; return; }
  $("#ops-precision").innerHTML = `<table class="ops-table"><thead><tr><th>detector</th><th>approved</th><th>rejected</th><th>dismissed</th><th>GLM ✓/✗</th><th>reject rate</th><th>suggestion</th></tr></thead><tbody>${rows.map((r) => {
    const rr = r.reject_rate == null ? "—" : `${Math.round(r.reject_rate * 100)}%`;
    const warn = r.reject_rate != null && r.reject_rate >= 0.8;
    return `<tr><td>${esc(r.detector)}</td><td>${esc(r.approved)}</td><td>${esc(r.rejected)}</td><td>${esc(r.dismissed)}</td><td class="muted">${esc(r.glm_proposed)}/${esc(r.glm_dismissed)}</td><td${warn ? ' class="warn"' : ""}>${rr}</td><td class="small">${r.suggestion ? esc(r.suggestion) : '<span class="muted">—</span>'}</td></tr>`;
  }).join("")}</tbody></table>`;
}

async function opsEngineRun({ detector = null, dryRun = false } = {}) {
  const statusEl = $("#ops-engine-status");
  if (dryRun) {
    statusEl.textContent = detector ? `Dry-running ${detector}…` : "Dry-running all detectors (can take ~20s)…";
    const d = await opsFetch("/api/admin/ops/engine/dryrun", { method: "POST", body: JSON.stringify({ detector }) });
    if (!d || d.error) { statusEl.textContent = "✗ " + (d?.error ?? "failed"); return; }
    const lines = Object.entries(d.detectors)
      .filter(([, r]) => !r.skipped)
      .map(([idv, r]) => r.error ? `${idv}: ERROR ${r.error}` : `${idv}: ${r.big} big + ${r.small} small${(r.samples ?? []).length ? "\n  " + r.samples.join("\n  ") : ""}`);
    statusEl.textContent = `dry run ${d.tookMs}ms — nothing written`;
    openOpsText(`Dry run ${detector ?? "(all)"}`, lines.join("\n\n") || "no flags under current thresholds");
    return;
  }
  const payload = detector ? { detector } : {};
  const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type: "engine_scan", payload }) });
  if (!res || res.error) { statusEl.textContent = "✗ " + (res?.error ?? "failed"); return; }
  statusEl.textContent = `queued ${String(res.id).slice(0, 8)}`;
  openOpsDrawer(res.id, "engine_scan");
}

// Reuse the log drawer for plain text (dry-run results).
function openOpsText(title, text) {
  $("#ops-drawer").hidden = false;
  $("#ops-drawer-title").textContent = title;
  if (window.__opsDrawerTimer) { clearInterval(window.__opsDrawerTimer); window.__opsDrawerTimer = null; }
  $("#ops-drawer-log").textContent = text;
}

// ---- Tuning tab ----
async function loadOpsTuning() {
  if (!__opsEngine) await loadOpsEngine();
  if (!__opsEngine) return;
  // keyPrefix: engine tunables persist as engine.<gid>.<param>; the worker-pool
  // group persists as worker.<param> (same PUT endpoint validates both).
  const groupBlock = (g, keyPrefix = `engine.${g.id}.`) => `<div class="ops-tune-group" data-gid="${esc(g.id)}">
    <h4 class="ops-sub">${esc(g.label)} <span class="muted small">· ${esc(g.id)}</span></h4>
    <p class="muted small">${esc(g.desc)}</p>
    <div class="ops-tune-rows">${Object.entries(g.tunables).map(([param, meta]) => {
      const key = keyPrefix + param;
      const val = g.settings[param];
      const input = meta.type === "boolean"
        ? `<select data-key="${esc(key)}" data-def="${meta.def}"><option value="true"${val === true ? " selected" : ""}>on</option><option value="false"${val === false ? " selected" : ""}>off</option></select>`
        : `<input type="number" data-key="${esc(key)}" data-def="${meta.def}" value="${esc(val)}" ${meta.min != null ? `min="${meta.min}"` : ""} ${meta.max != null ? `max="${meta.max}"` : ""} ${meta.step != null ? `step="${meta.step}"` : `step="any"`} />`;
      return `<div class="ops-tune-row"><label title="${esc(meta.desc ?? "")}">${esc(meta.label ?? param)}</label>${input}<span class="muted small">default ${esc(meta.def)}</span><button class="ghost small ops-tune-reset" data-key="${esc(key)}" type="button">reset</button></div>`;
    }).join("")}</div>
  </div>`;
  $("#ops-tuning").innerHTML =
    (__opsEngine.worker ? `<h4 class="ops-sub">Worker pool</h4>` + groupBlock(__opsEngine.worker, "worker.") : "") +
    `<h4 class="ops-sub">Engine-wide</h4>` + __opsEngine.groups.map((g) => groupBlock(g)).join("") +
    `<h4 class="ops-sub">Detectors</h4>` + __opsEngine.detectors.map((g) => groupBlock(g)).join("");
}

async function opsSaveTuning() {
  const statusEl = $("#ops-tuning-status");
  const settings = {};
  document.querySelectorAll("#ops-tuning [data-key]").forEach((el) => {
    if (el.classList.contains("ops-tune-reset")) return;
    const v = el.tagName === "SELECT" ? el.value === "true" : Number(el.value);
    const def = el.tagName === "SELECT" ? el.dataset.def === "true" : Number(el.dataset.def);
    if (el.dataset.reset === "1") settings[el.dataset.key] = null;
    else if (v !== def) settings[el.dataset.key] = v;
  });
  if (!Object.keys(settings).length) { statusEl.textContent = "No changes."; return; }
  statusEl.textContent = "Saving…";
  const d = await opsFetch("/api/admin/ops/engine/settings", { method: "PUT", body: JSON.stringify({ settings }) });
  if (!d || d.error) { statusEl.textContent = "✗ save failed"; return; }
  statusEl.textContent = `✓ ${d.applied.length} setting(s) saved${d.errors.length ? `, ${d.errors.length} rejected: ${d.errors.map((e) => `${e.key} (${e.error})`).join("; ")}` : ""}. Applies on the next run.`;
  __opsEngine = null; // refetch resolved values next time
}

// ---- Flags tab ----
let opsFlagsPage = 1;
async function loadOpsFlags(page) {
  opsFlagsPage = page || opsFlagsPage || 1;
  const params = new URLSearchParams({ page: opsFlagsPage, pageSize: 50 });
  if ($("#ops-fdetector").value) params.set("detector", $("#ops-fdetector").value);
  if ($("#ops-fseverity").value) params.set("severity", $("#ops-fseverity").value);
  params.set("status", $("#ops-fstatus").value || "active");
  if ($("#ops-fq").value.trim()) params.set("q", $("#ops-fq").value.trim());
  const d = await opsFetch(`/api/admin/ops/flags?${params.toString()}`);
  if (!d || d.error) return;
  $("#ops-flags-summary").textContent = `— ${d.counts.big} big · ${d.counts.small} small active (all detectors)`;
  $("#ops-flags").innerHTML = d.rows.length ? d.rows.map((f) => `
    <details class="ops-flag">
      <summary><span class="flag-chip ${esc(f.severity)}">${esc(f.severity)}</span> <strong>${esc(f.subject_name ?? "?")}</strong> · ${esc(f.headline ?? "")} <span class="muted small">${esc(f.detector)} · score ${Math.round(f.score)}</span></summary>
      <div class="ops-flag-body">
        <p>${esc(f.rationale ?? "")}</p>
        ${(f.evidence ?? []).length ? `<p class="small"><strong>Evidence:</strong></p><ul class="small">${f.evidence.map((e) => `<li>${esc(e.note ?? "source")}${e.url ? ` — <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title ?? e.url)}</a>` : e.evidence_id ? ` <span class="muted">[evidence:${esc(e.evidence_id)}]</span>` : ""}</li>`).join("")}</ul>` : ""}
        ${f.politician_id ? `<p class="small"><a href="#/rep/${esc(f.politician_id)}">open profile →</a></p>` : ""}
      </div>
    </details>`).join("") : `<p class="muted small">No flags match. Run the engine from the Engine tab.</p>`;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  $("#ops-flags-pager").innerHTML = `<button class="ghost ops-fprev" type="button" ${d.page <= 1 ? "disabled" : ""}>← prev</button> ${d.total} flag(s) · page ${d.page}/${pages} <button class="ghost ops-fnext" type="button" ${d.page >= pages ? "disabled" : ""}>next →</button>`;
}

// ---- Leads tab ----
let opsLeadsPage = 1;
async function loadOpsLeads(page) {
  opsLeadsPage = page || opsLeadsPage || 1;
  const params = new URLSearchParams({ page: opsLeadsPage, pageSize: 30 });
  if ($("#ops-lstatus").value) params.set("status", $("#ops-lstatus").value);
  if ($("#ops-lvector").value) params.set("vector", $("#ops-lvector").value);
  if ($("#ops-lq").value.trim()) params.set("q", $("#ops-lq").value.trim());
  const d = await opsFetch(`/api/admin/ops/leads?${params.toString()}`);
  if (!d || d.error) return;
  $("#ops-leads-summary").textContent = "— " + Object.entries(d.byStatus).map(([k, v]) => `${v} ${k}`).join(" · ");
  const vsel = $("#ops-lvector");
  const cur = vsel.value;
  vsel.innerHTML = `<option value="">any vector</option>` + d.vectors.map((v) => `<option${v === cur ? " selected" : ""}>${esc(v)}</option>`).join("");
  const actions = (l) => [
    l.status === "detected" ? `<button class="ghost ops-lact" data-id="${esc(l.id)}" data-action="investigate" type="button">Investigate (GLM)</button>` : "",
    l.status === "proposed" ? `<button class="primary ops-lact" data-id="${esc(l.id)}" data-action="approve" type="button">Approve</button> <button class="ghost ops-lact" data-id="${esc(l.id)}" data-action="reject" type="button">Reject</button>` : "",
    ["detected", "proposed"].includes(l.status) ? `<button class="ghost ops-lact" data-id="${esc(l.id)}" data-action="dismiss" type="button">Dismiss</button>` : "",
  ].join(" ");
  $("#ops-leads").innerHTML = d.rows.length ? d.rows.map((l) => `
    <details class="ops-flag">
      <summary><span class="ops-badge ${esc(l.status)}">${esc(l.status)}</span> <strong>${esc(l.actor_name ?? l.beneficiary ?? "?")}</strong> · ${esc(l.headline ?? "")} <span class="muted small">${esc(l.vector)} · score ${Math.round(l.signal_score ?? 0)}</span></summary>
      <div class="ops-flag-body">
        <pre class="ops-lead-detail">${esc(l.detail ?? "")}</pre>
        ${(l.evidence_urls ?? []).length ? `<p class="small"><strong>Sources:</strong> ${l.evidence_urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.length > 60 ? u.slice(0, 57) + "…" : u)}</a>`).join(" · ")}</p>` : ""}
        <p class="small">${actions(l)} <span class="ops-run-status muted small"></span></p>
      </div>
    </details>`).join("") : `<p class="muted small">No leads match.</p>`;
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  $("#ops-leads-pager").innerHTML = `<button class="ghost ops-lprev" type="button" ${d.page <= 1 ? "disabled" : ""}>← prev</button> ${d.total} lead(s) · page ${d.page}/${pages} <button class="ghost ops-lnext" type="button" ${d.page >= pages ? "disabled" : ""}>next →</button>`;
}

async function opsLeadAction(btn) {
  const statusEl = btn.closest(".ops-flag-body").querySelector(".ops-run-status");
  const action = btn.dataset.action;
  if (action === "reject" && !confirm("Reject (delete) this proposed lead?")) return;
  statusEl.textContent = "…";
  const d = await opsFetch(`/api/admin/ops/leads/${encodeURIComponent(btn.dataset.id)}/action`, { method: "POST", body: JSON.stringify({ action }) });
  if (!d || d.error) { statusEl.textContent = "✗ " + (d?.error ?? "failed"); return; }
  statusEl.textContent = d.jobId ? `queued GLM job ${String(d.jobId).slice(0, 8)}` : `✓ ${d.status ?? "done"}`;
  if (d.jobId) openOpsDrawer(d.jobId, "investigate_lead");
  else loadOpsLeads();
}

// Ops wiring — elements exist at load (script is at end of body).
$("#ops-load").addEventListener("click", opsConnect);
$("#ops-token").addEventListener("keydown", (e) => { if (e.key === "Enter") opsConnect(); });
$("#ops-health-days").addEventListener("change", loadOpsHealth);
$("#ops-rsearch").addEventListener("click", () => loadOpsRoster(1));
$("#ops-rq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsRoster(1); });
$("#ops-drawer-close").addEventListener("click", () => { $("#ops-drawer").hidden = true; if (window.__opsDrawerTimer) { clearInterval(window.__opsDrawerTimer); window.__opsDrawerTimer = null; } });
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
  if (e.target.closest(".ops-rprev")) { loadOpsRoster(Math.max(1, opsRosterPage - 1)); return; }
  if (e.target.closest(".ops-rnext")) { loadOpsRoster(opsRosterPage + 1); return; }
  if (e.target.closest(".ops-fprev")) { loadOpsFlags(Math.max(1, opsFlagsPage - 1)); return; }
  if (e.target.closest(".ops-fnext")) { loadOpsFlags(opsFlagsPage + 1); return; }
  if (e.target.closest(".ops-lprev")) { loadOpsLeads(Math.max(1, opsLeadsPage - 1)); return; }
  if (e.target.closest(".ops-lnext")) { loadOpsLeads(opsLeadsPage + 1); return; }
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
