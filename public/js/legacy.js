// legacy.js — the not-yet-extracted remainder of the old app.js (Task 9.1).
// Each subsequent task moves a banner-comment section out into its own module
// until this file is empty. Module scope, so nothing leaks to window.
import {
  $, currentTheme, toggleTheme, syncThemeToggle,
  GRADE_COLORS, GRADE_TEXT, CONF, AVATAR_COLORS,
  esc, avatarColor, initials, barColor, confChip, withCites,
} from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { hideAllViews } from "./views.js";
import { attachAutocomplete, fuzzyScore, repSuggestions, scandalSuggestions } from "./search.js";

// ================= HOME =================

// Lower rank = more "consequential" (worst documented record first); no report last.
const GRADE_RANK = { F: 0, E: 1, D: 2, C: 3, B: 4, A: 5, INSUFFICIENT_DATA: 6 };
function consequenceRank(p) { return p.latest ? (GRADE_RANK[p.latest.grade] ?? 6) : 9; }

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

// ================= REPORT =================
function ringStyle(el, score, grade) {
  const color = GRADE_COLORS[grade] ?? "var(--na)";
  const pct = score >= 0 ? score : 0;
  el.style.background = `conic-gradient(${color} ${pct * 3.6}deg, var(--na-soft) 0deg)`;
}

function renderMethodology(report) {
  if (!state.methodology) return;
  const { scoring, parameters } = state.methodology;
  const params = report.scorecard?.parameters ?? report.parameters ?? [];
  const scored = params.filter(p => p.score >= 0);
  $("#methodology-body").innerHTML = `
    <h4>1 · Data sources</h4>
    <p class="small">Evidence is pulled from 10 source tiers: official government records (ECI affidavits, CAG audits, court judgments, Lokpal/Lokayukta, MPLADS, parliamentary records, procurement, corporate filings, RTI, land records) and from news and international databases. Official records are marked <span class="badge adm">official record</span> and carry court-admissible weight under Bharatiya Sakshya Adhiniyam 2023 ss.74-78; news is marked <span class="badge lead">news lead</span> and can only support "reported, unverified" statements. <strong>${report.evidence_count}</strong> evidence items fed this report.</p>

    <h4>2 · Investigative dossier</h4>
    <p class="small">An AI model (${esc(report.model)}) reads the evidence list and acts as an investigative journalist — it groups findings into categories, builds a career timeline, identifies red flags and highlights, and writes factual prose. It is forbidden from using outside knowledge; every claim must cite a numbered evidence item you can check yourself.</p>

    <h4>3 · Accountability scorecard (plain math, not AI)</h4>
    <p class="small">${esc(scoring.formula)}</p>
    <div class="calc">${esc(report.calc ?? `(${scored.map(p => p.score).join(" + ")}) ÷ ${scored.length} = ${report.overall_score}`)}</div>
    <table>
      <tr><th>Score</th><th>Grade</th><th>Meaning</th></tr>
      ${scoring.bands.map((b, i) => `<tr><td>${b.min}–${i === 0 ? 100 : scoring.bands[i-1].min - 1}</td><td><strong>${b.grade}</strong></td><td>${esc(b.meaning)}</td></tr>`).join("")}
    </table>

    <h4>4 · Confidence labels</h4>
    <table>
      <tr><td>${confChip("high","")}</td><td class="small">${esc(scoring.confidence_levels.high)}</td></tr>
      <tr><td>${confChip("medium","")}</td><td class="small">${esc(scoring.confidence_levels.medium)}</td></tr>
      <tr><td>${confChip("low","")}</td><td class="small">${esc(scoring.confidence_levels.low)}</td></tr>
    </table>

    <h4>5 · Scorecard parameters</h4>
    <table>${parameters.map(p => `<tr><td><strong>${esc(p.label)}</strong></td><td class="small">${esc(p.desc)}</td></tr>`).join("")}</table>

    <p class="small muted">Model: ${esc(report.model)} · Generated ${new Date(report.generated_at).toLocaleString()}</p>
  `;
}

function renderCareerTimeline(timeline) {
  if (!timeline?.length) return "";
  return timeline.map((ev) => `
    <div class="tl-item">
      <div class="tl-dot"></div>
      <div class="tl-content">
        <span class="tl-year">${esc(ev.year ?? "")}</span>
        <span class="tl-role">${esc(ev.role ?? "")}</span>
        <p class="tl-event">${esc(ev.event ?? "")}</p>
      </div>
    </div>`
  ).join("");
}

function renderCategories(categories) {
  if (!categories?.length) return "";
  return categories.map((cat) => `
    <details class="cat-card" open>
      <summary>
        <span class="cat-title">${esc(cat.title)}</span>
        <span class="cat-verdict-inline">${esc(cat.verdict ?? "")}</span>
        ${confChip(cat.confidence, cat.confidence_reason)}
      </summary>
      <div class="cat-body-wrap">
        <p class="cat-body">${withCites(cat.body, cat.citations)}</p>
        ${cat.citations?.length ? `<p class="cites">${cat.citations.map(c =>
          `[${c.n}] <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> <span class="badge ${c.admissible ? "adm" : "lead"}">${c.admissible ? "official record" : "news lead"}</span>`
        ).join(" · ")}</p>` : ""}
      </div>
    </details>`
  ).join("");
}

function renderFlags(red_flags, positive_highlights) {
  const rfHtml = (red_flags ?? []).map((rf) => `
    <div class="flag-item sev-${esc(rf.severity)}">
      <span class="flag-icon">${rf.severity === "high" ? "🔴" : rf.severity === "medium" ? "🟠" : "🟡"}</span>
      <span class="flag-text">${esc(rf.text)}</span>
    </div>`
  ).join("");

  const hlHtml = (positive_highlights ?? []).map((h) => `
    <div class="highlight-item">
      <span class="flag-icon">✅</span>
      <span class="flag-text">${esc(typeof h === "string" ? h : h.text)}</span>
    </div>`
  ).join("");

  return { rfHtml, hlHtml };
}

function renderScorecard(parameters) {
  return (parameters ?? []).map((pm) => `
    <div class="param">
      <div class="param-top">
        <span class="label">${esc(pm.label)}</span>
        <span class="pts" style="color:${barColor(pm.score)}">${pm.score < 0 ? "not scored" : pm.score + "/100"}</span>
      </div>
      <div class="bar"><i data-w="${pm.score < 0 ? 0 : pm.score}" style="background:${barColor(pm.score)}"></i></div>
      <p class="verdict">${esc(pm.verdict)}</p>
      <div>${confChip(pm.confidence, pm.confidence_reason)}</div>
      <p class="rationale">${withCites(pm.rationale, pm.citations)}</p>
      ${pm.citations?.length ? `<p class="cites">${pm.citations.map(c =>
        `[${c.n}] <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> <span class="badge ${c.admissible ? "adm" : "lead"}">${c.admissible ? "official record" : "news lead"}</span>`
      ).join(" · ")}</p>` : ""}`
    + `</div>`
  ).join("");
}

// Verified affidavit snapshot — sworn ECI facts scraped at import time.
// Shown for every representative, even before an AI report exists.
function renderSnapshot(p) {
  const a = p.affidavit ?? {};
  const cells = [];
  if (a.criminal_cases != null)
    cells.push({ label: "Criminal cases declared", value: a.criminal_cases, flag: a.criminal_cases > 0, note: "charges, not convictions" });
  if (a.assets)       cells.push({ label: "Declared assets", value: a.assets });
  if (a.liabilities)  cells.push({ label: "Declared liabilities", value: a.liabilities });
  if (a.education)    cells.push({ label: "Education", value: a.education });

  const box = $("#affidavit-snapshot");
  if (!cells.length) { box.hidden = true; return; }

  box.innerHTML = `
    <div class="snapshot-head">Sworn affidavit snapshot
      <a href="${esc(p.myneta_url ?? "#")}" target="_blank" rel="noopener" class="snapshot-src">ECI filing ↗</a>
    </div>
    <div class="snapshot-grid">
      ${cells.map((c) => `
        <div class="snap-cell ${c.flag ? "snap-flag" : ""}">
          <div class="snap-val">${esc(c.value)}</div>
          <div class="snap-label">${esc(c.label)}${c.note ? `<span class="snap-note"> · ${esc(c.note)}</span>` : ""}</div>
        </div>`).join("")}
    </div>`;
  box.hidden = false;
}

// ===== Institutional report-card sections (NayaNeeta layout) =====
const SIGNAL_ICON = { criminal: "⚖", financial: "₹", legislative: "▤", interests: "🏛", promises: "✓" };
const SIGNAL_CLASS = { RED: "sig-red", AMBER: "sig-amber", GREEN: "sig-green", GREY: "sig-grey" };

function citeList(citations) {
  if (!citations?.length) return "";
  return `<p class="cites">${citations.map((c) =>
    `[${c.n}] <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a> <span class="badge ${c.admissible ? "adm" : "lead"}">${c.admissible ? "official record" : "news lead"}</span>`
  ).join(" · ")}</p>`;
}

function renderSignalBadges(signals) {
  return (signals ?? []).map((s) => `
    <div class="signal ${SIGNAL_CLASS[s.state] ?? "sig-grey"}" title="${esc(s.label)} — ${esc(s.state)}">
      <div class="sig-top"><span class="sig-icon">${SIGNAL_ICON[s.key] ?? "•"}</span><span class="sig-label">${esc(s.label)}</span></div>
      <div class="sig-phrase">${s.phrase ? withCites(s.phrase, s.citations) : '<span class="muted">Insufficient verified data</span>'}</div>
    </div>`
  ).join("");
}

// Verified findings — computed deterministically in code (analyzer.js). Each has
// a fixed weight, shown transparently so the score is never a black box.
const VF_SEV = { SIGNIFICANT: "vf-sig", NOTABLE: "vf-note", CLEAN: "vf-clean" };
function renderVerifiedFindings(flags) {
  if (!flags?.length) return "";
  // Adverse first (most negative weight), then clean positives.
  const sorted = [...flags].sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0));
  return `<p class="vf-intro">These findings were calculated directly from the underlying records (affidavits, MPLADS data, registries) — reproducible arithmetic, not the AI's opinion. The number is each finding's fixed effect on the score.</p>` +
    sorted.map((f) => {
      const cls = VF_SEV[f.severity] ?? "vf-note";
      const wn = Number(f.weight) || 0; // coerce — never inject a raw field into HTML
      const w = wn > 0 ? `+${wn}` : `${wn}`;
      return `<div class="vf-item ${cls}">
        <span class="vf-weight ${wn >= 0 ? "vf-pos" : "vf-neg"}">${w}</span>
        <div class="vf-main">
          <span class="vf-head">${esc(f.headline)}</span>
          <span class="vf-detail">${esc(f.detail || "")}</span>
          <span class="vf-meta">${esc(f.code)} · affects <strong>${esc(f.param)}</strong></span>
        </div>
      </div>`;
    }).join("");
}

