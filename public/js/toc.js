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
// Sort TOC entries into DOM order. Entries are { id, label, el }.
//
// This replaces "splice the dynamic sections in after the #exec-card entry":
// #exec-card is only unhidden when the report card has a `summary`, so for any
// rep without one findIndex() returned -1, `at + 1` was 0, and every dynamic
// card section was inserted at the FRONT of the nav — the TOC silently stopped
// matching document order. Document order is the thing we actually want, so ask
// the DOM for it instead of anchoring on one section that may not be there.
// Exported for the unit test.
function orderTocEntries(entries) {
  return [...entries].sort((a, b) => {
    const rel = a.el.compareDocumentPosition(b.el);
    if (rel & 4) return -1; // Node.DOCUMENT_POSITION_FOLLOWING: b comes after a
    if (rel & 2) return 1;  // Node.DOCUMENT_POSITION_PRECEDING: b comes before a
    return 0;
  });
}

let tocObserver = null;
function buildReportToc() {
  const nav = $("#report-toc");
  if (!nav) return;
  const onScreen = (el) => el && !el.hidden && el.offsetParent !== null;
  const fixed = TOC_SECTIONS
    .map(([id, label]) => ({ id, label, el: document.getElementById(id) }))
    .filter((e) => onScreen(e.el));
  // Dynamic report-card sections (collapsed <details> inside #card-sections).
  const dyn = [...document.querySelectorAll("#card-sections details.card-sec")]
    .filter(onScreen)
    .map((d) => ({ id: d.id, label: (d.querySelector("h3")?.textContent || "Section").split("—")[0].trim().slice(0, 22), el: d }));
  const visible = orderTocEntries([...fixed, ...dyn]);
  if (visible.length < 3) { nav.hidden = true; nav.innerHTML = ""; return; }
  nav.innerHTML = visible.map(({ id, label }) =>
    `<a href="#${esc(id)}" class="toc-link" data-toc="${esc(id)}">${esc(label)}</a>`).join("");
  nav.hidden = false;
  // Smooth scroll (scroll-margin-top in CSS handles the sticky offset);
  // deep links open a collapsed <details> section before scrolling to it.
  nav.querySelectorAll(".toc-link").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const el = document.getElementById(a.dataset.toc);
    if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    el.closest("details")?.setAttribute("open", "");
    el.scrollIntoView({ behavior: "smooth", block: "start" });
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
  visible.forEach(({ el }) => tocObserver.observe(el));
}

export { TOC_SECTIONS, buildReportToc, orderTocEntries };
