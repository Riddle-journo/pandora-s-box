// admin.js — the private admin desk (Task 9.8), extracted from legacy.js:
// scandal-proposal review queue, investigation leads, all-leads pipeline,
// story drafts and the directorship-network explorer. Token-gated server side.
import { $, esc, safeUrl } from "./core.js";
import { hideAllViews } from "./views.js";
import { renderRelationGraph } from "./report-sections.js";
import { invalidateScandalsCache } from "./govwatch.js";

// ================= ADMIN — SCANDAL REVIEW QUEUE =================
const adminToken = () => $("#admin-token").value.trim();
let adminTab = "scandals";

function showAdmin() {
  hideAllViews();
  $("#admin-view").hidden = false;
  window.scrollTo(0, 0);
  const saved = localStorage.getItem("pb_admin_token");
  if (saved && !$("#admin-token").value) $("#admin-token").value = saved;
  $("#admin-list").innerHTML = ""; $("#admin-empty").hidden = true;
  $("#lead-list").innerHTML = ""; $("#lead-empty").hidden = true;
  if (saved) loadAdminQueue();
}

function loadAdminQueue() {
  if (adminTab === "leads") loadLeads();
  else if (adminTab === "conflicts") loadAllLeads();
  else if (adminTab === "stories") loadStories();
  else if (adminTab === "directorships") loadDirectorshipNetwork();
  else loadProposals();
}

// Shared admin fetch: token header + uniform error reporting. Returns json|null.
async function adminFetch(path) {
  const token = adminToken();
  if (!token) { $("#admin-status").textContent = "Enter your admin token to load the queue."; return null; }
  localStorage.setItem("pb_admin_token", token);
  $("#admin-status").textContent = "Loading…";
  let res;
  try { res = await fetch(path, { headers: { "x-admin-token": token } }); }
  catch { $("#admin-status").textContent = "✗ Network error."; return null; }
  if (res.status === 401) { $("#admin-status").textContent = "✗ Unauthorized — wrong admin token."; return null; }
  if (!res.ok) { $("#admin-status").textContent = "✗ Failed to load (HTTP " + res.status + ")."; return null; }
  return res.json().catch(() => null);
}

// ---- All Leads tab: the full private Investigator pipeline, by status ----
let leadStatusFilter = "";
const LEAD_STATUS_LABEL = { detected: "detected (code)", proposed: "proposed (AI-vetted)", published: "cleared — shared externally", dismissed: "dismissed" };
// A DIRECTOR_LINK lead (a director of a flagged company matched to a tracked
// politician/relative) gets a distinct indigo accent + a facts row, so this
// "hidden directorship" class of lead reads apart from sector/collusion leads.
const MATCH_KIND_LABEL = {
  din: "matched by exact DIN", self_name: "matched by name (the member)", relative_name: "matched by name (a relative)",
};
function directorBits(l) {
  if (l.vector !== "DIRECTOR_LINK") return { chip: "", facts: "", cardClass: "" };
  const parts = [];
  if (l.director_name) parts.push(`<span><b>Director:</b> ${esc(l.director_name)}</span>`);
  if (l.director_din) parts.push(`<span><b>DIN:</b> ${esc(l.director_din)}</span>`);
  if (l.beneficiary) parts.push(`<span><b>Company:</b> ${esc(l.beneficiary)}${l.beneficiary_cin ? ` (${esc(l.beneficiary_cin)})` : ""}</span>`);
  if (l.match_kind) parts.push(`<span><b>Match:</b> ${esc(MATCH_KIND_LABEL[l.match_kind] ?? l.match_kind)}</span>`);
  return {
    chip: `<span class="adm-chip adm-chip-director">hidden directorship</span>`,
    facts: parts.length ? `<div class="dir-facts">${parts.join("")}</div>` : "",
    cardClass: " lead-director",
  };
}