// Relationship network — named relatives + dynasty / scandal ties.
const REL_ICON = { spouse: "💍", father: "👨", mother: "👩", child: "🧒", sibling: "👥", relative: "👤" };
// Radial SVG graph of the rep's network. Nodes clickable when they point at
// another dossier/scandal. Colours come from CSS vars so it works in dark mode.
function renderRelationGraph(centerName, relatives, links) {
  const nodes = [];
  for (const l of links) nodes.push({
    label: l.target_name || l.note?.slice(0, 24) || (l.type === "DYNASTY" ? "Dynasty tie" : "Scandal tie"),
    cls: l.type === "DYNASTY" ? "rg-dynasty" : "rg-scandal",
    href: l.target_kind === "politician" ? `#/rep/${l.target_id}` : l.target_kind === "scandal" ? `#/scandal/${l.target_id}` : null,
  });
  for (const r of relatives) nodes.push({ label: r.name, sub: r.relation, cls: "rg-family", href: null });
  const shown = nodes.slice(0, 8);
  if (shown.length < 2) return ""; // not worth a graph
  const W = 620, H = 430, cx = W / 2, cy = H / 2, R = 150;
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""));
  let edges = "", circles = "";
  shown.forEach((n, i) => {
    const a = -Math.PI / 2 + (i / shown.length) * Math.PI * 2;
    const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
    edges += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="rg-edge"/>`;
    const node = `<g class="rg-node ${n.cls} ${n.href ? "rg-clickable" : ""}">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="38"/>
      <text x="${x.toFixed(1)}" y="${(y - 2).toFixed(1)}" class="rg-label">${esc(trunc(n.label, 14))}</text>
      ${n.sub ? `<text x="${x.toFixed(1)}" y="${(y + 12).toFixed(1)}" class="rg-sub">${esc(trunc(n.sub, 14))}</text>` : ""}
    </g>`;
    circles += n.href ? `<a href="${esc(n.href)}">${node}</a>` : node;
  });
  return `<div class="rel-graph-wrap"><svg viewBox="0 0 ${W} ${H}" class="rel-graph" role="img" aria-label="Relationship network for ${esc(centerName)}">
    ${edges}
    <g class="rg-node rg-center"><circle cx="${cx}" cy="${cy}" r="52"/>
      <text x="${cx}" y="${cy}" class="rg-label rg-center-label">${esc(trunc(centerName, 16))}</text></g>
    ${circles}
  </svg>
  <div class="rg-legend"><span class="rg-key rg-k-dynasty">⚡ Dynasty</span><span class="rg-key rg-k-scandal">⚠ Scandal tie</span><span class="rg-key rg-k-family">👤 Family</span><span class="rg-hint">Coloured nodes with a border are clickable</span></div>
  </div>`;
}

function renderRelations(relations, centerName) {
  const relatives = relations?.relatives ?? [], links = relations?.links ?? [];
  if (!relatives.length && !links.length) return "";
  let html = renderRelationGraph(centerName || "This rep", relatives, links);
  if (links.length) {
    html += `<div class="rel-links">` + links.map((l) => `
      <div class="rel-link rel-${l.type === "DYNASTY" ? "dynasty" : "scandal"}">
        <span class="rel-badge">${l.type === "DYNASTY" ? "⚡ Dynasty" : "⚠ Scandal tie"}</span>
        <span>${esc(l.note)}</span>
        ${l.target_kind === "politician" ? `<a class="rel-go" href="#/rep/${esc(l.target_id)}">View →</a>` : ""}
        ${l.target_kind === "scandal" ? `<a class="rel-go" href="#/scandal/${esc(l.target_id)}">View →</a>` : ""}
      </div>`).join("") + `</div>`;
  }
  if (relatives.length) {
    html += `<p class="muted small rel-fam-label">Named family on record (Wikidata):</p><div class="rel-chips">` +
      relatives.map((r) => `<span class="rel-chip">${REL_ICON[r.relation] ?? "👤"} ${esc(r.name)} <em>${esc(r.relation)}</em></span>`).join("") + `</div>`;
  }
  return html;
}

function renderCriminal(cases) {
  if (!cases?.length) return `<p class="empty-state">No criminal cases declared in Election Commission affidavits.</p>`;
  const pill = { PENDING: "pill-amber", CONVICTED: "pill-red", ACQUITTED: "pill-green", DISCHARGED: "pill-grey" };
  return cases.map((c) => `
    <div class="rec-card">
      <div class="rec-card-head">
        <span class="rec-title">${esc(c.case_type)}</span>
        <span class="status-pill ${pill[c.status] ?? "pill-grey"}">${esc(c.status)}</span>
      </div>
      <div class="rec-meta">${[c.court && esc(c.court), c.year_filed && "Filed " + esc(c.year_filed)].filter(Boolean).join(" · ")}</div>
      ${c.source_citation ? `<div class="rec-source">${withCites(c.source_citation, c.citations)}</div>` : ""}
      ${citeList(c.citations)}
    </div>`
  ).join("") + `<p class="section-foot">Affidavits are self-declared by the candidate and verified against court records where available. Pending cases are charges, not convictions.</p>`;
}

function renderFinancial(assets, growthPhrase, growthCites) {
  if (!assets?.length) return "";
  const rows = assets.map((a) => `
    <tr><td>${esc(a.election_year)}</td><td>${esc(a.total_assets || "—")}</td><td>${esc(a.total_liabilities || "—")}</td><td>${esc(a.net_worth || "—")}</td></tr>`).join("");
  const b = assets[0]?.breakdown;
  const breakdown = b && (b.immovable || b.movable || b.financial)
    ? `<div class="asset-breakdown">
        <div class="ab-item"><span>Immovable</span><strong>${esc(b.immovable || "—")}</strong></div>
        <div class="ab-item"><span>Movable</span><strong>${esc(b.movable || "—")}</strong></div>
        <div class="ab-item"><span>Financial</span><strong>${esc(b.financial || "—")}</strong></div>
      </div>` : "";
  return `
    ${growthPhrase ? `<div class="callout">${withCites(growthPhrase, growthCites)}</div>` : ""}
    <table class="rec-table">
      <tr><th>Election Year</th><th>Total Assets</th><th>Total Liabilities</th><th>Net Worth</th></tr>${rows}
    </table>${breakdown}
    <p class="section-foot">All figures are candidate self-declarations to the Election Commission of India. Independent verification of declared assets is not possible.</p>`;
}

function renderLegislative(lr) {
  if (!lr) return "";
  const blocks = [
    { v: lr.attendance_pct, label: "Attendance", src: "Digital Sansad" },
    { v: lr.questions_asked, label: "Questions Asked", src: "Lok Sabha records" },
    { v: lr.debates, label: "Debates", src: "PRS Legislative Research" },
    { v: lr.bills, label: "Bills", src: "Lok Sabha records" },
  ];
  if (!blocks.some((x) => x.v) && !lr.notable_moments?.length) return "";
  const grid = blocks.map((x) => `
    <div class="fact-block">
      <div class="fact-num">${x.v ? esc(x.v) : '<span class="na">Data not available</span>'}</div>
      <div class="fact-label">${esc(x.label)}</div>
      <div class="fact-src">${esc(x.src)}</div>
    </div>`).join("");
  const moments = lr.notable_moments?.length
    ? `<div class="moments">${lr.notable_moments.map((m) => `<div class="moment">${withCites(m.description, m.citations)}</div>`).join("")}</div>` : "";
  return `<div class="fact-grid">${grid}</div>${moments}`;
}

function renderBusiness(companies) {
  if (!companies?.length) return "";
  return companies.map((c) => `
    <div class="rec-card">
      <div class="rec-card-head"><span class="rec-title">${esc(c.name)}</span>${c.company_status ? `<span class="status-pill pill-grey">${esc(c.company_status)}</span>` : ""}</div>
      <div class="rec-meta">${[c.role, c.relation && "Relation: " + c.relation, c.cin && "CIN: " + c.cin, c.appointment_date].filter(Boolean).map(esc).join(" · ")}</div>
      ${citeList(c.citations)}
    </div>`).join("") + `<p class="section-foot">Company data cross-referenced with MCA21 where available. Relationships to the politician are as declared in EC affidavit.</p>`;
}

const STANCE = { SUPPORTS: { cls: "pill-green", t: "SUPPORTS" }, OPPOSES: { cls: "pill-red", t: "OPPOSES" }, MIXED: { cls: "pill-amber", t: "MIXED" }, UNCLEAR: { cls: "pill-grey", t: "UNCLEAR" } };
function renderPositions(positions) {
  if (!positions?.length) return "";
  return positions.map((p) => {
    const s = STANCE[p.stance] ?? STANCE.UNCLEAR;
    return `<div class="rec-card">
      <div class="rec-card-head"><span class="rec-title">${esc(p.issue)}</span><span class="status-pill ${s.cls}">${s.t}</span></div>
      <p class="pos-summary">${withCites(p.summary, p.citations)}</p>
      ${p.evidence ? `<div class="rec-meta">Basis: ${esc(p.evidence)}</div>` : ""}
      ${citeList(p.citations)}
    </div>`;
  }).join("") + `<p class="section-foot">Positions are drawn only from the documented record — speeches, questions, votes, manifestos and quoted statements — not inferred.</p>`;
}

const RELATION_LABEL = { WHILE_IN_OFFICE: "Held WHILE in office", BEFORE_OFFICE: "Before office", AFTER_OFFICE: "After office", FAMILY: "Family member" };
function renderRevolving(items) {
  if (!items?.length) return "";
  return items.map((r) => `
    <div class="rec-card ${r.relation_to_office === "WHILE_IN_OFFICE" ? "rev-flag" : ""}">
      <div class="rec-card-head"><span class="rec-title">${esc([r.role, r.organization].filter(Boolean).join(" · "))}</span>${r.relation_to_office ? `<span class="status-pill ${r.relation_to_office === "WHILE_IN_OFFICE" ? "pill-amber" : "pill-grey"}">${esc(RELATION_LABEL[r.relation_to_office] ?? r.relation_to_office)}</span>` : ""}</div>
      <div class="rec-meta">${[r.sector && "Sector: " + r.sector, r.period].filter(Boolean).map(esc).join(" · ")}</div>
      ${r.note ? `<p class="pos-summary">${withCites(r.note, r.citations)}</p>` : ""}
      ${citeList(r.citations)}
    </div>`).join("") + `<p class="section-foot">A factual record of overlap between public office and private industry. Overlap is not by itself wrongdoing — it is shown so the citizen can judge conflicts of interest.</p>`;
}

function renderPartyFunding(f, p) {
  const top = (f.donors ?? []).slice(0, 6);
  const sectors = (f.sectors ?? []).slice(0, 6);
  return `
    <p class="fund-lead"><strong>${esc(p.party ?? "")}</strong> received <strong>₹${f.total_cr.toLocaleString()} crore</strong> in electoral bonds — ranked <strong>#${f.rank}</strong> of ${f.total_parties} disclosed parties. ${esc(p.name)} stands for election under this party, so this is the money behind their platform.</p>
    ${top.length ? `<h4 class="fund-h">Top disclosed donors to ${esc(f.abbr)}</h4>
    <div class="fund-list">${top.map((d) => `<div class="fund-row"><span class="fund-donor">${esc(d.donor)}</span><span class="fund-sector">${esc(d.sector)}</span><span class="fund-amt">₹${d.total_cr.toLocaleString()} cr</span></div>`).join("")}</div>` : ""}
    ${sectors.length ? `<h4 class="fund-h">By industry</h4>
    <div class="fund-chips">${sectors.map((s) => `<span class="fund-chip">${esc(s.sector)} · ₹${s.total_cr.toLocaleString()} cr</span>`).join("")}</div>` : ""}
    <p class="section-foot"><a href="#/funding">See the full cross-party money trail →</a> · Source: Electoral Bonds disclosed by SBI on Supreme Court / ECI order. Figures approximate, in ₹ crore.</p>`;
}

function renderClaims(claims) {
  if (!claims?.length) return "";
  const pill = { VERIFIED_TRUE: "pill-green", PARTIALLY_TRUE: "pill-amber", UNVERIFIED: "pill-grey", CONTRADICTED_BY_PUBLIC_RECORD: "pill-red" };
  const label = { VERIFIED_TRUE: "VERIFIED TRUE", PARTIALLY_TRUE: "PARTIALLY TRUE", UNVERIFIED: "UNVERIFIED", CONTRADICTED_BY_PUBLIC_RECORD: "CONTRADICTED BY PUBLIC RECORD" };
  return claims.map((c) => `
    <div class="rec-card">
      <div class="claim-text">"${esc(c.claim_text)}"</div>
      <div class="rec-meta">${[c.claim_source, c.claim_date].filter(Boolean).map(esc).join(" · ")}</div>
      <span class="status-pill ${pill[c.verdict] ?? "pill-grey"}">${label[c.verdict] ?? esc(c.verdict)}</span>
      ${c.evidence ? `<div class="claim-evidence">${esc(c.evidence)}</div>` : ""}
      ${citeList(c.citations)}
    </div>`).join("");
}

function renderPartyHistory(switches) {
  if (!switches?.length) return "";
  return `<div class="party-timeline">${switches.map((s) => `
    <div class="pt-item"><div class="pt-dot"></div>
      <div class="pt-content">
        <span class="pt-year">${esc(s.year || "")}</span>
        <span class="pt-switch">${esc(s.from_party || "?")} → <strong>${esc(s.to_party || "?")}</strong></span>
        ${citeList(s.citations)}
      </div></div>`).join("")}</div>`;
}

const PATTERN_LABEL = {
  VOTING_INTEREST_CORRELATION: "Voting record aligns with family business sectors",
  CONTRACT_TIMING_PATTERN: "Government contracts follow relevant legislative activity",
  ASSET_GROWTH_ANOMALY: "Asset growth exceeds declared income sources",
  CASE_WITHDRAWAL_PATTERN: "Cases withdrawn / discharged following political events",
  ATTENDANCE_INTEREST_PATTERN: "Attendance drops during sessions touching family interests",
  MANIFESTO_RECORD_DIVERGENCE: "Voting record diverges from stated positions",
  PARTY_SWITCH_TIMING: "Party switch close to an election or asset declaration",
  QUESTION_INTEREST_ALIGNMENT: "Questions cluster around family business sectors",
  CROSS_CONSTITUENCY_ASSET_PATTERN: "Assets declared in constituencies of office held",
  COMPANY_REGULATORY_TIMING: "Company sectors received regulatory changes during tenure",
};

function renderPatterns(flags) {
  if (!flags?.length) return `<p class="empty-state">No patterns identified in available public records. Pattern analysis runs continuously as new data is added.</p>`;
  const sev = { SIGNIFICANT: "sev-significant", NOTABLE: "sev-notable", UNDER_REVIEW: "sev-review" };
  return flags.map((f) => `
    <div class="pattern-card">
      <div class="pattern-head">
        <span class="pattern-title">${esc(f.title || PATTERN_LABEL[f.flag_name] || f.flag_name)}</span>
        <span class="sev-badge ${sev[f.severity] ?? "sev-notable"}">${esc(String(f.severity).replace(/_/g, " "))}</span>
      </div>
      <ul class="pattern-points">
        ${f.supporting_data_points.map((d) => `<li><span class="dp-fact">${esc(d.fact)}</span> <span class="dp-src">(${[d.source, d.date].filter(Boolean).map(esc).join(", ")})</span></li>`).join("")}
      </ul>
      <p class="pattern-obs">${withCites(f.description, f.citations)}</p>
      <p class="pattern-disclaimer">This identifies a pattern in verified public records. No allegation of wrongdoing is made. The citizen is invited to review the cited sources directly.</p>
    </div>`).join("");
}

function renderTransparencyFooter(report) {
  const refresh = report.generated_at ? new Date(report.generated_at).toLocaleString() : "—";
  const uniq = [...new Set((report.sources ?? []).map((s) => s.source_type).filter(Boolean))];
  return `
    <h4>Data Transparency</h4>
    <p><strong>Last data refresh:</strong> ${esc(refresh)}</p>
    ${uniq.length ? `<p><strong>Source types used for this profile:</strong> ${uniq.map(esc).join(", ")}</p>` : ""}
    <p>This profile contains only publicly available government data and verified records. No allegations are made. All adverse information reflects official public records.</p>
    <p class="muted small">Dispute this data: if any information is factually incorrect, use the anonymous tip form below to flag it — we review and update.</p>`;
}

// ===== Summarizer report card (Branch 1) — the new public politician page =====
// Every number here was computed in code from public records; prose (when
// present) was written by a free clerical model constrained to those facts.
const CARD_SEV = { CLEAN: "vf-clean", INFO: "", NOTABLE: "vf-note", SIGNIFICANT: "vf-sig" };
function renderCardSection(sec) {
  const stats = (sec.stats ?? []).map((st) => `
    <div class="snap-cell">
      <div class="snap-val">${esc(st.value)}</div>
      <div class="snap-label">${esc(st.label)}${st.trend ? `<span class="snap-note"> · ${esc(st.trend)}</span>` : ""}</div>
    </div>`).join("");
  const facts = (sec.facts ?? []).map((f) => `
    <div class="vf-item ${CARD_SEV[f.severity] ?? ""}">
      <div class="vf-main">
        <span class="vf-head">${esc(f.text)}</span>
        ${f.sources?.length ? `<span class="vf-meta">${f.sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">source ${i + 1} ↗</a>`).join(" · ")}</span>` : ""}
      </div>
    </div>`).join("");
  const prose = sec.prose ?? sec.template_prose ?? "";
  return `
    <section class="record-section">
      <div class="section-head"><h3>${esc(sec.title)}</h3></div>
      ${prose ? `<p class="section-sub">${esc(prose)}</p>` : ""}
      ${stats ? `<div class="snapshot-grid">${stats}</div>` : ""}
      ${facts}
    </section>`;
}

function renderCardScorecard(card) {
  const params = (card.parameters ?? []).map((pm) => `
    <div class="param">
      <div class="param-top">
        <span class="label">${esc(pm.label)}</span>
        <span class="pts" style="color:${barColor(pm.score)}">${pm.score < 0 ? "not scored — insufficient data" : pm.score + "/100"}</span>
      </div>
      <div class="bar"><i data-w="${pm.score < 0 ? 0 : pm.score}" style="background:${barColor(pm.score)}"></i></div>
      ${pm.contributions?.length ? `<ul class="calc-contribs">${pm.contributions.map((c) =>
        `<li><span class="${c.weight >= 0 ? "vf-pos" : "vf-neg"}">${c.weight >= 0 ? "+" : ""}${Number(c.weight) || 0}</span> ${esc(c.headline)}</li>`).join("")}</ul>`
      : pm.score >= 0 ? `<p class="rationale muted small">Clean baseline (70) — no adverse records computed for this parameter.</p>` : ""}
    </div>`).join("");
  return params;
}

