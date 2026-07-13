// SEBI corporate-disclosures tests: the pure NSE-feed parsers, evidence shaping,
// the opt-in gate, and the extractor's pure record builder — all against inline
// fixture JSON. NO live network. PANDOROS_DB_PATH is set to a per-pid throwaway DB
// BEFORE importing the extractor (which pulls in extract.js → store.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-sebi-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const {
  parsePit, parseSast, parseAnnouncements, parseNseDate,
  disclosureUrl, disclosureToEvidence, fetchCompanyDisclosures, fetchSebiDisclosures,
} = await import("../server/fetchers/sebi-disclosures.js");
const { sebiRecords } = await import("../server/extractors/sebi-disclosures.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// ── Fixtures modelled on the real NSE feed shapes (verified 2026-07-13) ──────
const PIT_JSON = {
  acqNameList: ["BALANADU NARAYAN"],
  data: [{
    acqMode: "Off Market", acqName: "BALANADU NARAYAN", acqfromDt: "13-Feb-2026",
    afterAcqSharesNo: "1600", befAcqSharesNo: "3920", buyQuantity: "0", buyValue: "0",
    company: "Reliance Industries Limited", date: "18-Feb-2026 19:06", intimDt: "16-Feb-2026",
    personCategory: "Other", secAcq: "2320", secType: "Equity Shares", secVal: "3294168",
    sellValue: "0", sellquantity: "0", symbol: "RELIANCE",
  }],
};
const SAST_JSON = {
  acqNameList: ["Acme Holdings LLP"],
  data: [{
    acqName: "Acme Holdings LLP", company: "Sample Listed Ltd", symbol: "SAMPLE",
    secAcq: "500000", secVal: "125000000", acqMode: "Market Purchase",
    secType: "Equity Shares", intimDt: "02-Mar-2026", date: "03-Mar-2026 10:00",
    personCategory: "Promoter Group",
  }],
};
const ANN_JSON = [
  {
    an_dt: "13-Jul-2026 17:49:20", symbol: "SAMPLE", sm_name: "Sample Listed Ltd",
    attchmntFile: "https://nsearchives.nseindia.com/corporate/SAMPLE_rpt.pdf",
    attchmntText: "Disclosure of Related Party Transactions for the half-year ended.",
    desc: "Related Party Transactions",
  },
  {
    an_dt: "10-Jul-2026 09:00:00", symbol: "SAMPLE", sm_name: "Sample Listed Ltd",
    attchmntFile: "", attchmntText: "Board meeting intimation", desc: "Board Meeting Intimation",
  },
];

test("parseNseDate handles the feed's date formats", () => {
  assert.equal(parseNseDate("18-Feb-2026 19:06"), "2026-02-18");
  assert.equal(parseNseDate("13-Jul-2026 17:49:20"), "2026-07-13");
  assert.equal(parseNseDate("16-Feb-2026"), "2026-02-16");
  assert.equal(parseNseDate("garbage"), null);
});

test("parsePit normalises an insider-trade row", () => {
  const rows = parsePit(PIT_JSON);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.type, "insider_trade");
  assert.equal(r.company, "Reliance Industries Limited");
  assert.equal(r.symbol, "RELIANCE");
  assert.equal(r.counterparty, "BALANADU NARAYAN");
  assert.equal(r.quantity, 2320);   // secAcq
  assert.equal(r.value, 3294168);   // secVal
  assert.equal(r.date, "2026-02-16"); // intimDt preferred
  assert.deepEqual(parsePit({ data: [] }), []);
  assert.deepEqual(parsePit(null), []);
});

test("parseSast tags rows as sast_acquisition", () => {
  const rows = parseSast(SAST_JSON);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "sast_acquisition");
  assert.equal(rows[0].counterparty, "Acme Holdings LLP");
  assert.equal(rows[0].quantity, 500000);
});

