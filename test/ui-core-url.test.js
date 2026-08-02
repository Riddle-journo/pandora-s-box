// ui-core-url.test.js — safeUrl()'s contract, exercised as a unit.
//
// safeUrl() is the only thing standing between an ingested href and an <a> on a
// public dossier that presents as an official record, so its accept/reject set
// is worth pinning: anything that is not http(s), mailto, a same-page fragment
// or a same-site relative path must collapse to "#".
import test from "node:test";
import assert from "node:assert/strict";

// core.js applies the stored theme at import time behind try/catch, so it loads
// under node without a DOM; nothing else runs until a helper is called.
const { safeUrl } = await import("../public/js/core.js");

test("safeUrl rejects protocol-relative URLs", () => {
  // REGRESSION: the `\/(?!\/)` guard was cancelled by a later `\.{0,2}\/`
  // alternative that matched zero dots + the FIRST slash of "//", so an
  // attacker-controlled host resolved as a same-scheme absolute URL.
  assert.equal(safeUrl("//evil.example/x"), "#");
  assert.equal(safeUrl("  //evil.example"), "#"); // trimmed first, then tested
  assert.equal(safeUrl("//evil.example"), "#");
  assert.equal(safeUrl("/\\evil.example"), "#"); // browsers treat \ as / here
});

test("safeUrl rejects script-bearing and unknown schemes", () => {
  for (const u of [
    "javascript:alert(1)", "JaVaScript:alert(1)", "\tjavascript:alert(1)",
    "data:text/html,<script>x</script>", "vbscript:msgbox", "ftp://host/x",
    "www.myneta.info/x", "", null, undefined,
  ]) assert.equal(safeUrl(u), "#", `expected "#" for ${JSON.stringify(u)}`);
});

test("safeUrl keeps the URLs the site actually renders", () => {
  assert.equal(safeUrl("https://myneta.info/x?y=1"), "https://myneta.info/x?y=1");
  assert.equal(safeUrl("http://example.com/"), "http://example.com/");
  assert.equal(safeUrl("mailto:tips@example.org"), "mailto:tips@example.org");
  assert.equal(safeUrl("#/rep/abc"), "#/rep/abc");
  assert.equal(safeUrl("/api/v1/politicians"), "/api/v1/politicians");
  assert.equal(safeUrl("./x.json"), "./x.json");
  assert.equal(safeUrl("../x.json"), "../x.json");
});

test("safeUrl HTML-escapes what it accepts", () => {
  assert.equal(safeUrl('https://e.com/?q="><img src=x>'), "https://e.com/?q=&quot;&gt;&lt;img src=x&gt;");
});
