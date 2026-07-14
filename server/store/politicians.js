// Politicians + evidence + reports/cards domain, extracted from store.js.
// Owns the CRUD/list/get for politicians, their evidence rows, and the report
// and Summarizer-card records. Re-exported through the store.js facade (store.js
// may import from store/*, never the reverse). DDL for these tables lives in
// ./db.js and runs at its import time, before any db.prepare() below.
import { db } from "./db.js";
import { id, J, lc } from "./shared.js";

// ---- Politicians ----
export function listPoliticians() {
  return db.prepare("SELECT data FROM politicians").all().map(J);
}

export function getPolitician(pid) {
  return J(db.prepare("SELECT data FROM politicians WHERE id = ?").get(pid));
}

// Politicians + their latest report (any tier), in a single pass. Uses the
// promoted report columns so we never parse a report blob just for the listing.
export function listPoliticiansWithLatest() {
  const pols = db.prepare("SELECT data FROM politicians").all().map(J);
  const latest = db.prepare(`
    SELECT r.politician_id, r.overall_grade, r.overall_score, r.headline, r.report_tier, r.generated_at, r.update_mode
    FROM reports r
    JOIN (SELECT politician_id, MAX(generated_at) mg FROM reports GROUP BY politician_id) m
      ON r.politician_id = m.politician_id AND r.generated_at = m.mg
  `).all();
  const byPol = {};
  for (const r of latest) byPol[r.politician_id] = r;
  return pols.map((p) => {
    const r = byPol[p.id];
    return {
      ...p,
      latest: r ? { grade: r.overall_grade, score: r.overall_score, headline: r.headline, report_tier: r.report_tier, generated_at: r.generated_at, update_mode: r.update_mode } : null,
    };
  });
}

export const insPolitician = db.prepare(`INSERT OR REPLACE INTO politicians
  (id, name, name_lc, constituency_lc, office, state_lc, is_demo, created_at, data)
  VALUES (@id, @name, @name_lc, @constituency_lc, @office, @state_lc, @is_demo, @created_at, @data)`);

export function polRow(p) {
  return {
    id: p.id, name: p.name ?? "", name_lc: lc(p.name), constituency_lc: lc(p.constituency),
    office: p.office ?? null, state_lc: lc(p.state), is_demo: p.is_demo ? 1 : 0,
    created_at: p.created_at ?? new Date().toISOString(), data: JSON.stringify(p),
  };
}

export function upsertPolitician(p) {
  const existing = p.id ? getPolitician(p.id) : null;
  const row = { ...(existing ?? {}), ...p };
  if (!row.id) row.id = id();
  if (!row.created_at) row.created_at = new Date().toISOString();
  insPolitician.run(polRow(row));
  return row;
}

// Bulk insert. Dedupes on (name, constituency) like the old store. One txn.
export function batchUpsertPoliticians(politicians) {
  const existing = new Set(
    db.prepare("SELECT name_lc, constituency_lc FROM politicians").all().map((r) => `${r.name_lc}|${r.constituency_lc}`)
  );
  const added = [];
  const tx = db.transaction((rows) => {
    for (const p of rows) {
      const key = `${lc(p.name)}|${lc(p.constituency)}`;
      if (existing.has(key)) continue;
      const row = { id: id(), created_at: new Date().toISOString(), ...p };
      insPolitician.run(polRow(row));
      existing.add(key);
      added.push(row);
    }
  });
  tx(politicians);
  return added;
}

// ---- Evidence ----
export function listEvidence(pid) {
  return db.prepare("SELECT data FROM evidence WHERE politician_id = ? ORDER BY date DESC").all(pid).map(J);
}

export const insEvidence = db.prepare(`INSERT OR REPLACE INTO evidence
  (id, politician_id, url, date, has_content, fetched_at, data)
  VALUES (@id, @politician_id, @url, @date, @has_content, @fetched_at, @data)`);

export function evRow(e) {
  return {
    id: e.id, politician_id: e.politician_id ?? null, url: e.url ?? null, date: e.date ?? "",
    has_content: e.content ? 1 : 0, fetched_at: e.fetched_at ?? new Date().toISOString(), data: JSON.stringify(e),
  };
}

