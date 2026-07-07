// Review CLI for proposed entity assertions (the gray-zone identity matches that
// weren't auto-accepted). argv-only, no interactive prompts — safe for scripts.
//
//   node server/entities-review.js --list [--source mca_directors]
//   node server/entities-review.js --accept <assertionId> [--entity <entityId>]
//   node server/entities-review.js --reject <assertionId>
import "dotenv/config";
import { listProposed, decideAssertion } from "./entities.js";
import { getPolitician } from "./store.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : undefined; };

const pad = (s, n) => { s = String(s ?? ""); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); };

function list() {
  const source = flag("--source");
  const rows = listProposed({ source: typeof source === "string" ? source : undefined, limit: 200 });
  console.log(`\n${rows.length} proposed assertion(s)${typeof source === "string" ? ` from ${source}` : ""}:\n`);
  if (!rows.length) { console.log("  (none)\n"); return; }
  console.log(pad("ID", 38) + pad("RAW NAME", 28) + pad("SOURCE", 16) + pad("CONF", 6) + "POLITICIAN");
  console.log("─".repeat(110));
  for (const r of rows) {
    const pol = r.politician_id ? getPolitician(r.politician_id) : null;
    console.log(
      pad(r.id, 38) + pad(r.raw_name, 28) + pad(r.source, 16) +
      pad(r.confidence.toFixed(2), 6) + (pol?.name ?? r.politician_id ?? "?"));
  }
  console.log("");
}

function main() {
  if (args.includes("--list") || args.length === 0) return list();

  const acc = flag("--accept");
  if (typeof acc === "string") {
    const r = decideAssertion(acc, "accepted", flag("--entity") || null);
    console.log(r ? `Accepted ${acc} → entity ${r.entity_id}` : `No such assertion: ${acc}`);
    return;
  }
  const rej = flag("--reject");
  if (typeof rej === "string") {
    const r = decideAssertion(rej, "rejected");
    console.log(r ? `Rejected ${rej}` : `No such assertion: ${rej}`);
    return;
  }
  console.log("Usage: --list [--source X] | --accept <id> [--entity <id>] | --reject <id>");
}

main();
