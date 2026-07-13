// SEBI corporate DISCLOSURES for LISTED companies — insider-trading (PIT),
// substantial-acquisition (SAST) and routine corporate announcements filed on the
// stock exchanges. This is DISTINCT from sebi-orders.js (enforcement orders): these
// are the routine disclosures every listed company files, published by NSE/BSE.
//
// RELATIONSHIP-TRIGGERED + OPT-IN — modelled on server/tofler-enrich.js. We NEVER
// crawl the exchanges by date; we only ever look up a company that is ALREADY
// linked to a politician (a company-bearing relationship / affidavit holding), so
// this stays a targeted per-company lookup. OFF by default: it does nothing unless
// SEBI_DISCLOSURES_ENABLE=1 (or { force:true }) is set.
//
// NSE gates its JSON APIs behind a cookie handshake exactly like nse-deals.js: GET
// the homepage with a browser User-Agent to obtain cookies, then GET the JSON API
// with those cookies + a Referer. The feeds are DATE-indexed but also accept a
// ?symbol= filter, which is what makes the per-company lookup possible. Everything
// is fail-silent: any network/parse failure degrades to [] (or null), never throws.
//
// Verified reachable 2026-07-13 (with the handshake):
//   GET /api/corporates-pit?index=equities&symbol=RELIANCE&from_date=..&to_date=..
//       → { acqNameList:[…], data:[{ acqName, company, symbol, secAcq, secVal,
//                                     buyQuantity, sellquantity, acqMode, … }] }
//   GET /api/corporate-sast-reg29?index=equities&symbol=..&from_date=..&to_date=..
//       → same { acqNameList, data:[…] } shape (SAST Reg-29 acquirer disclosures)
//   GET /api/corporate-announcements?index=equities&symbol=..&from_date=..&to_date=..
//       → [{ an_dt, attchmntFile (PDF url), attchmntText, desc, symbol, sm_name }]

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const NSE = "https://www.nseindia.com";

