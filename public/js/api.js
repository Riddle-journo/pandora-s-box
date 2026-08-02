// Backend fetch helpers (Task 9.1).
//
// api(): the legacy contract — resolves to parsed JSON, or null on ANY failure
// (404, 500, network). Callers all guard with `if (!data)`; keep it.
// apiEx(): status-aware variant for callers that need to tell 404 from offline.
//
// Both helpers rewrite "/api/…" to the CANONICAL "/api/v1/…" prefix so the SPA
// dogfoods the versioned surface without touching ~30 call sites. Bare /api
// stays a permanent server-side alias, so nothing breaks if a call site is
// added that bypasses these helpers. Already-versioned paths pass through.
const V1_PREFIX = "/api/v1";
const ALREADY_VERSIONED = /^\/api\/v\d+(\/|\?|$)/;
export const toApiV1 = (path) =>
  (typeof path === "string" && path.startsWith("/api/") && !ALREADY_VERSIONED.test(path))
    ? V1_PREFIX + path.slice("/api".length)
    : path;

export const api = async (path) => { try { const r = await fetch(toApiV1(path)); return r.ok ? r.json() : null; } catch { return null; } };

export async function apiEx(path, opts = {}) {
  try {
    const r = await fetch(toApiV1(path), opts);
    let data = null;
    try { data = await r.json(); } catch { /* non-JSON body */ }
    return { ok: r.ok, status: r.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err };
  }
}
