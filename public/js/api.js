// Backend fetch helpers (Task 9.1).
//
// api(): the legacy contract — resolves to parsed JSON, or null on ANY failure
// (404, 500, network). Callers all guard with `if (!data)`; keep it.
// apiEx(): status-aware variant for callers that need to tell 404 from offline.
export const api = async (path) => { try { const r = await fetch(path); return r.ok ? r.json() : null; } catch { return null; } };

export async function apiEx(path, opts = {}) {
  try {
    const r = await fetch(path, opts);
    let data = null;
    try { data = await r.json(); } catch { /* non-JSON body */ }
    return { ok: r.ok, status: r.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err };
  }
}
