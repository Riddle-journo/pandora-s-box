// Selective Tofler enrichment (Phase 1) — react to a FLAG, never crawl.
//
// Given the leads a detector just raised, resolve every company-bearing lead to
// its concrete company, and for each company we haven't already looked up, do ONE
// throttled Tofler lookup and persist the directors. This is the free substitute
// for the (paid) MCA bulk Directors Data file: we only pay the per-company cost
// for companies that are already flagged.
//
// Persistence is two-layered:
//   • tofler_companies cache — one row per company (dedup guard + Phase-2 input).
//   • mca_company evidence — written only when the flag has an actor (politician),
//     so the EXISTING conflict/collusion detectors can consume the directors too.
//
// OFF by default. Enable with env TOFLER_ENRICH=1 (or pass { force:true }), so a
// normal ingest never hits Tofler unless you opt in.
import { sleep } from "./fetchers/http.js";
import { companyTargetsFromLead, companyKey, fetchToflerDirectors } from "./fetchers/tofler.js";
import { getToflerCompany, upsertToflerCompany, addEvidence } from "./store.js";

const COMPANY_KINDS = new Set(["company", "company_cluster", "tender"]);

const ttlMs = () => (Number(process.env.TOFLER_TTL_DAYS) || 30) * 86400_000;
const delayMs = () => (process.env.TOFLER_DELAY_MS != null ? Number(process.env.TOFLER_DELAY_MS) : 1500);

const isFresh = (cached) =>
  cached?.fetched_at && (Date.now() - new Date(cached.fetched_at).getTime()) < ttlMs();

// Build an mca_company evidence row from a Tofler result so the deterministic
// detectors (which read e.numbers.companies) light up on the directors.
function toEvidence(actorId, company) {
  const lines = [
    `TOFLER DIRECTOR LOOKUP — ${company.name ?? company.cin} (${company.directors.length} director(s)); flagged company, enriched from the free MCA mirror:`,
    ...company.directors.map((d) => `• ${d.name} (DIN ${d.din})`),
  ];
  return {
    politician_id: actorId,
    source_type: "mca_company",
    tier: 6,
    admissible: true,
    title: `Tofler directors — ${company.name ?? company.cin}`,
    url: company.source_url,
    date: null,
    summary: `${company.directors.length} director(s) for a flagged company (${company.name ?? company.cin}), via Tofler.`,
    content: lines.join("\n"),
    numbers: { companies: [{ name: company.name, cin: company.cin, source_url: company.source_url, source: "tofler", directors: company.directors }] },
  };
}

// Enrich a batch of leads. Returns a summary; safe to call with any lead array.
export async function enrichLeadsWithTofler(leads = [], { force = false, fetchImpl, resolveCin } = {}) {
  const enabled = force || process.env.TOFLER_ENRICH === "1";
  if (!enabled) return { enabled: false, targets: 0, fetched: 0, cached: 0, evidence: 0 };

  // Collect unique company targets, remembering which politicians (actors) each
  // came from so we can attach evidence to every one of them.
  const targets = new Map(); // company_key → { target, actorIds:Set }
  for (const lead of leads) {
    if (!COMPANY_KINDS.has(lead?.beneficiary_kind)) continue;
    for (const t of companyTargetsFromLead(lead)) {
      const k = companyKey(t);
      const slot = targets.get(k) ?? { target: t, actorIds: new Set() };
      if (lead.actor_id) slot.actorIds.add(lead.actor_id);
      targets.set(k, slot);
    }
  }

  let fetched = 0, cached = 0, evidence = 0;
  let first = true;
  for (const [key, { target, actorIds }] of targets) {
    // Resolve the company's directors: cache hit (fresh) or a throttled fetch.
    let company;
    const hit = getToflerCompany(key);
    if (isFresh(hit)) { company = hit; cached++; }
    else {
      if (!first) await sleep(delayMs()); // politeness gap between network hits
      first = false;
      const opts = {};
      if (fetchImpl) opts.fetchImpl = fetchImpl;
      if (resolveCin) opts.resolveCin = resolveCin;
      const res = await fetchToflerDirectors(target, opts);
      if (res) {
        company = upsertToflerCompany({ company_key: key, cin: res.cin, name: res.name, ...res });
        fetched++;
      }
    }
    if (!company?.directors?.length) continue;

    // Attach to each politician the flag implicated (dedup on url is handled by
    // addEvidence, so re-runs upgrade in place rather than duplicating).
    for (const actorId of actorIds) {
      addEvidence([toEvidence(actorId, company)]);
      evidence++;
    }
  }

  return { enabled: true, targets: targets.size, fetched, cached, evidence };
}
