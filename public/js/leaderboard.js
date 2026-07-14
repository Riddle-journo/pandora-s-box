// leaderboard.js — the rankings page (Task 9.9), extracted from legacy.js.
import { $, esc } from "./core.js";
import { api } from "./api.js";
import { hideAllViews } from "./views.js";

// ================= LEADERBOARD =================
let lbMetric = "worst";
async function showLeaderboard() {
  hideAllViews();
  $("#leaderboard-view").hidden = false;
  window.scrollTo(0, 0);
  await renderLeaderboard();
}
async function renderLeaderboard() {
  const data = await api(`/api/leaderboard?metric=${encodeURIComponent(lbMetric)}`);
  if (!data) { $("#lb-body").innerHTML = `<p class="muted center">No reports yet.</p>`; return; }
  $("#lb-tabs").innerHTML = data.metrics.map((m) =>
    `<button class="lb-tab${m.key === lbMetric ? " active" : ""}" data-lb="${m.key}">${esc(m.label)}</button>`).join("");
  const fmt = (r) => {
    switch (data.metric) {
      case "most_cases": return `${r.cases} case${r.cases !== 1 ? "s" : ""} declared`;
      case "richest": return r.net_worth ?? "—";
      case "asset_growth": return r.asset_growth_x ? `${Number(r.asset_growth_x).toFixed(1)}×` : "—";
      default: return `${r.score}/100 (${r.grade})`;
    }
  };
  $("#lb-body").innerHTML = `<h3 class="lb-h">${esc(data.label)}</h3>` + (data.rows.length
    ? `<ol class="lb-list">` + data.rows.map((r, i) => `
        <li class="lb-row">
          <span class="lb-rank">${i + 1}</span>
          <a class="lb-name" href="#/rep/${r.id}">${esc(r.name)}</a>
          <span class="lb-meta">${esc(r.party ?? "")} · ${esc(r.office ?? "")}${r.state ? " · " + esc(r.state) : ""}</span>
          <span class="lb-fig">${esc(fmt(r))}</span>
        </li>`).join("") + `</ol>`
    : `<p class="muted center">Not enough data for this ranking yet.</p>`);
}
function setLbMetric(v) { lbMetric = v; }

export { showLeaderboard, renderLeaderboard, setLbMetric };