function renderCardView(card) {
  const g = card.grade;
  $("#grade").textContent = g === "INSUFFICIENT_DATA" ? "?" : g;
  $("#grade").style.color = GRADE_COLORS[g];
  $("#score").textContent = g === "INSUFFICIENT_DATA" ? "not enough data" : `${card.score}/100 · ${GRADE_TEXT[g]}`;
  ringStyle($("#grade-ring"), card.score, g);
  $("#how-scored").hidden = g === "INSUFFICIENT_DATA";
  $("#headline").textContent = card.headline ?? "";
  $("#generated").textContent = `Report card generated ${new Date(card.generated_at).toLocaleDateString()} · ${card.evidence_count} evidence items · computed from public records${card.prose_model ? "" : ""}`;

  if (card.summary) {
    $("#exec-summary").textContent = card.summary;
    $("#exec-card").hidden = false;
  }

  const box = $("#card-sections");
  box.innerHTML = (card.sections ?? []).map(renderCardSection).join("");
  box.hidden = false;

  // Why this grade — deterministic scorecard with itemised contributions.
  $("#params").innerHTML = renderCardScorecard(card);
  $("#calc-display").innerHTML = card.calc
    ? `<p class="small muted">Calculation: </p><div class="calc">${esc(card.calc)}</div>
       <p class="small muted">Every score starts from a clean baseline of 70; each computed finding above shifts it by a fixed, published weight. Parameters without enough records are excluded — never guessed.</p>`
    : "";
  $("#scorecard-box").hidden = false;
  requestAnimationFrame(() =>
    document.querySelectorAll(".bar > i").forEach((b) => (b.style.width = b.dataset.w + "%"))
  );

  // Methodology — the card variant (no AI investigation step).
  if (state.methodology) {
    const { scoring, parameters } = state.methodology;
    $("#methodology-body").innerHTML = `
      <h4>1 · Data sources</h4>
      <p class="small">Sworn ECI affidavits, MPLADS fund records, MCA company registry, Digital Sansad, Wikidata, court/news archives — every fact links to its source.</p>
      <h4>2 · Computation (plain code, not AI)</h4>
      <p class="small">${esc(scoring.formula)}</p>
      ${card.calc ? `<div class="calc">${esc(card.calc)}</div>` : ""}
      <table>
        <tr><th>Score</th><th>Grade</th><th>Meaning</th></tr>
        ${scoring.bands.map((b, i) => `<tr><td>${b.min}–${i === 0 ? 100 : scoring.bands[i - 1].min - 1}</td><td><strong>${b.grade}</strong></td><td>${esc(b.meaning)}</td></tr>`).join("")}
      </table>
      <h4>3 · Scorecard parameters</h4>
      <table>${parameters.map((pm) => `<tr><td><strong>${esc(pm.label)}</strong></td><td class="small">${esc(pm.desc)}</td></tr>`).join("")}</table>
      <p class="small muted">${card.prose_model ? `Connective prose written by a free clerical model (${esc(card.prose_model)}) constrained to the computed facts — it can add no new fact or number.` : "All prose on this card is template-generated from the computed facts — no AI model was involved."} Generated ${new Date(card.generated_at).toLocaleString()}.</p>`;
    $("#methodology").hidden = false;
  }

  // Data transparency footer.
  $("#transparency-footer").innerHTML = `
    <h4>Data Transparency</h4>
    <p><strong>Last data refresh:</strong> ${esc(new Date(card.generated_at).toLocaleString())}</p>
    <p>This report card contains only publicly available government data and verified records, computed by reproducible code. No allegations are made. All adverse information reflects official public records.</p>
    <p class="muted small">Dispute this data: if any information is factually incorrect, use the anonymous tip form below to flag it — we review and update.</p>`;
  $("#transparency-footer").hidden = false;
}

// Ministry / party report card page (#/ministry/<key>, #/party/<key>[/<state>]).
async function showOrgCard(kind, key, scope = "union") {
  hideAllViews();
  $("#org-view").hidden = false;
  window.scrollTo(0, 0);
  $("#org-name").textContent = "Loading…";
  $("#org-sub").textContent = ""; $("#org-headline").textContent = "";
  $("#org-sections").innerHTML = "";

  const url = kind === "ministry"
    ? `/api/ministries/${key}/card`
    : `/api/parties/${encodeURIComponent(key)}/card${scope !== "union" ? `?scope=${encodeURIComponent(scope)}` : ""}`;
  const card = await api(url);
  if (!card) { $("#org-name").textContent = "Not found"; return; }

  $("#org-name").textContent = card.name;
  $("#org-sub").textContent = kind === "ministry"
    ? `${card.scope === "union" ? "Union ministry" : `${card.scope} state department`}${card.sectors?.length ? ` · ${card.sectors.join(", ")}` : ""}`
    : card.scope === "union" ? "National party report card" : `Party report card — ${card.scope}`;
  $("#org-headline").textContent = card.headline ?? "";

  // State scope is reachable via URL: #/party/<key>/<State Name>. A National
  // link is shown when viewing a state slice.
  const tabs = $("#org-scope-tabs");
  if (kind === "party" && scope !== "union") {
    tabs.innerHTML = `<a class="lb-tab" href="#/party/${esc(key)}">← National view</a>`;
    tabs.hidden = false;
  } else tabs.hidden = true;

  $("#org-sections").innerHTML = (card.sections ?? []).map((sec) => {
    let html = renderCardSection(sec);
    // Link failures to their Government Watch pages / ministers to dossiers.
    if (sec.slugs?.length) {
      const links = sec.slugs.slice(0, 12).map((s) => `<a class="prov-chip" href="#/scandal/${esc(s)}">${esc(s)}</a>`).join(" ");
      html = html.replace("</section>", `<p class="small">Full analyses: ${links}</p></section>`);
    }
    if (sec.ministers?.length) {
      const links = sec.ministers.filter((x) => x.politician_id).map((x) => `<a class="prov-chip" href="#/rep/${esc(x.politician_id)}">${esc(x.name)} →</a>`).join(" ");
      if (links) html = html.replace("</section>", `<p class="small">${links}</p></section>`);
    }
    return html;
  }).join("");
}

async function showReport(id) {
  state.currentId = id;
  hideAllViews();
  $("#report-view").hidden = false;
  window.scrollTo(0, 0);

  // Reset all sections
  [
    "exec-card","timeline-box","categories-section","flags-row","card-sections",
    "scorecard-box","methodology","gaps-box","evidence-head-row","evidence-legend","related-dossiers",
    "signal-badges","verified-section","relations-section","criminal-section","financial-section","legislative-section",
    "positions-section","business-section","revolving-section","funding-section",
    "claims-section","party-history-section","ministerial-section","pattern-section",
    "transparency-footer",
  ].forEach((el) => { const e = $(  `#${el}`); if (e) e.hidden = true; });
  $("#no-report-msg").hidden = true;

  const [p, card, evidence, ministerScandals, funding] = await Promise.all([
    api(`/api/politicians/${id}`),
    api(`/api/politicians/${id}/card`),
    api(`/api/politicians/${id}/evidence`),
    api(`/api/politicians/${id}/scandals`),
    api(`/api/politicians/${id}/funding`),
  ]);
  if (!p) { location.hash = "#/"; return; }
  state.currentRep = p; state.currentEvidence = evidence ?? [];

  // Follow the money — the party's electoral-bond funding (shown regardless of report).
  if (funding && !funding.unavailable && funding.total_cr != null) {
    $("#funding-body").innerHTML = renderPartyFunding(funding, p);
    $("#funding-section").hidden = false;
  }

  // "Accountability on their watch" — failures linked to this person as minister.
  // Shown even with no AI report, since it's sourced from the scandal corpus.
  if (ministerScandals?.length) {
    $("#ministerial-body").innerHTML = ministerScandals.map((s) => `
      <a href="#/scandal/${esc(s.slug)}" class="watch-item">
        <span class="gw-signal">${SIGNAL_DOT[s.signal] ?? "⚪"}</span>
        <div class="watch-main">
          <span class="watch-title">${esc(s.title)}</span>
          <span class="muted small">${esc(s.portfolio || s.ministry || "")} · ${esc(s.date || "")}</span>
        </div>
        <span class="gw-verdict ${(VERDICT_LABEL[s.verdict]||{}).cls || ''}">${(VERDICT_LABEL[s.verdict]||{}).txt || "—"}</span>
      </a>`).join("");
    $("#ministerial-section").hidden = false;
  }

  $("#rep-name").textContent = p.name;
  $("#rep-sub").textContent = [p.party, p.office, p.constituency, p.state].filter(Boolean).join(" · ");
  const cwBtn = $("#compare-with-btn");
  cwBtn.dataset.compareWith = p.id;
  cwBtn.href = `#/compare/${p.id}/_`;
  cwBtn.hidden = false;

  // Bookmark + recently-viewed
  const railItem = { id: p.id, name: p.name, grade: p.latest?.grade ?? "INSUFFICIENT_DATA", sub: [p.party, p.constituency].filter(Boolean).join(" · ") };
  recordRecentView(railItem);
  const bmBtn = $("#bookmark-btn");
  if (bmBtn) {
    bmBtn.hidden = false;
    const paint = () => { const on = isBookmarked(p.id); bmBtn.textContent = on ? "★ Saved" : "☆ Save"; bmBtn.classList.toggle("saved", on); };
    paint();
    bmBtn.onclick = () => { toggleBookmark(railItem); paint(); };
  }

  // Related dossiers — same party first, then same state; report-havers ranked up.
  const related = state.reps
    .filter((r) => r.id !== p.id && (r.party === p.party || r.state === p.state))
    .sort((a, b) =>
      (a.party === p.party ? 0 : 1) - (b.party === p.party ? 0 : 1) ||
      (a.latest ? 0 : 1) - (b.latest ? 0 : 1) ||
      consequenceRank(a) - consequenceRank(b))
    .slice(0, 6)
    .map((r) => ({ id: r.id, name: r.name, grade: r.latest?.grade ?? "INSUFFICIENT_DATA", sub: [r.party, r.constituency].filter(Boolean).join(" · ") }));
  const rd = $("#related-dossiers");
  if (rd) {
    rd.hidden = related.length === 0;
    if (related.length) $("#related-cards").innerHTML = related.map(railCardHTML).join("");
  }

  // Affidavit snapshot — verified ECI facts, available for every imported rep
  renderSnapshot(p);

  if (card) {
    renderCardView(card);
  } else {
    // Every rep is carded; this is only reached if the card fetch failed.
    $("#grade").textContent = "–";
    $("#score").textContent = "report card unavailable";
    $("#headline").textContent = "";
    $("#how-scored").hidden = true;
    $("#no-report-msg").hidden = false;
  }

  // ── Legacy dossier renderer (dead code: kept for reference during the
  // transition; `report` is never fetched now). ──
  const report = null;
  if (report) {
    const g = report.overall_grade;
    $("#grade").textContent = g === "INSUFFICIENT_DATA" ? "?" : g;
    $("#grade").style.color = GRADE_COLORS[g];
    $("#score").textContent = g === "INSUFFICIENT_DATA" ? "not enough data" : `${report.overall_score}/100 · ${GRADE_TEXT[g]}`;
    ringStyle($("#grade-ring"), report.overall_score, g);
    $("#how-scored").hidden = g === "INSUFFICIENT_DATA";
    $("#headline").textContent = report.headline;
    const modeLabel = { incremental: "incremental update", full: "full investigation", recheck: "full re-investigation" }[report.update_mode] ?? "";
    $("#generated").textContent = `Report generated ${new Date(report.generated_at).toLocaleDateString()} · ${report.evidence_count} evidence items${modeLabel ? ` · ${modeLabel}` : ""}`;

    // Executive summary
    const execText = report.executive_summary ?? report.summary ?? "";
    if (execText) {
      $("#exec-summary").textContent = execText;
      $("#exec-card").hidden = false;
    }

    // Verified findings (computed in code) + relationship graph
    const vfHtml = renderVerifiedFindings(report.computed_flags);
    if (vfHtml) { $("#verified-body").innerHTML = vfHtml; $("#verified-section").hidden = false; }
    const relHtml = renderRelations(report.relations, p.name);
    if (relHtml) { $("#relations-body").innerHTML = relHtml; $("#relations-section").hidden = false; }

    // ===== Institutional record-card sections (NayaNeeta) =====
    // Signal badges (5-second record-status view)
    if (report.signals?.length) {
      $("#signal-badges").innerHTML = renderSignalBadges(report.signals);
      $("#signal-badges").hidden = false;
    }
    // Criminal & Legal Record — always shown (empty state is itself informative)
    $("#criminal-body").innerHTML = renderCriminal(report.cases ?? []);
    $("#criminal-section").hidden = false;
    // Financial declarations
    const finHtml = renderFinancial(report.assets, report.growth_phrase, report.growth_citations);
    if (finHtml) { $("#financial-body").innerHTML = finHtml; $("#financial-section").hidden = false; }
    // Legislative record
    const legHtml = renderLegislative(report.legislative_record);
    if (legHtml) { $("#legislative-body").innerHTML = legHtml; $("#legislative-section").hidden = false; }
    // Where they stand — issue positions
    const posHtml = renderPositions(report.issue_positions);
    if (posHtml) { $("#positions-body").innerHTML = posHtml; $("#positions-section").hidden = false; }
    // Business interests
    const bizHtml = renderBusiness(report.companies);
    if (bizHtml) { $("#business-body").innerHTML = bizHtml; $("#business-section").hidden = false; }
    // Revolving door
    const revHtml = renderRevolving(report.revolving_door);
    if (revHtml) { $("#revolving-body").innerHTML = revHtml; $("#revolving-section").hidden = false; }
    // Public statements & verification
    const claimsHtml = renderClaims(report.claims);
    if (claimsHtml) { $("#claims-body").innerHTML = claimsHtml; $("#claims-section").hidden = false; }
    // Party history
    const phHtml = renderPartyHistory(report.party_switches);
    if (phHtml) { $("#party-history-body").innerHTML = phHtml; $("#party-history-section").hidden = false; }
    // Pattern Analysis — only when there are published patterns (no empty box).
    if ((report.pattern_flags ?? []).some((f) => f.is_published !== false)) {
      $("#pattern-cards").innerHTML = renderPatterns(report.pattern_flags);
      $("#pattern-section").hidden = false;
    }
    // Data transparency footer
    $("#transparency-footer").innerHTML = renderTransparencyFooter(report);
    $("#transparency-footer").hidden = false;

    // Career timeline
    if (report.career_timeline?.length) {
      $("#career-timeline").innerHTML = renderCareerTimeline(report.career_timeline);
      $("#timeline-box").hidden = false;
    }

    // AI investigation categories (new format)
    if (report.categories?.length) {
      $("#categories").innerHTML = renderCategories(report.categories);
      $("#categories-section").hidden = false;
    }

    // Red flags + positive highlights
    const { rfHtml, hlHtml } = renderFlags(report.red_flags, report.positive_highlights);
    if (rfHtml || hlHtml) {
      $("#red-flags").innerHTML   = rfHtml  || '<p class="muted small">No red flags identified from available evidence.</p>';
      $("#highlights").innerHTML  = hlHtml || '<p class="muted small">No highlights identified from available evidence.</p>';
      $("#flags-row").hidden = false;
    }

    // Accountability scorecard
    const params = report.scorecard?.parameters ?? report.parameters ?? [];
    if (params.length) {
      $("#params").innerHTML = renderScorecard(params);
      if (report.calc) {
        $("#calc-display").innerHTML = `<p class="small muted">Calculation: </p><div class="calc">${esc(report.calc)}</div>`;
      }
      $("#scorecard-box").hidden = false;
      requestAnimationFrame(() =>
        document.querySelectorAll(".bar > i").forEach((b) => (b.style.width = b.dataset.w + "%"))
      );
    }

    // Methodology
    renderMethodology(report);
    $("#methodology").hidden = false;

    // Data gaps
    if (report.data_gaps?.length) {
      $("#gaps").innerHTML = report.data_gaps.map((g2) => `<li>${esc(g2)}</li>`).join("");
      $("#gaps-box").hidden = false;
    }
  }

  // Evidence trail (always show if we have evidence)
  if (evidence?.length) {
    $("#evidence").innerHTML = evidence.map((e) => `
      <li>
        ${e.date ? `<span class="date">${esc(e.date)}</span>` : ""}
        <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
        <span class="badge ${e.admissible ? "adm" : "lead"}">${e.admissible ? "official record" : "news lead"}</span>
        <span class="src-sum">${esc(e.summary ?? "")}</span>
      </li>`
    ).join("");
    $("#evidence-head-row").hidden = false;
    $("#evidence-legend").hidden = false;
    // Provenance summary chips in the header (links down to the evidence trail).
    const official = evidence.filter((e) => e.admissible).length;
    const leads = evidence.length - official;
    $("#evidence-summary").innerHTML =
      `<a href="#" class="prov-chip prov-total" data-scroll="evidence-heading">📎 ${evidence.length} source${evidence.length !== 1 ? "s" : ""} cited</a>` +
      (official ? `<span class="prov-chip prov-official">${official} official record${official !== 1 ? "s" : ""}</span>` : "") +
      (leads ? `<span class="prov-chip prov-lead">${leads} news lead${leads !== 1 ? "s" : ""}</span>` : "");
    $("#evidence-summary").hidden = false;
  } else {
    $("#evidence-summary").hidden = true;
  }

  buildReportToc();
}

