// Collusion engine (L1, code-only) — SHARED_CONTROL_CLUSTER + COLLUSIVE_BIDDING.
//
// The Patanjali shape: several "independent" bidders on one tender all trace to
// one group. We can't see ownership (the director index is the one hard link),
// but we CAN see the free MCA `Registered_Office_Address`/`pincode` (C1). So we
// cluster companies that share a registered PIN code AND a distinctive address
// token, then flag any tender whose bidders fall in the SAME cluster.
//
// Guardrail (Rule 5 + the task DO-NOT): a shared registered address is a LEAD,
// never a public claim of "same owner". The wording here says precisely "shared
// registered address"; the AI Investigator/Referee + human gate decide the rest.
//
// Pure & code-only: `detectCollusion({companies, tenders})` takes plain arrays and
// returns {clusters, leads} with no store/network, so it is trivially testable.
// `runCollusion()` gathers the same inputs from the store and upserts the leads.
import { upsertLead, listPoliticians, listEvidence } from "../store/store.js";

// Detector identity — bump when any threshold/weight/vector changes.
export const DETECTOR_VERSION = "collusion-v1";

const sev = (s) => (s >= 20 ? "SIGNIFICANT" : s >= 8 ? "NOTABLE" : "UNDER_REVIEW");

// Address words too generic to prove a shared location — dropped before matching.
const STOP = new Set([
  "ROAD", "MARG", "PATH", "LANE", "GALI", "STREET", "FLOOR", "FLR", "BUILDING", "BLDG",
  "PLOT", "HOUSE", "NEAR", "OPP", "OPPOSITE", "BEHIND", "SECTOR", "PHASE", "BLOCK",
  "NAGAR", "COLONY", "SOCIETY", "APARTMENT", "APARTMENTS", "APT", "COMPLEX", "TOWER",
  "TOWERS", "EAST", "WEST", "NORTH", "SOUTH", "INDIA", "POST", "DIST", "DISTRICT",
  "STATE", "CITY", "MAIN", "CROSS", "GROUND", "FIRST", "SECOND", "THIRD", "ROOM",
  "OFFICE", "SHOP", "GATE", "AREA", "PARK", "CHOWK", "BAZAR", "BAZAAR", "LTD", "PVT",
  "PRIVATE", "LIMITED", "COMPANY", "AND",
]);

// Distinctive tokens = alpha words length ≥4 that aren't generic address filler.
function addressTokens(addr) {
  return new Set(
    String(addr ?? "").toUpperCase().split(/[^A-Z]+/)
      .filter((t) => t.length >= 4 && !STOP.has(t))
  );
}

function shareToken(aTokens, bTokens) {
  for (const t of aTokens) if (bTokens.has(t)) return t;
  return null;
}

// Union-find for connected components.
function makeDSU(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  return { find, union };
}

// Given company records, build clusters (size ≥2) of companies sharing a pincode
// AND a distinctive address token. Returns {clusters:[{id,members,pincode,token}], indexByKey}.
function clusterCompanies(companies) {
  // Dedupe companies by CIN (or name) — the same firm can appear under many reps.
  const uniq = [];
  const byKey = new Map();
  for (const c of companies) {
    const key = (c.cin || c.name || "").toUpperCase().trim();
    if (!key || byKey.has(key)) continue;
    byKey.set(key, uniq.length);
    uniq.push({ ...c, _key: key, _tokens: addressTokens(c.registered_address) });
  }

  const dsu = makeDSU(uniq.length);
  const sharedToken = {}; // component-root → an example shared token
  // Group by pincode, then within a pincode connect any pair sharing a token.
  const byPin = new Map();
  uniq.forEach((c, i) => {
    if (!c.pincode) return;
    (byPin.get(c.pincode) ?? byPin.set(c.pincode, []).get(c.pincode)).push(i);
  });
  for (const idxs of byPin.values()) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const tok = shareToken(uniq[idxs[a]]._tokens, uniq[idxs[b]]._tokens);
        if (tok) { dsu.union(idxs[a], idxs[b]); sharedToken[dsu.find(idxs[a])] = tok; }
      }
    }
  }

  // Collect components of size ≥2.
  const comp = new Map();
  uniq.forEach((c, i) => { const r = dsu.find(i); (comp.get(r) ?? comp.set(r, []).get(r)).push(i); });
  const clusters = [];
  const clusterOfKey = new Map();
  let cid = 0;
  for (const [root, members] of comp) {
    if (members.length < 2) continue;
    const id = `cluster_${cid++}`;
    const memberRecs = members.map((i) => uniq[i]);
    clusters.push({
      id, pincode: memberRecs[0].pincode, token: sharedToken[root] ?? null,
      members: memberRecs.map((m) => ({ name: m.name, cin: m.cin, pincode: m.pincode, source_url: m.source_url })),
    });
    // Index each member by BOTH its CIN and its name, so a tender bidder given
    // as either form resolves to the cluster.
    for (const m of memberRecs) {
      if (m.cin) clusterOfKey.set(String(m.cin).toUpperCase().trim(), id);
      if (m.name) clusterOfKey.set(String(m.name).toUpperCase().trim(), id);
    }
  }
  return { clusters, clusterOfKey };
}

