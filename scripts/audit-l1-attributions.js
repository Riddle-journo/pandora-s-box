// Retroactive attribution audit for the bulk-dataset evidence already in the DB.
//
// Every `l1_*` evidence row (including the mega caches, whose source_types are
// l1_mega_*) was attributed to a named politician by the OLD matcher: a
// normalized substring test. This tool re-decides each of those rows with the
// abstain-first ladder in server/util/linker.js and reports what the old test got
// wrong — how many stored adverse rows the ladder would refuse to attribute at
// all, which politicians carry them, and which sources produce the most.
//
// HARD CONSTRAINTS
//   - Report-only by default. The live DB is opened READ-ONLY, and in dry-run the
//     app's own store handle is pointed at a scratch file BEFORE any server
//     module is imported, so importing the ingest registry cannot touch
//     data/pandoros.db at all.
//   - --apply QUARANTINES (never deletes): each would-abstain row is rewritten in
//     place through the existing evidence writer with admissible:false and a
//     quarantine reason, so the raw fetched content survives for review.
//
// USAGE
//   node scripts/audit-l1-attributions.js                  # dry run, prints + writes a JSON report
//   node scripts/audit-l1-attributions.js --limit 500      # sample the first N rows
//   node scripts/audit-l1-attributions.js --source l1_up_flood_tenders
//   node scripts/audit-l1-attributions.js --json <path>    # override the report path
//   node scripts/audit-l1-attributions.js --apply          # quarantine would-abstain rows
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, dbPath, openReadOnly, parseArgs } from "./label-leads.js";
import { buildRosterIndex, linkRowsForPolitician, LINKER_VERSION } from "../server/util/linker.js";

const QUARANTINE_REASON = `identity ladder abstained (${LINKER_VERSION}) — name matched but nothing in the row corroborated it`;

