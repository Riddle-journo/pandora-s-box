// toc.js — the report page's section nav + scroll-spy (Task 9.4/9.5),
// extracted from legacy.js.
import { $, esc } from "./core.js";

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

export { TOC_SECTIONS, buildReportToc };
