// Party-finance extractor — pins that the enriched party_finance content yields
// per-year facts attributed to the PARTY entity (not the politician), that the two
// distinct accountability line items (donations income, election spend) are
// captured, that values are normalised lacs → absolute rupees, and that the batch
// runner writes each party's facts ONCE (one representative row) despite the same
// figures riding on many members' evidence rows.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-party-finance-${process.pid}.db`);
// Clear any leftover from a prior run whose unlink failed (Windows holds the
// SQLite handle) so every run starts from an empty DB — see expenditure.test.js.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const { db } = await import("../server/store/store.js");
const { getEntity, findEntityByStrongId } = await import("../server/entities/entities.js");
const { factsFor } = await import("../server/store/ledger.js");
const { partyFinanceFacts, runPartyFinanceExtraction, PARTY_FINANCE_VERSION } =
  await import("../server/extractors/party-finance.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

// A trimmed but faithful sample of the enriched fetcher output for BJP (id=3).
const CONTENT = [
  "PARTY FINANCIALS — Bharatiya Janata Party (BJP) (Prof S P Singh Baghel's party):",
  "DETAILED BREAKDOWN — per-year income sources, spending categories, and asset/liability composition (the distinct, non-balancing figures):",
  "FY 2024-25:",
  "  Assets: Fixed Assets Rs.1,94,094.04 | Current Assets Rs.9,99,612.30 | Loans & Advances Rs.23,411.33 | Total Assets Rs.12,17,117.68 (lacs)",
  "  Liabilities: General Fund Rs.12,16,414.54 | Loans/Borrowings Rs.15.43 | Current Liabilities Rs.687.70 | Total Liabilities Rs.12,17,117.68 (lacs)",
  "  Income: Fee & Subscription Rs.570.08 | Voluntary Contributions Rs.6,12,485.83 | Interest from Banks Rs.63,409.67 | Other Income Rs.449.38 | Total Income Rs.6,76,914.98 (lacs)",
  "  Expenditure: Employee Costs Rs.7,434.89 | Administrative Costs Rs.32,305.41 | Election/General Propaganda Rs.3,33,536.85 | Surplus/Deficit Carried over to General Fund Rs.2,99,456.73 | Total Expenditure Rs.6,76,914.98 (lacs)",
  "FY 2023-24:",
  "  Income: Fee & Subscription Rs.271.98 | Voluntary Contributions Rs.3,96,714.84 | Interest Income Rs.36,903.35 | Total Income Rs.4,34,047.34 (lacs)",
  "  Expenditure: Employee Costs Rs.7,352.95 | Election/General Propaganda Rs.1,75,406.56 | Total Expenditure Rs.4,34,047.34 (lacs)",
  "",
  "MULTI-YEAR SUMMARY — top-line totals per year. By accounting identity Total Assets = Total Liabilities and Total Income = Total Expenditure:",
  "Total Assets (in lacs) Total Liabilities (in lacs) Total Income (in lacs) Total Expenditure (in lacs) 2024-25 Rs. 12,17,117.68 lacs Rs. 12,17,117.68 lacs Rs. 6,76,914.98 lacs Rs. 6,76,914.98 lacs 2023-24 Rs. 9,18,115.53 lacs Rs. 9,18,115.53 lacs Rs. 4,34,047.34 lacs Rs. 4,34,047.34 lacs",
].join("\n");

const evidence = (id, pid) => ({
  data: {
    source_type: "party_finance", tier: 6,
    url: "https://www.myneta.info/party/index.php?action=summary&id=3",
    title: "Party financials — Bharatiya Janata Party (BJP) (Prof S P Singh Baghel's party)",
    summary: "Income, expenditure, assets, liabilities and donation records of Bharatiya Janata Party (BJP) (ADR/ECI data) — the party Prof S P Singh Baghel belongs to.",
    content: CONTENT,
  },
  id, politician_id: pid,
});

test("partyFinanceFacts: attributes distinct per-year facts to the PARTY entity", () => {
  const facts = partyFinanceFacts(evidence("EV1", "P1"));
  // 4 totals × 2 summary years + donations/election × 2 detail years = 12
  assert.equal(facts.length, 12);
  assert.ok(facts.every((f) => f.subject_kind === "party"));
  const eid = findEntityByStrongId("party", { myneta_party_id: "3" }).id;
  assert.ok(facts.every((f) => f.entity_id === eid));
  assert.equal(getEntity(eid).kind, "party");
  assert.equal(getEntity(eid).canonical_name, "Bharatiya Janata Party (BJP)");

  const one = (metric, fy) => facts.find((f) => f.metric === metric && f.period === `FY${fy}`);
  // lacs → absolute rupees (12,17,117.68 lacs × 100000).
  assert.equal(one("party_total_assets", "2024-25").value, 121711768000);
  assert.equal(one("party_total_assets", "2024-25").as_of_date, "2025-03-31");
  // The distinct line items the old summary-only content could never surface.
  assert.equal(one("party_donations_income", "2024-25").value, 61248583000);
  assert.equal(one("party_election_expenditure", "2024-25").value, 33353685000);
  // Income ≠ donations, and donations ≠ election spend — genuinely distinct figures.
  assert.notEqual(one("party_donations_income", "2024-25").value, one("party_total_income", "2024-25").value);
  assert.notEqual(one("party_donations_income", "2024-25").value, one("party_election_expenditure", "2024-25").value);
});

test("party name survives a politician nickname with nested parens (BJP regression)", () => {
  // The member's name carries its own parentheses — "(Guddu)" — which broke the
  // naive title parser and dropped BJP entirely on the live DB.
  const ev = evidence("EVG", "PG");
  ev.data.title = "Party financials — Bharatiya Janata Party (BJP) (Ambrish Sharma (Guddu)'s party)";
  ev.data.summary = "records of Bharatiya Janata Party (BJP) (ADR/ECI data) — the party Ambrish Sharma (Guddu) belongs to.";
  const facts = partyFinanceFacts(ev);
  assert.equal(facts.length, 12);
  assert.equal(getEntity(facts[0].entity_id).canonical_name, "Bharatiya Janata Party (BJP)");

  // Even with summary absent, the nested-paren-tolerant title fallback recovers it.
  const ev2 = evidence("EVG2", "PG2");
  ev2.data.title = "Party financials — Bharatiya Janata Party (BJP) (Ambrish Sharma (Guddu)'s party)";
  delete ev2.data.summary;
  assert.equal(getEntity(partyFinanceFacts(ev2)[0].entity_id).canonical_name, "Bharatiya Janata Party (BJP)");
});

test("no party entity → no facts (never misattributes to the politician)", () => {
  const bad = { id: "EVX", politician_id: "P9", data: { source_type: "party_finance", content: "no header, no url" } };
  assert.equal(partyFinanceFacts(bad).length, 0);
});

test("batch runner: writes each party ONCE despite many member rows; idempotent", () => {
  // Three members of the SAME party (same summary url) → one representative row.
  for (const [id, pid] of [["A", "PA"], ["B", "PB"], ["C", "PC"]]) {
    const e = evidence(id, pid);
    db.prepare("INSERT INTO evidence (id, politician_id, url, date, has_content, fetched_at, data) VALUES (?,?,?,?,?,?,?)")
      .run(id, pid, e.data.url, null, 1, "t", JSON.stringify({ id, ...e.data }));
  }
  const c = runPartyFinanceExtraction();
  assert.equal(c.parties, 1);   // three member rows collapse to one party
  assert.equal(c.evidence, 1);  // extracted from a single representative row
  assert.equal(c.facts, 12);

  const eid = findEntityByStrongId("party", { myneta_party_id: "3" }).id;
  const assets = factsFor(eid, "party_total_assets");
  assert.equal(assets.length, 2); // one per summary year, NOT one per member
  assert.equal(assets[0].source_type, "party_finance");
  assert.equal(assets[0].extractor_version, PARTY_FINANCE_VERSION);

  // Re-run is a no-op (idempotent).
  assert.equal(runPartyFinanceExtraction().facts, 0);
  assert.equal(factsFor(eid, "party_total_assets").length, 2);
});