export function addEvidence(items) {
  const added = [];
  const findByUrl = db.prepare("SELECT id, has_content, data FROM evidence WHERE politician_id = ? AND url = ? LIMIT 1");
  const tx = db.transaction((rows) => {
    for (const item of rows) {
      if (item.url) {
        const ex = findByUrl.get(item.politician_id, item.url);
        if (ex) {
          // Upgrade in place when the fresh fetch brings something the stored
          // row lacks: real content over a bare pointer, or the structured
          // `numbers` object (added 2026-07 for the computed-flags layer —
          // without this, evidence ingested before that change would never
          // gain numbers and the deterministic analyzer would stay blind).
          const old = JSON.parse(ex.data);
          const contentUpgrade = item.content && !ex.has_content;
          // Fresh numbers win when: the old row has none, the fresh fetch
          // filled in MORE data (an extraction fix now parses what used to be
          // null), or the values CHANGED (time-series sources like MPLADS move
          // monthly — freezing the first snapshot would rot the computed
          // flags). But NEVER downgrade: a partially-failed fetch (e.g. a
          // relatives list that came back empty because a lookup errored) must
          // not replace richer stored data. Richness counts array lengths, not
          // just key presence.
          const richness = (o) => Object.values(o ?? {}).reduce((s, v) =>
            s + (Array.isArray(v) ? v.length : v != null ? 1 : 0), 0);
          const numbersUpgrade = item.numbers && (
            richness(item.numbers) > richness(old.numbers) ||
            (old.numbers && richness(item.numbers) >= richness(old.numbers)
              && JSON.stringify(item.numbers) !== JSON.stringify(old.numbers))
          );
          if (contentUpgrade || numbersUpgrade) {
            // Stamp a fresh fetched_at: the row genuinely changed, and the
            // incremental report mode selects on fetched_at > last report —
            // keeping the old timestamp would hide the upgrade from it.
            const merged = { ...old, ...item, id: ex.id, fetched_at: new Date().toISOString() };
            insEvidence.run(evRow(merged));
            added.push(merged);
          }
          continue;
        }
      }
      const row = { id: id(), fetched_at: new Date().toISOString(), ...item };
      insEvidence.run(evRow(row));
      added.push(row);
    }
  });
  tx(items);
  return added;
}

// ---- Reports ----
export const insReport = db.prepare(`INSERT OR REPLACE INTO reports
  (id, politician_id, generated_at, report_tier, overall_grade, overall_score, headline, update_mode, data)
  VALUES (@id, @politician_id, @generated_at, @report_tier, @overall_grade, @overall_score, @headline, @update_mode, @data)`);

export function repRow(r) {
  return {
    id: r.id, politician_id: r.politician_id, generated_at: r.generated_at,
    report_tier: r.report_tier ?? 2, overall_grade: r.overall_grade ?? null,
    overall_score: typeof r.overall_score === "number" ? r.overall_score : null,
    headline: r.headline ?? null, update_mode: r.update_mode ?? null, data: JSON.stringify(r),
  };
}

// One report per politician (the T1/T2 split was removed). Returns the latest.
export function latestReport(pid) {
  return J(db.prepare("SELECT data FROM reports WHERE politician_id = ? ORDER BY generated_at DESC LIMIT 1").get(pid));
}

export function reportHistory(pid) {
  return db.prepare("SELECT data FROM reports WHERE politician_id = ? ORDER BY generated_at DESC").all(pid).map(J);
}

export function addReport(report) {
  const row = { id: id(), generated_at: new Date().toISOString(), ...report };
  insReport.run(repRow(row));
  return row;
}

// ---- Summarizer report cards (Branch 1) ----
const insCard = db.prepare(`INSERT OR REPLACE INTO cards
  (id, kind, subject_key, scope, card_version, generated_at, score, grade, data)
  VALUES (@id, @kind, @subject_key, @scope, @card_version, @generated_at, @score, @grade, @data)`);

export function addCard(card) {
  const row = { id: id(), generated_at: new Date().toISOString(), ...card };
  insCard.run({
    id: row.id, kind: row.kind, subject_key: row.subject_key,
    scope: row.scope ?? "union", card_version: row.card_version ?? null,
    generated_at: row.generated_at,
    score: typeof row.score === "number" ? row.score : null,
    grade: row.grade ?? null, data: JSON.stringify(row),
  });
  return row;
}

export function latestCard(kind, subjectKey, scope = null) {
  const sql = scope
    ? "SELECT data FROM cards WHERE kind = ? AND subject_key = ? AND scope = ? ORDER BY generated_at DESC LIMIT 1"
    : "SELECT data FROM cards WHERE kind = ? AND subject_key = ? ORDER BY generated_at DESC LIMIT 1";
  const args = scope ? [kind, subjectKey, scope] : [kind, subjectKey];
  return J(db.prepare(sql).get(...args));
}