// ── Bookmarks + recently-viewed (localStorage; upgradeable to accounts later) ──
const BOOKMARK_KEY = "pb_bookmarks", RECENT_VIEW_KEY = "pb_recent_views";
function lsGet(key) { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; } }
function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }
function isBookmarked(id) { return lsGet(BOOKMARK_KEY).some((b) => b.id === id); }
function toggleBookmark(item) {
  const cur = lsGet(BOOKMARK_KEY);
  const idx = cur.findIndex((b) => b.id === item.id);
  if (idx >= 0) cur.splice(idx, 1); else cur.unshift(item);
  lsSet(BOOKMARK_KEY, cur.slice(0, 40));
  return idx < 0; // true if now bookmarked
}
function recordRecentView(item) {
  const cur = lsGet(RECENT_VIEW_KEY).filter((r) => r.id !== item.id);
  cur.unshift(item);
  lsSet(RECENT_VIEW_KEY, cur.slice(0, 12));
}
function railCardHTML(it) {
  const g = it.grade ?? "INSUFFICIENT_DATA";
  return `<a class="rail-card" href="#/rep/${it.id}">
    <span class="rail-grade" style="background:${GRADE_COLORS[g] ?? "#97a0ad"}">${g === "INSUFFICIENT_DATA" ? "?" : g}</span>
    <span class="rail-body"><span class="rail-name">${esc(it.name)}</span><span class="rail-sub">${esc(it.sub ?? "")}</span></span>
  </a>`;
}
function renderHomeRails() {
  const saved = lsGet(BOOKMARK_KEY), recent = lsGet(RECENT_VIEW_KEY);
  const sr = $("#saved-rail"), rr = $("#recent-rail");
  if (sr) {
    sr.hidden = saved.length === 0;
    if (saved.length) $("#saved-cards").innerHTML = saved.slice(0, 8).map(railCardHTML).join("");
  }
  if (rr) {
    // don't show items already in saved to avoid duplication noise
    const savedIds = new Set(saved.map((s) => s.id));
    const rec = recent.filter((r) => !savedIds.has(r.id)).slice(0, 8);
    rr.hidden = rec.length === 0;
    if (rec.length) $("#recent-cards").innerHTML = rec.map(railCardHTML).join("");
  }
}

// ── Export the evidence trail (CSV / BibTeX) + cite-this permalink ──
function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function slugify(s) { return (s || "rep").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function csvCell(s) { s = String(s ?? ""); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportEvidenceCsv() {
  if (!state.currentEvidence.length) return;
  const rows = [["#", "Date", "Type", "Title", "URL", "Summary"]];
  state.currentEvidence.forEach((e, i) => rows.push([i + 1, e.date ?? "", e.admissible ? "official record" : "news lead", e.title ?? "", e.url ?? "", e.summary ?? ""]));
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  downloadFile(`${slugify(state.currentRep?.name)}-sources.csv`, csv, "text/csv;charset=utf-8");
}
function exportEvidenceBibtex() {
  if (!state.currentEvidence.length) return;
  const name = slugify(state.currentRep?.name);
  const bib = state.currentEvidence.map((e, i) => {
    const year = (e.date || "").match(/\d{4}/)?.[0] || "";
    return `@online{${name}-src${i + 1},\n  title = {${(e.title || "Untitled source").replace(/[{}]/g, "")}},\n  url = {${e.url || ""}},\n  note = {${(e.summary || "").replace(/[{}]/g, "")}${e.admissible ? " [official record]" : " [news lead]"}},${year ? `\n  year = {${year}},` : ""}\n  urldate = {${new Date().toISOString().slice(0, 10)}}\n}`;
  }).join("\n\n");
  downloadFile(`${name}-sources.bib`, bib, "application/x-bibtex;charset=utf-8");
}
async function copyCiteLink(btn) {
  const url = location.href;
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "✓ Link copied";
  } catch {
    // Fallback: select-and-copy via a temp input
    const t = document.createElement("input"); t.value = url; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); btn.textContent = "✓ Link copied"; } catch { btn.textContent = "Copy failed"; }
    t.remove();
  }
  setTimeout(() => { btn.textContent = label; }, 1800);
}

// ── Dossier section nav — built from whichever sections are actually visible ──
const TOC_SECTIONS = [
  ["exec-card", "Summary"],
  ["verified-section", "Verified"],
  ["relations-section", "Network"],
  ["criminal-section", "Criminal"],
  ["financial-section", "Financial"],
  ["legislative-section", "Legislative"],
  ["positions-section", "Positions"],
  ["business-section", "Business"],
  ["revolving-section", "Revolving Door"],
  ["funding-section", "Funding"],
  ["claims-section", "Statements"],
  ["ministerial-section", "On Their Watch"],
  ["pattern-section", "Patterns"],
  ["categories-section", "Investigation"],
  ["flags-row", "Flags"],
  ["evidence-heading", "Evidence"],
];
let tocObserver = null;
function buildReportToc() {
  const nav = $("#report-toc");
  if (!nav) return;
  const visible = TOC_SECTIONS.filter(([id]) => { const el = document.getElementById(id); return el && !el.hidden && el.offsetParent !== null; });
  if (visible.length < 3) { nav.hidden = true; nav.innerHTML = ""; return; }
  nav.innerHTML = visible.map(([id, label]) =>
    `<a href="#${id}" class="toc-link" data-toc="${id}">${esc(label)}</a>`).join("");
  nav.hidden = false;
  // Smooth scroll (scroll-margin-top in CSS handles the sticky offset)
  nav.querySelectorAll(".toc-link").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById(a.dataset.toc)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  // Scroll-spy: highlight the section currently in view
  if (tocObserver) tocObserver.disconnect();
  tocObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) {
        nav.querySelectorAll(".toc-link").forEach((l) => l.classList.toggle("active", l.dataset.toc === en.target.id));
        const on = nav.querySelector(".toc-link.active");
        if (on) on.scrollIntoView({ inline: "center", block: "nearest" });
      }
    });
  }, { rootMargin: "-120px 0px -70% 0px" });
  visible.forEach(([id]) => { const el = document.getElementById(id); if (el) tocObserver.observe(el); });
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

// ================= COMPARE =================
const SIGNAL_DOT = { RED: "🔴", AMBER: "🟠", GREEN: "🟢", GREY: "⚪" };
let cmpSel = { a: null, b: null };

function showCompare(idA, idB) {
  $("#home-view").hidden = true;
  $("#report-view").hidden = true;
  $("#compare-view").hidden = false;
  cmpSel = { a: idA || cmpSel.a, b: idB || cmpSel.b };
  // reflect current selection in the search boxes
  for (const side of ["a", "b"]) {
    const rep = state.reps.find((p) => p.id === cmpSel[side]);
    if (rep) $(`#cmp-search-${side}`).value = rep.name;
  }
  if (cmpSel.a && cmpSel.b) loadComparison();
  else $("#compare-result").innerHTML = `<p class="muted center cmp-empty">Choose two representatives above to see them side by side.</p>`;
}

function wireComparePicker(side) {
  const input = $(`#cmp-search-${side}`);
  const box = $(`#cmp-results-${side}`);
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (q.length < 2) { box.hidden = true; return; }
    const hits = state.reps.filter((p) => `${p.name} ${p.constituency ?? ""} ${p.party ?? ""}`.toLowerCase().includes(q)).slice(0, 8);
    box.innerHTML = hits.map((p) =>
      `<button class="cmp-hit" data-id="${p.id}">${esc(p.name)} <span class="ac-desc">(${esc([p.office, p.party, p.constituency || p.state].filter(Boolean).join(" · "))})</span></button>`
    ).join("") || `<div class="cmp-hit muted">No match</div>`;
    box.hidden = false;
  });
  box.addEventListener("click", (e) => {
    const btn = e.target.closest(".cmp-hit[data-id]");
    if (!btn) return;
    cmpSel[side] = btn.dataset.id;
    box.hidden = true;
    const other = side === "a" ? cmpSel.b : cmpSel.a;
    location.hash = `#/compare/${cmpSel.a ?? "_"}/${cmpSel.b ?? "_"}`;
    if (cmpSel.a && cmpSel.b) loadComparison();
    else { const rep = state.reps.find((p) => p.id === cmpSel[side]); if (rep) $(`#cmp-search-${side}`).value = rep.name;
           $("#compare-result").innerHTML = `<p class="muted center cmp-empty">Pick the second representative to compare.</p>`; }
  });
}

async function loadComparison() {
  const box = $("#compare-result");
  box.innerHTML = `<p class="muted center">Loading comparison…</p>`;
  const data = await api(`/api/compare?ids=${encodeURIComponent(cmpSel.a)},${encodeURIComponent(cmpSel.b)}`);
  if (!data || data.length < 2) { box.innerHTML = `<p class="muted center">Couldn't load that comparison.</p>`; return; }
  box.innerHTML = renderComparison(data[0], data[1]);
}

// Build the side-by-side table. Each row is one metric; the "winner" (more
// accountable / cleaner record) is highlighted where a direction is meaningful.
function renderComparison(A, B) {
  const head = (X) => {
    const g = X.summary?.overall_grade ?? "INSUFFICIENT_DATA";
    return `<div class="cmp-head">
      <div class="avatar" style="background:${avatarColor(X.politician.name)}">${initials(X.politician.name)}</div>
      <a href="#/rep/${X.politician.id}" class="cmp-name">${esc(X.politician.name)}</a>
      <div class="muted small">${esc(X.politician.party ?? "")} · ${esc(X.politician.constituency ?? "")}</div>
      <div class="grade-chip cmp-grade" style="background:${GRADE_COLORS[g]}" title="${GRADE_TEXT[g]}">${g === "INSUFFICIENT_DATA" ? "?" : g}</div>
    </div>`;
  };

  const sa = A.summary, sb = B.summary;
  if (!sa || !sb) {
    return `<div class="cmp-grid"><div></div>${head(A)}${head(B)}</div>
      <p class="muted center cmp-empty">${!sa ? esc(A.politician.name) : esc(B.politician.name)} has no generated report yet, so there's nothing to compare. Generate both reports first.</p>`;
  }

  // helper: a row. dir = +1 means higher is better, -1 means lower is better, 0 = neutral
  const row = (label, va, vb, na, nb, dir, hint) => {
    let ca = "", cb = "";
    if (dir && na != null && nb != null && na !== nb) {
      const aWins = dir > 0 ? na > nb : na < nb;
      ca = aWins ? "cmp-win" : ""; cb = aWins ? "" : "cmp-win";
    }
    return `<div class="cmp-rowlabel">${esc(label)}${hint ? `<span class="cmp-hint" title="${esc(hint)}">ⓘ</span>` : ""}</div>
      <div class="cmp-cell ${ca}">${va}</div><div class="cmp-cell ${cb}">${vb}</div>`;
  };

  const sigCell = (s) => s ? `${SIGNAL_DOT[s.state] ?? "⚪"} <span class="cmp-sig-${(s.state||'GREY').toLowerCase()}">${s.state}</span>` : "—";
  const scoreCell = (p) => (p && p.score >= 0) ? `<strong>${p.score}</strong>/100` : `<span class="muted">n/a</span>`;
  const SIG_LABELS = { criminal: "Criminal record", financial: "Financial integrity", legislative: "Legislative activity", interests: "Declared interests", promises: "Promises vs record" };
  const PARAM_KEYS = ["manifesto","corruption","favoritism","hypocrisy","abuse_of_power"];
  const PARAM_LABELS = { manifesto:"Manifesto delivery", corruption:"Corruption indicators", favoritism:"Favoritism / nepotism", hypocrisy:"Hypocrisy (says vs does)", abuse_of_power:"Abuse of power" };

  let rows = "";
  rows += `<div class="cmp-section-row">Overall</div>`;
  rows += row("Overall score", scoreCell({score:sa.overall_score}), scoreCell({score:sb.overall_score}), sa.overall_score, sb.overall_score, +1, "Higher = more accountable documented record");

  // Signal flags — legacy dossier concept; cards carry no signals object.
  if (Object.keys(sa.signals ?? {}).length || Object.keys(sb.signals ?? {}).length) {
    rows += `<div class="cmp-section-row">Signal flags <span class="muted small">(record status)</span></div>`;
    for (const k of Object.keys(SIG_LABELS))
      rows += row(SIG_LABELS[k], sigCell(sa.signals?.[k]), sigCell(sb.signals?.[k]), null, null, 0);
  }

  rows += `<div class="cmp-section-row">Accountability scorecard</div>`;
  for (const k of PARAM_KEYS)
    rows += row(PARAM_LABELS[k], scoreCell(sa.parameters[k]), scoreCell(sb.parameters[k]), sa.parameters[k]?.score, sb.parameters[k]?.score, +1);

  rows += `<div class="cmp-section-row">Criminal record</div>`;
  rows += row("Cases declared", sa.criminal_cases ?? "—", sb.criminal_cases ?? "—", sa.criminal_cases, sb.criminal_cases, -1, "Fewer declared cases = cleaner record");
  if (sa.pending_cases != null || sb.pending_cases != null) {
    rows += row("Pending charges", sa.pending_cases ?? "—", sb.pending_cases ?? "—", sa.pending_cases, sb.pending_cases, -1);
    rows += row("Convictions", sa.convicted_cases ?? "—", sb.convicted_cases ?? "—", sa.convicted_cases, sb.convicted_cases, -1);
  }

  rows += `<div class="cmp-section-row">Wealth</div>`;
  rows += row("Declared net worth", esc(sa.net_worth ?? "—"), esc(sb.net_worth ?? "—"), sa.net_worth_num, sb.net_worth_num, 0, "Latest sworn affidavit");
  if (sa.asset_growth_x != null || sb.asset_growth_x != null)
    rows += row("Asset growth", sa.asset_growth_x != null ? `${sa.asset_growth_x}×` : "—", sb.asset_growth_x != null ? `${sb.asset_growth_x}×` : "—", null, null, 0, "Across successive sworn affidavits");

  if (sa.attendance != null || sb.attendance != null || sa.questions != null || sb.questions != null) {
    rows += `<div class="cmp-section-row">Legislative activity</div>`;
    rows += row("Attendance", esc(sa.attendance ?? "—"), esc(sb.attendance ?? "—"), null, null, 0);
    rows += row("Questions asked", esc(sa.questions ?? "—"), esc(sb.questions ?? "—"), null, null, 0);
    rows += row("Debates", esc(sa.debates ?? "—"), esc(sb.debates ?? "—"), null, null, 0);
  }

  rows += `<div class="cmp-section-row">Other</div>`;
  rows += row("Declared companies", sa.companies ?? "—", sb.companies ?? "—", null, null, 0);
  if (sa.party_switches != null || sb.party_switches != null)
    rows += row("Party switches", sa.party_switches ?? "—", sb.party_switches ?? "—", sa.party_switches, sb.party_switches, -1);

  return `<div class="cmp-grid">
      <div class="cmp-corner"></div>${head(A)}${head(B)}
      ${rows}
    </div>
    <p class="muted small cmp-foot">Green highlight marks the more accountable record on metrics with a clear direction. Signal flags, wealth, and activity are shown without a "winner" — read them in context. n/a means that dimension wasn't scored for that representative. Open either full report for the cited sources behind every figure.</p>`;
}

