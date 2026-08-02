// Summarizer CLI (Branch 1) — build public report cards. No detectors, no
// paid LLM. Optional FREE-chain prose; cards always complete without it.
//
//   node server/summarize.js --id <politician-id>       one rep
//   node server/summarize.js --all                      every real rep
//   node server/summarize.js --all --office MP          filter by office
//   node server/summarize.js --all --state Bihar        filter by state
//   node server/summarize.js --all --limit 20           first N (testing)
//   ... --no-prose                                      skip the free-chain pass
//   ... --no-ingest                                     card from existing evidence only
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { listPoliticians, getPolitician } from "./store.js";
import { ingestFor } from "./ingest.js";
import { generateCard, CARD_VERSION } from "./cards.js";

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return flags;
}

export async function summarizeOne(pid, { prose = true, ingest = true } = {}) {
  const p = getPolitician(pid);
  if (!p) throw new Error(`no politician ${pid}`);
  if (ingest) {
    try { await ingestFor(p); }
    catch (err) { console.warn(`[summarize] ingest failed for ${p.name} (${err.message}) — carding existing evidence`); }
  }
  const card = await generateCard("politician", pid, { prose });
  console.log(`[summarize] ${p.name} → grade ${card.grade} (${card.score >= 0 ? card.score : "—"}) · ${card.sections.length} sections · prose: ${card.prose_model ?? "template"}`);
  return card;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const prose = !flags["no-prose"];
  const ingest = !flags["no-ingest"];
  const t0 = Date.now();

  if (flags.id) {
    await summarizeOne(String(flags.id), { prose, ingest });
  } else if (flags.all) {
    let reps = listPoliticians().filter((p) => !p.is_demo);
    if (flags.office) reps = reps.filter((p) => (p.office ?? "").toLowerCase() === String(flags.office).toLowerCase());
    if (flags.state) reps = reps.filter((p) => (p.state ?? "").toLowerCase() === String(flags.state).toLowerCase());
    if (flags.limit) reps = reps.slice(0, Number(flags.limit));
    console.log(`[summarize] carding ${reps.length} reps (card v${CARD_VERSION}, prose ${prose ? "on" : "off"}, ingest ${ingest ? "on" : "off"})`);
    let done = 0, failed = 0;
    for (const p of reps) {
      try { await summarizeOne(p.id, { prose, ingest }); done++; }
      catch (err) { console.error(`[summarize] FAILED ${p.name}: ${err.message}`); failed++; }
    }
    console.log(`[summarize] done: ${done} carded, ${failed} failed`);
  } else {
    console.log("Usage: node server/summarize.js --id <id> | --all [--office MP|RS|MLA] [--state X] [--limit N] [--no-prose] [--no-ingest]");
    process.exitCode = 1;
  }
  console.log(`[summarize] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
