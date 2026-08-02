// ops-shared.js — helpers every ops-console tab needs: the authenticated fetch
// wrapper, the value formatters, and the generic command-card renderer/reader.
// Extracted verbatim from ops.js when that module was split along its tab seams.
import { $, esc } from "./core.js";

const opsToken = () => ($("#ops-token").value.trim() || localStorage.getItem("pb_admin_token") || "");

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

const opsWhen = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toISOString().slice(0, 10); };
const opsClock = (v) => { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toLocaleTimeString(); };
const opsBytes = (n) => { if (n == null) return "?"; const u = ["B", "KB", "MB", "GB"]; let i = 0, v = Number(n); while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };

function opsCmdCard(c) {
  const fields = (c.fields || []).map((f) => {
    if (f.type === "checkbox") return `<label class="ck"><input type="checkbox" data-k="${esc(f.k)}" /> ${esc(f.label || f.k)}</label>`;
    if (f.type === "select") return `<select data-k="${esc(f.k)}">${f.opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
    return `<input type="${f.type === "number" ? "number" : "text"}" data-k="${esc(f.k)}" placeholder="${esc(f.ph || f.k)}" />`;
  }).join("");
  const dangerInput = c.danger ? `<input type="text" data-k="confirmPhrase" placeholder="type ${esc(c.danger)}" />` : "";
  // db_maintenance cards carry their tier/task as data-* so opsRun folds it into the
  // payload (the type is shared across many cards; the tier/task selects the work).
  return `<div class="ops-cmd" data-type="${esc(c.type)}"${c.task ? ` data-task="${esc(c.task)}"` : ""}${c.tier ? ` data-tier="${esc(c.tier)}"` : ""}>
    <h4>${esc(c.label)}</h4><p class="desc">${esc(c.desc)}</p>
    <div class="row">${fields}${dangerInput}</div>
    <button class="${c.danger ? "ghost" : "primary"} ops-run" type="button">Run</button>
    <span class="ops-run-status muted small"></span>
  </div>`;
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

export { opsToken, opsFetch, opsWhen, opsClock, opsBytes, opsCmdCard, opsCollectPayload };