// ================= GOVERNMENT WATCH (scandals) =================
// (SIGNAL_DOT is defined in the COMPARE section above and reused here.)
const VERDICT_LABEL = {
  NONE: { txt: "No accountability", cls: "vd-none" },
  PARTIAL: { txt: "Partial accountability", cls: "vd-partial" },
  FULL: { txt: "Full accountability", cls: "vd-full" },
};
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
        <span class="gw-signal">${SIGNAL_DOT[s.signal] ?? "⚪"}</span>
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
        <span class="gw-verdict ${vd.cls}">${vd.txt}</span>
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
    const fb = f ? `<span class="freedom-badge fb-${(f.status||'').toLowerCase().replace(/\s+/g,'-')}" title="Freedom House: ${f.status} (${f.fh_score}/100) · RSF press-freedom rank ${f.rsf_rank}/180">${esc(f.status)} · 🗞 #${f.rsf_rank}</span>` : "";
    return `<div class="prec-row">
      <div class="prec-when"><strong>${esc(p.country ?? "")}</strong> ${fb}<div class="muted small">${esc(p.year ?? "")}</div></div>
      <div class="prec-what"><strong>${esc(p.incident ?? "")}</strong>${p.official ? ` — ${esc(p.official)}` : ""}
        <div class="prec-action">${esc(p.what_they_did ?? "")}${p.source_hint ? ` <span class="muted small">(${esc(p.source_hint)})</span>` : ""}</div>
      </div>
    </div>`;
  }).join("");

  return `
    <div class="scandal-head">
      <span class="gw-signal-lg">${SIGNAL_DOT[s.signal] ?? "⚪"}</span>
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
        <p class="gw-verdict ${vd.cls} verdict-lg">${vd.txt}</p>
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
      <p class="muted small">Each country is annotated with its democratic standing — 🗞 # is the RSF World Press Freedom rank (of 180). It tells you whether accountability there is the norm or the exception.</p>
      <div class="prec-list">${intlRows}</div>
    </section>` : ""}

    ${s.pattern_note ? `<div class="card pattern-section"><h3>Pattern note</h3><p>${esc(s.pattern_note)}</p></div>` : ""}

    ${(s.sources ?? []).length ? `<section class="prec-section">
      <h3>Sources</h3>
      <ul class="src-list">${s.sources.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    </section>` : ""}

    <div class="related-links">
      <span class="related-label">Explore related</span>
      ${s.minister_politician_id ? `<a href="#/rep/${esc(s.minister_politician_id)}" class="related-link">🧑‍⚖️ ${esc(m.name || "Minister")}'s dossier</a>` : ""}
      <a href="#/scorecards" class="related-link">📊 Accountability scorecards</a>
      ${s.party ? `<a href="#/funding" class="related-link">💰 ${esc(s.party)} funding</a>` : ""}
      <a href="#/govwatch" class="related-link">🏛️ More in Government Watch</a>
    </div>

    <p class="muted small scandal-foot">Generated by ${esc(s.model ?? "AI")} from public reporting and official records · ${s.generated_at ? new Date(s.generated_at).toLocaleDateString() : ""}. Accountability grading reflects the documented public record; pending cases are charges, not convictions. This is analysis of governance, not an allegation against any individual.</p>
  `;
}

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
    return `<div class="sc-bar-wrap"><div class="sc-bar" style="width:${r}%;background:${col}"></div><span class="sc-bar-val">${r}%</span></div>`;
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
            <div class="sc-label">${esc(b.label)}${b.card_key ? ` <a class="prov-chip" href="${scActiveTab === "byParty" ? `#/party/${esc(b.card_key)}` : `#/ministry/${esc(b.card_key)}`}">report card →</a>` : ""}</div>
            <div class="sc-c">${b.total}</div>
            <div class="sc-c">${b.resignations}</div>
            <div class="sc-c">${b.prosecutions}</div>
            <div class="sc-rate">${rateBar(b.accountability_rate)}</div>
          </summary>
          <div class="sc-detail">
            ${b.scandals.map((s) => `<a href="#/scandal/${esc(s.slug)}" class="sc-scandal">
              <span class="gw-signal">${SIGNAL_DOT[s.signal] ?? "⚪"}</span>
              <span class="sc-sc-title">${esc(s.title)}</span>
              <span class="gw-verdict ${(VERDICT_LABEL[s.verdict]||{}).cls || ''}">${(VERDICT_LABEL[s.verdict]||{}).txt || "—"}</span>
            </a>`).join("")}
          </div>
        </details>`).join("")}
    </div>`;
}

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
    chip: `<span class="adm-chip adm-chip-director">🔗 hidden directorship</span>`,
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
        <span class="rel-badge">🏢 ${esc((c.roles || []).join(", "))}</span>
        <span>${esc(c.name)}${c.cin ? ` <span class="muted small">(${esc(c.cin)})</span>` : ""}${c.corroborated ? " ✓ corroborated" : ""}</span>
        <span class="muted small">${esc((c.sources || []).join(", "))}</span>
      </div>`).join("") + `</div>`;
  }
  if (net.codirectors?.length) {
    html += `<p class="muted small rel-fam-label">Others on the same boards:</p><div class="rel-chips">` +
      net.codirectors.map((d) => `<span class="rel-chip">${d.is_relative ? "👪" : "🔗"} ${esc(d.name)} <em>${esc(d.role)} · ${esc(d.via_company)}</em>${d.politician_id ? ` <a class="rel-go" href="#/rep/${esc(d.politician_id)}">rep →</a>` : ""}</span>`).join("") + `</div>`;
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
    return `<div class="adm-card${dir.cardClass}">
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
      ${(l.evidence_urls ?? []).filter(Boolean).length ? `<p class="small">Sources: ${l.evidence_urls.filter(Boolean).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}</p>` : ""}
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
      ${(s.sources ?? []).length ? `<p class="small">Sources: ${s.sources.map((c, i) => `<a href="${esc(c.url ?? "#")}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}</p>` : ""}
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
    return `<div class="adm-card lead-card${dir.cardClass}" data-id="${esc(l.id)}">
      <div class="adm-card-head">
        <span class="adm-chip">${esc(l.vector)}</span>
        ${dir.chip}
        <span class="adm-chip">score ${esc(l.signal_score)}</span>
        <span class="gw-verdict ${vd}">${esc(inv.verdict ?? "—")}${inv.confidence != null ? ` · ${esc(inv.confidence)}%` : ""}</span>
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
    ? `<p class="small conflict-sources">Sources: ${urls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">[${i + 1}]</a>`).join(" ")}</p>`
    : "";
  return `<div class="conflict-card record-card">
    <div class="conflict-head">
      <span class="adm-chip">${esc((l.vector || "").replaceAll("_", " "))}</span>
      <span class="gw-verdict ${vd}">${esc(inv.verdict ?? "—")}${inv.confidence != null ? ` · ${esc(inv.confidence)}%` : ""}</span>
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
  scandalsCache = null; // govwatch list is now stale
  card.classList.add("adm-done");
  card.querySelector(".adm-actions").innerHTML = action === "approve"
    ? `<span class="adm-published">✓ Published${data.verdict ? " · verdict " + esc(data.verdict) : ""} — now live in Government Watch</span>`
    : `<span class="muted">✗ Rejected and discarded.</span>`;
}

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

// ================= ISSUES (Where India Stands) =================
async function showIssues() {
  hideAllViews();
  $("#issues-view").hidden = false;
  window.scrollTo(0, 0);
  const list = (await api("/api/issues")) ?? [];
  $("#issue-grid").innerHTML = list.map((i) => `
    <a class="issue-card${i.generated ? "" : " issue-pending"}" href="${i.generated ? `#/issue/${esc(i.slug)}` : "#/issues"}">
      <span class="issue-icon">${esc(i.icon || "📌")}</span>
      <span class="issue-name">${esc(i.title)}</span>
      <span class="issue-desc">${esc(i.description)}</span>
      ${i.generated ? `<span class="issue-go">Read analysis →</span>` : `<span class="issue-soon">Analysis pending</span>`}
    </a>`).join("");
}
async function showIssue(slug) {
  hideAllViews();
  $("#issue-detail-view").hidden = false;
  window.scrollTo(0, 0);
  const box = $("#issue-detail-body");
  box.innerHTML = `<p class="muted center">Loading…</p>`;
  const i = await api(`/api/issues/${encodeURIComponent(slug)}`);
  if (!i) { box.innerHTML = `<p class="muted center">This issue hasn't been analysed yet. Run <code>node server/issue-analyzer.js seed</code>.</p>`; return; }
  box.innerHTML = renderIssue(i);
}
const ASSESS_CLS = { STRONG: "vd-full", MIXED: "vd-partial", WEAK: "vd-none", UNCLEAR: "" };
function renderIssue(i) {
  const ivw = i.india_vs_world ?? {};
  const best = (ivw.best_performers ?? []).map((b) => `<li><strong>${esc(b.country)}</strong>${b.freedom ? ` <span class="muted small">(${esc(b.freedom.status)})</span>` : ""} — ${esc(b.what_they_do)}</li>`).join("");
  const govs = (i.by_government ?? []).map((g) => `
    <div class="issue-gov">
      <div class="issue-gov-head"><strong>${esc(g.government || g.period)}</strong> <span class="muted small">${esc(g.period)}</span>
        <span class="gw-verdict ${ASSESS_CLS[g.assessment] ?? ""}">${esc(g.assessment)}</span></div>
      ${g.stance ? `<p class="small"><em>Stance:</em> ${esc(g.stance)}</p>` : ""}
      ${(g.key_measures ?? []).length ? `<ul class="issue-measures">${g.key_measures.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
      ${g.record ? `<p class="small">${esc(g.record)}</p>` : ""}
    </div>`).join("");
  const parties = (i.by_party ?? []).map((pp) => `
    <div class="issue-party"><strong>${esc(pp.party)}</strong>${pp.stance ? ` — ${esc(pp.stance)}` : ""}
      ${(pp.notable_actions ?? []).length ? `<ul class="issue-measures">${pp.notable_actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}</div>`).join("");
  return `
    <div class="issue-head"><span class="issue-icon-lg">${esc(i.icon || "📌")}</span><h2>${esc(i.title)}</h2></div>
    <div class="card"><h3>What this means for India</h3><p>${esc(i.what_it_means)}</p></div>
    <div class="card"><h3>Where India stands today</h3><p>${esc(i.india_state)}</p></div>
    <div class="card"><h3>India vs the world</h3>
      <p>${esc(ivw.summary ?? "")}</p>
      ${ivw.rank_note ? `<p class="issue-rank">${esc(ivw.rank_note)}</p>` : ""}
      ${best ? `<h4>Best performers</h4><ul class="issue-best">${best}</ul>` : ""}
    </div>
    ${govs ? `<section class="issue-section"><h3>What governments have done</h3>${govs}</section>` : ""}
    ${parties ? `<section class="issue-section"><h3>Where the parties stand</h3>${parties}</section>` : ""}
    ${(i.key_facts ?? []).length ? `<div class="card"><h3>Key facts</h3><ul>${i.key_facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>` : ""}
    ${(i.sources ?? []).length ? `<p class="muted small">Sources: ${i.sources.map(esc).join(" · ")}</p>` : ""}
    <p class="muted small">Generated by ${esc(i.model ?? "GLM")} · ${i.generated_at ? new Date(i.generated_at).toLocaleDateString() : ""} · neutral analysis of the public record.</p>`;
}

// ================= TIPS PAGE =================
let tipRep = null;
function showTips() {
  hideAllViews();
  $("#tips-view").hidden = false;
  window.scrollTo(0, 0);
  $("#tip-page-category").innerHTML = ($("#tip-category")?.innerHTML) || "";
  $("#tip-rep-search").value = ""; $("#tip-rep-chosen").textContent = ""; tipRep = null;
  $("#tip-page-form").hidden = true;
}

// ================= OPS CONSOLE =================
// One-click chains. The worker is serial, so enqueue order = run order.
const OPS_PRESETS = [
  { key: "full", label: "Fresh evidence → ledger → engine", desc: "Ingest every rep, re-extract the analysis ledgers, then run the full Anomaly Engine (flags → leads). All free.", steps: [{ type: "ingest_all" }, { type: "extract_all" }, { type: "engine_scan" }] },
  { key: "incremental", label: "Incremental refresh (new/stale reps only)", desc: "Ingest ONLY reps never fetched or stale >7 days (not a full re-scrape), then re-extract ledgers and run the engine. All free.", steps: [{ type: "ingest_all", payload: { incremental: true, staleDays: 7 } }, { type: "extract_all" }, { type: "engine_scan" }] },
  { key: "analyze", label: "Analyze existing evidence", desc: "No fetching: re-extract ledgers from stored evidence, then run the engine. Free, fast.", steps: [{ type: "extract_all" }, { type: "engine_scan" }] },
  { key: "investigate", label: "Full investigation (engine + GLM)", desc: "Engine over everyone (free), then GLM L2/L3 on the global top 50 leads (paid, capped).", steps: [{ type: "investigate_all", payload: { top: 50 } }] },
  { key: "cards", label: "Refresh public cards", desc: "Rebuild every Summarizer report card from existing evidence (free chain).", steps: [{ type: "cards_all" }] },
];
const OPS_COMMANDS = [
  // ── Summarizer (Branch 1 — free) ──
  { type: "generate_card", label: "Summarizer · card for one rep", desc: "Build the public report card (computed facts + free-chain prose).", fields: [{ k: "politicianId", ph: "politician id", type: "text" }, { k: "noProse", type: "checkbox", label: "Skip prose (pure template)" }] },
  { type: "cards_all", label: "Summarizer · card all reps", desc: "Queue one card job per rep. Free — no paid LLM.", fields: [{ k: "noProse", type: "checkbox", label: "Skip prose" }, { k: "reingest", type: "checkbox", label: "Re-ingest first" }] },
  // ── Ingest / maintenance ──
  { type: "ingest_all", label: "Ingest all reps", desc: "Queue one ingest job per rep (fetch fresh evidence). Tick Incremental to skip reps fetched within the last N days — only new/stale reps, not a full re-scrape.", fields: [{ k: "incremental", type: "checkbox", label: "Incremental (new/stale only)" }, { k: "staleDays", ph: "7", type: "number" }] },
  { type: "ingest_politician", label: "Ingest one rep", desc: "Fetch evidence for a single politician id.", fields: [{ k: "politicianId", ph: "politician id", type: "text" }] },
  { type: "source_health", label: "Source health sweep", desc: "Aggregate the fetch-run ledger + prune old rows.", fields: [{ k: "days", ph: "14", type: "number" }] },
  { type: "roster_update", label: "Roster update", desc: "Refresh MP/RS roster from Sansad (dry-run unless Apply).", fields: [{ k: "apply", type: "checkbox", label: "Apply" }, { k: "mla", type: "checkbox", label: "Incl. MLAs" }] },
  { type: "mega_refresh", label: "Mega refresh", desc: "Re-download a bulk dataset (heavy).", fields: [{ k: "id", ph: "all or source id", type: "text" }] },
  { type: "repair_myneta", label: "Repair MyNeta URLs", desc: "Validate/repair affidavit URLs (dry-run unless Apply).", fields: [{ k: "apply", type: "checkbox", label: "Apply" }, { k: "onlySuspect", type: "checkbox", label: "Only suspect" }, { k: "limit", ph: "limit", type: "number" }] },
  { type: "cppp_ingest", label: "CPPP procurement ingest", desc: "Query the local 6.6GB contract-award DB per rep → gem evidence. Resumable; slow over the whole roster.", fields: [{ k: "office", ph: "MP | RS | MLA (blank = all)", type: "text" }, { k: "state", ph: "state (optional)", type: "text" }, { k: "limit", ph: "limit", type: "number" }] },
  // ── Analysis store (free extraction + detectors) ──
  { type: "extract_all", label: "Analysis · extract + detect", desc: "Run every deterministic extractor (facts/claims/relationships) then the ledger detectors. Pure code, free.", fields: [] },
  { type: "extract_prose", label: "Analysis · prose extract (free LLM)", desc: "News/fact-check/CBI/Wikipedia → claims via the FREE model chain. Leave limit blank + tick All for the full backfill.", fields: [{ k: "source", ph: "news | fact_check | cbi_press | wikipedia (blank = all)", type: "text" }, { k: "limit", ph: "25", type: "number" }, { k: "all", type: "checkbox", label: "All rows (full backfill)" }] },
  // ── Investigator (Branch 2 — private, GLM budget) ──
  { type: "engine_scan", label: "Engine · full scan", desc: "Every detector → small/big flags → leads with evidence. Pure code + free enrichment.", fields: [{ k: "detector", ph: "detector id (blank = all)", type: "text" }, { k: "politicianId", ph: "politician id (blank = all)", type: "text" }, { k: "dryRun", type: "checkbox", label: "Dry run (write nothing)" }] },
  { type: "engine_synthesis", label: "Engine · re-synthesise leads", desc: "Re-run flags → leads only (after tuning thresholds; no re-detection).", fields: [] },
  { type: "cppp_scan", label: "Engine · procurement scan (CPPP)", desc: "Run the CPPP procurement detectors (single-bidder, capture, splitting…) over the 4.9M-award corpus. Slow. Tick Rebuild to re-flatten the index first (needs CPPP_DB_PATH).", fields: [{ k: "rebuild", type: "checkbox", label: "Rebuild index first" }] },
  { type: "investigate_politician", label: "Investigator · one rep", desc: "Engine for one rep + GLM L2/L3 on their top leads (paid).", fields: [{ k: "politicianId", ph: "politician id", type: "text" }, { k: "top", ph: "10", type: "number" }] },
  { type: "investigate_all", label: "Investigator · full sweep", desc: "Engine for everyone (free) + GLM L2/L3 on the global top leads (paid, capped).", fields: [{ k: "top", ph: "50", type: "number" }] },
  { type: "investigate_lead", label: "Investigator · one lead", desc: "GLM investigation of a single lead id (paid). Use the Leads tab's Investigate button instead when browsing.", fields: [{ k: "leadId", ph: "lead id", type: "text" }] },
  { type: "run_synthesis", label: "Investigator · network hubs", desc: "Cross-entity network-hub meta-leads (pure code, free).", fields: [] },
  { type: "draft_stories", label: "Investigator · draft stories", desc: "Write journalist-handoff narratives from vetted leads (paid).", fields: [] },
  { type: "anomaly_scan", label: "Legacy · anomaly scan", desc: "Old standalone statistical scan — superseded by Engine · full scan.", fields: [] },
  // ── Editorial (public content, GLM, human-gated) ──
  { type: "discover_scandals", label: "Editorial · discover scandals", desc: "Scan news for new scandal proposals (self rate-limited; GLM runs only on your approval).", fields: [] },
  // ── Legacy (transition only) ──
  { type: "generate_report", label: "Legacy · GLM dossier", desc: "Old expensive dossier — retired; kept during the card transition.", fields: [{ k: "politicianId", ph: "politician id", type: "text" }, { k: "mode", type: "select", opts: ["incremental", "full", "recheck"] }] },
];
const OPS_DANGER = [
  { type: "reset_data", label: "Reset data", desc: "Delete reports/evidence/demo. Type RESET to confirm.", danger: "RESET",
    fields: [{ k: "scope", type: "select", opts: ["reports", "evidence", "demo", "all"] }, { k: "apply", type: "checkbox", label: "Apply (else dry-run)" }] },
];
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

const opsToken = () => ($("#ops-token").value.trim() || localStorage.getItem("pb_admin_token") || "");
let opsRosterPage = 1;

async function opsFetch(path, opts = {}) {
  const token = opsToken();
  if (!token) { $("#ops-status").textContent = "Enter your admin token to connect."; return null; }
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { "x-admin-token": token, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
  } catch { $("#ops-status").textContent = "✗ Network error."; return null; }
  if (res.status === 401) { $("#ops-status").textContent = "✗ Unauthorized — wrong admin token."; return null; }
  if (!res.ok) return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  return res.json().catch(() => null);
}

function showOps() {
  hideAllViews();
  $("#ops-view").hidden = false;
  window.scrollTo(0, 0);
  const saved = localStorage.getItem("pb_admin_token");
  if (saved && !$("#ops-token").value) $("#ops-token").value = saved;
  renderOpsCommands();
  if (saved) opsConnect();
}

function opsCmdCard(c) {
  const fields = (c.fields || []).map((f) => {
    if (f.type === "checkbox") return `<label class="ck"><input type="checkbox" data-k="${f.k}" /> ${esc(f.label || f.k)}</label>`;
    if (f.type === "select") return `<select data-k="${f.k}">${f.opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    return `<input type="${f.type === "number" ? "number" : "text"}" data-k="${f.k}" placeholder="${esc(f.ph || f.k)}" />`;
  }).join("");
  const dangerInput = c.danger ? `<input type="text" data-k="confirmPhrase" placeholder="type ${esc(c.danger)}" />` : "";
  // db_maintenance cards carry their tier/task as data-* so opsRun folds it into the
  // payload (the type is shared across many cards; the tier/task selects the work).
  const extra = `${c.task ? ` data-task="${esc(c.task)}"` : ""}${c.tier ? ` data-tier="${esc(c.tier)}"` : ""}`;
  return `<div class="ops-cmd" data-type="${esc(c.type)}"${extra}>
    <h4>${esc(c.label)}</h4><p class="desc">${esc(c.desc)}</p>
    <div class="row">${fields}${dangerInput}</div>
    <button class="${c.danger ? "ghost" : "primary"} ops-run" type="button">Run</button>
    <span class="ops-run-status muted small"></span>
  </div>`;
}
function renderOpsCommands() {
  $("#ops-commands").innerHTML = OPS_COMMANDS.map(opsCmdCard).join("");
  $("#ops-danger-body").innerHTML = OPS_DANGER.map(opsCmdCard).join("");
  $("#ops-presets").innerHTML = OPS_PRESETS.map((p) => `<div class="ops-cmd" data-preset="${esc(p.key)}">
    <h4>${esc(p.label)}</h4><p class="desc">${esc(p.desc)}</p>
    <p class="muted small">${p.steps.map((s) => esc(s.type)).join(" → ")}</p>
    <button class="primary ops-preset-run" type="button">Run chain</button>
    <span class="ops-run-status muted small"></span>
  </div>`).join("");
}

function opsShowTab(tab) {
  document.querySelectorAll("#ops-tabs .ops-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".ops-tabpane").forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  // Lazy-load per tab so switching is instant and cheap.
  if (tab === "engine") loadOpsEngine();
  if (tab === "tuning") loadOpsTuning();
  if (tab === "flags") loadOpsFlags(1);
  if (tab === "leads") loadOpsLeads(1);
  if (tab === "roster") loadOpsRoster(1);
  if (tab === "jobs") loadOpsJobs();
  if (tab === "health") loadOpsMaint();
}

async function opsRunPreset(el) {
  const preset = OPS_PRESETS.find((p) => p.key === el.dataset.preset);
  const statusEl = el.querySelector(".ops-run-status");
  statusEl.textContent = "Queuing chain…";
  let last = null, n = 0;
  for (const step of preset.steps) {
    const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type: step.type, payload: step.payload ?? {} }) });
    if (!res || res.error) { statusEl.textContent = `✗ ${res?.error ?? "failed"} at ${step.type}`; return; }
    last = res; n++;
  }
  statusEl.textContent = `queued ${n} job(s)`;
  loadOpsJobs();
  if (last) openOpsDrawer(last.id, preset.steps.at(-1).type);
}

function opsCollectPayload(cmdEl) {
  const payload = {};
  cmdEl.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.dataset.k;
    if (el.type === "checkbox") { if (el.checked) payload[k] = true; }
    else if (el.value !== "") payload[k] = el.type === "number" ? Number(el.value) : el.value;
  });
  return payload;
}

async function opsRun(cmdEl) {
  const type = cmdEl.dataset.type;
  const statusEl = cmdEl.querySelector(".ops-run-status");
  statusEl.textContent = "Queuing…";
  const payload = opsCollectPayload(cmdEl);
  if (cmdEl.dataset.task) payload.task = cmdEl.dataset.task;   // maintenance single-task cards
  if (cmdEl.dataset.tier) payload.tier = cmdEl.dataset.tier;   // maintenance tier cards
  const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type, payload }) });
  if (!res) { statusEl.textContent = "✗ failed"; return; }
  if (res.error) { statusEl.textContent = "✗ " + res.error; return; }
  statusEl.textContent = `queued ${String(res.id).slice(0, 8)}`;
  loadOpsJobs();
  openOpsDrawer(res.id, type);
}

async function opsConnect() {
  const token = opsToken();
  if (!token) { $("#ops-status").textContent = "Enter your admin token to connect."; return; }
  localStorage.setItem("pb_admin_token", token);
  $("#ops-status").textContent = "Loading…";
  const ok = await loadOpsSummary();
  if (!ok) return; // auth/network failed; message already set
  $("#ops-body").hidden = false;
  $("#ops-status").textContent = "Connected.";
  loadOpsHealth();
  loadOpsCounts();
  opsShowTab("overview");
  if (window.__opsTimer) clearInterval(window.__opsTimer);
  window.__opsTimer = setInterval(() => {
    if ($("#ops-view").hidden || !$("#ops-auto").checked) return;
    loadOpsSummary();
    loadOpsJobs();
    loadOpsCounts();
  }, 3000);
}

// Tab-badge counts (active big flags, leads awaiting decision) — cheap polls.
async function loadOpsCounts() {
  const f = await opsFetch("/api/admin/ops/flags?pageSize=1");
  if (f && !f.error) $("#ops-flagcount").textContent = f.counts ? `${f.counts.big}` : "";
  const l = await opsFetch("/api/admin/ops/leads?pageSize=1");
  if (l && !l.error) $("#ops-leadcount").textContent = `${(l.byStatus?.proposed ?? 0) + (l.byStatus?.detected ?? 0)}`;
}

const opsWhen = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toISOString().slice(0, 10); };
const opsClock = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toLocaleTimeString(); };
const opsBytes = (n) => { if (n == null) return "?"; const u = ["B", "KB", "MB", "GB"]; let i = 0, v = Number(n); while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };

async function loadOpsSummary() {
  const d = await opsFetch("/api/admin/ops/summary");
  if (!d || d.error) return false;
  const c = d.counts || {}, m = d.missing || {};
  const tiles = [
    { n: c.politicians, l: "reps" }, { n: c.evidence, l: "evidence rows" }, { n: c.reports, l: "reports" },
    { n: d.leads?.published ?? 0, l: "published leads" }, { n: c.scandals, l: "scandals" },
    { n: m.noReport, l: "reps w/o report", warn: true }, { n: m.noEvidence, l: "reps w/o evidence", warn: true },
  ];
  $("#ops-tiles").innerHTML = tiles.map((t) => `<div class="ops-tile${t.warn ? " warn" : ""}"><div class="n">${esc(t.n ?? 0)}</div><div class="l">${esc(t.l)}</div></div>`).join("");
  const cov = d.coverage || [];
  const maxRows = Math.max(1, ...cov.map((r) => r.rows));
  $("#ops-coverage").innerHTML = `<table class="ops-table"><thead><tr><th>source</th><th>rows</th><th>with content</th><th>last fetched</th></tr></thead><tbody>${cov.map((r) => `<tr><td>${esc(r.source_type)}</td><td>${esc(r.rows)} <span class="ops-bar" style="width:${Math.round(60 * r.rows / maxRows)}px"></span></td><td>${esc(r.with_content)}</td><td>${esc(opsWhen(r.last_fetched))}</td></tr>`).join("")}</tbody></table>`;
  return true;
}

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
  return `<span class="ops-badge ${cls}">${esc((label || "ok").toUpperCase())}</span>`;
};

// Render one finding as a row: task, status badge, and a compact detail summary.
function opsMaintFinding(f) {
  const skip = { task: 1, status: 1, ms: 1 };
  const bits = Object.entries(f).filter(([k]) => !skip[k])
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 80) : esc(String(v))}`)
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

let __opsPaused = false;

// Reflect worker paused-state on the Pause button (and remember it for the
// toggle), and show every job currently in flight — the pool runs several at
// once, so this is a list, not a single job.
async function loadOpsQueueState() {
  const d = await opsFetch("/api/admin/ops/queue");
  if (!d || d.error) return;
  __opsPaused = !!d.paused;
  const btn = $("#ops-pause");
  if (btn) {
    btn.textContent = __opsPaused ? "▶ Resume queue" : "⏸ Pause queue";
    btn.classList.toggle("primary", __opsPaused);
    btn.classList.toggle("ghost", !__opsPaused);
  }
  const runEl = $("#ops-running");
  if (runEl) {
    const running = d.running ?? [];
    runEl.innerHTML = running.length
      ? `▶ ${running.length} in flight: ` + running.map((j) =>
          `<a href="#" class="ops-runlink" data-id="${esc(j.id)}" data-type="${esc(j.type)}">${esc(j.type)}</a>`).join(" · ")
      : (__opsPaused ? "⏸ paused — nothing will be claimed until resumed" : "");
    runEl.querySelectorAll(".ops-runlink").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault();
      openOpsDrawer(a.dataset.id, a.dataset.type);
    }));
  }
}

// Per-job action buttons depend on status: queued jobs can be cancelled + bumped +
// edited; finished/dead jobs can be re-run. Everything keeps the log button.
function opsJobActions(j) {
  const log = `<button class="ghost small ops-joblog" data-id="${esc(j.id)}" data-type="${esc(j.type)}" type="button">log</button>`;
  if (j.status === "queued") {
    return `<button class="ghost small ops-jbump" data-id="${esc(j.id)}" data-dir="1" title="raise priority" type="button">▲</button>`
      + `<button class="ghost small ops-jbump" data-id="${esc(j.id)}" data-dir="-1" title="lower priority" type="button">▼</button>`
      + `<button class="ghost small ops-jedit" data-id="${esc(j.id)}" data-type="${esc(j.type)}" title="edit payload" type="button">edit</button>`
      + `<button class="ghost small ops-jcancel" data-id="${esc(j.id)}" type="button">cancel</button>` + log;
  }
  if (j.status === "done" || j.status === "dead") {
    return `<button class="ghost small ops-jrequeue" data-id="${esc(j.id)}" type="button">re-run</button>` + log;
  }
  return log; // running
}

async function loadOpsJobs() {
  loadOpsQueueState();
  const d = await opsFetch("/api/admin/ops/jobs");
  if (!d || d.error) return;
  const cc = d.counts || {};
  $("#ops-jobcounts").textContent = Object.keys(cc).length ? "— " + Object.entries(cc).map(([k, v]) => `${v} ${k}`).join(", ") : "";
  const jobs = (d.jobs || []).slice(0, 40);
  $("#ops-jobs").innerHTML = jobs.length
    ? `<table class="ops-table"><thead><tr><th>type</th><th>status</th><th>prio</th><th>created</th><th>error</th><th></th></tr></thead><tbody>${jobs.map((j) => `<tr><td>${esc(j.type)}</td><td><span class="ops-badge ${esc(j.status)}">${esc(j.status)}</span></td><td>${esc(j.priority ?? 0)}</td><td>${esc(opsClock(j.created_at))}</td><td class="muted small">${esc((j.last_error || "").slice(0, 60))}</td><td class="ops-jactions">${opsJobActions(j)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted small">No jobs yet. Run a command above.</p>`;
}

async function opsTogglePause() {
  const next = !__opsPaused;
  const r = await opsFetch("/api/admin/ops/queue/pause", { method: "POST", body: JSON.stringify({ paused: next }) });
  if (r && !r.error) { __opsPaused = !!r.paused; loadOpsQueueState(); loadOpsJobs(); }
}

async function opsReclaim() {
  if (!confirm("Requeue jobs stuck in 'running' for >10 min (orphaned by a past crash/restart)?")) return;
  const r = await opsFetch("/api/admin/ops/queue/reclaim", { method: "POST", body: JSON.stringify({ olderThanMinutes: 10 }) });
  if (r && !r.error) { alert(`Reclaimed ${r.reclaimed} stuck job(s) → queued.`); loadOpsJobs(); }
}

async function opsTrim(spec) {
  const label = spec.status ? `all ${spec.status} jobs` : `jobs older than ${spec.olderThanDays}d`;
  if (!confirm(`Delete ${label}? Running jobs are never touched.`)) return;
  const r = await opsFetch("/api/admin/ops/jobs/trim", { method: "POST", body: JSON.stringify(spec) });
  if (r && !r.error) loadOpsJobs();
}

async function opsJobCancel(id) {
  const r = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  if (r && r.reason === "running") alert("That job is already in flight — it can't be stopped mid-run. Pause the queue to stop new jobs from being claimed; the in-flight ones finish on their own.");
  loadOpsJobs();
}

async function opsJobRequeue(id) {
  const r = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}/requeue`, { method: "POST" });
  if (r && r.error) alert(r.error);
  loadOpsJobs();
}

async function opsJobBump(id, dir) {
  const job = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`);
  const cur = Number(job?.job?.priority ?? 0);
  await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ priority: cur + dir }) });
  loadOpsJobs();
}

