// Number parsing for Indian public-record figures. The whole point of the
// "computed-flags" layer is that arithmetic (asset growth, utilisation %, etc.)
// is done in CODE against real numbers — never eyeballed by the LLM from
// formatted strings. Everything here returns a plain number of RUPEES.

// "₹3.45 Cr", "₹3.45Cr", "Rs 45 Lac", "5 Crs", "Rs 15,23,45,000" → rupees.
// Also "Rs 3,09,16,833 ~ 3 Crore+": MyNeta/ADR affidavit figures give the exact
// comma-grouped rupees, then a "~" and a rounded approximation carrying a scale
// word. Only the figure BEFORE the "~" is authoritative — parsing the whole
// string would re-apply the trailing "Crore"/"Lac" multiplier to the already-full
// figure and inflate it ~1e7×. So drop everything from the first "~" onward.
export function parseRupees(input) {
  if (input == null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let raw = String(input);
  // Cut the "~ N Crore+" approximation, but only when a digit actually precedes
  // the "~" (guards a stray leading "~" from wiping out the whole value).
  const tilde = raw.indexOf("~");
  if (tilde > 0 && /\d/.test(raw.slice(0, tilde))) raw = raw.slice(0, tilde);
  // Remove Indian grouping commas FIRST (15,23,45,000 → 152345000), then strip
  // currency tokens with word boundaries — a bare /rs/ would eat the middle of
  // "Crs" and destroy the crore scale word.
  let s = raw.toLowerCase().replace(/,/g, "")
    .replace(/₹/g, " ").replace(/\brs\b\.?/g, " ").replace(/\binr\b/g, " ").trim();
  if (!s) return null;
  // First numeric token (handles "3.45", "150000000.00").
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (!Number.isFinite(n)) return null;
  // Scale word: look right AFTER the number (works with no space, "3.45cr"),
  // falling back to anywhere in the string. Covers crore/cr/crs and
  // lakh/lakhs/lac/lacs spellings.
  const after = s.slice(m.index + m[0].length);
  const CR = /^\s*cr(?:ore)?s?\b/, LAKH = /^\s*la(?:kh|c)s?\b/, TH = /^\s*thousand\b/;
  const CR_ANY = /\bcr(?:ore)?s?\b/, LAKH_ANY = /\bla(?:kh|c)s?\b/, TH_ANY = /\bthousand\b/;
  let mult = 1;
  if (CR.test(after) || CR_ANY.test(s)) mult = 1e7;
  else if (LAKH.test(after) || LAKH_ANY.test(s)) mult = 1e5;
  else if (TH.test(after) || TH_ANY.test(s)) mult = 1e3;
  return Math.round(n * mult);
}

// Compact human formatting back the other way, for display in computed facts.
export function formatRupees(n) {
  if (n == null || !Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(2)} Lakh`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

// "34.3%", "34.3", 0.343 → a percent number (0–100). Best-effort.
export function parsePercent(input) {
  if (input == null) return null;
  if (typeof input === "number") return input <= 1 ? input * 100 : input;
  const m = String(input).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// First 4-digit year found in a string ("2024", "FY 2022-23" → 2022).
export function parseYear(input) {
  const m = String(input ?? "").match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}
