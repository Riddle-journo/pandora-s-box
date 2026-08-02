// Backfill: canonical government-org entities (Phase B of the org-entity plan).
//
//   node scripts/backfill-org-entities.js            # dry-run (default): report only
//   node scripts/backfill-org-entities.js --apply    # write changes
//
// Steps:
//   1. syncOrgEntities()      — mint/refresh every catalogue org + aliases.
//   2. Remap relationships    — dst entities that are name-keyed kind='org'
//      orphans (no org_key strong id) whose canonical_name resolves in the
//      catalogue get their relationships repointed at the canonical entity;
//      aliases move over; the orphan is deleted if nothing references it.
//   3. Scandal → org events   — one idempotent `governance_failure` event per
//      (scandal, resolved org), so org pages get ledger-native scandal links.
//   4. same_as links          — PSUs that also exist as `company` entities (from
//      the registry/directorship sources, often holding a CIN) are LINKED, not
//      merged: merging would strip identity keys other code relies on. The org
//      also learns the company's spelling as an alias, so lookups converge.
import { db } from "../server/store/store.js";
import { listScandals } from "../server/store/store.js";
import { syncOrgEntities, findEntityByStrongId, ensureOrgEntity } from "../server/entities/entities.js";
import { resolveOrg, resolveOrgExact } from "../server/data/orgs.js";
import { upsertEvent, upsertRelationship } from "../server/entities/relations.js";

const APPLY = process.argv.includes("--apply");
const log = (...a) => console.log(...a);

log(APPLY ? "APPLY mode — writing changes." : "DRY-RUN — no writes. Pass --apply to execute.");

// ── 1. Catalogue sync ────────────────────────────────────────────────────────
if (APPLY) {
  const r = syncOrgEntities();
  log(`[sync] org entities ensured: ${r.synced}/${r.total}`);
} else {
  log("[sync] would ensure all catalogue org entities (idempotent)");
}

// ── 2. Remap name-keyed org orphans ─────────────────────────────────────────
const orphans = db.prepare(
  "SELECT id, canonical_name, strong_ids FROM entities WHERE kind = 'org' AND json_extract(strong_ids, '$.org_key') IS NULL"
).all();

let remapped = 0, unresolved = 0, deleted = 0, kept = 0;
const refCount = (eid) =>
  db.prepare("SELECT count(*) c FROM relationships WHERE src_entity_id = ? OR dst_entity_id = ?").get(eid, eid).c +
  db.prepare("SELECT count(*) c FROM facts WHERE entity_id = ?").get(eid).c +
  db.prepare("SELECT count(*) c FROM claims WHERE subject_entity_id = ? OR object_entity_id = ?").get(eid, eid).c +
  db.prepare("SELECT count(*) c FROM events WHERE entity_ids LIKE ?").get(`%"${eid}"%`).c;

const remapTx = db.transaction((orphan, canonicalId) => {
  // Repoint relationships; the unique index may collide with an existing row —
  // insert-or-ignore semantics via individual UPDATE with conflict fallback.
  const rels = db.prepare("SELECT id FROM relationships WHERE dst_entity_id = ?").all(orphan.id);
  for (const r of rels) {
    try {
      db.prepare("UPDATE relationships SET dst_entity_id = ? WHERE id = ?").run(canonicalId, r.id);
    } catch {
      db.prepare("DELETE FROM relationships WHERE id = ?").run(r.id); // duplicate of an existing canonical edge
    }
  }
  db.prepare("UPDATE relationships SET src_entity_id = ? WHERE src_entity_id = ?").run(canonicalId, orphan.id);
  // Move aliases (INSERT OR IGNORE handles duplicates), then drop the orphan if unreferenced.
  const aliases = db.prepare("SELECT alias, alias_lc, source FROM entity_aliases WHERE entity_id = ?").all(orphan.id);
  for (const a of aliases)
    db.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_lc, source) VALUES (?,?,?,?)")
      .run(canonicalId, a.alias, a.alias_lc, a.source);
  db.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(orphan.id);
  if (refCount(orphan.id) === 0) {
    db.prepare("DELETE FROM entities WHERE id = ?").run(orphan.id);
    return true;
  }
  return false;
});