// Rebuild pseudo-rows from a stored evidence blob's "• cell | cell" bullets. Used
// only when the source's cache file is gone: the cells were truncated to 160 chars
// on write, so corroborating context may have been cut off — those rows are
// reported under a separate `basis: "content"` so the headline numbers stay honest.
export function rowsFromContent(content) {
  return String(content ?? "").split(/\r?\n/)
    .filter((l) => l.startsWith("•"))
    .map((l) => l.replace(/^•\s?/, "").split(" | "));
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

export function summarize(rows) {
  const totals = { total: rows.length, match: 0, abstain: 0, no_match: 0, unresolvable: 0 };
  const bySource = new Map();
  const byPolitician = new Map();
  const byMethod = new Map();
  for (const r of rows) {
    totals[r.decision] = (totals[r.decision] ?? 0) + 1;
    const s = bySource.get(r.source_type) ?? { source_type: r.source_type, total: 0, match: 0, abstain: 0, no_match: 0, unresolvable: 0, basis: r.basis };
    s.total++; s[r.decision]++;
    bySource.set(r.source_type, s);
    byMethod.set(r.method ?? "—", (byMethod.get(r.method ?? "—") ?? 0) + 1);
    if (r.decision === "abstain" || r.decision === "no_match") {
      const p = byPolitician.get(r.politician_id) ?? { politician_id: r.politician_id, name: r.politician_name, abstain: 0, no_match: 0, sources: new Set() };
      p[r.decision]++; p.sources.add(r.source_type);
      byPolitician.set(r.politician_id, p);
    }
  }
  return {
    totals,
    bySource: [...bySource.values()].sort((a, b) => (b.abstain + b.no_match) - (a.abstain + a.no_match)),
    byPolitician: [...byPolitician.values()]
      .map((p) => ({ ...p, sources: [...p.sources] }))
      .sort((a, b) => (b.abstain + b.no_match) - (a.abstain + a.no_match)),
    byMethod: [...byMethod.entries()].sort((a, b) => b[1] - a[1]),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const apply = flags.apply === true;
  const limit = flags.limit ? Number(flags.limit) : 0;
  const onlySource = typeof flags.source === "string" ? flags.source : null;

  // Resolve the LIVE path first: in dry-run we then redirect the app's store
  // handle to a scratch DB so importing server modules is provably harmless.
  const liveDb = dbPath();
  if (!apply) {
    process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-audit-scratch-${process.pid}.db`);
  }
  // Pin the cache dir to the repo (ingest.js otherwise derives it from cwd).
  process.env.L1_CACHE_DIR = process.env.L1_CACHE_DIR || path.join(REPO_ROOT, "server", "data", "l1-cache");
  const ingest = await import("../server/orchestration/ingest.js");

  const db = openReadOnly(liveDb);
  const politicians = db.prepare("SELECT data FROM politicians").all().map((r) => JSON.parse(r.data));
  const byId = new Map(politicians.map((p) => [String(p.id), p]));
  const roster = buildRosterIndex(politicians.filter((p) => !p.is_demo));

  const evidence = db.prepare(`
    SELECT id, politician_id, url, fetched_at, json_extract(data, '$.source_type') AS source_type, data
    FROM evidence
    WHERE source_type LIKE 'l1\\_%' ESCAPE '\\' OR source_type LIKE 'mega%'
    ORDER BY source_type, politician_id`).all()
    .filter((r) => !onlySource || r.source_type === onlySource);
  const scope = limit ? evidence.slice(0, limit) : evidence;

  console.log(`[audit] ${scope.length} bulk-dataset evidence row(s)${limit ? ` (limited from ${evidence.length})` : ""}; roster ${roster.entries.length} names; matcher ${LINKER_VERSION}`);

  const caches = new Map(); // source_type → { cfg, cache } (loaded once)
  const cacheDirFiles = fs.existsSync(process.env.L1_CACHE_DIR) ? fs.readdirSync(process.env.L1_CACHE_DIR) : [];
  function sourceFor(sourceType) {
    if (caches.has(sourceType)) return caches.get(sourceType);
    const cfg = ingest.l1CfgByType(sourceType);
    let id = cfg?.id ?? null;
    if (!id) {
      const f = cacheDirFiles.find((n) => n.endsWith(".json") && ingest.l1SourceType(path.basename(n, ".json")) === sourceType);
      if (f) id = path.basename(f, ".json");
    }
    const cache = id ? ingest.l1Read(id) : null;
    const entry = { cfg: cfg ?? cache?.meta ?? null, cache, id };
    caches.set(sourceType, entry);
    return entry;
  }

  const results = [];
  for (const ev of scope) {
    const blob = JSON.parse(ev.data);
    const p = byId.get(String(ev.politician_id));
    if (!p) {
      results.push({ evidence_id: ev.id, politician_id: ev.politician_id, politician_name: "(missing from roster)",
        source_type: ev.source_type, decision: "unresolvable", basis: "none", method: null, confidence: 0,
        reasons: ["evidence points at a politician_id that no longer exists"], candidates: [], url: ev.url });
      continue;
    }
    const { cfg, cache } = sourceFor(ev.source_type);
    const mode = cfg?.match === "party" ? "party" : "name";
    const stored = rowsFromContent(blob.content);
    const cacheRows = Array.isArray(cache?.rows) && cache.rows.length > 0 ? cache.rows : null;
    if (!cacheRows && !stored.length) {
      results.push({ evidence_id: ev.id, politician_id: p.id, politician_name: p.name, source_type: ev.source_type,
        decision: "unresolvable", basis: "none", method: null, confidence: 0,
        reasons: ["no cache on disk and no parsable bullets in the stored content"], candidates: [], url: ev.url });
      continue;
    }

    // Decide against today's cache when there is one…
    let basis = cacheRows ? "cache" : "content";
    let rows = cacheRows ?? stored;
    let link = linkRowsForPolitician(rows, p, { mode, roster, maxHits: 3 });
    // …but a present cache is not necessarily the SNAPSHOT this row came from. L1
    // caches expire (L1_TTL_MS) and are re-fetched with maxRows truncation while
    // evidence rows persist forever, so for any rotating listing (tender lists, ED
    // releases, paged html-list sources) the row that produced this evidence is
    // simply gone from today's file. scanned === 0 means "the name is not in the
    // CURRENT snapshot", which is not the same claim as "this attribution was
    // bogus" — so fall back to the row's OWN stored content before concluding
    // no_match, and keep the two apart in the report.
    if (link.scanned === 0 && cacheRows && stored.length) {
      const reDecided = linkRowsForPolitician(stored, p, { mode, roster, maxHits: 3 });
      if (reDecided.scanned > 0) {
        basis = "content_fallback";
        rows = stored;
        link = reDecided;
      } else {
        basis = "cache_and_content";
      }
    }
    const cacheFetchedAt = cache?.fetched_at ?? null;
    results.push({
      evidence_id: ev.id, politician_id: p.id, politician_name: p.name, source_type: ev.source_type,
      decision: link.decision, basis,
      method: link.method, confidence: link.confidence, reasons: link.reasons,
      candidates: link.candidates, url: ev.url,
      scanned_rows: link.scanned, matched_rows: link.matchedCount, abstained_rows: link.abstainedCount,
      excerpt: link.abstainExcerpt ?? link.matched?.[0]?.excerpt ?? null,
      dataset_rows: rows.length,
      // A no_match whose cache is NEWER than the evidence is a stale-snapshot
      // artifact, not proof the original attribution was wrong.
      evidence_fetched_at: ev.fetched_at ?? null,
      cache_fetched_at: cacheFetchedAt,
      cache_newer_than_evidence: Boolean(cacheFetchedAt && ev.fetched_at && cacheFetchedAt > ev.fetched_at),
    });
  }

  const sum = summarize(results);
  const t = sum.totals;
  console.log(`\n[audit] verdicts over ${t.total} stored row(s):`);
  console.log(`  would MATCH        ${t.match}  (${pct(t.match, t.total)})`);
  console.log(`  would ABSTAIN      ${t.abstain}  (${pct(t.abstain, t.total)})   ← currently published as attributed evidence`);
  console.log(`  would NOT MATCH    ${t.no_match}  (${pct(t.no_match, t.total)})   ← the name isn't even in the dataset any more`);
  console.log(`  unresolvable       ${t.unresolvable}  (${pct(t.unresolvable, t.total)})`);
  const basis = results.reduce((a, r) => ((a[r.basis] = (a[r.basis] ?? 0) + 1), a), {});
  console.log(`  basis: ${Object.entries(basis).map(([k, v]) => `${k}=${v}`).join(" ")} (content = cache gone, cells truncated to 160 chars → biased toward abstain)`);
  console.log(`  methods: ${sum.byMethod.map(([m, n]) => `${m}=${n}`).join("  ")}`);

  console.log(`\n[audit] worst sources (by rows the ladder refuses):`);
  for (const s of sum.bySource.slice(0, 15)) {
    console.log(`  ${String(s.source_type).padEnd(34)} total=${String(s.total).padStart(4)}  match=${String(s.match).padStart(4)}  abstain=${String(s.abstain).padStart(4)}  no_match=${String(s.no_match).padStart(4)}`);
  }

  console.log(`\n[audit] politicians carrying would-abstain / would-not-match rows (top 25 of ${sum.byPolitician.length}):`);
  for (const p of sum.byPolitician.slice(0, 25)) {
    console.log(`  ${String(p.name).padEnd(30)} abstain=${String(p.abstain).padStart(3)} no_match=${String(p.no_match).padStart(3)}  ${p.sources.join(", ")}`);
  }

  const reportPath = typeof flags.json === "string"
    ? path.resolve(flags.json)
    : path.join(REPO_ROOT, "logs", "audits", `l1-attributions-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(), matcher_version: LINKER_VERSION, db: liveDb,
    scope: { rows: scope.length, of: evidence.length, source: onlySource ?? null, limit: limit || null },
    totals: t, basis, byMethod: sum.byMethod, bySource: sum.bySource, byPolitician: sum.byPolitician,
    quarantine_eligible: results.filter((r) => (r.decision === "abstain" || r.decision === "no_match")
      && r.basis !== "content" && r.basis !== "content_fallback"
      && !(r.decision === "no_match" && r.cache_newer_than_evidence)).length,
    rows: results,
  }, null, 2) + "\n", "utf8");
  console.log(`\n[audit] full detail → ${reportPath}`);

  // What --apply may touch. Two classes of would-refuse row are deliberately HELD
  // BACK, because for them the audit cannot tell a bogus attribution from its own
  // blind spot — and quarantining a defensible adverse record is a real loss:
  //   • basis "content"/"content_fallback": decided from the stored bullets, whose
  //     cells were truncated to 160 chars on write, so corroborating context may
  //     simply have been cut off. The script's own output labels this "biased
  //     toward abstain".
  //   • a no_match whose cache is newer than the evidence: the source listing has
  //     rotated, so the row is absent from today's snapshot for reasons that say
  //     nothing about the original match.
  const isReconstructed = (r) => r.basis === "content" || r.basis === "content_fallback";
  const wouldRefuse = results.filter((r) => r.decision === "abstain" || r.decision === "no_match");
  const held = wouldRefuse.filter((r) => isReconstructed(r) || (r.decision === "no_match" && r.cache_newer_than_evidence));
  const quarantine = wouldRefuse.filter((r) => !held.includes(r));
  console.log(`\n[audit] quarantine scope: ${quarantine.length} eligible, ${held.length} held back`
    + ` (${held.filter(isReconstructed).length} decided from truncated stored content,`
    + ` ${held.filter((r) => !isReconstructed(r)).length} stale-snapshot no_match)`);
  if (!apply) {
    console.log(`[audit] REPORT ONLY — nothing written to ${liveDb}. Re-run with --apply to quarantine ${quarantine.length} row(s).`);
    db.close();
    return { totals: t, reportPath, quarantine: quarantine.length, held: held.length };
  }

  // --apply: rewrite each row in place through the existing evidence writer.
  // Never DELETE — the fetched content is the source of truth and a human may
  // still adjudicate the identity via the proposed entity assertion.
  db.close();
  const { insEvidence, evRow } = await import("../server/store/politicians.js");
  const { db: liveHandle } = await import("../server/store/store.js");
  const readRow = liveHandle.prepare("SELECT data FROM evidence WHERE id = ?");
  const tx = liveHandle.transaction((list) => {
    let n = 0;
    for (const r of list) {
      const cur = readRow.get(r.evidence_id);
      if (!cur) continue;
      const old = JSON.parse(cur.data);
      insEvidence.run(evRow({
        ...old,
        id: r.evidence_id,
        admissible: false,
        quarantined: true,
        quarantine_reason: QUARANTINE_REASON,
        quarantined_at: new Date().toISOString(),
        match_method: r.method,
        match_confidence: r.confidence,
        match_reasons: r.reasons,
        matcher_version: LINKER_VERSION,
      }));
      n++;
    }
    return n;
  });
  const n = tx(quarantine);
  console.log(`[audit] --apply: quarantined ${n} evidence row(s) (admissible:false, content preserved, nothing deleted).`);
  return { totals: t, reportPath, quarantined: n };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => { console.error(String(err?.stack ?? err)); process.exit(1); });
}

export { main };
