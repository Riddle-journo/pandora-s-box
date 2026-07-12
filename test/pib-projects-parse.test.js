// Unit tests for parseReleaseLinks — the pure function that lifts individual
// PIB press-release links out of a listing page's raw HTML and absolutises them
// against the PIB origin. No network, no DB: an inline HTML fixture in, a
// [{title, href}] list out. Proves release anchors (incl. PIB's misspelled
// "PressRelese" variant and &amp;-encoded queries) are kept and absolutised,
// while nav / social / gallery noise is dropped, and duplicates collapse.
import test from "node:test";
import assert from "node:assert/strict";
import { parseReleaseLinks } from "../server/fetchers/pib-projects.js";

// A realistic PIB listing fragment: three genuine release anchors amid nav,
// social, mailto and photo-gallery noise. The middle link uses PIB's real
// "PressRelese" misspelling and HTML-encodes its query separators as &amp;.
const HTML = `
<html><body>
  <nav>
    <a href="/index.aspx">Home</a>
    <a href="AllReleasem.aspx">All Releases</a>
  </nav>
  <div class="content">
    <ul class="num">
      <li><a href="PressReleasePage.aspx?PRID=1234567">PM inaugurates new highway <b>project</b> in Nagpur district</a></li>
      <li><a class="rel" href="/PressReleseDetail.aspx?PRID=7654321&amp;reg=3&amp;lang=1" target="_blank">Minister launches drinking-water scheme in Bihar</a></li>
      <li><a href="https://pib.gov.in/PressReleaseIframePage.aspx?PRID=999">Cabinet approves rail line</a></li>
    </ul>
    <a href="https://twitter.com/PIB_India">Follow us on Twitter</a>
    <a href="mailto:pib@example.gov.in">Email us</a>
    <a href="PhotoDetails.aspx?PhotoId=42">Photo gallery</a>
  </div>
</body></html>`;

test("parseReleaseLinks: extracts and absolutises exactly the release anchors, in order", () => {
  const links = parseReleaseLinks(HTML, "https://pib.gov.in");
  assert.equal(links.length, 3, "only the three release anchors are kept");
  assert.deepEqual(links.map((l) => l.href), [
    "https://pib.gov.in/PressReleasePage.aspx?PRID=1234567",
    "https://pib.gov.in/PressReleseDetail.aspx?PRID=7654321&reg=3&lang=1",
    "https://pib.gov.in/PressReleaseIframePage.aspx?PRID=999",
  ]);
});

test("parseReleaseLinks: relative hrefs resolve against the default PIB origin", () => {
  // Called with a single argument — the baseUrl default must absolutise them.
  const links = parseReleaseLinks(HTML);
  assert.equal(links[0].href, "https://pib.gov.in/PressReleasePage.aspx?PRID=1234567");
  assert.equal(links[1].href, "https://pib.gov.in/PressReleseDetail.aspx?PRID=7654321&reg=3&lang=1");
});

test("parseReleaseLinks: strips inner markup from titles and decodes &amp;", () => {
  const links = parseReleaseLinks(HTML, "https://pib.gov.in");
  assert.equal(links[0].title, "PM inaugurates new highway project in Nagpur district");
  assert.equal(links[1].title, "Minister launches drinking-water scheme in Bihar");
});

test("parseReleaseLinks: ignores nav, social, mailto and gallery links", () => {
  const hrefs = parseReleaseLinks(HTML, "https://pib.gov.in").map((l) => l.href);
  for (const bad of ["index.aspx", "AllReleasem.aspx", "twitter.com", "mailto:", "PhotoDetails.aspx"]) {
    assert.ok(!hrefs.some((h) => h.includes(bad)), `must not include ${bad}`);
  }
});

test("parseReleaseLinks: collapses duplicate release links", () => {
  const dupHtml = `
    <a href="PressReleasePage.aspx?PRID=111">First</a>
    <a href="/PressReleasePage.aspx?PRID=111">Same release, different path shape</a>
    <a href="PressReleasePage.aspx?PRID=222">Second</a>`;
  const links = parseReleaseLinks(dupHtml, "https://pib.gov.in");
  assert.deepEqual(links.map((l) => l.href), [
    "https://pib.gov.in/PressReleasePage.aspx?PRID=111",
    "https://pib.gov.in/PressReleasePage.aspx?PRID=222",
  ]);
});

test("parseReleaseLinks: empty / link-less HTML yields []", () => {
  assert.deepEqual(parseReleaseLinks(""), []);
  assert.deepEqual(parseReleaseLinks(null), []);
  assert.deepEqual(parseReleaseLinks("<p>No links here, just prose about a project.</p>"), []);
});