// ── NSE cookie handshake (mirrors nse-deals.js) ──────────────────────────────
// GET the homepage with a browser UA to collect the anti-bot cookies, return a
// Cookie header string, or "" on any failure.
async function nseCookies(timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${NSE}/`, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: ac.signal,
    });
    const raw = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
    return raw.map((c) => c.split(";")[0]).join("; ");
  } catch { return ""; }
  finally { clearTimeout(t); }
}

// GET a warmed NSE JSON endpoint. Returns the parsed JSON, or null on any failure.
async function nseJson(url, { cookie, referer, timeoutMs = 12000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, "Accept": "application/json,*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": referer ?? `${NSE}/`, "Cookie": cookie ?? "" },
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ── Symbol resolution ────────────────────────────────────────────────────────
// The disclosure feeds key on the NSE trading SYMBOL, not a company name/CIN. A
// target that already carries a symbol skips the lookup; otherwise resolve the
// name through NSE's free autocomplete (?q=NAME → symbols). Injectable for tests.
export async function resolveNseSymbol(name, { cookie, fetchJsonImpl = nseJson } = {}) {
  const q = String(name ?? "").trim();
  if (q.length < 3) return null;
  const j = await fetchJsonImpl(`${NSE}/api/search/autocomplete?q=${encodeURIComponent(q)}`, {
    cookie, referer: `${NSE}/`,
  });
  const rows = Array.isArray(j?.symbols) ? j.symbols : [];
  // Prefer an equity (EQ) hit; fall back to the first symbol offered.
  const eq = rows.find((s) => /^(EQ|equity)$/i.test(String(s.result_sub_type ?? s.type ?? "")) && s.symbol)
    || rows.find((s) => s.symbol);
  return eq?.symbol ? String(eq.symbol).trim().toUpperCase() : null;
}

// ── Date helpers ─────────────────────────────────────────────────────────────
const pad2 = (n) => String(n).padStart(2, "0");
// NSE wants DD-MM-YYYY for the from/to window.
function nseDate(d) { return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`; }
function windowDates(days = 365) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400_000);
  return { from: nseDate(from), to: nseDate(to) };
}
// "18-Feb-2026 19:06" | "13-Feb-2026" | "13-Jul-2026 17:49:20" → ISO date, else null.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
export function parseNseDate(s) {
  const m = String(s ?? "").match(/(\d{1,2})-([A-Za-z]{3,4})-(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (!mo) return null;
  return `${m[3]}-${pad2(mo)}-${pad2(Number(m[1]))}`;
}

const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

// ── Pure parsers (unit-tested, no network) ───────────────────────────────────
// Normalise a PIT (insider-trading) feed row → a disclosure object. The `acqName`
// is the insider (the disclosed COUNTERPARTY); the company is the listed issuer.
function pitRow(row, type) {
  const counterparty = String(row.acqName ?? row.name ?? "").trim();
  const company = String(row.company ?? "").trim();
  const symbol = String(row.symbol ?? "").trim().toUpperCase();
  if (!counterparty && !company) return null;
  const buy = num(row.buyQuantity), sell = num(row.sellquantity);
  const secAcq = num(row.secAcq);
  const quantity = secAcq ?? (buy ? buy : sell ? -sell : null);
  const value = num(row.secVal) ?? num(row.buyValue) ?? num(row.sellValue);
  return {
    type, company, symbol, counterparty,
    mode: String(row.acqMode ?? "").trim() || null,
    security: String(row.secType ?? row.securitiesTypePost ?? "").trim() || null,
    person_category: String(row.personCategory ?? "").trim() || null,
    quantity, value,
    date: parseNseDate(row.intimDt) || parseNseDate(row.date) || parseNseDate(row.acqfromDt),
  };
}

// PIT feed: { acqNameList, data:[…] }. → insider_trade disclosures.
export function parsePit(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return rows.map((r) => pitRow(r, "insider_trade")).filter(Boolean);
}

// SAST Reg-29 feed: same shape as PIT. → sast_acquisition disclosures.
export function parseSast(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return rows.map((r) => pitRow(r, "sast_acquisition")).filter(Boolean);
}

// Announcements feed: [{ an_dt, attchmntFile, attchmntText, desc, symbol, sm_name }].
// Related-party & other routine filings surface here as free text; we keep the
// attachment URL (the primary evidence) and the description.
export function parseAnnouncements(json, { symbol } = {}) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return rows.map((row) => {
    const desc = String(row.desc ?? row.attchmntText ?? "").trim();
    if (!desc && !row.attchmntFile) return null;
    const sym = String(row.symbol ?? symbol ?? "").trim().toUpperCase();
    // Flag related-party transactions specifically (a first-class disclosure class);
    // everything else stays a generic "announcement" so we keep ALL rows.
    const isRpt = /related[\s-]*part/i.test(desc) || /related[\s-]*part/i.test(String(row.attchmntText ?? ""));
    return {
      type: isRpt ? "related_party_txn" : "announcement",
      company: String(row.sm_name ?? row.smName ?? "").trim() || null,
      symbol: sym,
      counterparty: null,
      desc,
      attachment: row.attchmntFile ? String(row.attchmntFile).trim() : null,
      date: parseNseDate(row.an_dt) || parseNseDate(row.sort_date) || parseNseDate(row.dt),
    };
  }).filter(Boolean);
}

// ── Evidence shaping ─────────────────────────────────────────────────────────
const TIER = 4;                        // official exchange disclosure (public filing)
const LISTING = {
  insider_trade: "companies-listing/corporate-filings-insider-trading",
  sast_acquisition: "companies-listing/corporate-filings-sast",
  related_party_txn: "companies-listing/corporate-filings-announcements",
  announcement: "companies-listing/corporate-filings-announcements",
};
// A mandatory, stable URL for a disclosure: the attachment when present, else the
// canonical NSE filing page for that disclosure class filtered to the symbol.
export function disclosureUrl(d) {
  if (d.attachment) return d.attachment;
  const page = LISTING[d.type] ?? LISTING.announcement;
  return d.symbol ? `${NSE}/${page}?symbol=${encodeURIComponent(d.symbol)}` : `${NSE}/${page}`;
}

const TYPE_LABEL = {
  insider_trade: "Insider trade (SEBI PIT)",
  sast_acquisition: "Substantial acquisition (SEBI SAST Reg-29)",
  related_party_txn: "Related-party transaction",
  announcement: "Corporate announcement",
};

// Turn ONE normalised disclosure into an evidence row (URL mandatory). Returns
// null when no URL can be built (a row we cannot cite is dropped). The structured
// specifics ride on `data.disclosure` so the extractor never re-parses prose.
export function disclosureToEvidence(d, politician_id) {
  if (!d || !politician_id) return null;
  const url = disclosureUrl(d);
  if (!url) return null;
  const label = TYPE_LABEL[d.type] ?? "Corporate disclosure";
  const who = d.counterparty ? ` — ${d.counterparty}` : "";
  const co = d.company || d.symbol || "listed company";
  const title = `SEBI disclosure: ${label} — ${co}${who}`.slice(0, 200);
  const bits = [];
  if (d.counterparty) bits.push(`Counterparty: ${d.counterparty}`);
  if (d.person_category) bits.push(`Category: ${d.person_category}`);
  if (d.mode) bits.push(`Mode: ${d.mode}`);
  if (d.quantity != null) bits.push(`Qty: ${d.quantity}`);
  if (d.value != null) bits.push(`Value: ₹${d.value}`);
  if (d.desc) bits.push(d.desc);
  const summary = `${label} disclosed for ${co}${who}${d.date ? ` on ${d.date}` : ""}. Identity link to the politician is UNVERIFIED (routine exchange filing tied to a company already linked to them).`;
  return {
    politician_id,
    source_type: "sebi_disclosures",
    tier: TIER,
    admissible: true,
    title,
    url,
    date: d.date ?? null,
    summary,
    content: `${label} — ${co}${d.symbol ? ` (${d.symbol})` : ""}\n${bits.join("\n")}`.trim(),
    // structured payload for the extractor (keep-all: every named entity survives)
    disclosure: {
      type: d.type, company: d.company ?? null, symbol: d.symbol ?? null,
      counterparty: d.counterparty ?? null, person_category: d.person_category ?? null,
      mode: d.mode ?? null, security: d.security ?? null,
      quantity: d.quantity ?? null, value: d.value ?? null, date: d.date ?? null,
    },
  };
}

// ── Per-company orchestration (network) ──────────────────────────────────────
// Fetch a single politician-linked company's recent PIT + SAST + announcement
// disclosures and return evidence rows. Best-effort; returns [] on any failure.
// `fetchJsonImpl` / `resolveSymbol` are injectable so tests never hit the network.
export async function fetchCompanyDisclosures(target, politician_id, {
  cookie = null, fetchJsonImpl = nseJson, resolveSymbol = resolveNseSymbol, days = 365, timeoutMs = 12000,
} = {}) {
  const name = target?.name ?? null;
  let symbol = target?.symbol ? String(target.symbol).trim().toUpperCase() : null;
  if (!symbol && name) symbol = await resolveSymbol(name, { cookie });
  if (!symbol) return [];
  const { from, to } = windowDates(days);
  const win = `index=equities&symbol=${encodeURIComponent(symbol)}&from_date=${from}&to_date=${to}`;
  const j = async (path, referer) => fetchJsonImpl(`${NSE}/api/${path}?${win}`, { cookie, referer, timeoutMs });

  const [pit, sast, ann] = await Promise.all([
    j("corporates-pit", `${NSE}/${LISTING.insider_trade}`),
    j("corporate-sast-reg29", `${NSE}/${LISTING.sast_acquisition}`),
    j("corporate-announcements", `${NSE}/${LISTING.announcement}`),
  ]);

  const disclosures = [
    ...parsePit(pit),
    ...parseSast(sast),
    ...parseAnnouncements(ann, { symbol }),
  ];
  return disclosures.map((d) => disclosureToEvidence({ ...d, symbol: d.symbol || symbol }, politician_id)).filter(Boolean);
}

// ── Gated entry point (mirrors enrichLeadsWithTofler's opt-in flag) ──────────
// Given one or more politician-linked company targets, return SEBI-disclosure
// evidence rows. Does NOTHING (returns []) unless SEBI_DISCLOSURES_ENABLE=1 (or
// { force:true }). Accepts a single target or an array of { name?, symbol?, cin? }.
export async function fetchSebiDisclosures(targets, politician_id, opts = {}) {
  const enabled = opts.force || process.env.SEBI_DISCLOSURES_ENABLE === "1";
  if (!enabled) return [];
  const list = Array.isArray(targets) ? targets : targets ? [targets] : [];
  if (!list.length || !politician_id) return [];
  // One handshake shared across every company lookup in this batch.
  const cookie = opts.cookie ?? await nseCookies(opts.timeoutMs ?? 12000);
  if (!cookie && !opts.fetchJsonImpl) return []; // no cookie and not a test → bail
  const out = [];
  const seen = new Set(); // dedup by url within this batch
  for (const target of list) {
    const rows = await fetchCompanyDisclosures(target, politician_id, { ...opts, cookie });
    for (const r of rows) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
  }
  return out;
}
