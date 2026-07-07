// CAG (Comptroller & Auditor General) audit report search — finds audit
// reports where the politician's name appears, and when the search returns a
// report PDF, reads its text via pdf-parse. CAG reports are tabled in
// Parliament/state legislature — admissible constitutional records, highest
// evidentiary quality for financial findings.
//
// Free, no key. Low hit rate: CAG indexes report titles/metadata, and a
// politician's name rarely appears in a report TITLE — but when it does, the
// content is gold (named in a performance/financial audit).
import { fetchText, htmlToText, fetchPdfText } from "./http.js";

function contextAround(text, name, window = 1000) {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  if (i < 0) return null;
  return text.slice(Math.max(0, i - window), i + name.length + window).trim();
}

// Find the first report PDF link in the CAG results HTML.
function firstPdfLink(html, base = "https://cag.gov.in") {
  const m = html.match(/href=['"]([^'"]+\.pdf[^'"]*)['"]/i);
  if (!m) return null;
  try { return new URL(m[1], base).href; } catch { return null; }
}

export async function fetchCAGReports(p) {
  const q = encodeURIComponent(p.name);
  const url = `https://cag.gov.in/en/audit-report?title=&field_state_target_id=All&keys=${q}`;
  const html = await fetchText(url, { timeoutMs: 14000 });
  if (!html) return [];

  const text = htmlToText(html, 20000);
  const ctx = contextAround(text, p.name);
  if (!ctx) return [];

  const items = [{
    politician_id: p.id,
    source_type: "cag",
    tier: 3,
    admissible: true,
    title: `CAG audit report search — ${p.name}`,
    url,
    date: null,
    summary: "CAG audit report search result — findings tabled before Parliament or a state legislature (admissible constitutional record).",
    content: `CAG audit report search results for "${p.name}":\n…${ctx}…`,
  }];

  // Level 2: if the results link to an actual report PDF, read it.
  const pdfUrl = firstPdfLink(html);
  if (pdfUrl) {
    const pdfText = await fetchPdfText(pdfUrl, { maxLen: 5000 });
    if (pdfText && pdfText.length > 200) {
      items.push({
        politician_id: p.id,
        source_type: "cag",
        tier: 3,
        admissible: true,
        title: `CAG audit report (full text) — ${p.name}`,
        url: pdfUrl,
        date: null,
        summary: "Full text of a CAG audit report surfaced by the name search (admissible constitutional record).",
        content: pdfText,
      });
    }
  }

  return items;
}
