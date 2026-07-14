// home.js — landing page (stats, feed, spotlight) + the browse directory with
// its filters/chips/pagination (Task 9.6), extracted from legacy.js.
import { $, esc, avatarColor, initials, GRADE_COLORS, GRADE_TEXT, consequenceRank } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { hideAllViews } from "./views.js";
import { renderHomeRails } from "./bookmarks.js";

// ================= HOME =================

function repCardHTML(p) {
  const g = p.latest?.grade ?? "INSUFFICIENT_DATA";
  return `
    <a class="rep-card" href="#/rep/${p.id}">
      <div class="top">
        <div class="avatar" style="background:${avatarColor(p.name)}">${initials(p.name)}</div>
        <div>
          <div class="name">${esc(p.name)}</div>
          <div class="meta">${esc(p.constituency ?? "")} · ${esc(p.office ?? "")}</div>
        </div>
      </div>
      ${p.latest?.headline
        ? `<div class="headline-snip">"${esc(p.latest.headline)}"</div>`
        : `<div class="headline-snip muted">No report yet</div>`}
      <div class="bottom">
        <span class="party-pill ${p.party === "Independent" ? "independent" : ""}">${esc(p.party ?? "—")}</span>
        <div class="card-badges">
          <span class="grade-chip" style="background:${GRADE_COLORS[g]}" title="${GRADE_TEXT[g]}">${g === "INSUFFICIENT_DATA" ? "?" : g}</span>
        </div>
      </div>
    </a>`;
}

const BROWSE_PAGE = 120;
let browseShown = BROWSE_PAGE;   // how many cards currently rendered
let browseChip = null;           // active quick-filter chip

function renderHome(resetPage = true) {
  if (resetPage) browseShown = BROWSE_PAGE;
  const q = (($("#browse-search")?.value || $("#search")?.value) || "").toLowerCase();
  const fState  = $("#f-state").value;
  const fParty  = $("#f-party").value;
  const fOffice = $("#f-office").value;
  const sort    = $("#f-sort")?.value || "relevance";

  const chipOk = (p) => {
    const g = p.latest?.grade;
    switch (browseChip) {
      case "dossier":  return !!p.latest;
      case "concern":  return ["D", "E", "F"].includes(g);
      case "strong":   return ["A", "B"].includes(g);
      case "noreport": return !p.latest;
      default: return true;
    }
  };

  const filtered = state.reps.filter((p) =>
    (!fState  || p.state  === fState) &&
    (!fParty  || p.party  === fParty) &&
    (!fOffice || p.office === fOffice) &&
    chipOk(p) &&
    (!q       || `${p.name} ${p.constituency ?? ""} ${p.party ?? ""}`.toLowerCase().includes(q))
  );

  // Sort (a copy — never mutate the shared reps array)
  const sorted = filtered.slice();
  if (sort === "relevance" || sort === "grade") sorted.sort((a, b) => consequenceRank(a) - consequenceRank(b) || a.name.localeCompare(b.name));
  else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
  // "state" keeps insertion order, grouped below

  const shown = sorted.slice(0, browseShown);
  const dir = $("#directory");

  if (sort === "state") {
    const byState = {};
    for (const p of shown) (byState[p.state ?? "Other"] ??= []).push(p);
    dir.innerHTML = Object.keys(byState).sort().map((state) => `
      <div class="state-group">
        <h2>${esc(state)} <span class="count">· ${byState[state].length} rep${byState[state].length !== 1 ? "s" : ""}</span></h2>
        <div class="cards">${byState[state].map(repCardHTML).join("")}</div>
      </div>`).join("");
  } else {
    dir.innerHTML = `<div class="cards">${shown.map(repCardHTML).join("")}</div>`;
  }

  // Load-more control
  const more = sorted.length > browseShown;
  const wrap = $("#load-more-wrap");
  if (wrap) {
    wrap.hidden = !more;
    const btn = $("#load-more");
    if (btn) btn.textContent = `Load more (${(sorted.length - browseShown).toLocaleString()} more)`;
  }

  // Reflect active chip in the UI
  document.querySelectorAll(".qchip").forEach((c) => c.classList.toggle("active", c.dataset.chip === browseChip));
  $("#no-results").hidden = filtered.length > 0;
}


function buildFilters() {
  const states  = [...new Set(state.reps.map(p => p.state).filter(Boolean))].sort();
  const parties = [...new Set(state.reps.map(p => p.party).filter(Boolean))].sort();
  const offices = [...new Set(state.reps.map(p => p.office).filter(Boolean))].sort();
  $("#f-state").innerHTML  = '<option value="">All states</option>'  + states.map(s  => `<option>${esc(s)}</option>`).join("");
  $("#f-party").innerHTML  = '<option value="">All parties</option>' + parties.map(s => `<option>${esc(s)}</option>`).join("");
  $("#f-office").innerHTML = '<option value="">All offices</option>' + offices.map(s => `<option>${esc(s)}</option>`).join("");
}

function showHome() {
  hideAllViews();
  $("#home-view").hidden = false;
  window.scrollTo(0, 0);
  renderLanding();
}

