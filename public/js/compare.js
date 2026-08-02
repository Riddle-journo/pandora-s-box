// compare.js — the side-by-side comparison view (Task 9.6), extracted from
// legacy.js. cmpSel remembers the two picked reps across hash changes.
import { $, esc, avatarColor, initials, GRADE_COLORS, GRADE_TEXT, SIGNAL_DOT } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";

// ================= COMPARE =================
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
      `<button class="cmp-hit" data-id="${esc(p.id)}">${esc(p.name)} <span class="ac-desc">(${esc([p.office, p.party, p.constituency || p.state].filter(Boolean).join(" · "))})</span></button>`
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
      <div class="avatar" style="background:${esc(avatarColor(X.politician.name))}">${initials(X.politician.name)}</div>
      <a href="#/rep/${esc(X.politician.id)}" class="cmp-name">${esc(X.politician.name)}</a>
      <div class="muted small">${esc(X.politician.party ?? "")} · ${esc(X.politician.constituency ?? "")}</div>
      <div class="grade-chip cmp-grade" style="background:${esc(GRADE_COLORS[g])}" title="${esc(GRADE_TEXT[g])}">${g === "INSUFFICIENT_DATA" ? "?" : g}</div>
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
      <div class="cmp-cell ${esc(ca)}">${va}</div><div class="cmp-cell ${esc(cb)}">${vb}</div>`;
  };

  const sigCell = (s) => s ? `${SIGNAL_DOT[s.state] ?? SIGNAL_DOT.GREY} <span class="cmp-sig-${esc((s.state||'GREY').toLowerCase())}">${esc(s.state)}</span>` : "—";
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

export { showCompare, wireComparePicker, loadComparison, renderComparison };
