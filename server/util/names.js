// Shared name-normalization + token-overlap scoring used by the roster
// importers (import-ls.js, import-rs.js) and the MyNeta repair tool.
// Moved verbatim from those files (Task 4.1) — the three copies were identical.
// NOTE: other norm() helpers elsewhere (data/, extractors/, sources/) have
// intentionally different rules — do not fold them into this one.
export const NORM = (s) => (s ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
export const nameScore = (a, b) => {
  const A = NORM(a); const B = new Set(NORM(b));
  const hit = A.filter((w) => B.has(w)).length;
  return A.length ? hit / A.length : 0;
};
