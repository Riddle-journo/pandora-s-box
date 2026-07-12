// SEBI order-link parsing (full-text upgrade). Pure — exercises parseOrderLinks,
// the function that pulls the linked enforcement-order PDFs out of the SEBI
// search-results HTML — with NO network and NO DB. Proves that only `.pdf`
// anchors survive (nav/HTML/#/js noise is dropped), that hrefs are absolutised
// against https://www.sebi.gov.in regardless of how they were written
// (root-relative, path-relative, protocol-relative, already-absolute), that
// duplicates collapse, and that link text becomes a clean title.
import test from "node:test";
import assert from "node:assert/strict";
import { parseOrderLinks } from "../server/fetchers/sebi-orders.js";

// A realistic slice of a SEBI orders search-results page: three order PDFs
// (written three different ways) buried among non-PDF links and markup noise.
const HTML = `
<html><body>
  <nav><a href="/enforcement/orders/">Orders</a> <a href="/sitemap">Sitemap</a></nav>
  <div class="search-results">
    <ul>
      <li><a href="/enforcement/orders/jul-2024/order-in-the-matter-of-abc-ltd_84512.pdf">Order in the matter of ABC Ltd</a></li>
      <li><a class="doc" href="attachdocs/1720000000000.pdf"><span>Adjudication</span> Order &ndash; XYZ &amp; Sons</a></li>
      <li><a href="https://www.sebi.gov.in/cms/sebi_data/attachdocs/aug-2024/order-def.pdf">Order DEF</a></li>
    </ul>
    <a href="https://example.com/press-release.html">Related press release</a>
    <a href="#top">Back to top</a>
    <a href="javascript:void(0)">Print</a>
    <img src="/logo.png" alt="SEBI logo">
  </div>
</body></html>
`;

test("parseOrderLinks: extracts only .pdf anchors, absolutised against sebi.gov.in", () => {
  const links = parseOrderLinks(HTML);
  assert.deepEqual(
    links.map((l) => l.href),
    [
      "https://www.sebi.gov.in/enforcement/orders/jul-2024/order-in-the-matter-of-abc-ltd_84512.pdf",
      "https://www.sebi.gov.in/attachdocs/1720000000000.pdf",
      "https://www.sebi.gov.in/cms/sebi_data/attachdocs/aug-2024/order-def.pdf",
    ],
    "3 PDF links, root-relative + path-relative + already-absolute all normalised",
  );
  // Non-PDF noise (.html, #top, javascript:, <img>, nav) is excluded.
  assert.equal(links.length, 3);
  assert.ok(links.every((l) => l.href.startsWith("https://www.sebi.gov.in/")));
});

test("parseOrderLinks: link text becomes a clean, tag-stripped, entity-decoded title", () => {
  const links = parseOrderLinks(HTML);
  assert.equal(links[0].title, "Order in the matter of ABC Ltd");
  // Inner <span> stripped; &ndash; and &amp; decoded; whitespace collapsed.
  assert.equal(links[1].title, "Adjudication Order – XYZ & Sons");
});

test("parseOrderLinks: dedups identical hrefs; matches .PDF and query strings", () => {
  const html = `
    <a href="/a/one.PDF?ver=2">One (upper-case ext + query)</a>
    <a href="/a/one.PDF?ver=2">One again (duplicate)</a>
    <a href="/a/two.pdf#page=3">Two (fragment)</a>
    <a href="/a/notes.txt">Not a PDF</a>
  `;
  const links = parseOrderLinks(html);
  assert.deepEqual(links.map((l) => l.href), [
    "https://www.sebi.gov.in/a/one.PDF?ver=2",
    "https://www.sebi.gov.in/a/two.pdf#page=3",
  ]);
});

test("parseOrderLinks: empty / no-anchor input returns []", () => {
  assert.deepEqual(parseOrderLinks(""), []);
  assert.deepEqual(parseOrderLinks(null), []);
  assert.deepEqual(parseOrderLinks("<p>no links here at all</p>"), []);
});
