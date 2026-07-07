// One-time (re-run-safe) backfill: seed the entity layer from the politicians
// already in the store. Creates one person entity per politician (strong ids
// politician_id + myneta_url, plus any name variants found on the row as
// aliases), and one party entity per distinct party name. Also records an
// auto-accepted strong_id assertion per politician so the binding is auditable.
//
//   node server/backfill-entities.js
import "dotenv/config";
import { listPoliticians } from "./store.js";
import { ensureEntity, recordAssertion, normName } from "./entities.js";

// Fields on a politician row that may carry an alternate spelling of the name.
const ALIAS_FIELDS = ["name", "full_name", "fullName", "display_name", "displayName", "aka", "alias"];

function collectAliases(p) {
  const out = new Set();
  for (const f of ALIAS_FIELDS) {
    const v = p[f];
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  }
  if (Array.isArray(p.aliases)) for (const v of p.aliases) if (typeof v === "string" && v.trim()) out.add(v.trim());
  return [...out];
}

export function backfill() {
  const pols = listPoliticians();
  let persons = 0, aliasVariants = 0, assertions = 0;
  const partyKeys = new Set();
  let parties = 0;

  for (const p of pols) {
    const strongIds = { politician_id: p.id };
    if (p.myneta_url) strongIds.myneta_url = p.myneta_url;

    const eid = ensureEntity({ kind: "person", name: p.name, strongIds, source: "backfill" });
    persons++;

    // Add every distinct name variant as an alias (ensureEntity re-resolves by
    // the politician_id strong id, then upserts the alias).
    for (const alias of collectAliases(p)) {
      if (!alias || alias === p.name) continue;
      ensureEntity({ kind: "person", name: alias, strongIds: { politician_id: p.id }, source: "backfill" });
      aliasVariants++;
    }

    // Auditable, auto-accepted binding of the politician's own name → entity.
    const rec = recordAssertion({
      subject_kind: "person", raw_name: p.name, source: "backfill_politician",
      source_ref: p.id, politician_id: p.id, confidence: 1, method: "strong_id",
      evidence_url: p.myneta_url ?? null,
    });
    if (rec.inserted) assertions++;

    // Party entity (one per distinct normalized party name).
    if (p.party) {
      const k = normName(p.party);
      if (k && !partyKeys.has(k)) {
        partyKeys.add(k);
        ensureEntity({ kind: "party", name: p.party, strongIds: {}, source: "backfill" });
        parties++;
      }
    }
  }

  return { politicians: pols.length, persons, parties, aliasVariants, assertions };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("backfill-entities.js");
if (invokedDirectly) {
  const c = backfill();
  console.log("[backfill-entities] done:");
  console.log(`  politicians processed : ${c.politicians}`);
  console.log(`  person entities       : ${c.persons}`);
  console.log(`  party entities (distinct): ${c.parties}`);
  console.log(`  alias variants added  : ${c.aliasVariants}`);
  console.log(`  assertions recorded   : ${c.assertions}`);
  process.exit(0);
}
