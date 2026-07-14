// report-sections.js — pure-ish (data) => html renderers for the politician
// report page + org (ministry/party) cards (Task 9.4), extracted from legacy.js.
import { $, esc, barColor, confChip, withCites, GRADE_COLORS, GRADE_TEXT } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { hideAllViews } from "./views.js";

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

export {
  ringStyle, renderMethodology, renderCareerTimeline, renderCategories, renderFlags,
  renderScorecard, renderSnapshot, citeList, renderSignalBadges, renderVerifiedFindings,
  renderRelationGraph, renderRelations, renderCriminal, renderFinancial, renderLegislative,
  renderBusiness, renderPositions, renderRevolving, renderPartyFunding, renderClaims,
  renderPartyHistory, renderPatterns, renderTransparencyFooter,
  renderCardSection, renderCardScorecard, renderCardView, showOrgCard,
};
