// scorecards.js — accountability scorecards by party/government/ministry/sector
// (Task 9.7), extracted from legacy.js.
import { $, esc, SIGNAL_DOT, VERDICT_LABEL } from "./core.js";
import { api } from "./api.js";
import { hideAllViews } from "./views.js";

// ================= ACCOUNTABILITY SCORECARDS =================
let scorecardCache = null, scActiveTab = "byParty";

async function showScorecards() {
  hideAllViews();
  $("#scorecards-view").hidden = false;
  window.scrollTo(0, 0);
  if (!scorecardCache) scorecardCache = await api("/api/scorecards");
  $("#scorecards-empty").hidden = !!(scorecardCache && scorecardCache.total_scandals > 0);
  renderScorecardTab();
}

function renderScorecardTab() {
  const sc = scorecardCache;
  if (!sc || !sc.total_scandals) { $("#scorecards-body").innerHTML = ""; return; }
  const rows = sc[scActiveTab] ?? [];
  const rateBar = (r) => {
    if (r == null) return `<span class="muted small">n/a</span>`;
    const col = r >= 67 ? "var(--good)" : r >= 34 ? "var(--mid)" : "var(--bad)";
    return `<div class="sc-bar-wrap"><div class="sc-bar" style="width:${esc(r)}%;background:${esc(col)}"></div><span class="sc-bar-val">${r}%</span></div>`;
  };
  $("#scorecards-body").innerHTML = `
    <p class="muted small sc-count">${sc.total_scandals} documented failures analysed · accountability across the corpus: ${sc.totals.FULL} full · ${sc.totals.PARTIAL} partial · ${sc.totals.NONE} none</p>
    <div class="sc-table">
      <div class="sc-row sc-head">
        <div>${scActiveTab === "byParty" ? "Party" : scActiveTab === "byGovernment" ? "Government" : scActiveTab === "byMinistry" ? "Ministry" : "Sector"}</div>
        <div class="sc-c">Failures</div><div class="sc-c">Resigned</div><div class="sc-c">Prosecuted</div><div class="sc-rate">Accountability rate</div>
      </div>
      ${rows.map((b) => `
        <details class="sc-row-group">
          <summary class="sc-row">
            <div class="sc-label">${esc(b.label)}${b.card_key ? ` <a class="prov-chip" href="${scActiveTab === "byParty" ? `#/party/${esc(b.card_key)}` : `#/org/${esc(b.card_key)}`}">report card →</a>` : ""}</div>
            <div class="sc-c">${b.total}</div>
            <div class="sc-c">${b.resignations}</div>
            <div class="sc-c">${b.prosecutions}</div>
            <div class="sc-rate">${rateBar(b.accountability_rate)}</div>
          </summary>
          <div class="sc-detail">
            ${b.scandals.map((s) => `<a href="#/scandal/${esc(s.slug)}" class="sc-scandal">
              <span class="gw-signal">${SIGNAL_DOT[s.signal] ?? SIGNAL_DOT.GREY}</span>
              <span class="sc-sc-title">${esc(s.title)}</span>
              <span class="gw-verdict ${esc((VERDICT_LABEL[s.verdict]||{}).cls || '')}">${(VERDICT_LABEL[s.verdict]||{}).txt || "—"}</span>
            </a>`).join("")}
          </div>
        </details>`).join("")}
    </div>`;
}
function setScActiveTab(v) { scActiveTab = v; }

export { showScorecards, renderScorecardTab, setScActiveTab };
