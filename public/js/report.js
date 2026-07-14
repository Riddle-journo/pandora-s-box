// report.js — showReport(id): the politician report/dossier page (Task 9.4),
// extracted from legacy.js. Mutates state.currentRep / state.currentEvidence.
import { $, esc, GRADE_COLORS, GRADE_TEXT, consequenceRank, SIGNAL_DOT, VERDICT_LABEL } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { hideAllViews } from "./views.js";
import {
  ringStyle, renderMethodology, renderCareerTimeline, renderCategories, renderFlags,
  renderScorecard, renderSnapshot, renderSignalBadges, renderVerifiedFindings,
  renderRelations, renderCriminal, renderFinancial, renderLegislative,
  renderBusiness, renderPositions, renderRevolving, renderPartyFunding, renderClaims,
  renderPartyHistory, renderPatterns, renderTransparencyFooter, renderCardView,
} from "./report-sections.js";
import { isBookmarked, toggleBookmark, recordRecentView, railCardHTML } from "./bookmarks.js";
import { buildReportToc } from "./toc.js";

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

export { showReport };
