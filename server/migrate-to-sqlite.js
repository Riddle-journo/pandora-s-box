// One-time migration: copy data/db.json into the SQLite store (data/pandoros.db).
// Safe to re-run with --force (wipes the SQLite tables first). The old db.json
// is left untouched as a backup.
//
//   node server/migrate-to-sqlite.js          # migrate (refuses if DB non-empty)
//   node server/migrate-to-sqlite.js --force  # wipe SQLite + re-migrate
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { migrateFromJson, counts } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(__dirname, "..", "data", "db.json");
const force = process.argv.includes("--force");

if (!fs.existsSync(jsonPath)) {
  console.error(`No db.json found at ${jsonPath} — nothing to migrate.`);
  process.exit(1);
}

console.log(`Migrating ${jsonPath} → SQLite${force ? " (force: wiping first)" : ""}…`);
try {
  const c = migrateFromJson(jsonPath, { force });
  console.log("Migrated from JSON:", c);
  console.log("SQLite now holds:  ", counts());
  console.log("\n✓ Done. db.json is untouched (kept as backup). The app now reads/writes SQLite.");
} catch (err) {
  console.error("✗", err.message);
  process.exit(1);
}
