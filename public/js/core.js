// Core utilities + theme + shared constants, extracted from app.js (Task 9.1).
// Pure helpers only — no view logic, no mutable app state (that's state.js).
const $ = (sel) => document.querySelector(sel);

// ── Theme: apply saved preference before first paint (no flash) ──
(function applyStoredTheme() {
  try {
    const t = localStorage.getItem("pb_theme");
    if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
  } catch {}
})();
function currentTheme() {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced) return forced;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("pb_theme", next); } catch {}
  syncThemeToggle();
}
function syncThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.innerHTML = icon(currentTheme() === "dark" ? "sun" : "moon");
}

// Render an inline SVG icon from the sprite in index.html.
const icon = (name, cls = "") => `<svg class="${esc(cls ? "icon " + cls : "icon")}" aria-hidden="true"><use href="#i-${esc(name)}"></use></svg>`;

const GRADE_COLORS = {
  A: "#168a52", B: "#5ba636", C: "#b97e0a",
  D: "#cf6a1f", E: "#c5392c", F: "#9c2b21", INSUFFICIENT_DATA: "#97a0ad",
};
const GRADE_TEXT = {
  A: "Strong documented record", B: "Good record, minor issues", C: "Mixed record",
  D: "Significant documented concerns", E: "Serious documented concerns",
  F: "Severe documented record", INSUFFICIENT_DATA: "Not enough evidence yet",
};
const CONF = {
  high:   { dots: "●●●", label: "Strong evidence" },
  medium: { dots: "●●○", label: "Moderate evidence" },
  low:    { dots: "●○○", label: "Limited evidence" },
};
const AVATAR_COLORS = ["#1f3a93","#c2255c","#0b7285","#5f3dc4","#a61e4d","#2b8a3e","#d9480f"];

// Lower rank = more "consequential" (worst documented record first); no report last.
const GRADE_RANK = { F: 0, E: 1, D: 2, C: 3, B: 4, A: 5, INSUFFICIENT_DATA: 6 };
function consequenceRank(p) { return p.latest ? (GRADE_RANK[p.latest.grade] ?? 6) : 9; }

// Shared across the report, compare, govwatch and scorecard views.
// CSS-drawn dots (theme-aware) instead of emoji.
const SIGNAL_DOT = {
  RED: '<span class="sig-dot sig-red"></span>',
  AMBER: '<span class="sig-dot sig-amber"></span>',
  GREEN: '<span class="sig-dot sig-green"></span>',
  GREY: '<span class="sig-dot"></span>',
};
const VERDICT_LABEL = {
  NONE: { txt: "No accountability", cls: "vd-none" },
  PARTIAL: { txt: "Partial accountability", cls: "vd-partial" },
  FULL: { txt: "Full accountability", cls: "vd-full" },
};


const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// href/src guard for URLs that came from scraped or ingested data. esc() alone
// cannot stop `javascript:`/`data:` in a URL position, and every external link
// on this site originates in fetched evidence. Anything that is not http(s),
// mailto, a same-page fragment or a site-relative path collapses to "#".
//
// The bare-slash alternative must come LAST and own the leading `/`: written as
// `\/(?!\/)|\.{0,2}\/` the `\.{0,2}\/` branch matched zero dots + one slash, so
// it matched the first `/` of `//evil.example` and cancelled the lookahead —
// protocol-relative URLs (which resolve to an attacker host, same scheme) sailed
// through. `\.{1,2}\/` keeps `./x` and `../x`; the lookahead rejects BOTH slash
// kinds because the URL parser folds `\` into `/` for http(s), so `/\evil.example`
// is just another spelling of `//evil.example`.
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:|#|\.{1,2}\/|\/(?![/\\]))/i;
const safeUrl = (u) => {
  const s = String(u ?? "").trim();
  return SAFE_URL_RE.test(s) ? esc(s) : "#";
};
const avatarColor = (name) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AVATAR_COLORS[h % AVATAR_COLORS.length]; };
const initials = (name) => name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join("");

function barColor(score) {
  if (score < 0) return "var(--na)";
  if (score >= 70) return "var(--good)";
  if (score >= 45) return "var(--mid)";
  return "var(--bad)";
}

function confChip(level, reason) {
  const c = CONF[level] ?? CONF.low;
  return `<span class="conf ${esc(level)}" title="${esc(reason)}"><span class="dots">${c.dots}</span>${c.label}</span><span class="conf-reason">${esc(reason ?? "")}</span>`;
}

// Convert [n] citation markers in text to superscript links.
// citations: array of {n, url, title, admissible}
function withCites(rawText, citations) {
  const escaped = esc(rawText ?? "");
  return escaped.replace(/\[(\d+)\]/g, (_, n) => {
    const c = (citations ?? []).find((x) => x.n === parseInt(n));
    if (c) return `<sup><a href="${safeUrl(c.url)}" target="_blank" rel="noopener" class="cite-ref" title="${esc(c.title)}">[${n}]</a></sup>`;
    return `<sup class="cite-ref">[${n}]</sup>`;
  });
}

export {
  $, currentTheme, toggleTheme, syncThemeToggle, icon,
  GRADE_COLORS, GRADE_TEXT, CONF, AVATAR_COLORS,
  esc, safeUrl, avatarColor, initials, barColor, confChip, withCites,
  consequenceRank, SIGNAL_DOT, VERDICT_LABEL,
};