async function opsJobEdit(id) {
  const cur = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`);
  const existing = JSON.stringify(cur?.job?.payload ?? {}, null, 0);
  const next = prompt("Edit job payload (JSON). Only queued jobs are editable.", existing);
  if (next == null) return;
  let payload;
  try { payload = JSON.parse(next); } catch { alert("Not valid JSON — nothing changed."); return; }
  const r = await opsFetch(`/api/admin/ops/jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ payload }) });
  if (r && r.error) alert(r.error);
  loadOpsJobs();
}

function openOpsDrawer(jobId, type) {
  $("#ops-drawer").hidden = false;
  $("#ops-drawer-title").textContent = `${type} · ${String(jobId).slice(0, 8)}`;
  $("#ops-drawer-log").textContent = "";
  let since = 0;
  const poll = async () => {
    const d = await opsFetch(`/api/admin/ops/logs/${encodeURIComponent(jobId)}?since=${since}`);
    if (!d || d.error || !d.lines?.length) return;
    since = d.last;
    const el = $("#ops-drawer-log");
    el.textContent += d.lines.map((l) => l.line).join("\n") + "\n";
    el.scrollTop = el.scrollHeight;
  };
  if (window.__opsDrawerTimer) clearInterval(window.__opsDrawerTimer);
  poll();
  window.__opsDrawerTimer = setInterval(poll, 1500);
}

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