// Landing: live stats strip + a "spotlight" of striking findings.
async function renderLanding() {
  // Stats strip
  const withReport = state.reps.filter((p) => p.latest).length;
  $("#landing-stats").innerHTML = [
    ["🧑‍⚖️", state.reps.length.toLocaleString(), "representatives tracked"],
    ["📄", withReport.toLocaleString(), "dossiers generated"],
    ["🏛️", "—", "scandals documented"],
  ].map(([i, n, l]) => `<div class="lstat"><span class="lstat-i">${i}</span><span class="lstat-n" data-stat="${l}">${n}</span><span class="lstat-l">${l}</span></div>`).join("");
  // Nav-card count badges (best-effort, filled as data lands)
  const setCount = (key, n) => document.querySelectorAll(`.nc-count[data-count="${key}"]`).forEach((el) => el.textContent = n);
  setCount("reps", state.reps.length.toLocaleString());
  // Fill scandal count + spotlight + feed from the APIs (best-effort).
  api("/api/scandals").then((s) => {
    if (Array.isArray(s)) {
      const el = document.querySelector('[data-stat="scandals documented"]'); if (el) el.textContent = s.length;
      setCount("scandals", s.length);
    }
  });
  api("/api/issues").then((iss) => { if (iss) setCount("issues", (Array.isArray(iss) ? iss.length : Object.keys(iss).length)); });
  renderHomeRails();
  renderFeed();
  renderSpotlight();
}

// "Latest from the investigation" — newest dossiers + newest scandals, timestamped.
function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime(); if (isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const mo = Math.floor(days / 30); return mo === 1 ? "1 month ago" : `${mo} months ago`;
}
async function renderFeed() {
  const box = $("#feed-grid");
  if (!box) return;
  box.innerHTML = Array.from({ length: 3 }, () => `<div class="feed-card skel"><span class="skel-line skel-tag"></span><span class="skel-line skel-name"></span></div>`).join("");
  const recentReports = state.reps
    .filter((p) => p.latest?.generated_at)
    .sort((a, b) => new Date(b.latest.generated_at) - new Date(a.latest.generated_at))
    .slice(0, 4);
  const scandals = (await api("/api/scandals")) ?? [];
  const items = [];
  for (const p of recentReports.slice(0, 3))
    items.push(`<a class="feed-card" href="#/rep/${p.id}">
      <span class="feed-kind kind-report">New dossier</span>
      <span class="feed-title">${esc(p.name)}</span>
      <span class="feed-sub">${esc([p.party, p.constituency].filter(Boolean).join(" · "))}</span>
      <span class="feed-time">${timeAgo(p.latest.generated_at)}</span>
    </a>`);
  for (const s of scandals.slice(0, 3))
    items.push(`<a class="feed-card" href="#/scandal/${esc(s.slug)}">
      <span class="feed-kind kind-scandal">Government Watch</span>
      <span class="feed-title">${esc(s.title)}</span>
      <span class="feed-sub">${esc([s.sector, s.minister].filter(Boolean).join(" · "))}</span>
      <span class="feed-time">${esc(s.date || "")}</span>
    </a>`);
  box.innerHTML = items.length ? items.join("") : `<p class="muted small">New investigations will appear here as they're published.</p>`;
}

async function renderSpotlight() {
  const box = $("#spotlight-grid");
  box.innerHTML = Array.from({ length: 4 }, () => `<div class="spot-card skel"><span class="skel-line skel-tag"></span><span class="skel-line skel-name"></span><span class="skel-line skel-fig"></span></div>`).join("");
  const [worst, cases, scandals] = await Promise.all([
    api("/api/leaderboard?metric=worst"),
    api("/api/leaderboard?metric=most_cases"),
    api("/api/scandals"),
  ]);
  const cards = [];
  const w = worst?.rows?.[0];
  if (w) cards.push(`<a class="spot-card spot-red" href="#/rep/${w.id}"><span class="spot-tag">Lowest accountability score</span><span class="spot-name">${esc(w.name)}</span><span class="spot-fig">${w.score}/100 · ${esc(w.party ?? "")}</span></a>`);
  const c = cases?.rows?.[0];
  if (c) cards.push(`<a class="spot-card spot-amber" href="#/rep/${c.id}"><span class="spot-tag">Most criminal cases declared</span><span class="spot-name">${esc(c.name)}</span><span class="spot-fig">${c.cases} case${c.cases !== 1 ? "s" : ""} declared</span></a>`);
  if (Array.isArray(scandals) && scandals.length) {
    const noAcc = scandals.find((s) => s.verdict === "NONE") ?? scandals[0];
    cards.push(`<a class="spot-card spot-grey" href="#/scandal/${esc(noAcc.slug)}"><span class="spot-tag">From Government Watch</span><span class="spot-name">${esc(noAcc.title)}</span><span class="spot-fig">${esc(noAcc.minister || noAcc.sector || "")}</span></a>`);
  }
  cards.push(`<a class="spot-card spot-go" href="#/leaderboard"><span class="spot-tag">See all</span><span class="spot-name">Full leaderboards →</span><span class="spot-fig">richest, fastest asset growth, most cases…</span></a>`);
  box.innerHTML = cards.join("") || `<p class="muted small">Highlights will appear here as dossiers are published.</p>`;
}

function showBrowse() {
  hideAllViews();
  $("#browse-view").hidden = false;
  window.scrollTo(0, 0);
  renderHome();
}
// Browse-page state accessors — the wiring (still in legacy/main) toggles the
// quick-filter chip and grows the rendered slice through these.
function setBrowseChip(v) { browseChip = v; }
function getBrowseChip() { return browseChip; }
function growBrowse() { browseShown += BROWSE_PAGE; }

export {
  showHome, renderLanding, timeAgo, renderFeed, renderSpotlight, showBrowse,
  renderHome, repCardHTML, buildFilters, setBrowseChip, getBrowseChip, growBrowse,
};
