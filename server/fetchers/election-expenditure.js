// Election expenditure declaration — scrapes the FULL contents of a candidate's
// sworn ECI election-expenditure account from MyNeta's expense.php page (the
// same candidate_id as the affidavit we already store in p.myneta_url).
//
// Declared campaign spending; a large gap between this and observed campaign
// activity is a classic undeclared-funding signal. Free, no key.
import { fetchText, htmlToText } from "./http.js";

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
  }];
}