// Reuse the log drawer for plain text (dry-run results).
function openOpsText(title, text) {
  $("#ops-drawer").hidden = false;
  $("#ops-drawer-title").textContent = title;
  if (window.__opsDrawerTimer) { clearInterval(window.__opsDrawerTimer); window.__opsDrawerTimer = null; }
  $("#ops-drawer-log").textContent = text;
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
        ? `<select data-key="${esc(key)}" data-def="${meta.def}"><option value="true"${val === true ? " selected" : ""}>on</option><option value="false"${val === false ? " selected" : ""}>off</option></select>`
        : `<input type="number" data-key="${esc(key)}" data-def="${meta.def}" value="${esc(val)}" ${meta.min != null ? `min="${meta.min}"` : ""} ${meta.max != null ? `max="${meta.max}"` : ""} ${meta.step != null ? `step="${meta.step}"` : `step="any"`} />`;
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
        ${(f.evidence ?? []).length ? `<p class="small"><strong>Evidence:</strong></p><ul class="small">${f.evidence.map((e) => `<li>${esc(e.note ?? "source")}${e.url ? ` — <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title ?? e.url)}</a>` : e.evidence_id ? ` <span class="muted">[evidence:${esc(e.evidence_id)}]</span>` : ""}</li>`).join("")}</ul>` : ""}
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
        ${(l.evidence_urls ?? []).length ? `<p class="small"><strong>Sources:</strong> ${l.evidence_urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.length > 60 ? u.slice(0, 57) + "…" : u)}</a>`).join(" · ")}</p>` : ""}
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

// Ops wiring — elements exist at load (script is at end of body).
$("#ops-load").addEventListener("click", opsConnect);
$("#ops-token").addEventListener("keydown", (e) => { if (e.key === "Enter") opsConnect(); });
$("#ops-health-days").addEventListener("change", loadOpsHealth);
$("#ops-rsearch").addEventListener("click", () => loadOpsRoster(1));
$("#ops-rq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsRoster(1); });
$("#ops-drawer-close").addEventListener("click", () => { $("#ops-drawer").hidden = true; if (window.__opsDrawerTimer) { clearInterval(window.__opsDrawerTimer); window.__opsDrawerTimer = null; } });
$("#ops-view").addEventListener("click", (e) => {
  const tab = e.target.closest(".ops-tab"); if (tab) { opsShowTab(tab.dataset.tab); return; }
  const preset = e.target.closest(".ops-preset-run"); if (preset) { opsRunPreset(preset.closest(".ops-cmd")); return; }
  const run = e.target.closest(".ops-run"); if (run) { opsRun(run.closest(".ops-cmd")); return; }
  const detRun = e.target.closest(".ops-det-run"); if (detRun) { opsEngineRun({ detector: detRun.closest(".ops-cmd").dataset.detector }); return; }
  const detDry = e.target.closest(".ops-det-dry"); if (detDry) { opsEngineRun({ detector: detDry.closest(".ops-cmd").dataset.detector, dryRun: true }); return; }
  const reset = e.target.closest(".ops-tune-reset");
  if (reset) {
    const input = document.querySelector(`#ops-tuning [data-key="${reset.dataset.key}"]:not(button)`);
    if (input) {
      if (input.tagName === "SELECT") input.value = input.dataset.def;
      else input.value = input.dataset.def;
      input.dataset.reset = "1";
    }
    return;
  }
  const lact = e.target.closest(".ops-lact"); if (lact) { opsLeadAction(lact); return; }
  const log = e.target.closest(".ops-joblog"); if (log) { openOpsDrawer(log.dataset.id, log.dataset.type); return; }
  // Queue control + batch run
  if (e.target.closest("#ops-pause")) { opsTogglePause(); return; }
  if (e.target.closest("#ops-reclaim")) { opsReclaim(); return; }
  const trim = e.target.closest(".ops-trim"); if (trim) { opsTrim(trim.dataset.older ? { olderThanDays: Number(trim.dataset.older) } : { status: trim.dataset.status }); return; }
  const jcancel = e.target.closest(".ops-jcancel"); if (jcancel) { opsJobCancel(jcancel.dataset.id); return; }
  const jrequeue = e.target.closest(".ops-jrequeue"); if (jrequeue) { opsJobRequeue(jrequeue.dataset.id); return; }
  const jbump = e.target.closest(".ops-jbump"); if (jbump) { opsJobBump(jbump.dataset.id, Number(jbump.dataset.dir)); return; }
  const jedit = e.target.closest(".ops-jedit"); if (jedit) { opsJobEdit(jedit.dataset.id); return; }
  if (e.target.closest("#ops-brun-sel")) { opsBatchRun("selected"); return; }
  if (e.target.closest("#ops-brun-filter")) { opsBatchRun("filter"); return; }
  if (e.target.closest(".ops-rprev")) { loadOpsRoster(Math.max(1, opsRosterPage - 1)); return; }
  if (e.target.closest(".ops-rnext")) { loadOpsRoster(opsRosterPage + 1); return; }
  if (e.target.closest(".ops-fprev")) { loadOpsFlags(Math.max(1, opsFlagsPage - 1)); return; }
  if (e.target.closest(".ops-fnext")) { loadOpsFlags(opsFlagsPage + 1); return; }
  if (e.target.closest(".ops-lprev")) { loadOpsLeads(Math.max(1, opsLeadsPage - 1)); return; }
  if (e.target.closest(".ops-lnext")) { loadOpsLeads(opsLeadsPage + 1); return; }
});
// Roster batch selection (checkboxes fire change, not click).
$("#ops-view").addEventListener("change", (e) => {
  const rsel = e.target.closest(".ops-rsel");
  if (rsel) { if (rsel.checked) opsSelected.add(rsel.dataset.id); else opsSelected.delete(rsel.dataset.id); opsUpdateSelCount(); return; }
  if (e.target.id === "ops-rall") {
    for (const p of opsRosterLastRows) { if (e.target.checked) opsSelected.add(p.id); else opsSelected.delete(p.id); }
    document.querySelectorAll(".ops-rsel").forEach((cb) => { cb.checked = e.target.checked; });
    opsUpdateSelCount();
  }
});
// Any manual edit to a tuning input cancels a pending reset for that key.
$("#ops-tuning").addEventListener("input", (e) => { if (e.target.dataset) delete e.target.dataset.reset; });
$("#ops-engine-run").addEventListener("click", () => opsEngineRun({}));
$("#ops-engine-dryrun").addEventListener("click", () => opsEngineRun({ dryRun: true }));
$("#ops-engine-synth").addEventListener("click", async () => {
  const res = await opsFetch("/api/admin/ops/jobs", { method: "POST", body: JSON.stringify({ type: "engine_synthesis", payload: {} }) });
  $("#ops-engine-status").textContent = res && !res.error ? `synthesis queued ${String(res.id).slice(0, 8)}` : "✗ failed";
  if (res && !res.error) openOpsDrawer(res.id, "engine_synthesis");
});
$("#ops-tuning-save").addEventListener("click", opsSaveTuning);
$("#ops-fsearch").addEventListener("click", () => loadOpsFlags(1));
$("#ops-fq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsFlags(1); });
$("#ops-lsearch").addEventListener("click", () => loadOpsLeads(1));
$("#ops-lq").addEventListener("keydown", (e) => { if (e.key === "Enter") loadOpsLeads(1); });

// ================= ROUTER =================
function route() {
  if (location.hash === "#/admin") { showAdmin(); return; }
  if (location.hash === "#/browse") { showBrowse(); return; }
  if (location.hash === "#/leaderboard") { showLeaderboard(); return; }
  if (location.hash === "#/issues") { showIssues(); return; }
  if (location.hash === "#/tips") { showTips(); return; }
  if (location.hash === "#/funding") { showFunding(); return; }
  if (location.hash === "#/scorecards") { showScorecards(); return; }
  if (location.hash === "#/govwatch") { showGovWatch(); return; }
  if (location.hash === "#/ops") { showOps(); return; }
  const iss = location.hash.match(/^#\/issue\/(.+)$/);
  if (iss) { showIssue(iss[1]); return; }
  const sc = location.hash.match(/^#\/scandal\/(.+)$/);
  if (sc) { showScandal(sc[1]); return; }
  const cmp = location.hash.match(/^#\/compare(?:\/([^/]+)\/([^/]+))?$/);
  if (cmp) { showCompare(cmp[1] === "_" ? null : cmp[1], cmp[2] === "_" ? null : cmp[2]); return; }
  const mi = location.hash.match(/^#\/ministry\/(.+)$/);
  if (mi) { showOrgCard("ministry", decodeURIComponent(mi[1])); return; }
  const pa = location.hash.match(/^#\/party\/([^/]+)(?:\/(.+))?$/);
  if (pa) { showOrgCard("party", pa[1], pa[2] ? decodeURIComponent(pa[2]) : "union"); return; }
  const m = location.hash.match(/^#\/rep\/(.+)$/);
  if (m) showReport(m[1]); else showHome();
}

// Highlight the active section in the persistent nav (browse+rep+compare all map to Representatives).
function syncNav() {
  const h = location.hash || "#/";
  let key = null;
  if (h.startsWith("#/browse") || h.startsWith("#/rep/") || h.startsWith("#/compare") || h.startsWith("#/leaderboard")) key = "browse";
  else if (h.startsWith("#/ministry/") || h.startsWith("#/party/")) key = "scorecards";
  else if (h.startsWith("#/govwatch") || h.startsWith("#/scandal/")) key = "govwatch";
  else if (h.startsWith("#/scorecards")) key = "scorecards";
  else if (h.startsWith("#/funding")) key = "funding";
  else if (h.startsWith("#/issues") || h.startsWith("#/issue/")) key = "issues";
  else if (h.startsWith("#/tips")) key = "tips";
  else if (h.startsWith("#/ops")) key = "ops";
  document.querySelectorAll("#appnav-links a").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
  const links = document.getElementById("appnav-links");
  if (links) links.classList.remove("open"); // close mobile menu on navigate
  const tgl = document.getElementById("appnav-toggle");
  if (tgl) tgl.setAttribute("aria-expanded", "false");
}
window.addEventListener("hashchange", () => { route(); syncNav(); });

// ================= GLOBAL SEARCH (command palette) =================
let cmdkScandals = null, cmdkIssues = null, cmdkActive = -1, cmdkRows = [];
const RECENT_KEY = "pb_recent_searches";
function getRecent() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } }
function pushRecent(item) {
  const cur = getRecent().filter((r) => !(r.type === item.type && r.id === item.id));
  cur.unshift(item);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, 6))); } catch {}
}
async function openCmdk() {
  const ov = $("#cmdk"); if (!ov) return;
  ov.hidden = false;
  // lazy-load government + issues data once
  if (cmdkScandals === null) cmdkScandals = (await api("/api/scandals")) ?? [];
  if (cmdkIssues === null) { const iss = await api("/api/issues"); cmdkIssues = Array.isArray(iss) ? iss : (iss ? Object.values(iss) : []); }
  const inp = $("#cmdk-input"); inp.value = ""; inp.focus();
  cmdkRender("");
}
function closeCmdk() { const ov = $("#cmdk"); if (ov) ov.hidden = true; cmdkActive = -1; }
function cmdkGather(q) {
  q = q.trim().toLowerCase();
  const groups = [];
  if (!q) {
    const recent = getRecent();
    if (recent.length) groups.push({ label: "Recent", items: recent.map((r) => ({ ...r, recent: true })) });
    return groups;
  }
  const people = state.reps.map((p) => [fuzzyScore(`${p.name} ${p.constituency ?? ""} ${p.party ?? ""} ${p.state ?? ""}`, q) + (p.latest ? 5 : 0), p])
    .filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 6)
    .map(([, p]) => ({ type: "rep", id: p.id, label: p.name, sub: [p.office, p.party, p.constituency || p.state].filter(Boolean).join(" · ") }));
  if (people.length) groups.push({ label: "Representatives", items: people });
  const gov = (cmdkScandals ?? []).map((s) => [fuzzyScore(`${s.title} ${s.party ?? ""} ${s.minister ?? ""} ${s.sector ?? ""}`, q), s])
    .filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, 5)
    .map(([, s]) => ({ type: "scandal", id: s.slug, label: s.title, sub: [s.sector, s.minister].filter(Boolean).join(" · ") }));
  if (gov.length) groups.push({ label: "Government Watch", items: gov });
  const issues = (cmdkIssues ?? []).filter((i) => `${i.title ?? i.name ?? ""} ${i.summary ?? ""}`.toLowerCase().includes(q))
    .slice(0, 4).map((i) => ({ type: "issue", id: i.slug ?? i.id, label: i.title ?? i.name, sub: "Where India Stands" }));
  if (issues.length) groups.push({ label: "Issues", items: issues });
  return groups;
}
function cmdkGoto(item) {
  pushRecent({ type: item.type, id: item.id, label: item.label, sub: item.sub });
  closeCmdk();
  if (item.type === "rep") location.hash = `#/rep/${item.id}`;
  else if (item.type === "scandal") location.hash = `#/scandal/${item.id}`;
  else if (item.type === "issue") location.hash = `#/issue/${item.id}`;
}
function cmdkRender(q) {
  const box = $("#cmdk-results");
  const groups = cmdkGather(q);
  cmdkRows = [];
  if (!groups.length) { box.innerHTML = `<div class="cmdk-empty">${q ? "No matches." : "Type to search people, scandals and issues."}</div>`; return; }
  let html = "";
  groups.forEach((g) => {
    html += `<div class="cmdk-group">${esc(g.label)}</div>`;
    g.items.forEach((it) => {
      const idx = cmdkRows.length; cmdkRows.push(it);
      const icon = it.type === "rep" ? "🧑‍⚖️" : it.type === "scandal" ? "🏛️" : "🧭";
      html += `<div class="cmdk-item" role="option" data-idx="${idx}"><span class="cmdk-ic">${icon}</span><span class="cmdk-main">${esc(it.label)}</span><span class="cmdk-sub">${esc(it.sub ?? "")}</span></div>`;
    });
  });
  box.innerHTML = html;
  cmdkActive = cmdkRows.length ? 0 : -1;
  cmdkPaint();
}
function cmdkPaint() {
  document.querySelectorAll("#cmdk-results .cmdk-item").forEach((el, i) => {
    const on = i === cmdkActive; el.classList.toggle("active", on);
    if (on) el.scrollIntoView({ block: "nearest" });
  });
}

