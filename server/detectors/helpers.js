// Shared helpers used inside detector run() bodies, extracted verbatim from
// engine.js so the registry file stays focused on the DETECTORS array. Bodies
// are unchanged; only the `export` keyword was added to those that were
// module-private in engine.js. engine.js imports these by name and re-exports
// the ones that were part of its public surface (meanStd/benfordStats/evidenceRef).
import { db } from "../store.js";

const CR = 1e7, L = 1e5;
export { CR, L };

// ── Shared statistics helpers ────────────────────────────────────────────────
export function meanStd(xs) {
  const n = xs.length;
  if (!n) return { mean: 0, std: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance), n };
}

// Benford first-digit screen: chi-square (8 dof) + Nigrini's Mean Absolute
// Deviation, so a deviation must clear BOTH a significance test and an effect-
// size band before it flags. Returns null when there are too few numbers.
const BENFORD_P = Array.from({ length: 9 }, (_, i) => Math.log10(1 + 1 / (i + 1)));
export function benfordStats(values, { minN = 40 } = {}) {
  const digits = [];
  for (const v of values) {
    const s = String(Math.abs(Number(v) || 0)).replace(/[^1-9]/g, "");
    if (s) digits.push(Number(s[0]));
  }
  if (digits.length < minN) return null;
  const n = digits.length;
  const counts = Array(9).fill(0);
  for (const d of digits) counts[d - 1]++;
  let chi2 = 0, mad = 0;
  for (let i = 0; i < 9; i++) {
    const expected = BENFORD_P[i] * n;
    chi2 += (counts[i] - expected) ** 2 / expected;
    mad += Math.abs(counts[i] / n - BENFORD_P[i]);
  }
  mad /= 9;
  return { n, chi2, mad, counts };
}

// ── Evidence citation helper ─────────────────────────────────────────────────
// A flag's evidence array is its "why": [{ evidence_id?, url?, note }]. The note
// says what the row shows, so the lead (and later GLM) can cite it directly.
let _evStmt = null;
const evUrlStmt = () => (_evStmt ??= db.prepare("SELECT url, data FROM evidence WHERE id = ?"));
export function evidenceRef(evidence_id, note) {
  if (!evidence_id) return { note };
  try {
    const row = evUrlStmt().get(evidence_id);
    const title = row?.data ? (JSON.parse(row.data).title ?? null) : null;
    return { evidence_id, url: row?.url ?? null, title, note };
  } catch { return { evidence_id, note }; }
}

// Pull just the legacy-default keys out of a resolved settings object (drops
// enabled/bigAt) to pass as overrides to the pure detector.
export const legacyOverrides = (S, defaults) =>
  Object.fromEntries(Object.keys(defaults).map((k) => [k, S[k]]));

// Adapter: legacy lead-candidates → flag candidates (keeps the original lead so
// promotion preserves the legacy vector + dedupe key exactly).
export function fromLegacy(candidates, ctx) {
  return candidates.map((c) => ({
    subject: {
      politician_id: c.actor_id && ctx.pmap.has(c.actor_id) ? c.actor_id : null,
      entity_id: c.actor_id && !ctx.pmap.has(c.actor_id) ? c.actor_id : null,
      name: c.actor_name ?? c.beneficiary ?? "(population)",
      kind: c.beneficiary_kind ?? "lead",
    },
    score: c.signal_score ?? 0,
    fingerprint: `${c.vector}|${c.actor_id ?? ""}|${c.beneficiary ?? ""}`,
    headline: c.headline,
    rationale: c.detail ?? c.headline,
    evidence: [
      ...(c.data?.evidence_ids ?? []).map((eid) => evidenceRef(eid, "source row this signal was computed from")),
      ...(c.evidence_urls ?? []).map((u) => ({ url: u, note: "source cited by the detector" })),
    ],
    data: c.data ?? {},
    lead: c,
  }));
}