// Like listPoliticiansWithLatest, but joined against cards instead of reports.
export function listPoliticiansWithCard() {
  const pols = db.prepare("SELECT data FROM politicians").all().map(J);
  const latest = db.prepare(`
    SELECT c.subject_key, c.grade, c.score, c.generated_at,
           json_extract(c.data, '$.headline') headline
    FROM cards c
    JOIN (SELECT subject_key, MAX(generated_at) mg FROM cards WHERE kind = 'politician' GROUP BY subject_key) m
      ON c.subject_key = m.subject_key AND c.generated_at = m.mg
    WHERE c.kind = 'politician'
  `).all();
  const byPol = {};
  for (const r of latest) byPol[r.subject_key] = r;
  return pols.map((p) => {
    const r = byPol[p.id];
    return { ...p, card: r ? { grade: r.grade, score: r.score, headline: r.headline, generated_at: r.generated_at } : null };
  });
}

// One indexed row per latest politician card with the leaderboard-relevant
// computed facts pulled out via json_extract — avoids parsing 4,000+ blobs.
export function cardLeaderboardRows() {
  return db.prepare(`
    SELECT c.subject_key id, c.grade, c.score,
      json_extract(c.data,'$.computed_facts.criminal_cases')      cases,
      json_extract(c.data,'$.computed_facts.net_worth')           net_worth_num,
      json_extract(c.data,'$.computed_facts.net_worth_display')   net_worth,
      json_extract(c.data,'$.computed_facts.asset_growth_multiple') asset_growth_x
    FROM cards c
    JOIN (SELECT subject_key, MAX(generated_at) mg FROM cards WHERE kind = 'politician' GROUP BY subject_key) m
      ON c.subject_key = m.subject_key AND c.generated_at = m.mg
    WHERE c.kind = 'politician'
  `).all();
}

// ---- Maintenance / reset helpers ----
export function deleteAllReports() {
  return db.prepare("DELETE FROM reports").run().changes;
}

// Wipe ALL ingested evidence (for a clean re-ingest). Politicians untouched.
export function deleteAllEvidence() {
  return db.prepare("DELETE FROM evidence").run().changes;
}

// Find a politician by exact id, else by case-insensitive name match (for
// friendly test runs like `report-generator.js "Narendra Modi"`).
export function findPolitician(idOrName) {
  const byId = getPolitician(idOrName);
  if (byId) return byId;
  const q = lc(idOrName);
  const row = db.prepare("SELECT data FROM politicians WHERE name_lc = ? AND is_demo = 0 LIMIT 1").get(q)
    || db.prepare("SELECT data FROM politicians WHERE name_lc LIKE ? AND is_demo = 0 LIMIT 1").get(`%${q}%`);
  return J(row);
}

export function removeDemoPoliticians() {
  const demo = db.prepare("SELECT id FROM politicians WHERE is_demo = 1").all().map((r) => r.id);
  if (!demo.length) return { politicians: 0, reports: 0, evidence: 0 };
  const tx = db.transaction(() => {
    let reports = 0, evidence = 0;
    for (const pid of demo) {
      reports += db.prepare("DELETE FROM reports WHERE politician_id = ?").run(pid).changes;
      evidence += db.prepare("DELETE FROM evidence WHERE politician_id = ?").run(pid).changes;
    }
    const pols = db.prepare("DELETE FROM politicians WHERE is_demo = 1").run().changes;
    return { politicians: pols, reports, evidence };
  });
  return tx();
}

// Per-source_type evidence coverage: how many rows, how many carry real content,
// and the freshest fetch. source_type lives in the JSON blob (not a hot column).
export function evidenceCoverage() {
  return db.prepare(`
    SELECT json_extract(data, '$.source_type') AS source_type,
           COUNT(*)          AS rows,
           SUM(has_content)  AS with_content,
           MAX(fetched_at)   AS last_fetched
    FROM evidence GROUP BY source_type ORDER BY rows DESC`).all()
    .map((r) => ({
      source_type: r.source_type ?? "(unknown)",
      rows: r.rows,
      with_content: r.with_content ?? 0,
      last_fetched: r.last_fetched ?? null,
    }));
}

// Real (non-demo) reps with zero evidence rows / with no report at all — the two
// coverage gaps the owner most needs to see. Also returns the non-demo total.
export function politiciansMissing() {
  const total = db.prepare("SELECT COUNT(*) c FROM politicians WHERE is_demo = 0").get().c;
  const noEvidence = db.prepare(
    "SELECT COUNT(*) c FROM politicians p WHERE p.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.politician_id = p.id)").get().c;
  const noReport = db.prepare(
    "SELECT COUNT(*) c FROM politicians p WHERE p.is_demo = 0 AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.politician_id = p.id)").get().c;
  return { total, noEvidence, noReport };
}

// Map of politician_id → evidence-row count (one query), for the roster grid's
// per-rep evidence column and the has-evidence filter.
export function evidenceCounts() {
  const m = {};
  for (const r of db.prepare("SELECT politician_id AS pid, COUNT(*) AS n FROM evidence GROUP BY politician_id").all()) {
    m[r.pid] = r.n;
  }
  return m;
}