// ================= TIPS =================
async function sha256Bytes(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)];
}
function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24; break;
  }
  return bits;
}
async function solvePow(challenge, difficulty, onProgress) {
  let nonce = 0;
  for (;;) {
    const hash = await sha256Bytes(`${challenge}:${nonce}`);
    if (leadingZeroBits(hash) >= difficulty) return nonce;
    nonce++;
    if (nonce % 2000 === 0) { onProgress?.(nonce); await new Promise(r => setTimeout(r)); }
  }
}

$("#tip-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const btn = $("#tip-submit"), status = $("#tip-status");
  btn.disabled = true;
  try {
    status.textContent = "Solving anti-spam puzzle…";
    const { challenge, difficulty_bits } = await api("/api/pow-challenge");
    const nonce = await solvePow(challenge, difficulty_bits, (n) => (status.textContent = `Solving… (${n.toLocaleString()} attempts)`));
    status.textContent = "Submitting…";
    const res = await fetch(`/api/politicians/${state.currentId}/tips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, nonce, category: $("#tip-category").value, text: $("#tip-text").value, website: document.querySelector(".hp").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { status.textContent = "✓ " + (data.note ?? "Received."); $("#tip-text").value = ""; }
    else           status.textContent = "✗ " + (data.error ?? "Something went wrong.");
  } catch { status.textContent = "✗ Network error — try again."; }
  finally { btn.disabled = false; }
});

// ================= INIT =================
// Browse-page filters re-render the directory (reset pagination each change).
["#browse-search","#f-state","#f-party","#f-office","#f-sort"].forEach((sel) =>
  $(sel)?.addEventListener("input", () => renderHome(true))
);
$("#f-clear")?.addEventListener("click", () => {
  ["#browse-search","#f-state","#f-party","#f-office"].forEach(s => { const e = $(s); if (e) e.value = ""; });
  const so = $("#f-sort"); if (so) so.value = "relevance";
  browseChip = null;
  renderHome(true);
});
// Quick-filter chips (toggle on/off)
document.querySelectorAll(".qchip").forEach((c) => c.addEventListener("click", () => {
  browseChip = browseChip === c.dataset.chip ? null : c.dataset.chip;
  renderHome(true);
}));
// Load more — grow the rendered slice without resetting.
$("#load-more")?.addEventListener("click", () => { browseShown += BROWSE_PAGE; renderHome(false); });
// Landing search jumps to the browse page, carrying the query.
$("#landing-search")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search").value;
  location.hash = "#/browse";
  setTimeout(() => { const b = $("#browse-search"); if (b) { b.value = q; renderHome(); } }, 0);
});

(async function init() {
  const [list, meth, cats] = await Promise.all([
    api("/api/politicians"),
    api("/api/methodology"),
    api("/api/tip-categories"),
  ]);
  state.reps = list ?? [];
  state.methodology = meth;
  $("#tip-category").innerHTML = (cats ?? []).map(c => `<option value="${c}">${c.replaceAll("_"," ")}</option>`).join("");
  buildFilters();
  wireComparePicker("a");
  wireComparePicker("b");
  ["#gw-level","#gw-sector","#gw-state","#gw-party"].forEach((s) => $(s)?.addEventListener("change", renderGovList));
  $("#gw-search")?.addEventListener("input", renderGovList);
  // Search suggestions (typeahead) on every search box, with bracket descriptors.
  attachAutocomplete("#search", "#landing-ac", repSuggestions, (it) => { location.hash = `#/rep/${it.id}`; },
    { seeAll: (q) => { location.hash = "#/browse"; setTimeout(() => { const b = $("#browse-search"); if (b) { b.value = q; renderHome(); } }, 0); } });
  attachAutocomplete("#browse-search", "#browse-ac", repSuggestions, (it) => { location.hash = `#/rep/${it.id}`; });
  attachAutocomplete("#gw-search", "#gw-ac", (q) => scandalSuggestions(q, scandalsCache), (it) => {
    if (it.kind === "scandal") { location.hash = `#/scandal/${it.id}`; return; }
    if (it.kind === "party") $("#gw-party").value = it.id;
    if (it.kind === "state") $("#gw-state").value = it.id;
    $("#gw-search").value = "";
    renderGovList();
  });
  // Tips page: rep picker + standalone submit form.
  wireTipPicker();
  $("#tip-page-form")?.addEventListener("submit", submitPageTip);
  document.querySelectorAll(".sc-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".sc-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    scActiveTab = t.dataset.sc;
    renderScorecardTab();
  }));
  document.querySelectorAll(".fund-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".fund-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    fundActiveTab = t.dataset.fund;
    renderFundingOverview();
  }));
  // Admin review queue (two tabs: scandal proposals, investigation leads)
  $("#admin-load").addEventListener("click", loadAdminQueue);
  $("#admin-token").addEventListener("keydown", (e) => { if (e.key === "Enter") loadAdminQueue(); });
  $("#dirnet-load")?.addEventListener("click", loadDirectorshipNetwork);
  $("#dirnet-pid")?.addEventListener("keydown", (e) => { if (e.key === "Enter") loadDirectorshipNetwork(); });
  document.querySelectorAll(".admin-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    adminTab = t.dataset.adminTab;
    $("#admin-panel-scandals").hidden = adminTab !== "scandals";
    $("#admin-panel-leads").hidden = adminTab !== "leads";
    $("#admin-panel-conflicts").hidden = adminTab !== "conflicts";
    $("#admin-panel-stories").hidden = adminTab !== "stories";
    $("#admin-panel-directorships").hidden = adminTab !== "directorships";
    if (adminToken()) loadAdminQueue();
  }));
  // Status filter tabs inside the All Leads / Story Drafts panels.
  document.querySelectorAll("#conflict-status-tabs .sc-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("#conflict-status-tabs .sc-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    leadStatusFilter = t.dataset.leadStatus ?? "";
    loadAllLeads();
  }));
  document.querySelectorAll("#story-status-tabs .sc-tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll("#story-status-tabs .sc-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    storyStatusFilter = t.dataset.storyStatus ?? "draft";
    loadStories();
  }));
  // "Compare with…" button on a report jumps into compare with that rep pre-filled;
  // also handles admin approve/reject clicks (delegated). Lead cards carry
  // data-id (no slug), scandal cards carry data-slug — route accordingly.
  document.addEventListener("click", (e) => {
    const cw = e.target.closest("[data-compare-with]");
    if (cw) { location.hash = `#/compare/${cw.dataset.compareWith}/_`; return; }
    const ap = e.target.closest(".adm-approve");
    if (ap) {
      const card = ap.closest(".adm-card");
      if (card.classList.contains("lead-card")) decideLead(ap.dataset.id, "approve", card);
      else decideProposal(ap.dataset.slug, "approve", card);
      return;
    }
    const rj = e.target.closest(".adm-reject");
    if (rj) {
      const card = rj.closest(".adm-card");
      if (card.classList.contains("lead-card")) decideLead(rj.dataset.id, "reject", card);
      else decideProposal(rj.dataset.slug, "reject", card);
      return;
    }
    const lb = e.target.closest(".lb-tab");
    if (lb) { lbMetric = lb.dataset.lb; renderLeaderboard(); return; }
    const hs = e.target.closest("#how-scored");
    if (hs) {
      e.preventDefault();
      const meth = $("#methodology");
      if (meth && !meth.hidden) { meth.open = true; meth.scrollIntoView({ behavior: "smooth", block: "start" }); }
      return;
    }
    const sc = e.target.closest("[data-scroll]");
    if (sc) { e.preventDefault(); document.getElementById(sc.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  });
  // Theme toggle
  syncThemeToggle();
  $("#theme-toggle")?.addEventListener("click", toggleTheme);
  // Evidence export + cite
  $("#export-csv")?.addEventListener("click", exportEvidenceCsv);
  $("#export-bib")?.addEventListener("click", exportEvidenceBibtex);
  $("#cite-link")?.addEventListener("click", (e) => copyCiteLink(e.currentTarget));
  // Global command-palette search
  $("#global-search-btn")?.addEventListener("click", openCmdk);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); const ov = $("#cmdk"); ov && ov.hidden ? openCmdk() : closeCmdk(); }
    else if (e.key === "Escape" && !$("#cmdk").hidden) { closeCmdk(); }
  });
  $("#cmdk-input")?.addEventListener("input", (e) => cmdkRender(e.target.value));
  $("#cmdk-input")?.addEventListener("keydown", (e) => {
    if (!cmdkRows.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); cmdkActive = (cmdkActive + 1) % cmdkRows.length; cmdkPaint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); cmdkActive = (cmdkActive - 1 + cmdkRows.length) % cmdkRows.length; cmdkPaint(); }
    else if (e.key === "Enter") { e.preventDefault(); if (cmdkRows[cmdkActive]) cmdkGoto(cmdkRows[cmdkActive]); }
  });
  $("#cmdk-results")?.addEventListener("mousedown", (e) => {
    const el = e.target.closest(".cmdk-item"); if (!el) return;
    e.preventDefault(); cmdkGoto(cmdkRows[+el.dataset.idx]);
  });
  $("#cmdk")?.addEventListener("mousedown", (e) => { if (e.target.id === "cmdk") closeCmdk(); });
  // Mobile nav toggle
  $("#appnav-toggle")?.addEventListener("click", () => {
    const links = $("#appnav-links");
    const open = links.classList.toggle("open");
    $("#appnav-toggle").setAttribute("aria-expanded", String(open));
  });
  route();
  syncNav();
})();

// ---- Tips page: rep picker + submit (reuses the POW solver) ----
function wireTipPicker() {
  const input = $("#tip-rep-search"), box = $("#tip-rep-results");
  if (!input) return;
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (q.length < 2) { box.hidden = true; return; }
    const hits = state.reps.filter((p) => `${p.name} ${p.constituency ?? ""} ${p.party ?? ""}`.toLowerCase().includes(q)).slice(0, 8);
    box.innerHTML = hits.map((p) => `<div class="cmp-hit" data-tip-id="${p.id}">${esc(p.name)} <span class="ac-desc">(${esc([p.office, p.party, p.constituency || p.state].filter(Boolean).join(" · "))})</span></div>`).join("");
    box.hidden = hits.length === 0;
  });
  box.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-tip-id]");
    if (!hit) return;
    tipRep = state.reps.find((p) => p.id === hit.dataset.tipId);
    $("#tip-rep-chosen").textContent = tipRep ? `Tip about: ${tipRep.name}` : "";
    input.value = tipRep?.name ?? "";
    box.hidden = true;
    $("#tip-page-form").hidden = !tipRep;
  });
}

async function submitPageTip(ev) {
  ev.preventDefault();
  if (!tipRep) return;
  const btn = $("#tip-page-submit"), status = $("#tip-page-status");
  btn.disabled = true;
  try {
    status.textContent = "Solving anti-spam puzzle…";
    const { challenge, difficulty_bits } = await api("/api/pow-challenge");
    const nonce = await solvePow(challenge, difficulty_bits, (n) => (status.textContent = `Solving… (${n.toLocaleString()} attempts)`));
    status.textContent = "Submitting…";
    const res = await fetch(`/api/politicians/${tipRep.id}/tips`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, nonce, category: $("#tip-page-category").value, text: $("#tip-page-text").value, website: $("#tips-view .hp").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { status.textContent = "✓ " + (data.note ?? "Received."); $("#tip-page-text").value = ""; }
    else           status.textContent = "✗ " + (data.error ?? "Something went wrong.");
  } catch { status.textContent = "✗ Network error — try again."; }
  finally { btn.disabled = false; }
}
