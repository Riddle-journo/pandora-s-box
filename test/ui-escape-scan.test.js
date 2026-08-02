// ui-escape-scan.test.js — structural guard for the frontend's escaping rule.
//
// public/js/** renders with string templates and innerHTML; there is no build
// step and no framework auto-escaping, so every interpolation is guarded by a
// hand-called esc() (public/js/core.js). To be clear about scope: interpolating
// an unescaped value into innerHTML is the SAME stored-XSS class in text
// context as in attribute context — text-context slips are not "merely ugly".
// This scan is limited to MARKUP context (inside a tag: attribute values,
// unquoted values, and attribute/tag-name slots) because that is the part it
// can decide structurally without parsing HTML text nodes. A text-context slip
// is out of this scan's declared scope, not out of the threat model.
//
// Why a lexer and not a regex over the raw source: the previous version matched
// attribute values with /=\s*(["'])((?:(?!\1)[\s\S])*?)\1/g, which stops at the
// first nested same-type quote. That is exactly the shape of
//   `class="pill ${x ? "a" : ""} ${raw}"`
// so the interpolations MOST likely to be unwrapped were the ones it silently
// skipped, and it reported success while seeing almost nothing. Instead we lex
// each file, keep only TEMPLATE-LITERAL TEXT (every JS expression, string,
// comment and regex blanked to spaces, at every nesting depth), and decide each
// `${…}`'s context from the last unclosed tag-opening `<` before it. That sees
// nested quotes, unquoted attribute values, interpolated attribute names and
// nested templates in one pass, and needs no per-line exemptions.
//
// Still deliberately conservative about what counts as SAFE — a false positive
// would train people to disable the test — but a false negative that hides a
// raw interpolation is the failure this guard exists to prevent, so anything
// ambiguous is FLAGGED, and the safe forms are a short, explicit list.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "js");

// Wrappers that make a value safe anywhere in markup. esc() escapes & < > " ';
// safeUrl() esc()s AND rejects non-http(s) schemes for href/src positions.
const SAFE_WRAPPERS = ["esc", "safeUrl"];

// encodeURIComponent leaves ' ! * ( ) ~ UNENCODED. It is therefore safe inside
// a DOUBLE-quoted attribute value only — never in a single-quoted one (the
// apostrophe closes it), and never where the value is unquoted.
const DOUBLE_QUOTE_ONLY_WRAPPERS = ["encodeURIComponent"];

// Whole-expression forms that cannot carry markup because they are arithmetic.
const NUMERIC_CALLS = ["Math.abs", "Math.max", "Math.min", "Math.round", "Math.floor", "Math.ceil", "Number"];

// Bare locals that are provably numbers, kept per-file so the exemption cannot
// leak to a same-named data field elsewhere. Keep this list SMALL: escaping is
// nearly free, so a new entry needs a reason beyond "it's noisy".
const NUMERIC_LOCALS = {
  // SVG geometry for the relationship graph: viewBox size and centre point,
  // all computed from the two literals W and H a few lines above.
  "report-sections.js": new Set(["W", "H", "cx", "cy"]),
};

