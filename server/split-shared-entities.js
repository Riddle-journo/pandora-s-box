// One-time (re-run-safe) repair for the shared-entity collision bug.
//
// THE BUG (now fixed at the source in entities.js ensureEntity): a bare alias
// (name) match was allowed to override a strong id, so a politician whose name
// collided with an already-seen namesake got glued onto the namesake's entity
// instead of getting one of their own. Result: N politicians share ONE person
// entity with a DIFFERENT politician — their identities, and every entity-keyed
// row (assertions, relationships), silently merged.
//
// THE REPAIR: give each colliding politician its own person entity (carrying its
// politician_id + myneta_url strong ids and its name alias), re-point its accepted
// identity assertions onto that entity, and rebuild the tangled member_of_party
// edges so no namesake entity is left showing two parties. Rebuildable-by-design
// data (relationships) is delete-then-rebuild; the raw politician/evidence blobs
// are the untouched source of truth throughout.
//
// Safe by construction: backs the DB up first, runs in ONE transaction, and
// asserts the Phase-1 fix actually mints a FRESH entity for each split (if it ever
// returned the shared entity again, the run aborts and rolls back).
//
//   node server/split-shared-entities.js            # dry run — prints the plan, writes nothing
//   node server/split-shared-entities.js --apply     # back up + apply in a transaction
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, listPoliticians } from "./store.js";
import { ensureEntity, getEntity, resolveEntityIdForPolitician, findEntityByStrongId } from "./entities.js";
import { upsertRelationship } from "./relations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve a politician to its entity exactly like resolveEntityIdForPolitician:
// fast strong-id path, then the accepted-assertion fallback.
const findByStrong = db.prepare(
  "SELECT id FROM entities WHERE kind='person' AND json_extract(strong_ids,'$.politician_id') = ? LIMIT 1"
);
const findAssertion = db.prepare(
  "SELECT entity_id FROM entity_assertions WHERE politician_id = ? AND entity_id IS NOT NULL ORDER BY (status='accepted') DESC, created_at ASC LIMIT 1"
);

// Find every politician whose resolved entity is OWNED (strong_ids.politician_id)
// by a DIFFERENT politician — i.e. currently sharing an entity with a namesake.
function findCollisions() {
  const out = [];
  for (const p of listPoliticians()) {
    const pid = String(p.id);
    const eid = findByStrong.get(pid)?.id ?? findAssertion.get(pid)?.entity_id;
    if (!eid) continue;
    const owner = getEntity(eid)?.strong_ids?.politician_id;
    if (owner != null && String(owner) !== pid) {
      out.push({ pol: p, sharedEid: eid, owner: String(owner) });
    }
  }
  return out;
}

function plan() {
  const collisions = findCollisions();
  const sharedEids = [...new Set(collisions.map((c) => c.sharedEid))];
  const pols = listPoliticians();
  const polById = new Map(pols.map((p) => [String(p.id), p]));
  // Politicians whose party edge must be rebuilt: the split ones AND the namesake
  // owners (whose own edge is on the shared entity we're about to clean).
  const affected = new Map();
  for (const c of collisions) affected.set(String(c.pol.id), c.pol);
  for (const eid of sharedEids) {
    const owner = getEntity(eid)?.strong_ids?.politician_id;
    const op = owner != null ? polById.get(String(owner)) : null;
    if (op) affected.set(String(op.id), op);
  }
  return { collisions, sharedEids, affected: [...affected.values()], totalPoliticians: pols.length };
}

function currentCounts() {
  const c = (s, ...a) => db.prepare(s).get(...a).n;
  return {
    entities: c("SELECT COUNT(*) n FROM entities"),
    personEntities: c("SELECT COUNT(*) n FROM entities WHERE kind='person'"),
    memberOfParty: c("SELECT COUNT(*) n FROM relationships WHERE rel_type='member_of_party'"),
  };
}

