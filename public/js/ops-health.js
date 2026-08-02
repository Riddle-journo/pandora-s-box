// ops-health.js — source-fetch health (rendered into the Overview pane) and the
// Health tab's DB-maintenance cards, latest-run report and run history.
// Extracted verbatim from ops.js.
import { $, esc } from "./core.js";
import { opsFetch, opsCmdCard, opsWhen, opsBytes } from "./ops-shared.js";

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
  return `<span class="ops-badge ${esc(cls)}">${esc((label || "ok").toUpperCase())}</span>`;
};

// Render one finding as a row: task, status badge, and a compact detail summary.
function opsMaintFinding(f) {
  const skip = { task: 1, status: 1, ms: 1 };
  const bits = Object.entries(f).filter(([k]) => !skip[k])
    // Both branches must esc(): a finding's detail object routinely carries a
    // scraped string, and this page reads the admin token from localStorage, so
    // an injection here is a token-exfiltration path, not a cosmetic slip.
    .map(([k, v]) => `${esc(k)}=${esc(typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v))}`)
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

export { OPS_MAINT_TIERS, OPS_MAINT_TASKS, OPS_MAINT_DANGER, loadOpsHealth, loadOpsMaint };