// ── Lexer ───────────────────────────────────────────────────────────────────
// Returns { masked, exprs }. `masked` has the same length as `src` (newlines
// kept so line numbers still work) and every character that is NOT literal text
// inside a template literal is blanked to a space. `exprs` lists every `${…}`
// with its source span, its expression text, and the start offset of the
// OUTERMOST template literal containing it — its "scope" for context purposes,
// so a nested template still sees the tag its parent opened.
function maskSource(src) {
  const masked = new Array(src.length);
  for (let i = 0; i < src.length; i++) masked[i] = src[i] === "\n" ? "\n" : " ";
  const exprs = [];

  // Last significant character before `p` (whitespace and block comments skipped).
  function prevSignificant(p) {
    let i = p - 1;
    while (i >= 0) {
      if (/\s/.test(src[i])) { i--; continue; }
      if (src[i] === "/" && src[i - 1] === "*") {
        const at = src.lastIndexOf("/*", i - 2);
        if (at < 0) return "";
        i = at - 1; continue;
      }
      return src[i];
    }
    return "";
  }

  // `/` starts a regex literal (not division) after an operator/opener or a
  // keyword. Regexes here routinely contain < > " ' ` and braces, so getting
  // this wrong would let a regex swallow real markup.
  const REGEX_KEYWORDS = ["return", "typeof", "case", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "instanceof"];
  function regexAllowedAt(p) {
    const c = prevSignificant(p);
    if (c === "") return true;
    if ("([{,;:=!&|?+-*%^~<>".includes(c)) return true;
    let i = p - 1;
    while (i >= 0 && /\s/.test(src[i])) i--;
    const end = i + 1;
    while (i >= 0 && /[\w$]/.test(src[i])) i--;
    return REGEX_KEYWORDS.includes(src.slice(i + 1, end));
  }

  function readString(i) { // src[i] is ' or "
    const q = src[i++];
    while (i < src.length) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === q) return i + 1;
      if (src[i] === "\n") return i; // unterminated — resync at the newline
      i++;
    }
    return i;
  }
  function readLineComment(i) { const nl = src.indexOf("\n", i); return nl < 0 ? src.length : nl; }
  function readBlockComment(i) { const e = src.indexOf("*/", i + 2); return e < 0 ? src.length : e + 2; }
  function readRegex(i) { // src[i] is the opening /
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "\n") return i;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) { i++; while (/[a-z]/i.test(src[i] ?? "")) i++; return i; }
      i++;
    }
    return i;
  }

  function readTemplate(i, outerScope) { // src[i] is the opening backtick
    const scope = outerScope ?? i;
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") return i + 1;
      if (c === "$" && src[i + 1] === "{") { i = readExpr(i, scope); continue; }
      masked[i] = c; // ← template TEXT: the only thing the mask keeps
      i++;
    }
    return i;
  }
  function readExpr(start, scope) { // src[start] === "$", src[start + 1] === "{"
    let i = start + 2, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") { depth++; i++; continue; }
      if (c === "}") { depth--; i++; continue; }
      if (c === "`") { i = readTemplate(i, scope); continue; }
      if (c === "'" || c === '"') { i = readString(i); continue; }
      if (c === "/" && src[i + 1] === "/") { i = readLineComment(i); continue; }
      if (c === "/" && src[i + 1] === "*") { i = readBlockComment(i); continue; }
      if (c === "/" && regexAllowedAt(i)) { i = readRegex(i); continue; }
      i++;
    }
    exprs.push({ start, expr: src.slice(start + 2, Math.max(start + 2, i - 1)), scope });
    return i;
  }

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "`") { i = readTemplate(i, null); continue; }
    if (c === "'" || c === '"') { i = readString(i); continue; }
    if (c === "/" && src[i + 1] === "/") { i = readLineComment(i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = readBlockComment(i); continue; }
    if (c === "/" && regexAllowedAt(i)) { i = readRegex(i); continue; }
    i++;
  }
  return { masked: masked.join(""), exprs };
}

// ── Context ─────────────────────────────────────────────────────────────────
// `masked` holds template text only, so the nearest tag-opening `<` that has no
// `>` after it means the interpolation lands INSIDE a tag. Returns null for
// text context (out of scope), else the kind and the enclosing quote char.
function contextAt(masked, scope, start) {
  const before = masked.slice(scope, start);
  const gt = before.lastIndexOf(">");
  let lt = -1;
  for (let k = before.length - 1; k > gt; k--) {
    if (before[k] !== "<") continue;
    const next = before[k + 1];
    // A tag start is followed by a name, `/`, `!`, or by this very
    // interpolation (`<${tag}>`). Anything else is a literal "a < b".
    if (next === undefined || /[A-Za-z/!]/.test(next)) { lt = k; break; }
  }
  if (lt < 0) return null;
  let quote = null;
  for (let k = lt; k < before.length; k++) {
    const ch = before[k];
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
  }
  if (quote) return { kind: "attr", quote };
  if (/=\s*$/.test(before)) return { kind: "unquoted", quote: null };
  return { kind: "tag", quote: null }; // attribute-name / tag-name slot
}

