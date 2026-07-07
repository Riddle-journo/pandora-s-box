// SEBI enforcement orders — searches SEBI's orders listing for the politician's
// name. Catches insider trading, market manipulation, and promoter violations.
// SEBI orders are admissible public records (constitutional regulator).
// Free, no key.
import { fetchText, htmlToText } from "./http.js";

function contextAround(text, name, window = 1000) {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  if (i < 0) return null;
  return text.slice(Math.max(0, i - window), i + name.length + window).trim();
}

export async function fetchSEBIOrders(p) {
  const url = `https://www.sebi.gov.in/enforcement/orders/?text=${encodeURIComponent(p.name)}`;
  const html = await fetchText(url, { timeoutMs: 14000 });
  if (!html) return [];

  const text = htmlToText(html, 20000);
  const ctx = contextAround(text, p.name);
  if (!ctx) return [];

  return [{
    politician_id: p.id,
    source_type: "sebi_orders",
    tier: 6,
    admissible: true,
    title: `SEBI enforcement orders — ${p.name}`,
    url,
    date: null,
    summary: "SEBI enforcement orders listing — insider trading, market manipulation, or promoter violations (admissible public record from a statutory regulator).",
    content: `SEBI enforcement orders listing excerpt for "${p.name}":\n…${ctx}…`,
  }];
}
