// govwatch.js — Government Watch: the scandal corpus list + detail pages
// (Task 9.7), extracted from legacy.js. Owns the /api/scandals cache.
import { $, esc, icon, SIGNAL_DOT, VERDICT_LABEL } from "./core.js";
import { api } from "./api.js";
import { hideAllViews } from "./views.js";

// ================= GOVERNMENT WATCH (scandals) =================
// (SIGNAL_DOT / VERDICT_LABEL now live in core.js and are shared across views.)
let scandalsCache = null;

async function showGovWatch() {
  hideAllViews();
  $("#govwatch-view").hidden = false;
  window.scrollTo(0, 0);
  if (!scandalsCache) scandalsCache = (await api("/api/scandals")) ?? [];
  // Populate filter dropdowns once from facets.
  const facets = (await api("/api/scandals/facets")) ?? { states: [], parties: [], sectors: [] };
  const opt = (arr, label) => `<option value="">${label}</option>` + (arr ?? []).map((s) => `<option>${esc(s)}</option>`).join("");
  $("#gw-sector").innerHTML = opt(facets.sectors, "All sectors");
  $("#gw-state").innerHTML  = opt(facets.states, "All states");
  $("#gw-party").innerHTML  = opt(facets.parties, "All parties");
  renderGovList();
}

function renderGovList() {
  const lvl = $("#gw-level").value, sec = $("#gw-sector").value;
  const st = ($("#gw-state").value || "").toLowerCase(), pa = ($("#gw-party").value || "").toLowerCase();
  const q = ($("#gw-search").value || "").toLowerCase();
  const items = (scandalsCache ?? []).filter((s) =>
    (!lvl || s.govt_level === lvl) &&
    (!sec || s.sector === sec) &&
    (!st  || (s.state || "").toLowerCase() === st) &&
    (!pa  || (s.party || "").toLowerCase() === pa) &&
    (!q   || `${s.title} ${s.headline} ${s.minister} ${s.ministry} ${s.party}`.toLowerCase().includes(q)));
  const cnt = $("#gw-count"); if (cnt) cnt.textContent = `${items.length} of ${(scandalsCache ?? []).length} scandals`;
  $("#gw-empty").hidden = items.length > 0;
  $("#gw-list").innerHTML = items.map((s) => {
    const vd = VERDICT_LABEL[s.verdict] ?? { txt: "—", cls: "" };
    return `<a class="gw-card" href="#/scandal/${esc(s.slug)}">
      <div class="gw-card-top">
        <span class="gw-signal">${SIGNAL_DOT[s.signal] ?? SIGNAL_DOT.GREY}</span>
        <span class="gw-card-title">${esc(s.title)}</span>
      </div>
      <div class="gw-card-meta">
        <span class="gw-tag">${esc(s.sector ?? "")}</span>
        <span class="gw-tag gw-level-${esc(s.govt_level)}">${s.govt_level === "union" ? "Union" : "State"}${s.state ? " · " + esc(s.state) : ""}</span>
        <span class="gw-date">${esc(s.date ?? "")}</span>
      </div>
      ${s.headline ? `<p class="gw-headline">${esc(s.headline)}</p>` : ""}
      <div class="gw-card-foot">
        ${s.minister ? `<span class="gw-minister">Minister: <strong>${esc(s.minister)}</strong></span>` : `<span class="muted small">Minister: on record</span>`}
        <span class="gw-verdict ${esc(vd.cls)}">${vd.txt}</span>
      </div>
    </a>`;
  }).join("");
}

async function showScandal(slug) {
  hideAllViews();
  $("#scandal-view").hidden = false;
  window.scrollTo(0, 0);
  const box = $("#scandal-body");
  box.innerHTML = `<p class="muted center">Loading…</p>`;
  const s = await api(`/api/scandals/${encodeURIComponent(slug)}`);
  if (!s) { box.innerHTML = `<p class="muted center">This scandal analysis isn't available yet.</p>`; return; }
  box.innerHTML = renderScandal(s);
}

