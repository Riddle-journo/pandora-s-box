// ops-tuning.js — the Engine tab (detector cards, dry runs, precision table)
// and the Tuning tab (live-editable DB-backed tunables). They share the cached
// /ops/engine payload, so they stay together. Extracted verbatim from ops.js.
import { $, esc } from "./core.js";
import { opsFetch } from "./ops-shared.js";
import { openOpsDrawer, openOpsText } from "./ops-jobs.js";

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
        ? `<select data-key="${esc(key)}" data-def="${esc(meta.def)}"><option value="true"${val === true ? " selected" : ""}>on</option><option value="false"${val === false ? " selected" : ""}>off</option></select>`
        : `<input type="number" data-key="${esc(key)}" data-def="${esc(meta.def)}" value="${esc(val)}" ${meta.min != null ? `min="${esc(meta.min)}"` : ""} ${meta.max != null ? `max="${esc(meta.max)}"` : ""} ${meta.step != null ? `step="${esc(meta.step)}"` : `step="any"`} />`;
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

export { loadOpsEngine, loadOpsPrecision, opsEngineRun, loadOpsTuning, opsSaveTuning };