// ── Expression safety ───────────────────────────────────────────────────────
// True when `expr` is exactly one call to one of `names` — the call's closing
// paren must be the last character, so `esc(a) + b` and `x ? esc(a) : b` do NOT
// count as escaped (they aren't: the unwrapped half still reaches the output).
function isWholeCallTo(expr, names) {
  for (const name of names) {
    if (!expr.startsWith(name + "(")) continue;
    let depth = 0;
    for (let i = name.length; i < expr.length; i++) {
      if (expr[i] === "(") depth++;
      else if (expr[i] === ")" && --depth === 0) return i === expr.length - 1;
    }
  }
  return false;
}

// `n.toFixed(1)`, `(y + 12).toFixed(1)`, `(a / b * 100).toFixed(1)`.
// The WHOLE expression must be the .toFixed() call — `.toFixed` throws on a
// string receiver, so a non-numeric receiver can never reach the output — which
// leaves only one hole to close: a top-level `+` (or `?`/`,`) in front of it,
// which would make the value a concatenation. `row.name + pct.toFixed(1)`,
// `label+n.toFixed(1)` and `esc(a) + b.toFixed(1)` are all rejected here; the
// old check accepted every one of them.
function isToFixed(e) {
  const m = /\.toFixed\(\s*\d*\s*\)$/.exec(e);
  if (!m || m.index === 0) return false;
  const recv = e.slice(0, m.index);
  if (/["'`]/.test(recv)) return false; // a literal in the receiver means concatenation
  let depth = 0;
  for (const c of recv) {
    if ("([".includes(c)) depth++;
    else if (")]".includes(c)) depth--;
    else if (depth === 0 && (c === "+" || c === "?" || c === "," || c === ":")) return false;
  }
  return depth === 0;
}

function isStringLiteral(e) {
  return /^"(?:[^"\\]|\\[\s\S])*"$/.test(e) || /^'(?:[^'\\]|\\[\s\S])*'$/.test(e);
}

// True when `e` is exactly ONE template literal — nested `${…}` holes, and the
// strings and further templates inside them, all accounted for.
function isWholeTemplate(e) {
  if (e[0] !== "`") return false;
  const stack = ["tpl"];
  let i = 1;
  while (i < e.length) {
    const mode = stack[stack.length - 1], c = e[i];
    if (c === "\\") { i += 2; continue; }
    if (mode === "tpl") {
      if (c === "`") { stack.pop(); if (!stack.length) return i === e.length - 1; i++; continue; }
      if (c === "$" && e[i + 1] === "{") { stack.push("code"); i += 2; continue; }
      i++; continue;
    }
    if (mode === "code") {
      if (c === "}") stack.pop();
      else if (c === "{") stack.push("code");
      else if (c === "`") stack.push("tpl");
      else if (c === '"' || c === "'") stack.push(c);
      i++; continue;
    }
    if (c === mode) stack.pop();
    i++;
  }
  return false;
}

// Split a conditional expression at its top-level `?` / `:` (strings, parens,
// brackets, `??` and `?.` skipped). Returns [consequent, alternate] or null.
function splitTernary(e) {
  let depth = 0, quote = null, qmark = -1;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?") {
      if (e[i + 1] === "?" || e[i + 1] === ".") { i++; continue; }
      qmark = i; break;
    }
  }
  if (qmark < 0) return null;
  let nested = 0;
  depth = 0; quote = null;
  for (let i = qmark + 1; i < e.length; i++) {
    const c = e[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && c === "?") { if (e[i + 1] === "?" || e[i + 1] === ".") i++; else nested++; }
    else if (depth === 0 && c === ":") { if (nested === 0) return [e.slice(qmark + 1, i), e.slice(i + 1)]; nested--; }
  }
  return null;
}

// True when every value the expression can produce is a literal written in the
// SOURCE — `cond ? "checked" : ""`, `n != null ? `min="${esc(n)}"` : ""`.
// Whatever the condition reads, the markup that reaches the DOM is what the
// author typed, and no scraped value can flow into a source literal. Any `${…}`
// inside a nested template is visited by the scanner separately, in its own
// (correctly nested) markup context, so it is not this expression's business.
function isSourceLiteralOnly(expr) {
  const e = expr.trim();
  if (isStringLiteral(e) || isWholeTemplate(e)) return true;
  const t = splitTernary(e);
  return t ? isSourceLiteralOnly(t[0]) && isSourceLiteralOnly(t[1]) : false;
}