// Stable identity for a declared property across affidavits: type + district +
// owner (value is intentionally excluded — a revaluation must not read as a new item).
export function propKey(it) {
  return [it.property_type, it.district, it.owner].map((x) => String(x ?? "").toLowerCase().trim()).join("|");
}

// ── nexus helpers ────────────────────────────────────────────────────────────
// Assemble the three nexus legs for one politician from existing edges/events.
// selfEnt + interestEdges are precomputed by the caller (one pass, not per-rep).
export function gatherNexusLegs(ctx, p, awardees, selfEnt, interestEdges) {
  const detail = [], evidence = [], sectors = new Set();
  let power = false, interest = false, benefit = false;

  // Leg 1 — office power: parliamentary question/portfolio sectors (from evidence).
  for (const e of ctx.evidenceFor(p.id)) {
    if (e.source_type === "parliament_ls" && e.numbers?.power) {
      const qs = Object.keys(e.numbers.power.question_sectors ?? {});
      if (qs.length) { power = true; qs.slice(0, 4).forEach((s) => sectors.add(s)); detail.push(`office covers ${qs.slice(0, 3).join("/")}`); evidence.push(evidenceRef(e.id, "parliamentary power sectors")); break; }
    }
  }
  // Leg 2 — private interest: the rep's entity has owner_of/director_of/business edges.
  if (selfEnt) {
    const rels = interestEdges.get(selfEnt) ?? [];
    if (rels.length) {
      interest = true; detail.push(`holds ${rels.length} business/ownership interest(s)`);
      for (const r of rels.slice(0, 3)) { const d = r.data ?? {}; if (d.sector) sectors.add(d.sector); }
    }
    // Leg 3 — government benefit: this rep's entity is itself an awardee.
    if (awardees.has(selfEnt)) { benefit = true; detail.push("named on a government contract award"); }
  }
  return { power, interest, benefit, sectors: [...sectors], detail, evidence };
}

// Longest control chain INTO a company (how many holder-hops deep), bounded.
export function chainDepth(node, controlledBy, seen, depth, cap) {
  if (depth >= cap || seen.has(node)) return depth;
  seen.add(node);
  const holders = controlledBy.get(node);
  if (!holders || !holders.size) return depth;
  let best = depth;
  for (const h of holders) {
    const d = chainDepth(h, controlledBy, seen, depth + 1, cap);
    if (d > best) best = d;
  }
  seen.delete(node);
  return best;
}

// Compact value formatter for the generic detector's prose (rupee scale-aware).
export function fmtVal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= CR) return `₹${(n / CR).toFixed(2)} Cr`;
  if (Math.abs(n) >= L) return `₹${(n / L).toFixed(2)} L`;
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

// ── Tunable-metadata helpers ─────────────────────────────────────────────────
// Moved verbatim from engine.js so batch-file detector literals (which call
// T()/legacyTunables()/BASE_TUNABLES at module-load time) can build without a
// circular import back into engine.js. engine.js imports these by name.

// Common tunables every detector gets.
export const BASE_TUNABLES = {
  enabled: { label: "Enabled", type: "boolean", def: true, desc: "Turn this detector on/off." },
  bigAt: { label: "Big-flag score", type: "number", def: 20, min: 1, max: 100, desc: "Score at/above which a flag is BIG (lead-worthy on its own)." },
};
export const T = (extra = {}) => ({ ...BASE_TUNABLES, ...extra });

// Turn a legacy detector's DEFAULTS constant into tunable metadata (all numeric,
// labelled by their constant name) so the ops console can edit them live. `labels`
// optionally overrides the display label/desc for a given key.
export function legacyTunables(defaults, labels = {}, base = {}) {
  const out = { ...BASE_TUNABLES, ...base };
  for (const [k, def] of Object.entries(defaults)) {
    out[k] = { label: labels[k]?.label ?? k, type: "number", def, min: 0, desc: labels[k]?.desc ?? `Threshold ${k} (default ${def}).` };
  }
  return out;
}
