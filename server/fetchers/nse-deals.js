// NSE bulk/block-deal search (C.1) — used ONLY inside investigator.js on a
// handful of top-lead names (an actor + declared relatives), NEVER in the
// population loop. NSE publishes daily bulk- and block-deal reports naming the
// buying/selling client. A politician or a declared relative appearing as a
// large-trade client near a decision they influence is the POLICY_INSIDER_TRADING
// shape — a lead INPUT for L2, not a finding.
//
// NSE gates its APIs behind a cookie handshake: GET the homepage with a browser
// User-Agent to obtain cookies, then GET the report endpoint with those cookies +
// a Referer. Free, no key. Degrades to [] on any failure (offline, blocked, 429).
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// Perform the NSE cookie handshake and return a Cookie header string, or "".
async function nseCookies(timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch("https://www.nseindia.com/", {
      headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: ac.signal,
    });
    // Node's fetch exposes multiple Set-Cookie via getSetCookie() (undici ≥18.14).
    const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    return raw.map((c) => c.split(";")[0]).join("; ");
  } catch { return ""; }
  finally { clearTimeout(t); }
}

// Parse an NSE deals CSV into rows; keep only rows whose client name matches.
// Pure & synchronous → unit-testable without the network.
export function parseDealsCsv(csv, name) {
  const lines = String(csv ?? "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim().toLowerCase());
  const iClient = header.findIndex((h) => /client|name/.test(h));
  const iSymbol = header.findIndex((h) => /symbol|security/.test(h));
  const iDate = header.findIndex((h) => /date/.test(h));
  const iQty = header.findIndex((h) => /quantity|qty/.test(h));
  const iType = header.findIndex((h) => /buy|sell|type/.test(h));
  const needle = String(name ?? "").toLowerCase().trim();
  if (!needle) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const client = (cells[iClient] ?? "").toLowerCase();
    if (!client || !client.includes(needle)) continue;
    out.push({
      client: cells[iClient] ?? "", symbol: iSymbol >= 0 ? cells[iSymbol] : "",
      date: iDate >= 0 ? cells[iDate] : "", quantity: iQty >= 0 ? cells[iQty] : "",
      type: iType >= 0 ? cells[iType] : "",
    });
  }
  return out;
}

// Search recent NSE bulk + block deals for a client name. Returns matched rows
// (possibly empty). Network + best-effort; never throws.
export async function searchDeals(name, { timeoutMs = 12000 } = {}) {
  if (process.env.NSE_DEALS_DISABLE === "1") return [];
  const needle = String(name ?? "").trim();
  if (needle.length < 4) return [];
  const cookie = await nseCookies(timeoutMs);
  if (!cookie) return [];
  const endpoints = [
    "https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=bulk_deals",
    "https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=block_deals",
  ];
  const matches = [];
  for (const url of endpoints) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, "Accept": "application/json,text/csv,*/*", "Referer": "https://www.nseindia.com/report-detail/display-bulk-and-block-deals", "Cookie": cookie },
        signal: ac.signal,
      });
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const j = await r.json().catch(() => null);
        const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
        for (const row of rows) {
          const client = String(row.clientName ?? row.CLIENT_NAME ?? row.client ?? "").toLowerCase();
          if (client.includes(needle.toLowerCase())) {
            matches.push({ client: row.clientName ?? row.CLIENT_NAME ?? row.client ?? "", symbol: row.symbol ?? row.SYMBOL ?? "", date: row.date ?? row.BD_DT_DATE ?? "", quantity: row.quantityTraded ?? row.qty ?? "", type: row.buySell ?? row.dealType ?? "" });
          }
        }
      } else {
        const csv = await r.text().catch(() => "");
        matches.push(...parseDealsCsv(csv, needle));
      }
    } catch { /* ignore this endpoint */ }
    finally { clearTimeout(t); }
  }
  return matches;
}
