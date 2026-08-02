// MPLADS — full MP Local Area Development Scheme record (fund allocated vs spent,
// utilisation %, works recommended/completed/pending, year-wise spend, and the
// actual list of works) via empoweredindian.in's open JSON API, which mirrors
// the official MoSPI MPLADS portal API daily (~442k records, ~98% quality).
//
// MP-only. Free, no key. The official mplads.mospi.gov.in portal is login-walled
// for per-MP data, so this mirror is the only free programmatic path.
import { fetchJson , TIMEOUT_SLOW } from "./http.js";
import { noteParseMiss, noteTruncation } from "./observe.js";

const API = "https://api.empoweredindian.in/api";

const HONORIFICS = new Set(["dr", "shri", "smt", "kumari", "ms", "mr", "mrs", "prof", "adv", "shrimati", "alias"]);
const toks = (s) => (s ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z\s]/g, " ")
  .split(/\s+/).filter((t) => t.length >= 3 && !HONORIFICS.has(t));

// Fixed request caps, named so the truncation checks compare against the same
// numbers the URLs ask for.
const DIR_LIMIT = 900;
const WORKS_LIMIT = 100;

// Cached MP directory (one call), matched by name tokens + constituency.
let dirPromise = null;
async function directory() {
  if (!dirPromise) dirPromise = (async () => {
    const d = await fetchJson(`${API}/summary/mps?page=1&limit=${DIR_LIMIT}`, { timeoutMs: TIMEOUT_SLOW, source: "mplads" });
    const list = d?.data ?? [];
    // Single unpaged request: exactly DIR_LIMIT rows back means the roster was
    // cut off, and every MP past the cut silently stops matching.
    if (list.length >= DIR_LIMIT) noteTruncation("mplads", "directory", { got: list.length, cap: DIR_LIMIT });
    if (!list.length) noteParseMiss("mplads", "directory", { expected: "MP roster rows" });
    return list.map((m) => ({ ...m, toks: toks(m.mpName), cons: (m.constituency ?? "").toLowerCase() }));
  })();
  return dirPromise;
}

function matchMP(p, dir) {
  const pt = toks(p.name);
  if (!pt.length) return null;
  const cons = (p.constituency ?? "").toLowerCase().trim();
  const scored = dir
    .map((m) => ({ m, hit: pt.filter((t) => m.toks.includes(t)).length, consHit: cons && m.cons.includes(cons) }))
    .filter((s) => s.hit >= Math.min(2, pt.length) || s.consHit)
    .sort((a, b) => (b.consHit - a.consHit) || (b.hit - a.hit));
  if (!scored.length) return null;
  // need either a constituency match or all name tokens present
  const top = scored[0];
  if (top.consHit || top.hit >= pt.length) return top.m;
  return null;
}

const rupees = (n) => (n == null ? "?" : `Rs ${(n / 1e7).toFixed(2)} cr`);

export async function fetchMPLADS(p) {
  if (p.office !== "MP") return [];
  const m = matchMP(p, await directory());
  if (!m) return [];

  const detail = await fetchJson(`${API}/mplads/mps/${m.id}`, { timeoutMs: TIMEOUT_SLOW });
  const dd = detail?.data ?? {};
  const works = await fetchJson(`${API}/mplads/mps/${m.id}/works?page=1&limit=${WORKS_LIMIT}`, { timeoutMs: TIMEOUT_SLOW, source: "mplads" });
  // Same shape the works list is read with further down; checked here so a works
  // page that comes back exactly full is reported as a truncation, not a total.
  const workRows = works?.data?.works ?? works?.data ?? [];
  if (Array.isArray(workRows) && workRows.length >= WORKS_LIMIT) {
    noteTruncation("mplads", "works", { got: workRows.length, cap: WORKS_LIMIT });
  }

  const lines = [
    `MPLADS record — ${m.mpName} (${m.house}), ${m.constituency}, ${m.state}`,
    ``,
    `Funds allocated: ${rupees(m.allocatedAmount)}`,
    `Total spent: ${rupees(m.totalExpenditure)} (${(m.utilizationPercentage ?? 0).toFixed(1)}% utilised)`,
    `Unspent: ${rupees(m.unspentAmount)}`,
    `Works recommended: ${m.recommendedWorksCount}; completed: ${m.completedWorksCount}; pending: ${m.pendingWorks} (completion ${(m.completionRate ?? 0).toFixed(1)}%)`,
  ];

  // Year-wise spend trend
  const trend = dd.expenditure?.yearlyTrend ?? [];
  if (trend.length) {
    lines.push(``, `YEAR-WISE EXPENDITURE:`);
    for (const y of trend) lines.push(`  • ${y._id}: ${rupees(y.totalAmount)} (${y.transactionCount} transactions)`);
  }

  // Works list (what the money actually went to)
  const list = works?.data?.works ?? works?.data ?? dd.works?.recentCompleted ?? [];
  if (Array.isArray(list) && list.length) {
    lines.push(``, `WORKS (${list.length} shown):`);
    for (const w of list.slice(0, 100)) {
      const desc = (w.workDescription ?? w.description ?? "").toString().replace(/\s+/g, " ").slice(0, 160);
      const cat = w.workCategory ?? w.category ?? "";
      const cost = w.recommendedAmount ?? w.cost ?? w.amount;
      const status = w.status ?? (w.completedDate ? "completed" : "");
      lines.push(`  • ${desc}${cat ? ` [${cat}]` : ""}${cost ? ` — ${rupees(cost)}` : ""}${status ? ` (${status})` : ""}`);
    }
  }

  return [{
    politician_id: p.id,
    source_type: "mplads",
    tier: 2,
    admissible: true,
    title: `MPLADS fund utilisation — ${p.name} — ${m.constituency}`,
    url: `https://empoweredindian.in/mplads/mps`,
    date: detail?.data?.lastUpdated ?? null,
    summary: `MP Local Area Development funds: ${(m.utilizationPercentage ?? 0).toFixed(1)}% of ${rupees(m.allocatedAmount)} utilised, ${m.completedWorksCount}/${m.recommendedWorksCount} works completed. Mirror of official MoSPI MPLADS portal (updated daily).`,
    content: lines.join("\n").slice(0, 8000),
    numbers: {
      allocated: m.allocatedAmount ?? null,
      spent: m.totalExpenditure ?? null,
      unspent: m.unspentAmount ?? null,
      utilization_pct: m.utilizationPercentage ?? null,
      works_recommended: m.recommendedWorksCount ?? null,
      works_completed: m.completedWorksCount ?? null,
      completion_pct: m.completionRate ?? null,
    },
  }];
}