function isSafeExpression(expr, file, ctx) {
  const e = expr.trim();
  if (isWholeCallTo(e, SAFE_WRAPPERS)) return true;
  if (ctx.quote === '"' && isWholeCallTo(e, DOUBLE_QUOTE_ONLY_WRAPPERS)) return true;
  if (isWholeCallTo(e, NUMERIC_CALLS)) return true;
  if (isToFixed(e)) return true;
  if (/^[\d\s+\-*/.()]+$/.test(e)) return true; // literal arithmetic
  if (NUMERIC_LOCALS[file]?.has(e)) return true;
  if (isSourceLiteralOnly(e)) return true;
  return false;
}

// Report every markup-context interpolation in `src` that is not provably safe.
function scanSource(file, src) {
  const { masked, exprs } = maskSource(src);
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  const out = [];
  for (const { start, expr, scope } of exprs) {
    const ctx = contextAt(masked, scope, start);
    if (!ctx) continue; // text context — out of this scan's declared scope
    if (isSafeExpression(expr, file, ctx)) continue;
    out.push({
      file, line: lineAt(start), expr: expr.trim(), kind: ctx.kind,
      near: masked.slice(Math.max(scope, start - 60), start).replace(/\s+/g, " ").trim().slice(-56),
    });
  }
  return out;
}

test("no unescaped markup-context interpolations in public/js", () => {
  const files = readdirSync(JS_DIR).filter((f) => f.endsWith(".js")).sort();
  assert.ok(files.length > 10, "expected the frontend module set, found " + files.length);
  const violations = [];
  for (const f of files) violations.push(...scanSource(f, readFileSync(path.join(JS_DIR, f), "utf8")));
  const report = violations.map((v) => `  public/js/${v.file}:${v.line}  [${v.kind}]  \${${v.expr}}  after  …${v.near}`).join("\n");
  assert.equal(
    violations.length, 0,
    `${violations.length} markup interpolation(s) bypass esc()/safeUrl().\n` +
    "Wrap the expression: attr=\"${esc(x)}\" (or safeUrl(x) for href/src).\n" + report,
  );
});

test("the scanner sees interpolations the old quote-pair regex could not", () => {
  // THE regression case: a nested same-type quote inside the attribute value.
  // The previous ATTR_VALUE regex stopped the value at the inner quote and
  // dropped the whole region, so `${p.party}` here was invisible.
  const nested = [
    'x = `<span class="party-pill ${p.party === "Independent" ? "independent" : ""} ${p.party}">t</span>`;',
    'x = `<span class="${row.flag ? "on" : "off"} ${row.name}">y</span>`;',
    "x = `<span class='${row.flag ? 'on' : 'off'} ${row.name}'>y</span>`;",
  ];
  for (const src of nested) {
    const hits = scanSource("x.js", src);
    assert.equal(hits.length, 1, "missed nested-quote case: " + src + " → " + JSON.stringify(hits));
    assert.match(hits[0].expr, /row\.name|p\.party/);
  }

  // Unquoted attribute values are markup too — innerHTML parses them.
  assert.equal(scanSource("x.js", "const e = `<div class=${row.cls}>y</div>`;").length, 1);
  // Interpolated attribute-name / tag-name slots inject arbitrary attributes.
  assert.equal(scanSource("x.js", "const e = `<div ${row.attrs}>y</div>`;").length, 1);
  assert.equal(scanSource("x.js", "const e = `<${row.tag}>y</div>`;").length, 1);

  // encodeURIComponent does not encode the apostrophe, so it is not safe in a
  // single-quoted attribute (but is in a double-quoted one).
  assert.equal(scanSource("x.js", "const f = `<a href='${encodeURIComponent(u)}'>y</a>`;").length, 1);
  assert.deepEqual(scanSource("x.js", 'const f = `<a href="${encodeURIComponent(u)}">y</a>`;'), []);

  // The querySelector exemption used to skip the WHOLE line; markup built on a
  // line that also queries the DOM must still be checked.
  assert.equal(scanSource("x.js", 'const g = `<b title="${row.name}">x</b>`; el.querySelector(".x");').length, 1);

  // A raw field concatenated in front of a .toFixed() call is not a number.
  assert.equal(scanSource("x.js", 'const h = `<div title="${row.name + pct.toFixed(1)}">z</div>`;').length, 1);
  assert.equal(scanSource("x.js", 'const h = `<div title="${label+n.toFixed(1)}">z</div>`;').length, 1);
  assert.equal(scanSource("x.js", 'const h = `<div title="${esc(a) + b.toFixed(1)}">z</div>`;').length, 1);

  // Nested templates inherit their parent's tag context.
  assert.equal(scanSource("x.js", 'const i = `<div ${on ? `title="${row.name}"` : ""}>z</div>`;').length, 1);
});