test("parseAnnouncements flags related-party txns and keeps ALL rows", () => {
  const rows = parseAnnouncements(ANN_JSON, { symbol: "SAMPLE" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "related_party_txn");
  assert.equal(rows[0].attachment, "https://nsearchives.nseindia.com/corporate/SAMPLE_rpt.pdf");
  assert.equal(rows[1].type, "announcement"); // non-RPT kept, not filtered out
});

test("disclosureUrl is mandatory: attachment wins, else canonical filing page", () => {
  assert.equal(
    disclosureUrl({ type: "related_party_txn", attachment: "https://x/y.pdf", symbol: "SAMPLE" }),
    "https://x/y.pdf",
  );
  assert.equal(
    disclosureUrl({ type: "insider_trade", symbol: "RELIANCE" }),
    "https://www.nseindia.com/companies-listing/corporate-filings-insider-trading?symbol=RELIANCE",
  );
});

test("disclosureToEvidence yields a citable evidence row with structured payload", () => {
  const [pit] = parsePit(PIT_JSON);
  const ev = disclosureToEvidence(pit, "pol-1");
  assert.equal(ev.politician_id, "pol-1");
  assert.equal(ev.source_type, "sebi_disclosures");
  assert.ok(ev.url && ev.url.startsWith("http")); // URL mandatory
  assert.ok(ev.title.includes("BALANADU NARAYAN"));
  assert.equal(ev.disclosure.type, "insider_trade");
  assert.equal(ev.disclosure.value, 3294168);
  assert.equal(disclosureToEvidence(null, "pol-1"), null);
  assert.equal(disclosureToEvidence(pit, null), null);
});

test("fetchSebiDisclosures is OFF unless enabled (opt-in gate)", async () => {
  delete process.env.SEBI_DISCLOSURES_ENABLE;
  const off = await fetchSebiDisclosures({ symbol: "RELIANCE" }, "pol-1", {
    fetchJsonImpl: async () => ({ data: [] }),
  });
  assert.deepEqual(off, []);
});

test("fetchCompanyDisclosures wires the three feeds with an injected fetch (no network)", async () => {
  const routes = {
    "corporates-pit": PIT_JSON,
    "corporate-sast-reg29": SAST_JSON,
    "corporate-announcements": ANN_JSON,
  };
  const fetchJsonImpl = async (url) => {
    const hit = Object.keys(routes).find((k) => url.includes(`/api/${k}?`));
    return hit ? routes[hit] : null;
  };
  const rows = await fetchCompanyDisclosures({ symbol: "RELIANCE" }, "pol-1", { cookie: "x", fetchJsonImpl });
  // 1 PIT + 1 SAST + 2 announcements = 4 evidence rows, each citable.
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.url && r.source_type === "sebi_disclosures"));
  const kinds = rows.map((r) => r.disclosure.type).sort();
  assert.deepEqual(kinds, ["announcement", "insider_trade", "related_party_txn", "sast_acquisition"]);
});

test("fetchSebiDisclosures (forced) resolves a name→symbol then dedups by url", async () => {
  const fetchJsonImpl = async (url) => (url.includes("corporates-pit") ? PIT_JSON : { data: [] });
  const resolveSymbol = async () => "RELIANCE";
  const rows = await fetchSebiDisclosures([{ name: "Reliance Industries" }, { name: "Reliance Industries" }], "pol-1", {
    force: true, cookie: "x", fetchJsonImpl, resolveSymbol,
  });
  assert.equal(rows.length, 1); // both targets resolve to the same symbol → deduped
  assert.equal(rows[0].disclosure.counterparty, "BALANADU NARAYAN");
});

test("sebiRecords emits a low-confidence event + company→counterparty relationship", () => {
  const [pit] = parsePit(PIT_JSON);
  const ev = disclosureToEvidence(pit, "pol-1");
  const { events, relationships } = sebiRecords(ev);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "insider_trade");
  assert.equal(events[0].data.identity_unverified, true);
  assert.ok(events[0].data.confidence < 0.5);
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].rel_type, "sebi_disclosed_counterparty");
  assert.equal(relationships[0].dst_name, "BALANADU NARAYAN");
  assert.equal(relationships[0].dst_kind, "person");
  assert.deepEqual(relationships[0].src_company, { name: "Reliance Industries Limited", symbol: "RELIANCE" });
});

test("sebiRecords: SAST uses sast_counterparty; announcement w/o counterparty → event only", () => {
  const [sast] = parseSast(SAST_JSON);
  const sr = sebiRecords(disclosureToEvidence(sast, "pol-1"));
  assert.equal(sr.relationships[0].rel_type, "sast_counterparty");

  const [, boardMtg] = parseAnnouncements(ANN_JSON, { symbol: "SAMPLE" });
  const ar = sebiRecords(disclosureToEvidence(boardMtg, "pol-1"));
  assert.equal(ar.events.length, 1);
  assert.equal((ar.relationships ?? []).length, 0); // no counterparty → no edge
  assert.deepEqual(sebiRecords({}), {}); // no disclosure payload → nothing
});