function apply({ collisions, sharedEids, affected }) {
  const now = new Date().toISOString();
  const repoint = db.prepare(
    "UPDATE entity_assertions SET entity_id = ? WHERE politician_id = ? AND entity_id = ?"
  );
  const inClause = sharedEids.map(() => "?").join(",");
  const deleteEdges = db.prepare(
    `DELETE FROM relationships WHERE rel_type='member_of_party' AND src_entity_id IN (${inClause})`
  );

  const result = { split: 0, assertionsRepointed: 0, edgesDeleted: 0, edgesRebuilt: 0, dupMyneta: [] };

  const txn = db.transaction(() => {
    // 1 + 2 — mint a fresh entity per colliding politician and re-point its assertions.
    for (const c of collisions) {
      const p = c.pol;
      const strongIds = { politician_id: String(p.id) };
      // Attach myneta_url ONLY if no other entity already claims it. Four roster
      // rows share a myneta_url with a different politician (a source-data dup); for
      // those we anchor the new entity on politician_id alone (always unique) and
      // flag the duplicate for human review rather than minting a duplicate strong id.
      if (p.myneta_url) {
        if (findEntityByStrongId("person", { myneta_url: p.myneta_url })) {
          result.dupMyneta.push({ politician_id: String(p.id), name: p.name, myneta_url: p.myneta_url });
        } else {
          strongIds.myneta_url = p.myneta_url;
        }
      }
      const newEid = ensureEntity({ kind: "person", name: p.name, strongIds, source: "split_shared_entity" });
      // The Phase-1 fix MUST have minted a fresh entity, not returned the shared one.
      if (newEid === c.sharedEid) {
        throw new Error(
          `ensureEntity returned the shared entity ${c.sharedEid} for politician ${p.id} ("${p.name}") — the collision guard is not active; aborting.`
        );
      }
      result.split++;
      result.assertionsRepointed += repoint.run(newEid, String(p.id), c.sharedEid).changes;
    }

    // 3 — rebuild member_of_party for the split politicians AND the namesake owners,
    // so each party edge lands on its rightful owner and no entity shows two parties.
    result.edgesDeleted += deleteEdges.run(...sharedEids).changes;
    for (const p of affected) {
      if (!p.party) continue;
      const pEnt = resolveEntityIdForPolitician(p.id);
      if (!pEnt) continue;
      const partyEnt = ensureEntity({ kind: "party", name: p.party, source: "roster" });
      const r = upsertRelationship({
        src_entity_id: pEnt, dst_entity_id: partyEnt, rel_type: "member_of_party",
        confidence: 0.95, source: "roster", data: {},
      });
      if (r.inserted) result.edgesRebuilt++;
    }
  });
  txn();
  result.at = now;
  return result;
}

// Post-apply audit: no politician may resolve to a foreign-owned entity.
function verify() {
  const collisions = findCollisions();
  return { remainingCollisions: collisions.length, sample: collisions.slice(0, 5).map((c) => ({ pid: c.pol.id, name: c.pol.name })) };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("split-shared-entities.js");
if (invokedDirectly) {
  const doApply = process.argv.includes("--apply");
  const p = plan();
  const before = currentCounts();

  console.log("[split-shared-entities] plan");
  console.log(`  politicians scanned        : ${p.totalPoliticians}`);
  console.log(`  colliding politicians      : ${p.collisions.length}`);
  console.log(`  distinct shared entities   : ${p.sharedEids.length}`);
  console.log(`  party edges to rebuild for : ${p.affected.length} politicians (split + namesake owners)`);
  console.log(`  BEFORE  entities=${before.entities}  person=${before.personEntities}  member_of_party=${before.memberOfParty}`);
  console.log("  examples:");
  for (const c of p.collisions.slice(0, 8)) {
    console.log(`    pol ${c.pol.id} "${c.pol.name}"  →  shared entity ${c.sharedEid} (owned by pol ${c.owner})`);
  }

  if (p.collisions.length === 0) {
    console.log("\n  nothing to repair — 0 collisions. (Already clean / re-run.)");
    process.exit(0);
  }

  if (!doApply) {
    console.log("\n  DRY RUN — no changes written. Re-run with --apply to back up and apply.");
    process.exit(0);
  }

  // Back up first (SQLite online backup — WAL-safe, consistent snapshot).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dbFile = process.env.PANDOROS_DB_PATH || path.join(__dirname, "..", "data", "pandoros.db");
  const backup = `${dbFile}.bak-${stamp}`;
  console.log(`\n  backing up → ${backup}`);
  await db.backup(backup);
  console.log("  backup complete.");

  const res = apply(p);
  const after = currentCounts();
  const v = verify();

  console.log("\n[split-shared-entities] applied");
  console.log(`  entities split (new)       : ${res.split}`);
  console.log(`  assertions re-pointed      : ${res.assertionsRepointed}`);
  console.log(`  member_of_party deleted    : ${res.edgesDeleted}`);
  console.log(`  member_of_party rebuilt    : ${res.edgesRebuilt}`);
  console.log(`  AFTER   entities=${after.entities}  person=${after.personEntities}  member_of_party=${after.memberOfParty}`);
  console.log(`  entity delta               : +${after.entities - before.entities} (expected +${p.collisions.length})`);
  console.log(`  remaining collisions       : ${v.remainingCollisions} (expected 0)`);

  if (res.dupMyneta.length) {
    console.log(`\n  ⚠ ${res.dupMyneta.length} politician row(s) share a myneta_url with a DIFFERENT politician (source-roster`);
    console.log("    duplicate). Each was given its own entity (anchored on politician_id); the shared");
    console.log("    myneta_url was NOT copied. These need a human to decide same-person vs data error:");
    for (const d of res.dupMyneta) console.log(`      "${d.name}" [${d.politician_id}]  ${d.myneta_url}`);
  }

  const ok = v.remainingCollisions === 0 && (after.entities - before.entities) === p.collisions.length;
  if (!ok) {
    console.error("\n  ⚠ VERIFICATION FAILED — restore from the backup above.");
    process.exit(1);
  }
  console.log("\n  ✓ verified: every politician now owns its entity; no shared-with-a-different-politician records remain.");
  process.exit(0);
}

export { findCollisions, plan, apply, verify };
