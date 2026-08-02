// Dedicated CPPP procurement ingest — pulls government contract-award matches from
// the local 6.6 GB CPPP AOC SQLite (env CPPP_DB_PATH) for every rep and stores them
// as `gem` evidence, which the financial-links extractor then folds into the ledger.
//
// It lives apart from the full ingest.js sweep because a single lookup is a
// full-table LIKE scan (~2-5s), so a whole-roster pass is long-running (hours). This
// runner is RESUMABLE (skips reps that already have a CPPP `gem` row) so it can be
// stopped/restarted or driven from the Ops Console as the `cppp_ingest` job.
//
//   node server/cppp-ingest.js                     # all reps, resume (skip done)
//   node server/cppp-ingest.js --office MP          # only MPs
//   node server/cppp-ingest.js --state "Tamil Nadu" --limit 50
//   node server/cppp-ingest.js --force             # re-query even reps already done
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { listPoliticians, addEvidence, listEvidence, recordFetchRun } from "../store/store.js";
import { fetchCPPPProcurement } from "../fetchers/cppp-procurement.js";
import { startTimer } from "../util/timing.js";

// A rep is "done" if it already carries a CPPP-sourced gem row (the fetcher tags
// source_type 'gem' and the content names the CPPP corpus).
function hasCppp(pid) {
  return listEvidence(pid).some((e) => e.source_type === "gem" && /CPPP|award-of-contract/i.test(e.content ?? e.title ?? ""));
}

export async function runCpppIngest({ office = null, state = null, limit = null, force = false, log = console.log } = {}) {
  if (!process.env.CPPP_DB_PATH) { log("[cppp-ingest] CPPP_DB_PATH not set — nothing to do."); return { scanned: 0, matched: 0, skipped: 0, done: 0 }; }
  let reps = listPoliticians().filter((p) => !p.is_demo);
  if (office) reps = reps.filter((p) => (p.office ?? "").toLowerCase() === String(office).toLowerCase());
  if (state) reps = reps.filter((p) => (p.state ?? "").toLowerCase() === String(state).toLowerCase());
  if (limit) reps = reps.slice(0, Number(limit));

  const out = { scanned: 0, matched: 0, skipped: 0, done: 0, reps: reps.length };
  for (const p of reps) {
    out.scanned++;
    if (!force && hasCppp(p.id)) { out.skipped++; continue; }
    const t0 = Date.now();
    try {
      const res = await fetchCPPPProcurement(p);
      const items = Array.isArray(res) ? res : res ? [res] : [];
      if (items.length) { addEvidence(items); out.matched++; }
      out.done++;
      recordFetchRun({ source: "cppp", politician_id: p.id, ok: 1, items: items.length, ms: Date.now() - t0 });
      if (out.done % 50 === 0) log(`[cppp-ingest] ${out.done} queried, ${out.matched} with matches, ${out.skipped} skipped (of ${reps.length})`);
    } catch (e) {
      recordFetchRun({ source: "cppp", politician_id: p.id, ok: 0, items: 0, ms: Date.now() - t0, error: e.message });
      log(`[cppp-ingest]   ${p.name}: ${e.message}`);
    }
  }
  log(`[cppp-ingest] done: ${out.done} queried, ${out.matched} with matches, ${out.skipped} already had CPPP, of ${reps.length}.`);
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const stop = startTimer("CPPP ingest");
  runCpppIngest({
    office: val("--office"), state: val("--state"),
    limit: val("--limit"), force: argv.includes("--force"),
  }).then((r) => { console.log("[cppp-ingest] result:", JSON.stringify(r)); stop(); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
