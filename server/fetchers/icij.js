// ICIJ Offshore Leaks — free, no key, no registration.
//
// REBUILT 2026-07-07: the old flat `/api/v1/search` endpoint is dead (404 —
// ICIJ replaced it with a standard OpenRefine Reconciliation API). This
// version: (1) reconciles the politician's name against ICIJ's officer/entity/
// intermediary nodes, keeping only high-confidence matches; (2) for each
// match, fetches the node's own page and extracts its "Connections" table —
// which entities that person is a director/shareholder/BENEFICIAL OWNER of,
// in which jurisdiction, via which leak. That connections table IS the
// asset → real-owner link: an offshore entity (the "asset") mapped to the
// named person's role in it (the "real owner" relation), exactly the shape
// ICIJ/OCCRP-style investigations run on.
//
// Lead only — a match means the name appears in leaked data; it does not
// prove wrongdoing, and common names can collide with unrelated people.
import { htmlToText } from "./http.js";

const RECONCILE = "https://offshoreleaks.icij.org/api/v1/reconcile";
const NODE_PAGE = (id) => `https://offshoreleaks.icij.org/nodes/${id}`;

// Distinctive-token identity gate (same spirit as graph.js): a bare single
// common surname isn't enough to accept a match even at a modest score.
const COMMON_TOKENS = new Set(["kumar", "singh", "devi", "ram", "prasad", "yadav", "lal", "bai", "reddy", "rao", "das", "khan", "sharma", "verma", "gupta"]);
function distinctiveTokens(name) {
  return name.toLowerCase().split(/\s+/).filter((t) => t.length > 2 && !COMMON_TOKENS.has(t));
}
function sharesDistinctiveToken(candidateName, politicianName) {
  const cand = new Set(candidateName.toLowerCase().split(/[\s.,]+/));
  return distinctiveTokens(politicianName).some((t) => cand.has(t));
}

async function reconcile(name) {
  try {
    const body = new URLSearchParams({ queries: JSON.stringify({ q0: { query: name } }) });
    const res = await fetch(RECONCILE, {
      method: "POST",
      headers: { "User-Agent": "PandorosBox/0.1 (public-accountability research)", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.q0?.result ?? [];
  } catch { return []; }
}

async function fetchConnections(id) {
  let html;
  try {
    const res = await fetch(NODE_PAGE(id), {
      headers: { "User-Agent": "PandorosBox/0.1 (public-accountability research)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch { return null; }

  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

  const start = text.indexOf("Connections:");
  const end = text.search(/Explore more from/i);
  const connections = start >= 0 ? text.slice(start, end > start ? end : start + 2000).trim() : "";

  // Also grab the short bio line right before "Connections:" (name/role/country).
  const bioStart = Math.max(0, text.indexOf("Data from") > 0 ? 0 : 0);
  const bioMatch = text.match(/(Officer|Entity|Intermediary|Other):\s.{0,200}?(?=Linked countries|Connections:)/);
  const bio = bioMatch ? bioMatch[0].trim() : "";

  return { bio, connections };
}

export async function fetchICIJ(p) {
  const candidates = await reconcile(p.name);
  if (!candidates.length) return [];

  const accepted = candidates
    .filter((c) => c.type !== "https://offshoreleaks.icij.org/schema/oldb/address" && !(c.types ?? []).some((t) => /address/.test(t.id)))
    .filter((c) => c.match === true || c.score >= 85)
    .filter((c) => sharesDistinctiveToken(c.name, p.name))
    .slice(0, 3);
  if (!accepted.length) return [];

  const items = [];
  for (const c of accepted) {
    const detail = await fetchConnections(c.id);
    if (!detail || (!detail.connections && !detail.bio)) continue;
    const typeLabel = (c.types ?? [])[0]?.name ?? "Node";
    items.push({
      politician_id: p.id,
      source_type: "icij_leaks",
      tier: 6,
      admissible: false,
      title: `ICIJ Offshore Leaks — ${c.name} (${typeLabel}, matched "${p.name}")`,
      url: NODE_PAGE(c.id),
      date: null,
      summary: `ICIJ Offshore Leaks node "${c.name}" (match score ${c.score?.toFixed?.(0) ?? c.score}/100) matched against "${p.name}" — verify identity before concluding; a name match in leaked data is not an adjudicated finding.`,
      content: [
        `ICIJ Offshore Leaks — candidate match for "${p.name}" (verify identity: common names can collide):`,
        c.description ? `Node: ${c.name} — ${c.description}` : `Node: ${c.name}`,
        detail.bio,
        detail.connections || "(no listed entity/officer connections beyond the base record)",
      ].filter(Boolean).join("\n"),
    });
  }
  return items;
}
