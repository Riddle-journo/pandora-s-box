// Targeted re-ingest for the `party_finance` source.
//
// The party-funding fetcher was enriched (2026-07-12) to fold each recent year's
// ITR detail-page breakdown (distinct income sources, spending categories, and
// asset/liability composition) into the evidence content — previously it carried
// only the four balancing top-line totals from the summary table, which read as
// "duplicated" (Total Assets = Total Liabilities and Total Income = Total
// Expenditure are accounting identities, not a scrape bug).
//
// A normal `npm run ingest` will NOT refresh the existing rows: addEvidence()
// dedups by (politician_id, url) and its in-place upgrade path only fires for
// content-over-a-bare-pointer, never richer-content-over-existing-content. So we
// refresh in place here, preserving each row's id (evidence ids are referenced by
// extracted facts via evidence_id) and only swapping content + summary.
//
// Idempotent — safe to re-run. Distinct parties are scraped once (the fetcher
// caches per party id in-process), so ~1.5k rows cost only ~one scrape per party.
//   Run: node server/reingest-party-finance.js
import "dotenv/config";
import { db, listPoliticians } from "../server/store.js";
import { fetchPartyFunding } from "../server/fetchers/party-funding.js";

const rows = db.prepare(
  "SELECT id, politician_id, data FROM evidence WHERE json_extract(data,'$.source_type')='party_finance'"
).all();
console.log(`[reingest-party-finance] ${rows.length} party_finance rows to refresh`);

const polById = new Map(listPoliticians().map((p) => [p.id, p]));
const upd = db.prepare("UPDATE evidence SET data = ?, has_content = ?, fetched_at = ? WHERE id = ?");

let refreshed = 0, unchanged = 0, skipped = 0;
for (const r of rows) {
  const p = polById.get(r.politician_id);
  if (!p) { skipped++; continue; }
  const fresh = (await fetchPartyFunding(p))[0];
  if (!fresh?.content) { skipped++; continue; }

  const old = JSON.parse(r.data);
  if (old.content === fresh.content && old.summary === fresh.summary) { unchanged++; continue; }

  const merged = { ...old, content: fresh.content, summary: fresh.summary };
  upd.run(JSON.stringify(merged), merged.content ? 1 : 0, new Date().toISOString(), r.id);
  refreshed++;
  if (refreshed % 200 === 0) console.log(`[reingest-party-finance]   …${refreshed} refreshed`);
}

console.log(`[reingest-party-finance] done: ${refreshed} refreshed, ${unchanged} unchanged, ${skipped} skipped (no politician/party)`);
