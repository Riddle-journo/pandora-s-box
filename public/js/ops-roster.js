// ops-roster.js — the record-facing tabs: Roster (filter, tick, batch-run),
// Flags and Leads (paged browsers with per-lead actions). Extracted verbatim
// from ops.js. Page counters stay module-local; the pager wiring in ops.js
// reads them through the small accessors exported at the bottom.
import { $, esc, safeUrl } from "./core.js";
import { opsFetch, opsWhen } from "./ops-shared.js";
import { loadOpsJobs, openOpsDrawer } from "./ops-jobs.js";

let opsRosterPage = 1;

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
        ${(f.evidence ?? []).length ? `<p class="small"><strong>Evidence:</strong></p><ul class="small">${f.evidence.map((e) => `<li>${esc(e.note ?? "source")}${e.url ? ` — <a href="${safeUrl(e.url)}" target="_blank" rel="noopener">${esc(e.title ?? e.url)}</a>` : e.evidence_id ? ` <span class="muted">[evidence:${esc(e.evidence_id)}]</span>` : ""}</li>`).join("")}</ul>` : ""}
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
        ${(l.evidence_urls ?? []).length ? `<p class="small"><strong>Sources:</strong> ${l.evidence_urls.map((u) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener">${esc(u.length > 60 ? u.slice(0, 57) + "…" : u)}</a>`).join(" · ")}</p>` : ""}
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

const rosterPage = () => opsRosterPage;
const flagsPage = () => opsFlagsPage;
const leadsPage = () => opsLeadsPage;

export {
  opsSelected, opsRosterLastRows, opsUpdateSelCount, loadOpsRoster,
  opsBatchRun, loadOpsFlags, loadOpsLeads, opsLeadAction, rosterPage, flagsPage, leadsPage,
};