function renderScandal(s) {
  const acc = s.accountability ?? {};
  const vd = VERDICT_LABEL[acc.verdict] ?? { txt: "—", cls: "" };
  const m = s.minister_in_charge ?? {};

  const yesno = (b) => b ? "✓ Yes" : "✗ No";
  const indianRows = (s.indian_precedents ?? []).filter((p) => p.incident).map((p) => `
    <div class="prec-row">
      <div class="prec-when">${esc(p.year ?? "")}</div>
      <div class="prec-what"><strong>${esc(p.incident)}</strong>${p.minister ? ` — ${esc(p.minister)}` : ""}
        <div class="prec-action">${esc(p.what_they_did ?? "")}${p.source_hint ? ` <span class="muted small">(${esc(p.source_hint)})</span>` : ""}</div>
      </div>
    </div>`).join("");

  const intlRows = (s.international_precedents ?? []).filter((p) => p.country || p.incident).map((p) => {
    const f = p.freedom;
    const fb = f ? `<span class="freedom-badge fb-${esc((f.status||'').toLowerCase().replace(/\s+/g,'-'))}" title="Freedom House: ${esc(f.status)} (${esc(f.fh_score)}/100) · RSF press-freedom rank ${esc(f.rsf_rank)}/180">${esc(f.status)} · press rank #${f.rsf_rank}</span>` : "";
    return `<div class="prec-row">
      <div class="prec-when"><strong>${esc(p.country ?? "")}</strong> ${fb}<div class="muted small">${esc(p.year ?? "")}</div></div>
      <div class="prec-what"><strong>${esc(p.incident ?? "")}</strong>${p.official ? ` — ${esc(p.official)}` : ""}
        <div class="prec-action">${esc(p.what_they_did ?? "")}${p.source_hint ? ` <span class="muted small">(${esc(p.source_hint)})</span>` : ""}</div>
      </div>
    </div>`;
  }).join("");

  return `
    <div class="scandal-head">
      <span class="gw-signal-lg">${SIGNAL_DOT[s.signal] ?? SIGNAL_DOT.GREY}</span>
      <div>
        <h2 class="scandal-title">${esc(s.title)}</h2>
        <div class="gw-card-meta">
          <span class="gw-tag">${esc(s.sector ?? "")}</span>
          <span class="gw-tag gw-level-${esc(s.govt_level)}">${s.govt_level === "union" ? "Union" : "State"}${s.state ? " · " + esc(s.state) : ""}</span>
          <span class="gw-date">${esc(s.date ?? "")}</span>
        </div>
      </div>
    </div>

    ${s.headline ? `<p class="scandal-headline">${esc(s.headline)}</p>` : ""}
    <div class="card"><p>${esc(s.what_happened ?? "")}</p></div>

    <div class="scandal-grid">
      <div class="scandal-panel">
        <h3>Minister responsible</h3>
        ${m.name
          ? `<p class="big-fact">${s.minister_politician_id ? `<a href="#/rep/${esc(s.minister_politician_id)}" class="minister-link">${esc(m.name)} →</a>` : esc(m.name)}</p>
             <p class="muted small">${esc(m.portfolio ?? "")}${m.party ? " · " + esc(m.party) : ""}${m.tenure ? " · " + esc(m.tenure) : ""}</p>
             ${s.minister_politician_id ? `<p class="small">View their full dossier for the complete record.</p>` : ""}`
          : `<p class="muted">Not established from the record provided.</p>`}
      </div>
      <div class="scandal-panel">
        <h3>Accountability verdict</h3>
        <p class="gw-verdict ${esc(vd.cls)} verdict-lg">${vd.txt}</p>
        <p class="muted small">${esc(acc.verdict_reason ?? "")}</p>
      </div>
    </div>

    <div class="card accountability-card">
      <h3>What followed</h3>
      <p>${esc(acc.action_taken ?? "No documented action on record.")}</p>
      <div class="acc-facts">
        <span>Minister resigned: <strong>${yesno(acc.resigned)}</strong></span>
        <span>Inquiry ordered: <strong>${yesno(acc.inquiry_ordered)}</strong></span>
        <span>Prosecution: <strong>${esc(acc.prosecution || "—")}</strong></span>
        <span>Status: <strong>${esc(acc.status || "—")}</strong></span>
      </div>
      ${acc.compensation_or_remedy ? `<p class="small"><strong>Remedy:</strong> ${esc(acc.compensation_or_remedy)}</p>` : ""}
    </div>

    ${indianRows ? `<section class="prec-section">
      <h3>How India handled similar failures before</h3>
      <div class="prec-list">${indianRows}</div>
    </section>` : ""}

    ${intlRows ? `<section class="prec-section">
      <h3>How other countries handled comparable failures</h3>
      <p class="muted small">Each country is annotated with its democratic standing — "press rank" is the RSF World Press Freedom rank (of 180). It tells you whether accountability there is the norm or the exception.</p>
      <div class="prec-list">${intlRows}</div>
    </section>` : ""}

    ${s.pattern_note ? `<div class="card pattern-section"><h3>Pattern note</h3><p>${esc(s.pattern_note)}</p></div>` : ""}

    ${(s.sources ?? []).length ? `<section class="prec-section">
      <h3>Sources</h3>
      <ul class="src-list">${s.sources.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </section>` : ""}

    <div class="related-links">
      <span class="related-label">Explore related</span>
      ${s.minister_politician_id ? `<a href="#/rep/${esc(s.minister_politician_id)}" class="related-link">${icon("users")} ${esc(m.name || "Minister")}'s dossier</a>` : ""}
      <a href="#/scorecards" class="related-link">${icon("bar-chart")} Accountability scorecards</a>
      ${s.party ? `<a href="#/funding" class="related-link">${icon("banknote")} ${esc(s.party)} funding</a>` : ""}
      <a href="#/govwatch" class="related-link">${icon("landmark")} More in Government Watch</a>
    </div>

    <p class="muted small scandal-foot">Generated by ${esc(s.model ?? "AI")} from public reporting and official records · ${s.generated_at ? new Date(s.generated_at).toLocaleDateString() : ""}. Accountability grading reflects the documented public record; pending cases are charges, not convictions. This is analysis of governance, not an allegation against any individual.</p>
  `;
}
// Cache accessors: the gw-search autocomplete (wired in init) reads the list,
// and the admin desk invalidates it after publishing a new scandal.
function getScandalsCache() { return scandalsCache; }
function invalidateScandalsCache() { scandalsCache = null; }

export { showGovWatch, renderGovList, showScandal, renderScandal, getScandalsCache, invalidateScandalsCache };