// ---- Directorship Network tab (admin-only): the company web around a politician ----
function renderDirnetLists(net) {
  let html = "";
  if (net.companies?.length) {
    html += `<div class="rel-links">` + net.companies.map((c) => `
      <div class="rel-link">
        <span class="rel-badge">${esc((c.roles || []).join(", "))}</span>
        <span>${esc(c.name)}${c.cin ? ` <span class="muted small">(${esc(c.cin)})</span>` : ""}${c.corroborated ? " ✓ corroborated" : ""}</span>
        <span class="muted small">${esc((c.sources || []).join(", "))}</span>
      </div>`).join("") + `</div>`;
  }
  if (net.codirectors?.length) {
    html += `<p class="muted small rel-fam-label">Others on the same boards:</p><div class="rel-chips">` +
      net.codirectors.map((d) => `<span class="rel-chip">${d.is_relative ? "relative · " : ""}${esc(d.name)} <em>${esc(d.role)} · ${esc(d.via_company)}</em>${d.politician_id ? ` <a class="rel-go" href="#/rep/${esc(d.politician_id)}">rep →</a>` : ""}</span>`).join("") + `</div>`;
  }
  return html;
}

async function loadDirectorshipNetwork() {
  const pid = $("#dirnet-pid").value.trim();
  const box = $("#admin-dirnet");
  $("#dirnet-empty").hidden = true;
  box.innerHTML = "";
  if (!pid) { $("#admin-status").textContent = "Enter a politician id to view their directorship network."; return; }
  const net = await adminFetch(`/api/admin/politicians/${encodeURIComponent(pid)}/directorship-network`);
  if (!net) return;
  $("#admin-status").textContent = `${net.companies?.length ?? 0} company(ies), ${net.codirectors?.length ?? 0} other director(s).`;
  if (!(net.relatives?.length || net.links?.length)) { $("#dirnet-empty").hidden = false; return; }
  // Reuse the family-graph radial renderer, then the readable company/co-director lists.
  box.innerHTML = renderRelationGraph(net.center || "This rep", net.relatives ?? [], net.links ?? []) + renderDirnetLists(net);
}

