// cmdk.js — the global command-palette search (Ctrl/Cmd-K), Task 9.11,
// extracted from legacy.js. initCmdk() wires the trigger button, keyboard
// shortcuts and result-list interaction.
import { $, esc, icon } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { fuzzyScore } from "./search.js";

let cmdkScandals = null, cmdkIssues = null, cmdkOrgs = null, cmdkActive = -1, cmdkRows = [];
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
  if (cmdkOrgs === null) cmdkOrgs = (await api("/api/orgs")) ?? [];
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
  const orgs = (cmdkOrgs ?? []).map((o) => [fuzzyScore(`${o.name} ${o.short ?? ""} ${o.scope}`, q) + (o.failures ? 3 : 0), o])
    .filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]).slice(0, 5)
    .map(([, o]) => ({ type: "org", id: o.key, label: o.name, sub: [o.kind === "psu" ? "PSU" : o.kind, o.scope !== "union" ? o.scope : null].filter(Boolean).join(" · ") }));
  if (orgs.length) groups.push({ label: "Organizations", items: orgs });
  return groups;
}
function cmdkGoto(item) {
  pushRecent({ type: item.type, id: item.id, label: item.label, sub: item.sub });
  closeCmdk();
  if (item.type === "rep") location.hash = `#/rep/${item.id}`;
  else if (item.type === "scandal") location.hash = `#/scandal/${item.id}`;
  else if (item.type === "issue") location.hash = `#/issue/${item.id}`;
  else if (item.type === "org") location.hash = `#/org/${item.id}`;
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
      const ic = it.type === "rep" ? icon("users") : it.type === "scandal" ? icon("landmark") : it.type === "org" ? icon("shield") : icon("compass");
      html += `<div class="cmdk-item" role="option" data-idx="${esc(idx)}"><span class="cmdk-ic">${ic}</span><span class="cmdk-main">${esc(it.label)}</span><span class="cmdk-sub">${esc(it.sub ?? "")}</span></div>`;
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

// Wiring — trigger button, Ctrl/Cmd-K + Escape, input, and result clicks.
// (These lines lived in the INIT section of legacy.js; they mutate cmdkActive,
// so they live with the palette's state.)
function initCmdk() {
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
}

export { getRecent, pushRecent, openCmdk, closeCmdk, cmdkGather, cmdkGoto, cmdkRender, cmdkPaint, initCmdk };
