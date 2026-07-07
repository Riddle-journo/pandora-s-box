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

let browserPromise = null;
let pwWarned = false;

export async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      if (!pwWarned) { console.warn("[fetchers] playwright not installed — JS-portal fetcher disabled. Run: npm install playwright && npx playwright install chromium"); pwWarned = true; }
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
  if (!browser) return "";
  let page;
  try {
    page = await browser.newPage({ userAgent: "Mozilla/5.0 (PandorosBox research)" });
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: timeoutMs }).catch(() => {});
    const html = await page.content();
    return htmlToText(html, maxLen);
  } catch { return ""; }
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