async function loadAllLeads() {
  const leads = await adminFetch(`/api/admin/conflicts${leadStatusFilter ? `?status=${leadStatusFilter}` : ""}`);
  if (!leads) return;
  $("#admin-status").textContent = `${leads.length} lead(s)${leadStatusFilter ? ` · ${LEAD_STATUS_LABEL[leadStatusFilter] ?? leadStatusFilter}` : ""}.`;
  $("#conflict-empty").hidden = leads.length > 0;
  $("#conflict-list").innerHTML = leads.map((l) => {
    const inv = l.investigation ?? {};
    const dir = directorBits(l);
    return `<div class="adm-card${esc(dir.cardClass)}">
      <div class="adm-card-head">
        <span class="adm-chip">${esc((l.vector || "").replaceAll("_", " "))}</span>
        ${dir.chip}
        <span class="adm-chip">${esc(LEAD_STATUS_LABEL[l.status] ?? l.status)}</span>
        ${l.signal_score != null ? `<span class="adm-chip">score ${esc(l.signal_score)}</span>` : ""}
        <span class="adm-date">${esc(l.actor_name ?? "")}</span>
      </div>
      <h3 class="adm-title">${esc(l.headline ?? "")}</h3>
      <p class="adm-summary">${esc(inv.summary || l.detail || "")}</p>
      ${dir.facts}
      ${(l.evidence_urls ?? []).filter(Boolean).length ? `<p class="small">Sources: ${l.evidence_urls.filter(Boolean).map((u, i) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}</p>` : ""}
    </div>`;
  }).join("");
}

// ---- Story Drafts tab: journalist handoff material (never published) ----
let storyStatusFilter = "draft";
async function loadStories() {
  const stories = await adminFetch(`/api/admin/stories?status=${storyStatusFilter}`);
  if (!stories) return;
  $("#admin-status").textContent = `${stories.length} stor${stories.length === 1 ? "y" : "ies"} (${storyStatusFilter}).`;
  $("#story-empty").hidden = stories.length > 0;
  $("#story-list").innerHTML = stories.map((s) => `
    <details class="adm-card">
      <summary><strong>${esc(s.headline ?? s.slug)}</strong> <span class="muted small">${esc(s.status)}</span></summary>
      ${s.dek ? `<p class="adm-summary">${esc(s.dek)}</p>` : ""}
      ${(s.sections ?? []).map((x) => `<h4>${esc(x.heading ?? "")}</h4><p class="small">${esc(x.body ?? "")}</p>`).join("")}
      ${(s.sources ?? []).length ? `<p class="small">Sources: ${s.sources.map((c, i) => `<a href="${safeUrl(c.url ?? "#")}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}</p>` : ""}
    </details>`).join("");
}

async function loadProposals() {
  const token = adminToken();
  if (!token) { $("#admin-status").textContent = "Enter your admin token to load the queue."; return; }
  localStorage.setItem("pb_admin_token", token);
  $("#admin-status").textContent = "Loading…";
  let res;
  try { res = await fetch("/api/admin/scandal-proposals", { headers: { "x-admin-token": token } }); }
  catch { $("#admin-status").textContent = "✗ Network error."; return; }
  if (res.status === 401) { $("#admin-status").textContent = "✗ Unauthorized — wrong admin token."; return; }
  if (!res.ok) { $("#admin-status").textContent = "✗ Failed to load (HTTP " + res.status + ")."; return; }
  const props = await res.json().catch(() => []);
  $("#admin-status").textContent = `${props.length} proposal(s) awaiting review.`;
  renderProposals(props);
}

async function loadLeads() {
  const token = adminToken();
  if (!token) { $("#admin-status").textContent = "Enter your admin token to load the queue."; return; }
  localStorage.setItem("pb_admin_token", token);
  $("#admin-status").textContent = "Loading…";
  let res;
  try { res = await fetch("/api/admin/investigation-leads", { headers: { "x-admin-token": token } }); }
  catch { $("#admin-status").textContent = "✗ Network error."; return; }
  if (res.status === 401) { $("#admin-status").textContent = "✗ Unauthorized — wrong admin token."; return; }
  if (!res.ok) { $("#admin-status").textContent = "✗ Failed to load (HTTP " + res.status + ")."; return; }
  const leads = await res.json().catch(() => []);
  $("#admin-status").textContent = `${leads.length} lead(s) awaiting review.`;
  renderLeads(leads);
}

function renderLeads(leads) {
  $("#lead-empty").hidden = leads.length > 0;
  $("#lead-list").innerHTML = (leads ?? []).map((l) => {
    const inv = l.investigation ?? {};
    const vd = { SUBSTANTIATED: "vd-full", SUGGESTIVE: "vd-partial" }[inv.verdict] ?? "";
    const dir = directorBits(l);
    return `<div class="adm-card lead-card${esc(dir.cardClass)}" data-id="${esc(l.id)}">
      <div class="adm-card-head">
        <span class="adm-chip">${esc(l.vector)}</span>
        ${dir.chip}
        <span class="adm-chip">score ${esc(l.signal_score)}</span>
        <span class="gw-verdict ${esc(vd)}">${esc(inv.verdict ?? "—")}${inv.confidence != null ? ` · ${esc(inv.confidence)}%` : ""}</span>
        <span class="adm-date">${esc(l.actor_name)}</span>
      </div>
      <h3 class="adm-title">${esc(l.headline)}</h3>
      <p class="adm-summary">${esc(inv.summary || l.detail || "")}</p>
      ${dir.facts}
      ${inv.mechanism ? `<p class="small"><strong>Mechanism:</strong> ${esc(inv.mechanism)}</p>` : ""}
      ${(inv.evidence_for ?? []).length ? `<p class="small"><strong>For:</strong> ${inv.evidence_for.map(esc).join(" · ")}</p>` : ""}
      ${(inv.evidence_against ?? []).length ? `<p class="small"><strong>Against:</strong> ${inv.evidence_against.map(esc).join(" · ")}</p>` : ""}
      ${inv.confirming_record ? `<p class="muted small">Would confirm/kill: ${esc(inv.confirming_record)}</p>` : ""}
      ${inv.referee ? `<p class="muted small">Defence review: ${esc(inv.referee.innocent_explanation || "")}${inv.referee.fully_explainable ? " (deemed fully explainable — should not normally reach this queue)" : ""}</p>` : ""}
      <div class="adm-actions">
        <button class="primary adm-approve" data-id="${esc(l.id)}" type="button">Clear — vetted for external sharing</button>
        <button class="ghost adm-reject" data-id="${esc(l.id)}" type="button">Dismiss</button>
        <span class="adm-row-status muted small"></span>
      </div>
    </div>`;
  }).join("");
}

async function decideLead(id, action, card) {
  const token = adminToken();
  if (!token) return;
  const statusEl = card.querySelector(".adm-row-status");
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  statusEl.textContent = action === "approve" ? "Clearing…" : "Dismissing…";
  let res;
  try {
    res = await fetch(`/api/admin/investigation-leads/${encodeURIComponent(id)}/${action}`, {
      method: "POST", headers: { "x-admin-token": token, "Content-Type": "application/json" }, body: "{}",
    });
  } catch { statusEl.textContent = "✗ Network error."; card.querySelectorAll("button").forEach((b) => (b.disabled = false)); return; }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    statusEl.textContent = "✗ " + (e.error ?? ("HTTP " + res.status));
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    return;
  }
  card.classList.add("adm-done");
  card.querySelector(".adm-actions").innerHTML = action === "approve"
    ? `<span class="adm-published">✓ Cleared — vetted for sharing with a journalist. Stays private to this desk.</span>`
    : `<span class="muted">✗ Dismissed and discarded.</span>`;
}

// (Admin-only) rendering of a cleared conflict-of-interest lead. `withActor`
// adds a link to the representative's card. Kept for the admin desk.
// eslint-disable-next-line no-unused-vars
function renderConflictCard(l, withActor) {
  const inv = l.investigation ?? {};
  const vd = { SUBSTANTIATED: "vd-full", SUGGESTIVE: "vd-partial" }[inv.verdict] ?? "";
  const urls = (l.evidence_urls ?? []).filter(Boolean);
  const sources = urls.length
    ? `<p class="small conflict-sources">Sources: ${urls.map((u, i) => `<a href="${safeUrl(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}</p>`
    : "";
  return `<div class="conflict-card record-card">
    <div class="conflict-head">
      <span class="adm-chip">${esc((l.vector || "").replaceAll("_", " "))}</span>
      <span class="gw-verdict ${esc(vd)}">${esc(inv.verdict ?? "—")}${inv.confidence != null ? ` · ${esc(inv.confidence)}%` : ""}</span>
      ${withActor && l.actor_name ? `<a class="conflict-actor" href="#/rep/${esc(l.actor_id)}">${esc(l.actor_name)}</a>` : ""}
    </div>
    <h4 class="conflict-title">${esc(l.headline)}</h4>
    ${inv.summary || l.detail ? `<p class="conflict-summary">${esc(inv.summary || l.detail)}</p>` : ""}
    ${inv.mechanism ? `<p class="small"><strong>Possible mechanism:</strong> ${esc(inv.mechanism)}</p>` : ""}
    ${(inv.evidence_for ?? []).length ? `<p class="small"><strong>Evidence for:</strong> ${inv.evidence_for.map(esc).join(" · ")}</p>` : ""}
    ${(inv.evidence_against ?? []).length ? `<p class="small"><strong>Evidence against:</strong> ${inv.evidence_against.map(esc).join(" · ")}</p>` : ""}
    ${inv.confirming_record ? `<p class="muted small">What would confirm or kill this: ${esc(inv.confirming_record)}</p>` : ""}
    ${sources}
    <p class="muted small conflict-disclaimer">A lead, not a proven finding — shown for public scrutiny of the underlying records.</p>
  </div>`;
}

function renderProposals(props) {
  $("#admin-empty").hidden = props.length > 0;
  $("#admin-list").innerHTML = (props ?? []).map((p) => {
    const conf = (p.confidence ?? "low");
    const econ = p.economic
      ? `<span class="adm-chip adm-econ">Economic${p.est_value_cr != null ? ` · ~₹${esc(p.est_value_cr)} cr` : ""}</span>`
      : `<span class="adm-chip">Non-economic</span>`;
    const named = p.is_named ? `<span class="adm-chip adm-named">Named scandal</span>` : "";
    return `<div class="adm-card" data-slug="${esc(p.slug)}">
      <div class="adm-card-head">
        <span class="adm-conf adm-conf-${esc(conf)}">${esc(conf)} confidence</span>
        ${econ}${named}
        ${p.sector ? `<span class="adm-chip">${esc(p.sector)}</span>` : ""}
        <span class="adm-chip">${p.govt_level === "state" ? "State" + (p.state ? " · " + esc(p.state) : "") : "Union"}</span>
        ${p.party ? `<span class="adm-chip">${esc(p.party)}</span>` : ""}
        ${p.date ? `<span class="adm-date">${esc(p.date)}</span>` : ""}
      </div>
      <h3 class="adm-title">${esc(p.title)}</h3>
      <p class="adm-summary">${esc(p.summary ?? "")}</p>
      ${p.why ? `<p class="muted small">Evidence basis: ${esc(p.why)}</p>` : ""}
      <div class="adm-actions">
        <button class="primary adm-approve" data-slug="${esc(p.slug)}" type="button">Approve &amp; publish</button>
        <button class="ghost adm-reject" data-slug="${esc(p.slug)}" type="button">Reject</button>
        <span class="adm-row-status muted small"></span>
      </div>
    </div>`;
  }).join("");
}

async function decideProposal(slug, action, card) {
  const token = adminToken();
  if (!token) return;
  const statusEl = card.querySelector(".adm-row-status");
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  statusEl.textContent = action === "approve" ? "Generating full analysis…" : "Rejecting…";
  let res;
  try {
    res = await fetch(`/api/admin/scandal-proposals/${encodeURIComponent(slug)}/${action}`, {
      method: "POST", headers: { "x-admin-token": token, "Content-Type": "application/json" }, body: "{}",
    });
  } catch { statusEl.textContent = "✗ Network error."; card.querySelectorAll("button").forEach((b) => (b.disabled = false)); return; }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    statusEl.textContent = "✗ " + (e.error ?? ("HTTP " + res.status));
    card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    return;
  }
  const data = await res.json().catch(() => ({}));
  invalidateScandalsCache(); // govwatch list is now stale
  card.classList.add("adm-done");
  card.querySelector(".adm-actions").innerHTML = action === "approve"
    ? `<span class="adm-published">✓ Published${data.verdict ? " · verdict " + esc(data.verdict) : ""} — now live in Government Watch</span>`
    : `<span class="muted">✗ Rejected and discarded.</span>`;
}
// Tab / filter state setters — the tab wiring (still in legacy/main) drives these.
function setAdminTab(v) { adminTab = v; }
function setLeadStatusFilter(v) { leadStatusFilter = v; }
function setStoryStatusFilter(v) { storyStatusFilter = v; }

export {
  showAdmin, loadAdminQueue, adminToken, adminFetch, directorBits, renderDirnetLists,
  loadDirectorshipNetwork, loadAllLeads, loadStories, loadProposals, loadLeads,
  renderLeads, decideLead, renderConflictCard, renderProposals, decideProposal,
  setAdminTab, setLeadStatusFilter, setStoryStatusFilter,
};
