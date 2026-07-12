// Election expenditure declaration — scrapes the FULL contents of a candidate's
// sworn ECI election-expenditure account from MyNeta's expense.php page (the
// same candidate_id as the affidavit we already store in p.myneta_url).
//
// Declared campaign spending; a large gap between this and observed campaign
// activity is a classic undeclared-funding signal. Free, no key.
import { fetchText, htmlToText } from "./http.js";

// Strip inner markup + decode the handful of entities MyNeta emits, then collapse
// whitespace — the same cell-cleaning idiom as sources/myneta-full.js.
const cleanCell = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'")
    .replace(/&rsquo;/gi, "'").replace(/&#8377;/g, "₹")
    .replace(/\s+/g, " ").trim();

// A single cell → its rupee value, or null if it isn't a bare money figure.
// Tolerates ₹ / Rs. / INR prefixes, Indian comma grouping, and decimals; anything
// with leftover letters (a description, a header like "Amount (Rs.)") fails the
// numeric test and returns null.
function parseAmount(cell) {
  if (cell == null) return null;
  const cleaned = String(cell)
    .replace(/[₹]/g, " ")
    .replace(/rs\.?|inr/gi, " ")
    .replace(/\s+/g, "");
  if (!/^\d[\d,]*(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// PURE: parse the itemized MyNeta expenditure table out of raw HTML into
// { grand_total, items: [{ head, amount }] }. Scans every <tr> on the page (the
// expense table has no stable id and MyNeta wraps everything in legacy tables);
// a row counts as a line item only when it has BOTH a description cell (letters)
// and a bare-number cell, so layout/nav rows fall away. The amount is the LAST
// numeric cell in the row, which skips a leading serial-number column; the head
// is the first cell containing letters. Rows whose head reads "Grand Total"
// populate grand_total instead of items. Returns null when nothing parses so the
// caller can fall back to the text skim. Never throws.
export function parseExpenditureTable(html) {
  if (!html || typeof html !== "string") return null;
  try {
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, r]) =>
      [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) => cleanCell(c)),
    );

    const items = [];
    let grandTotal = null;
    for (const cells of rows) {
      if (cells.length < 2) continue;
      const head = cells.find((c) => /[a-z]/i.test(c));
      if (!head) continue;
      let amount = null;
      for (const c of cells) {
        const n = parseAmount(c);
        if (n != null) amount = n; // keep the rightmost numeric cell
      }
      if (amount == null) continue;
      if (/grand\s*total/i.test(head)) { grandTotal = amount; continue; }
      items.push({ head, amount });
    }

    if (!items.length && grandTotal == null) return null;
    return { grand_total: grandTotal, items };
  } catch {
    return null;
  }
}

export async function fetchElectionExpenditure(p) {
  if (!p.myneta_url || !/candidate\.php/i.test(p.myneta_url)) return [];
  const url = p.myneta_url.replace(/candidate\.php/i, "expense.php");

  const html = await fetchText(url, { timeoutMs: 20000 });
  if (!html) return [];

  // Whole-page text (MyNeta uses legacy table layout, no <main>); then trim the
  // shared footer/disclaimer and start at the expense section.
  let body = htmlToText(html, 7000);
  const di = body.toLowerCase().indexOf("disclaimer");
  if (di > 200) body = body.slice(0, di).trim();
  const si = body.search(/Election Expenses|Expenditure|Expense/i);
  if (si > 0) body = body.slice(si).trim();

  if (body.length < 80 || !/expens|expenditure|lump sum|lodg|election/i.test(body)) return [];

  // Structured per-head line items for the deterministic/computed-flags layer.
  // Best-effort and fail-soft: if the table markup doesn't parse we simply omit
  // `numbers` and nothing that reads `content` today is affected.
  const parsed = parseExpenditureTable(html);
  const numbers = parsed && (parsed.items.length || parsed.grand_total != null) ? parsed : null;

  return [{
    politician_id: p.id,
    source_type: "eci_expenditure",
    tier: 1,
    admissible: true,
    title: `Election expenditure declaration — ${p.name}`,
    url,
    date: null,
    summary: "Candidate's sworn election-expenditure account filed with ECI (via ADR/MyNeta) — declared campaign spending; a mismatch with observed spending is a corruption signal.",
    content: body.slice(0, 5000),
    ...(numbers ? { numbers } : {}),
  }];
}
