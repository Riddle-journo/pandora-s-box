// Task 4.5 — unit tests for the fetchers migrated onto the shared http core
// in Tasks 4.2/4.3 (they were the untested set). The Ex helpers default
// fetchImpl to the GLOBAL fetch binding, so a scoped monkey-patch of
// globalThis.fetch drives every internal call with canned fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchICIJ } from "../server/fetchers/icij.js";
import { fetchSECEdgar } from "../server/fetchers/sec-edgar.js";
import { searchDeals, parseDealsCsv } from "../server/fetchers/nse-deals.js";

const jsonRes = (data, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => headers.setcookie ?? [] },
  json: async () => data,
  text: async () => JSON.stringify(data),
});
const textRes = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => headers.setcookie ?? [] },
  json: async () => JSON.parse(body),
  text: async () => body,
});

async function withFetch(routes, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    for (const [pattern, res] of routes) {
      if (String(url).includes(pattern)) return typeof res === "function" ? res(url) : res;
    }
    return textRes("", 404);
  };
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

const P = { id: "pol-1", name: "Ranjan Testwala" };

// ---- ICIJ ----

test("icij: no reconcile candidates → []", async () => {
  await withFetch([["reconcile", jsonRes({ q0: { result: [] } })]], async () => {
    assert.deepEqual(await fetchICIJ(P), []);
  });
});

test("icij: high-confidence match pulls the node page connections", async () => {
  const nodeHtml = `<html><body>
    Officer: Ranjan Testwala role something Linked countries India
    Connections: Shell Thing Ltd (British Virgin Islands) — shareholder
    Explore more from the Offshore Leaks database</body></html>`;
  const routes = [
    ["reconcile", jsonRes({ q0: { result: [
      { id: "12345", name: "Ranjan Testwala", score: 92, match: true, types: [{ id: "officer", name: "Officer" }] },
    ] } })],
    ["/nodes/12345", textRes(nodeHtml)],
  ];
  await withFetch(routes, async () => {
    const items = await fetchICIJ(P);
    assert.equal(items.length, 1);
    assert.equal(items[0].source_type, "icij_leaks");
    assert.equal(items[0].admissible, false); // leak data is a lead, never admissible
    assert.match(items[0].content, /Shell Thing Ltd/);
  });
});

test("icij: network failure (all retries) degrades to []", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ENOTFOUND"); };
  try {
    assert.deepEqual(await fetchICIJ(P), []);
  } finally { globalThis.fetch = orig; }
});

// ---- SEC EDGAR ----

test("sec-edgar: hit whose document really names the politician becomes an item", async () => {
  const hit = {
    _id: "0001-23-456789:doc.htm",
    _source: { ciks: ["0000320193"], display_names: ["Testcorp Inc"], form: "6-K", file_date: "2024-01-05" },
  };
  const routes = [
    ["efts.sec.gov", jsonRes({ hits: { hits: [hit] } })],
    ["www.sec.gov/Archives", textRes(`<html><p>The dispute involving Ranjan Testwala was disclosed.</p></html>`)],
  ];
  await withFetch(routes, async () => {
    const items = await fetchSECEdgar(P);
    assert.equal(items.length, 1);
    assert.equal(items[0].source_type, "sec_edgar");
    assert.match(items[0].title, /Testcorp Inc/);
    assert.match(items[0].content, /Ranjan Testwala/);
  });
});

test("sec-edgar: hit whose document does NOT contain the name is dropped", async () => {
  const hit = {
    _id: "0001-23-456789:doc.htm",
    _source: { ciks: ["0000320193"], display_names: ["Testcorp Inc"], form: "6-K", file_date: "2024-01-05" },
  };
  const routes = [
    ["efts.sec.gov", jsonRes({ hits: { hits: [hit] } })],
    ["www.sec.gov/Archives", textRes(`<html><p>Nothing relevant here.</p></html>`)],
  ];
  await withFetch(routes, async () => {
    assert.deepEqual(await fetchSECEdgar(P), []);
  });
});

test("sec-edgar: search API failure degrades to []", async () => {
  await withFetch([["efts.sec.gov", jsonRes({}, 503)]], async () => {
    assert.deepEqual(await fetchSECEdgar(P), []);
  });
});

// ---- NSE deals ----

test("nse-deals: cookie handshake + json rows filtered by client name", async () => {
  const rows = [
    { clientName: "RANJAN TESTWALA HUF", symbol: "TCORP", date: "01-Jul-2025", quantityTraded: 100000, buySell: "BUY" },
    { clientName: "Somebody Else", symbol: "OTHER", date: "01-Jul-2025", quantityTraded: 5, buySell: "SELL" },
  ];
  const routes = [
    ["nseindia.com/api/", jsonRes({ data: rows }, 200, { "content-type": "application/json" })],
    ["nseindia.com", textRes("<html>home</html>", 200, { setcookie: ["nsit=abc; Path=/", "bm_sv=xyz; Path=/"] })],
  ];
  await withFetch(routes, async () => {
    const matches = await searchDeals("Ranjan Testwala", { timeoutMs: 1000 });
    // two endpoints (bulk + block) both return the same fixture → 2 matches
    assert.equal(matches.length, 2);
    assert.equal(matches[0].client, "RANJAN TESTWALA HUF");
    assert.equal(matches[0].symbol, "TCORP");
  });
});

test("nse-deals: failed cookie handshake degrades to []", async () => {
  await withFetch([["nseindia.com", textRes("<html>blocked</html>", 200, { setcookie: [] })]], async () => {
    assert.deepEqual(await searchDeals("Ranjan Testwala", { timeoutMs: 1000 }), []);
  });
});

test("nse-deals: parseDealsCsv matches case-insensitively and skips others", () => {
  const csv = [
    `"Date","Symbol","Security Name","Client Name","Buy/Sell","Quantity Traded"`,
    `"01-Jul-2025","TCORP","Testcorp","Ranjan Testwala","BUY","100000"`,
    `"01-Jul-2025","OTHER","Other Co","Somebody Else","SELL","5"`,
  ].join("\n");
  const rows = parseDealsCsv(csv, "ranjan testwala");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "TCORP");
});
