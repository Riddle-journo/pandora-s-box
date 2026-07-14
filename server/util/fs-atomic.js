// Atomic-enough file writes for the L1/mega cache layer. A plain
// writeFileSync interrupted mid-write (crash, second process, Ctrl-C) leaves a
// truncated JSON file that poisons every later read; write-temp-then-rename
// can't: rename on the same volume replaces the target in one step (Windows
// included — Node maps it to MOVEFILE_REPLACE_EXISTING).
import fs from "node:fs";

let counter = 0;

/**
 * @param {string} file absolute or relative target path
 * @param {string | NodeJS.ArrayBufferView} data
 */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${++counter}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}