test("the scanner catches a reintroduced unescaped interpolation", () => {
  const bad = [
    'const a = `<a href="#/rep/${p.id}">x</a>`;',
    "const b = `<div class='${row.cls}'></div>`;",
    'const c = `<span title="${esc(t)} ${raw}"></span>`;',
    'const d = `<i data-w="${esc(a) + b}"></i>`;',
    'const e = `<span style="background:${COLORS[g] ?? "#97a0ad"}">x</span>`;',
  ];
  for (const src of bad) assert.equal(scanSource("x.js", src).length, 1, "missed: " + src);

  const good = [
    'const a = `<a href="#/rep/${esc(p.id)}">x</a>`;',
    'const b = `<a href="${safeUrl(u)}">x</a>`;',
    'const c = `<a href="#/?party=${encodeURIComponent(p.party)}">x</a>`;',
    'const d = `<div style="width:${Math.max(2, n / m * 100)}%"></div>`;',
    'const e = `<circle cx="${x.toFixed(1)}"/>`;',
    'const f = `<div style="width:${100 / 3}%"></div>`;',
    'const f2 = `<text y="${(y + 12).toFixed(1)}"/>`;',
    'const f3 = `<text y="${(a / b * 100).toFixed(1)}"/>`;',
    // Constant-only alternatives: whatever the condition reads, the value that
    // reaches the DOM is one of two source literals.
    'const g = `<button ${n <= 1 ? "disabled" : ""}>p</button>`;',
    'const h = `<span class="badge ${e.admissible ? "adm" : "lead"}">x</span>`;',
    "const h2 = `<td${warn ? ' class=\"warn\"' : \"\"}>x</td>`;",
    // Conditionally-emitted whole attributes: the alternatives are source
    // templates, and their own `${…}` holes get scanned in their own context.
    'const h3 = `<input ${m.min != null ? `min="${esc(m.min)}"` : ""} ${m.step != null ? `step="${esc(m.step)}"` : `step="any"`} />`;',
    'const h4 = `<a href="${tab === "byParty" ? `#/party/${esc(k)}` : `#/org/${esc(k)}`}">x</a>`;',
    // Pure CSS selectors are not markup: no tag context, nothing to escape.
    'document.querySelectorAll(`.nc-count[data-count="${key}"]`);',
    'document.querySelector(`#ops-tuning [data-key="${k}"]:not(button)`);',
    // Text context is out of this scan's declared scope.
    "const i = `<p>${esc(a)} < ${esc(b)}</p>`;",
    "const j = `<li>${row.name}</li>`;",
    // Regexes and strings containing markup characters must not desync the lexer.
    'const k = String(s).replace(/[&<>"\']/g, (c) => c); const l = `<b title="${esc(t)}">x</b>`;',
  ];
  for (const src of good) assert.deepEqual(scanSource("x.js", src), [], "false positive: " + src);

  // The per-file numeric-locals allowlist must be scoped to its own file.
  assert.deepEqual(scanSource("report-sections.js", 'const g = `<svg viewBox="0 0 ${W} ${H}">`;'), []);
  assert.equal(scanSource("home.js", 'const g = `<svg viewBox="0 0 ${W} ${H}">`;').length, 2);
});
