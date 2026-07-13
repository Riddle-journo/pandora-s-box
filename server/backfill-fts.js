// Rebuilds the evidence_fts full-text index from the evidence table.
//
// Evidence prose (title/summary/content) lives inside each row's `data` blob,
// which the query engine can't search without cracking open all 36k blobs. This
// copies that prose into the FTS5 index once, so co-occurrence queries ("every
// doc mentioning both X and Y") become an indexed MATCH instead of a full scan.
//
// Idempotent: it clears and repopulates, so re-running always yields a clean
// index. Run:  node server/backfill-fts.js
import { db } from "./store.js";

db.pragma("busy_timeout = 5000"); // tolerate a running app/ops console briefly

const rows = db.prepare("SELECT id, politician_id, data FROM evidence").all();

const ins = db.prepare(`INSERT INTO evidence_fts
  (evidence_id, politician_id, source_type, title, summary, body)
  VALUES (@evidence_id, @politician_id, @source_type, @title, @summary, @body)`);

const rebuild = db.transaction((rows) => {
  db.exec("DELETE FROM evidence_fts");
  let n = 0;
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch { d = {}; }
    ins.run({
      evidence_id: r.id,
      politician_id: r.politician_id ?? null,
      source_type: d.source_type ?? null,
      title: d.title ?? "",
      summary: d.summary ?? "",
      body: d.content ?? "",
    });
    n++;
  }
  return n;
});

const t0 = Date.now();
const n = rebuild(rows);
console.log(`evidence_fts rebuilt: ${n} rows indexed in ${Date.now() - t0}ms`);