// A bare state name ("Punjab") is not an organization — never remap it onto a
// state department that merely carries that state token.
const BARE_STATES = new Set([
  "punjab", "kerala", "karnataka", "gujarat", "bihar", "assam", "delhi", "odisha",
  "manipur", "jharkhand", "chhattisgarh", "rajasthan", "goa", "haryana", "tamil nadu",
  "uttar pradesh", "madhya pradesh", "west bengal", "maharashtra", "himachal pradesh",
  "jammu and kashmir", "uttarakhand", "telangana", "andhra pradesh",
]);
const normLc = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

for (const o of orphans) {
  if (BARE_STATES.has(normLc(o.canonical_name))) { unresolved++; continue; }
  const org = resolveOrg(o.canonical_name) ?? resolveOrgExact(o.canonical_name);
  if (!org) { unresolved++; continue; }
  if (!APPLY) { remapped++; log(`[remap] "${o.canonical_name}" -> ${org.key}`); continue; }
  // In apply mode the sync above has minted the canonical entity.
  const canonical = findEntityByStrongId("org", { org_key: org.key });
  if (!canonical || canonical.id === o.id) { unresolved++; continue; }
  const gone = remapTx(o, canonical.id);
  remapped++; if (gone) deleted++; else kept++;
}
log(`[remap] orphan org entities: ${orphans.length} total, ${remapped} resolvable, ${unresolved} left name-keyed` +
    (APPLY ? `, ${deleted} deleted, ${kept} kept (still referenced)` : ""));

// ── 3. Scandal → org events ─────────────────────────────────────────────────
let events = 0, noOrg = 0;
for (const s of listScandals()) {
  const org = resolveOrg(s.ministry ?? "", { kinds: ["ministry", "department"] });
  if (!org) { noOrg++; continue; }
  if (!APPLY) { events++; continue; }
  const canonical = findEntityByStrongId("org", { org_key: org.key });
  if (!canonical) { noOrg++; continue; }
  const r = upsertEvent({
    kind: "governance_failure", at: s.date ?? null, entity_ids: [canonical.id],
    source: "scandal_backfill",
    data: { slug: s.slug, title: s.title, verdict: s.accountability?.verdict ?? s.verdict ?? null, signal: s.signal ?? null },
  });
  if (r.inserted) events++;
}
log(`[events] scandal->org governance_failure events ${APPLY ? "inserted" : "would insert"}: ${events}; scandals without a resolvable ministry: ${noOrg}`);

// ── 4. Link (never merge) org ↔ company duplicates ──────────────────────────
// A PSU is both a government body and a registered company; the registry
// sources mint it as kind='company', often WITH a CIN. Merging would destroy
// that identity key, so the two entities are linked and cross-aliased instead.
let linked = 0;
const dupes = db.prepare(
  "SELECT id, kind, canonical_name FROM entities WHERE kind <> 'org' AND json_extract(strong_ids, '$.org_key') IS NULL"
).all();
for (const e of dupes) {
  const org = resolveOrgExact(e.canonical_name);
  if (!org) continue;
  if (!APPLY) { linked++; log(`[same_as] ${e.kind} "${e.canonical_name}" ↔ ${org.key}`); continue; }
  const orgId = ensureOrgEntity(org.key);
  if (!orgId || orgId === e.id) continue;
  const r = upsertRelationship({
    src_entity_id: orgId, dst_entity_id: e.id, rel_type: "same_as",
    confidence: 0.9, source: "org_catalogue",
    data: { note: "same real-world body: catalogue org and registry company record", matched_on: "exact_name" },
  });
  db.prepare("INSERT OR IGNORE INTO entity_aliases (entity_id, alias, alias_lc, source) VALUES (?,?,?,?)")
    .run(orgId, e.canonical_name, String(e.canonical_name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().toLowerCase(), "org_catalogue");
  if (r.inserted) linked++;
}
log(`[same_as] org↔company duplicate links ${APPLY ? "created" : "would create"}: ${linked}`);
log("Done.");