// Map a bidder string (name or CIN) to a company key present in the cluster index.
function bidderKey(bidder, clusterOfKey) {
  const k = String(bidder ?? "").toUpperCase().trim();
  return clusterOfKey.has(k) ? k : null;
}

export function detectCollusion({ companies = [], tenders = [] } = {}) {
  const { clusters, clusterOfKey } = clusterCompanies(companies);
  const clusterById = new Map(clusters.map((c) => [c.id, c]));
  const leads = [];

  // ── SHARED_CONTROL_CLUSTER — a set of firms sharing a registered address. ──
  for (const cl of clusters) {
    const names = cl.members.map((m) => m.name).filter(Boolean);
    const signal_score = 6 + (cl.members.length - 2) * 4; // bigger cluster = stronger
    leads.push({
      vector: "SHARED_CONTROL_CLUSTER", actor_id: null, actor_name: null,
      detector_version: DETECTOR_VERSION,
      instrument: "shared registered office address",
      beneficiary: cl.id, beneficiary_kind: "company_cluster",
      cluster: cl, signal_score, severity: sev(signal_score),
      headline: `${cl.members.length} companies share the same registered PIN code (${cl.pincode})${cl.token ? ` and address token "${cl.token}"` : ""}.`,
      evidence_urls: [...new Set(cl.members.map((m) => m.source_url).filter(Boolean))],
      detail: `Companies at a shared registered address (${cl.pincode}${cl.token ? `, token "${cl.token}"` : ""}): ${names.join("; ")}. A shared registered address is a candidate for review — NOT proof of common ownership.`,
    });
  }

  // ── COLLUSIVE_BIDDING — ≥2 bidders on ONE tender fall in the SAME cluster. ──
  for (const t of tenders) {
    const hits = {}; // cluster id → set of bidder keys
    for (const bidder of t.bidders ?? []) {
      const k = bidderKey(bidder, clusterOfKey);
      if (!k) continue;
      const cid2 = clusterOfKey.get(k);
      (hits[cid2] ??= new Set()).add(k);
    }
    for (const [cid2, keys] of Object.entries(hits)) {
      if (keys.size < 2) continue;
      const cl = clusterById.get(cid2);
      const signal_score = 14 + (keys.size - 2) * 6;
      leads.push({
        vector: "COLLUSIVE_BIDDING",
        detector_version: DETECTOR_VERSION,
        actor_id: t.actor_id ?? null, actor_name: t.actor_name ?? null,
        instrument: `tender ${t.tender_id ?? "?"}${t.authority ? ` (${t.authority})` : ""}`,
        beneficiary: cid2, beneficiary_kind: "company_cluster",
        cluster: cl, tender_id: t.tender_id ?? null, signal_score, severity: sev(signal_score),
        headline: `${keys.size} bidders on one tender share the same registered address (PIN ${cl?.pincode ?? "?"}) — a possible single-group bidding pattern.`,
        evidence_urls: [t.source_url, ...(cl?.members.map((m) => m.source_url) ?? [])].filter(Boolean),
        detail: `Tender ${t.tender_id ?? "?"}${t.authority ? ` from ${t.authority}` : ""}: bidders ${[...keys].join("; ")} all belong to a cluster sharing a registered PIN code. Multiple "independent" bidders at one address is the collusive-bidding shape — a LEAD for the Investigator/Referee, not a finding.`,
      });
    }
  }

  return { clusters, leads };
}

// Store-backed runner: gather all mca_company evidence across reps, run the
// detector, and upsert the leads into the same queue the AI layers consume.
export function runCollusion({ tenders = [] } = {}) {
  const companies = [];
  for (const p of listPoliticians()) {
    for (const e of listEvidence(p.id)) {
      const nums = /** @type {any} */ (e).numbers;
      if (e.source_type === "mca_company" && Array.isArray(nums?.companies)) {
        for (const c of nums.companies) companies.push({ ...c, source_url: c.source_url ?? e.url });
      }
    }
  }
  const { clusters, leads } = detectCollusion({ companies, tenders });
  for (const lead of leads) upsertLead(lead);
  return { clusters, leads };
}
