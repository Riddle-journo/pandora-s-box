// funding.js — Follow the Money: the electoral-bond funding overview page
// (Task 9.7), extracted from legacy.js. (The per-rep funding panel on the
// report page renders via report-sections.js's renderPartyFunding.)
import { $, esc } from "./core.js";
import { api } from "./api.js";
import { hideAllViews } from "./views.js";

// ================= FOLLOW THE MONEY =================
let fundingCache = null, fundActiveTab = "party";
async function showFunding() {
  hideAllViews();
  $("#funding-view").hidden = false;
  window.scrollTo(0, 0);
  if (!fundingCache) fundingCache = await api("/api/funding/overview");
  renderFundingOverview();
}
function renderFundingOverview() {
  const f = fundingCache;
  if (!f) { $("#funding-overview-body").innerHTML = `<p class="muted center">Couldn't load funding data.</p>`; return; }
  let html = "";
  if (fundActiveTab === "party") {
    const max = f.party_totals[0]?.total_cr || 1;
    html = `<div class="fund-bars">${f.party_totals.map((p) => `
      <div class="fund-bar-row">
        <a class="fund-bar-label" href="#/?party=${encodeURIComponent(p.party)}">${esc(p.party)} <span class="muted">(${esc(p.abbr)})</span></a>
        <div class="fund-bar-track"><div class="fund-bar-fill" style="width:${Math.max(2, p.total_cr / max * 100)}%"></div></div>
        <span class="fund-bar-amt">₹${p.total_cr.toLocaleString()} cr</span>
      </div>`).join("")}</div>`;
  } else if (fundActiveTab === "sector") {
    const max = f.sectors[0]?.total_cr || 1;
    html = `<div class="fund-bars">${f.sectors.map((s) => `
      <div class="fund-bar-row">
        <span class="fund-bar-label">${esc(s.sector)} <span class="muted small">(${s.donor_count} donor${s.donor_count !== 1 ? "s" : ""} → ${esc(s.parties.join(", "))})</span></span>
        <div class="fund-bar-track"><div class="fund-bar-fill sect" style="width:${Math.max(2, s.total_cr / max * 100)}%"></div></div>
        <span class="fund-bar-amt">₹${s.total_cr.toLocaleString()} cr</span>
      </div>`).join("")}</div>`;
  } else {
    html = `<div class="fund-list">${f.top_donors.map((d) => `
      <div class="fund-row"><span class="fund-donor">${esc(d.donor)}</span><span class="fund-sector">${esc(d.sector)} → ${esc(d.parties.join(", "))}</span><span class="fund-amt">₹${d.total_cr.toLocaleString()} cr</span></div>`).join("")}</div>`;
  }
  $("#funding-overview-body").innerHTML = `<p class="muted small">${esc(f.note)}</p>` + html;
}
function setFundActiveTab(v) { fundActiveTab = v; }

export { showFunding, renderFundingOverview, setFundActiveTab };
