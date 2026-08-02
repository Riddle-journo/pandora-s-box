// DB-backed tunables for the Anomaly Engine. Every detector declares its knobs
// (thresholds, weights, on/off) with metadata; the values live in the
// engine_settings table so the ops console can edit them live — no restarts, no
// file edits. Absent key = code default, so a fresh DB behaves exactly like the
// hard-coded constants did.
//
// Key convention: 'engine.<detectorId>.<param>' (e.g. 'engine.da_ratio.bigAt').
// Values are stored as JSON so booleans and numbers round-trip losslessly.
import { db } from "./store.js";

const getStmt = () => db.prepare("SELECT value FROM engine_settings WHERE key = ?");
const setStmt = () => db.prepare(
  "INSERT INTO engine_settings (key, value, updated_at) VALUES (?, ?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
);

export function getSetting(key, def = undefined) {
  const row = getStmt().get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return def; }
}

// value === null clears the override (reverts to the code default).
export function setSetting(key, value) {
  if (value === null || value === undefined) {
    db.prepare("DELETE FROM engine_settings WHERE key = ?").run(key);
    return { key, value: null, cleared: true };
  }
  setStmt().run(key, JSON.stringify(value), new Date().toISOString());
  return { key, value };
}

export function listOverrides(prefix = "engine.") {
  return db.prepare("SELECT key, value, updated_at FROM engine_settings WHERE key LIKE ?")
    .all(prefix + "%")
    .map((r) => { try { return { ...r, value: JSON.parse(r.value) }; } catch { return r; } });
}

// Resolve one detector's settings: code defaults ⊕ DB overrides.
// `tunables` is the detector's declaration: { param: { def, type, ... } }.
export function resolveSettings(detectorId, tunables = {}) {
  const out = {};
  for (const [param, meta] of Object.entries(tunables)) {
    const v = getSetting(`engine.${detectorId}.${param}`);
    out[param] = v === undefined ? meta.def : v;
  }
  return out;
}

// Validate a raw value against a tunable's metadata before persisting. Throws on
// type mismatch so a typo in the ops console can never wedge a detector.
export function coerceValue(meta, raw) {
  if (meta.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === 1 || raw === "1") return true;
    if (raw === "false" || raw === 0 || raw === "0") return false;
    throw new Error("expected a boolean");
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("expected a number");
  if (meta.min != null && n < meta.min) throw new Error(`minimum is ${meta.min}`);
  if (meta.max != null && n > meta.max) throw new Error(`maximum is ${meta.max}`);
  return n;
}
