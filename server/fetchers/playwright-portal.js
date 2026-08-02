// Headless-browser fetcher for JavaScript-rendered government portals that
// plain fetch() can't read (MPLADS dashboards, GeM, some Sansad pages).
//
// Opt-in: requires the heavy `playwright` package + a browser binary:
//     npm install playwright
//     npx playwright install chromium
// If not installed, renderPageText() returns "" and logs once — nothing breaks.
//
// NOT wired into bulk per-politician ingest: launching a browser for each of
// thousands of reps is far too slow. Use this on-demand for a specific portal
// page, or in a targeted enrichment pass. Example at the bottom.
import { htmlToText } from "./http.js";
import { noteFetchFailure, noteParseMiss } from "./observe.js";

let browserPromise = null;
let pwWarned = false;

export async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch (err) {
      if (!pwWarned) { console.warn("[fetchers] playwright not installed — JS-portal fetcher disabled. Run: npm install playwright && npx playwright install chromium"); pwWarned = true; }
      noteFetchFailure("playwright_portal", "browser_launch", err, {});
      return null;
    }
    return chromium.launch({ headless: true });
  })();
  return browserPromise;
}

// Render a JS page and return its readable text. Optionally wait for a selector
// (e.g. a results table) before extracting.
export async function renderPageText(url, { waitForSelector = null, timeoutMs = 30000, maxLen = 3000 } = {}) {
  const browser = await getBrowser();
  // No browser means every JS-rendered portal silently yields "" for the whole
  // run — a class of source disappearing, not a set of empty pages.
  if (!browser) { noteFetchFailure("playwright_portal", "no_browser", "playwright unavailable", { url }); return ""; }
  let page;
  try {
    page = await browser.newPage({ userAgent: "Mozilla/5.0 (PandorosBox research)" });
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: timeoutMs }).catch(() => {});
    const html = await page.content();
    const text = htmlToText(html, maxLen);
    if (!text) noteParseMiss("playwright_portal", "render", { url, bytes: html.length, expected: "characters" });
    return text;
  } catch (err) {
    noteFetchFailure("playwright_portal", "render", err, { url, waitForSelector });
    return "";
  }
  finally { if (page) await page.close().catch(() => {}); }
}

export async function closeBrowser() {
  const b = await browserPromise;
  if (b) { await b.close().catch(() => {}); browserPromise = null; }
}

// Example on-demand fetcher (call it yourself for a specific portal page):
//
//   import { renderPageText } from "./playwright-portal.js";
//   const text = await renderPageText("https://mplads.gov.in/.../<mp-page>", {
//     waitForSelector: "table",
//   });
//   // → returns a content string you can store as evidence and feed to GLM.
