// orgs.js — the Organizations directory (#/orgs): every ministry, department,
// PSU and regulator in the catalogue, filterable, each linking to its own
// accountability page (#/org/<key>).
import { $, esc, icon } from "./core.js";
import { api } from "./api.js";
import { showView } from "./views.js";

let orgsCache = null;
let filters = { kind: "", state: "", q: "" };

const KIND_LABEL = { ministry: "Ministry", department: "Department", psu: "PSU / Authority", regulator: "Regulator / Watchdog" };
const KIND_ICON = { ministry: "landmark", department: "file-text", psu: "banknote", regulator: "shield" };

async function loadOrgs() {
  if (!orgsCache) orgsCache = (await api("/api/orgs")) ?? [];
  return orgsCache;
}

function renderDirectory() {
  const box = $("#orgs-grid");
  if (!box || !orgsCache) return;
  const q = filters.q.toLowerCase();
  let list = orgsCache.filter((o) =>
    (!filters.kind || o.kind === filters.kind) &&
    (!filters.state || o.scope === filters.state) &&
    (!q || o.name.toLowerCase().includes(q) || (o.short ?? "").toLowerCase().includes(q)));
  // Substance first: orgs with documented failures or evidence, then A–Z.
  list = list.slice().sort((a, b) =>
    (b.failures + b.evidence_mentions) - (a.failures + a.evidence_mentions) || a.name.localeCompare(b.name));

  document.querySelectorAll("#orgs-kind-chips .qchip").forEach((c) =>
    c.classList.toggle("active", (c.dataset.kind ?? "") === filters.kind));

  if (!list.length) {
    box.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon("landmark")}</div>
      <p class="empty-title">No organizations match</p>
      <p class="muted">Try clearing the filters or searching a different name.</p></div>`;
    return;
  }
  box.innerHTML = list.map((o) => `
    <a class="org-card" href="#/org/${esc(o.key)}">
      <span class="org-kind org-kind-${esc(o.kind)}">${icon(KIND_ICON[o.kind] ?? "landmark")} ${KIND_LABEL[o.kind] ?? esc(o.kind)}${o.scope !== "union" ? ` · ${esc(o.scope)}` : ""}</span>
      <span class="org-name">${esc(o.name)}${o.short ? ` <span class="muted">(${esc(o.short)})</span>` : ""}</span>
      <span class="org-meta">
        ${o.failures ? `<span class="org-count org-count-bad">${o.failures} documented failure${o.failures !== 1 ? "s" : ""}</span>` : ""}
        ${o.evidence_mentions ? `<span class="org-count">${o.evidence_mentions} evidence mention${o.evidence_mentions !== 1 ? "s" : ""}</span>` : ""}
        ${!o.failures && !o.evidence_mentions ? `<span class="org-count org-count-clean">no adverse records in corpus</span>` : ""}
      </span>
    </a>`).join("");
}

export async function showOrgsDirectory() {
  showView("orgs");
  window.scrollTo(0, 0);
  const box = $("#orgs-grid");
  if (box && !orgsCache) box.innerHTML = Array.from({ length: 6 }, () =>
    `<div class="org-card skel"><span class="skel-line skel-tag"></span><span class="skel-line skel-name"></span></div>`).join("");
  const orgs = await loadOrgs();

  // Populate the state filter once.
  const sel = $("#orgs-state");
  if (sel && sel.options.length <= 1) {
    const states = [...new Set(orgs.map((o) => o.scope).filter((s) => s !== "union"))].sort();
    sel.innerHTML = `<option value="">All levels (union + states)</option>` +
      states.map((s) => `<option>${esc(s)}</option>`).join("");
  }
  renderDirectory();
}

export function initOrgsDirectory() {
  document.querySelectorAll("#orgs-kind-chips .qchip").forEach((c) =>
    c.addEventListener("click", () => { filters.kind = c.dataset.kind ?? ""; renderDirectory(); }));
  $("#orgs-state")?.addEventListener("change", (e) => { filters.state = e.target.value; renderDirectory(); });
  $("#orgs-search")?.addEventListener("input", (e) => { filters.q = e.target.value; renderDirectory(); });
}

// Shared with cmdk: the cached directory for search.
export async function orgsForSearch() { return loadOrgs(); }
