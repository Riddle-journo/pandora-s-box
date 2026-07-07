// Source-health CLI. Reads the fetch_runs ledger (written by ingestFor) and
// prints a per-source table plus ROTTED / STALE sections, so a human — or a
// gating script — can see at a glance which scrapers have quietly stopped
// working. Read-only against the DB; never touches the network or the LLM.
//
// Usage:  node server/health.js [--days 14]
// Exit code 1 if any source is ROTTED (so automation can gate on it).
import { sourceHealth } from "./store.js";

// Pure classifier — extracted from the CLI so it is unit-testable without any
// I/O. `health` is sourceHealth()'s output; `knownSources` is the full fetcher
// roster (for detecting STALE sources that produced zero runs in the window).
//   ROTTED = ran at least once but is failing: success rate < 50% OR zero items.
//   STALE  = a known source with no runs at all in the window.
export function classifyHealth(health = [], knownSources = []) {
  const ran = new Set(health.map((h) => h.source));
  const rotted = health.filter((h) => h.runs > 0 && (h.ok_rate < 0.5 || h.total_items === 0));
  const stale = knownSources.filter((s) => !ran.has(s));
  return { rows: health, rotted, stale };
}

function humanizeAge(at) {
  if (!at) return "never";
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const padR = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };
const trunc = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

async function main() {
  const args = process.argv.slice(2);
  const di = args.indexOf("--days");
  const days = di >= 0 ? Number(args[di + 1]) || 14 : 14;

  const health = sourceHealth(days);
  let knownSources = [];
  try { ({ FETCHER_NAMES: knownSources } = await import("./ingest.js")); } catch { /* roster unavailable → no STALE */ }

  const { rows, rotted, stale } = classifyHealth(health, knownSources);

  console.log(`\nSource health — last ${days} day(s)  (${rows.length} source(s) with runs)\n`);
  if (rows.length) {
    console.log(
      padR("SOURCE", 22) + padL("RUNS", 6) + padL("OK%", 7) + padL("ITEMS", 8) +
      "  " + padR("LAST OK", 8) + "  LAST ERROR");
    console.log("─".repeat(90));
    for (const r of rows) {
      console.log(
        padR(r.source, 22) +
        padL(r.runs, 6) +
        padL(`${Math.round(r.ok_rate * 100)}%`, 7) +
        padL(r.total_items, 8) + "  " +
        padR(humanizeAge(r.last_success_at), 8) + "  " +
        trunc(r.last_error ?? "", 60));
    }
  } else {
    console.log("  (no fetch_runs recorded in this window)");
  }

  console.log(`\nROTTED (runs>0, success <50% or zero items): ${rotted.length}`);
  for (const r of rotted) {
    console.log(`  ✗ ${padR(r.source, 22)} ${Math.round(r.ok_rate * 100)}% ok, ${r.total_items} items — ${trunc(r.last_error ?? "no error logged", 60)}`);
  }

  console.log(`\nSTALE (known source, zero runs in window): ${stale.length}`);
  for (const s of stale) console.log(`  · ${s}`);

  console.log("");
  process.exit(rotted.length ? 1 : 0);
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("health.js");
if (invokedDirectly) main();
