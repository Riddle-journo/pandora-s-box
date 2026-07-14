// search.js — typeahead + fuzzy matching (Task 9.3), extracted from legacy.js.
// attachAutocomplete is the reusable combobox; fuzzyScore powers both the
// suggestion lists here and the command palette (cmdk).
import { $, esc } from "./core.js";
import { state } from "./state.js";

// ================= SEARCH AUTOCOMPLETE =================
// Reusable typeahead: as you type, shows up to 10 suggestions, each with a
// bracketed descriptor saying WHAT it is (person, party, state, scandal…).
function attachAutocomplete(inputSel, boxSel, getItems, onPick, opts = {}) {
  const input = $(inputSel), box = $(boxSel);
  if (!input || !box) return;
  let items = [];
  let active = -1;              // highlighted index; -1 = none
  const listId = box.id || (box.id = `ac-${Math.abs(inputSel.split("").reduce((a,c)=>a+c.charCodeAt(0),0))}`);
  // ARIA combobox wiring
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);
  box.setAttribute("role", "listbox");

  const paint = () => {
    box.querySelectorAll(".ac-item").forEach((el, i) => {
      const on = i === active;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", String(on));
      if (on) { input.setAttribute("aria-activedescendant", el.id); el.scrollIntoView({ block: "nearest" }); }
    });
    if (active < 0) input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { close(); return; }
    items = getItems(q).slice(0, 10);
    const rows = items.map((it, i) =>
      `<div class="ac-item" role="option" id="${listId}-o${i}" aria-selected="false" data-i="${i}"><span class="ac-main">${esc(it.label)}</span> <span class="ac-desc">(${esc(it.desc)})</span></div>`);
    if (opts.seeAll) rows.push(`<div class="ac-item ac-seeall" role="option" id="${listId}-all" aria-selected="false" data-i="all">See all results for “${esc(input.value.trim())}” →</div>`);
    box.innerHTML = rows.join("");
    active = -1;
    box.hidden = rows.length === 0;
    input.setAttribute("aria-expanded", String(!box.hidden));
  };
  const close = () => { box.hidden = true; box.innerHTML = ""; active = -1; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); };
  const pick = (i) => {
    if (i === "all") { opts.seeAll?.(input.value.trim()); close(); return; }
    const it = items[i]; if (it) onPick(it, input); close();
  };

  input.addEventListener("input", render);
  input.addEventListener("focus", () => { if (input.value.trim()) render(); });
  input.addEventListener("blur", () => setTimeout(close, 180));
  input.addEventListener("keydown", (e) => {
    const rows = box.querySelectorAll(".ac-item");
    if (box.hidden || !rows.length) {
      if (e.key === "Enter" && opts.seeAll && input.value.trim()) { /* let form submit / seeAll handle */ }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % rows.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + rows.length) % rows.length; paint(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const el = rows[active >= 0 ? active : 0];
      pick(el.dataset.i === "all" ? "all" : +el.dataset.i);
    }
    else if (e.key === "Escape") { close(); }
  });
  box.addEventListener("mousedown", (e) => { // mousedown fires before blur
    const el = e.target.closest(".ac-item"); if (!el) return;
    e.preventDefault();
    pick(el.dataset.i === "all" ? "all" : +el.dataset.i);
  });
}

// ── Fuzzy matching: exact substring ranks highest, then per-token prefix /
//    small-edit-distance fallback so typos ("modii", "gandi") still match. ──
function normStr(s) { return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
// Levenshtein with early exit at `max` (returns max+1 if exceeded).
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i]; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v; if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Score a haystack against a query. Returns 0 (no match) … higher = better.
function fuzzyScore(hay, q) {
  hay = normStr(hay); q = normStr(q);
  if (!q) return 0;
  if (hay.includes(q)) return hay.startsWith(q) ? 100 : (` ${hay}`.includes(` ${q}`) ? 80 : 60); // exact / word-start / substring
  const words = hay.split(" ");
  let total = 0;
  for (const tok of q.split(" ")) {
    if (!tok) continue;
    let best = 0;
    for (const w of words) {
      if (tok.length >= 2 && w.startsWith(tok)) { best = Math.max(best, 40); continue; } // word begins with typed token
      const max = tok.length <= 4 ? 1 : 2;               // tolerate 1–2 typos by word length
      const d = editDistance(w, tok, max);
      if (d <= max) best = Math.max(best, 40 - d * 12);   // 28 (d=1) or 16 (d=2)
    }
    if (best === 0) return 0;                             // every query token must match something
    total += best;
  }
  return total;
}

// Representative suggestions with "(office · party · place)" descriptors.
function repSuggestions(q) {
  const scored = [];
  for (const p of state.reps) {
    const s = fuzzyScore(`${p.name} ${p.constituency ?? ""} ${p.party ?? ""} ${p.state ?? ""}`, q);
    if (s > 0) scored.push([s + (p.latest ? 5 : 0), p]); // small boost for reps with a dossier
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 10).map(([, p]) => ({ id: p.id, label: p.name, desc: [p.office, p.party, p.constituency || p.state].filter(Boolean).join(" · ") || "representative" }));
}

// Scandal-page suggestions: matching scandals, plus party/state shortcuts.
// `scandals` is the caller's cached /api/scandals list (owned by the govwatch
// view) — passed in so this module stays free of view state.
function scandalSuggestions(q, scandals) {
  const out = [];
  for (const s of (scandals ?? [])) {
    if (`${s.title} ${s.party ?? ""} ${s.minister ?? ""}`.toLowerCase().includes(q))
      out.push({ kind: "scandal", id: s.slug, label: s.title, desc: [s.sector, s.party].filter(Boolean).join(" · ") || "scandal" });
    if (out.length >= 7) break;
  }
  for (const pa of [...new Set((scandals ?? []).map((s) => s.party).filter(Boolean))])
    if (pa.toLowerCase().includes(q)) out.push({ kind: "party", id: pa, label: pa, desc: "party" });
  for (const st of [...new Set((scandals ?? []).map((s) => s.state).filter(Boolean))])
    if (st.toLowerCase().includes(q)) out.push({ kind: "state", id: st, label: st, desc: "state" });
  return out.slice(0, 10);
}

export { attachAutocomplete, normStr, editDistance, fuzzyScore, repSuggestions, scandalSuggestions };
