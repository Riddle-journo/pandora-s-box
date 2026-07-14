// tips.js — anonymous tip submission (Task 9.9), extracted from legacy.js:
// the standalone tips page (rep picker + form), the report-page tip form
// handler, and the SHA-256 proof-of-work anti-spam solver they share.
import { $, esc } from "./core.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { hideAllViews } from "./views.js";

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
// ── Proof-of-work anti-spam ──
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
// Tip form on the report page (wired from init: #tip-form submit).
async function submitReportTip(ev) {
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
}

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


export { showTips, sha256Bytes, leadingZeroBits, solvePow, submitReportTip, wireTipPicker, submitPageTip };
