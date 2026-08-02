// ops-jobs.js — the job side of the ops console: the presets/commands/danger
// catalogue, the Jobs tab (queue control, per-job actions), and the live log
// drawer that every tab opens. Extracted verbatim from ops.js.
import { $, esc } from "./core.js";
import { opsFetch, opsClock, opsCmdCard, opsCollectPayload } from "./ops-shared.js";

// Log-drawer poll handle. Owned here because the drawer owns the polling;
// ops.js stops it from the view teardown via stopOpsDrawer().
let opsDrawerTimer = null;
function stopOpsDrawer() {
  if (opsDrawerTimer) { clearInterval(opsDrawerTimer); opsDrawerTimer = null; }
}

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
  { type: "sync_org_entities", label: "Sync org catalogue", desc: "Ensure every ministry/department/PSU/regulator in server/data/orgs.js has a canonical entity + aliases. Idempotent; run after editing the catalogue.", fields: [] },
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
  if (opsDrawerTimer) clearInterval(opsDrawerTimer);
  poll();
  opsDrawerTimer = setInterval(poll, 1500);
}

// Reuse the log drawer for plain text (dry-run results).
function openOpsText(title, text) {
  $("#ops-drawer").hidden = false;
  $("#ops-drawer-title").textContent = title;
  if (opsDrawerTimer) { clearInterval(opsDrawerTimer); opsDrawerTimer = null; }
  $("#ops-drawer-log").textContent = text;
}

export {
  OPS_PRESETS, OPS_COMMANDS, OPS_DANGER, renderOpsCommands, opsRunPreset, opsRun,
  loadOpsQueueState, loadOpsJobs, opsTogglePause, opsReclaim, opsTrim,
  opsJobCancel, opsJobRequeue, opsJobBump, opsJobEdit,
  openOpsDrawer, openOpsText, stopOpsDrawer,
};
