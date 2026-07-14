// ════════════════════════════════════════════════════════════════════════════
// Public content routes: scandals, issues, funding, scorecards, ministry/party
// cards, and the scandals-on-a-politician's-watch view.
// Split out of server/index.js (Task 5.5) — routes keep their FULL original
// path strings and their original relative registration order. /api/scandals/
// facets stays registered before /api/scandals/:slug.
// ════════════════════════════════════════════════════════════════════════════
import express from "express";
import { listScandals, getScandal, getPolitician, listPoliticians } from "../store.js";
import { asyncH, maybePaginate } from "./util.js";

const router = express.Router();

// ---- Scandals / government accountability ----
// Searchable by level, sector, state, party, and free-text q (task #8).
router.get("/api/scandals", (req, res) => {
  const items = listScandals().map((s) => ({
    id: s.id, slug: s.slug, title: s.title, date: s.date, sector: s.sector,
    govt_level: s.govt_level, state: s.state, ministry: s.ministry,
    party: s.party ?? "", government: s.government ?? "",
    headline: s.headline, signal: s.signal,
    minister: s.minister_in_charge?.name ?? "",
    verdict: s.accountability?.verdict ?? null,
  }));
  const level = req.query.level, sector = req.query.sector;
  const state = (req.query.state || "").toLowerCase(), party = (req.query.party || "").toLowerCase();
  const q = (req.query.q || "").toLowerCase();
  const filtered = items.filter((s) =>
    (!level  || s.govt_level === level) &&
    (!sector || s.sector === sector) &&
    (!state  || (s.state || "").toLowerCase() === state) &&
    (!party  || (s.party || "").toLowerCase().includes(party)) &&
    (!q      || `${s.title} ${s.headline} ${s.minister} ${s.ministry} ${s.party}`.toLowerCase().includes(q)));
  res.json(maybePaginate(filtered, req.query));
});

// Distinct filter values for the scandal search UI.
router.get("/api/scandals/facets", (_req, res) => {
  const all = listScandals();
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  res.json({
    states: uniq(all.map((s) => s.state)),
    parties: uniq(all.map((s) => s.party)),
    sectors: uniq(all.map((s) => s.sector)),
  });
});

router.get("/api/scandals/:slug", (req, res) => {
  const s = getScandal(req.params.slug);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// ---- Conflict-of-interest leads: ADMIN-ONLY (Investigator branch) ----
// The Investigator's output is never public. Leads are journalist work-product,
// reviewed at #/admin and shared externally by the owner — see the admin routes.

// ---- Issues: "Where India Stands" (task #5) ----
router.get("/api/issues", asyncH(async (req, res) => {
  const { listIssues } = await import("../store.js");
  const { ISSUE_SEEDS } = await import("../data/issues.js");
  const done = listIssues();
  const bySlug = {}; for (const i of done) bySlug[i.slug] = i;
  // Return all seeds (so the page shows the full set) annotated with whether
  // an analysis has been generated yet.
  const items = ISSUE_SEEDS.map((seed) => {
    const i = bySlug[seed.slug];
    return { slug: seed.slug, title: seed.title, icon: seed.icon ?? "", description: seed.description, generated: !!i };
  });
  res.json(maybePaginate(items, req.query));
}));
router.get("/api/issues/:slug", asyncH(async (req, res) => {
  const { getIssue } = await import("../store.js");
  const i = getIssue(req.params.slug);
  if (!i) return res.status(404).json({ error: "not generated yet" });
  res.json(i);
}));

// ---- Follow the money: electoral-bond funding (party-level) ----
router.get("/api/funding/overview", asyncH(async (_req, res) => {
  const { fundingOverview } = await import("../data/electoral-bonds.js");
  res.json(fundingOverview());
}));
router.get("/api/funding/party/:party", asyncH(async (req, res) => {
  const { fundingForParty } = await import("../data/electoral-bonds.js");
  const f = fundingForParty(req.params.party);
  if (!f) return res.status(404).json({ error: "party not in disclosed electoral-bond data" });
  res.json(f);
}));
router.get("/api/politicians/:id/funding", asyncH(async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { fundingForParty } = await import("../data/electoral-bonds.js");
  res.json(fundingForParty(p.party) ?? { party: p.party, unavailable: true });
}));

// Government / ministry / party / government-term accountability scorecards.
// Ministry/party buckets are annotated with their canonical card key (when one
// resolves) so the UI can link each row to its report card.
router.get("/api/scorecards", asyncH(async (_req, res) => {
  const [{ buildScorecards }, { resolveMinistry, resolveParty }] =
    await Promise.all([import("../scorecard.js"), import("../data/ministries.js")]);
  const sc = buildScorecards();
  for (const b of sc.byMinistry) b.card_key = resolveMinistry(b.label)?.key ?? null;
  for (const b of sc.byParty) b.card_key = resolveParty(b.label)?.key ?? null;
  res.json(sc);
}));

// ---- Ministry & party report cards (Summarizer, computed on request) ----
router.get("/api/ministries", asyncH(async (_req, res) => {
  const [{ MINISTRIES, resolveMinistry }] = await Promise.all([import("../data/ministries.js")]);
  const counts = {};
  for (const s of listScandals()) {
    const k = resolveMinistry(s.ministry)?.key;
    if (k) counts[k] = (counts[k] ?? 0) + 1;
  }
  res.json(MINISTRIES.map((m) => ({ key: m.key, name: m.name, scope: m.scope, sectors: m.sectors ?? [], failures: counts[m.key] ?? 0 })));
}));

router.get("/api/ministries/:key(*)/card", asyncH(async (req, res) => {
  try {
    const { buildMinistryCard } = await import("../cards.js");
    res.json(buildMinistryCard(req.params.key));
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "not found" });
  }
}));

router.get("/api/parties", asyncH(async (_req, res) => {
  const { PARTIES, resolveParty } = await import("../data/ministries.js");
  const rosterCounts = {};
  for (const p of listPoliticians()) {
    if (p.is_demo) continue;
    const k = resolveParty(p.party)?.key;
    if (k) rosterCounts[k] = (rosterCounts[k] ?? 0) + 1;
  }
  res.json(PARTIES.map((p) => ({ key: p.key, name: p.name, reps: rosterCounts[p.key] ?? 0 })));
}));

router.get("/api/parties/:key/card", asyncH(async (req, res) => {
  try {
    const { buildPartyCard } = await import("../cards.js");
    res.json(buildPartyCard(req.params.key, req.query.scope || "union"));
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "not found" });
  }
}));

// Failures on a given politician's watch (links scandals → minister dossier).
// Matches both the stored minister_politician_id and a live name-token match,
// so it works for historical ministers added before linking existed.
router.get("/api/politicians/:id/scandals", asyncH(async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { resolveMinisterPolitician } = await import("../scandal-generator.js");
  const hits = listScandals().filter((s) =>
    s.minister_politician_id === p.id ||
    (s.minister_in_charge?.name && resolveMinisterPolitician(s.minister_in_charge.name) === p.id));
  res.json(hits.map((s) => ({
    slug: s.slug, title: s.title, date: s.date, sector: s.sector, signal: s.signal,
    portfolio: s.minister_in_charge?.portfolio ?? "", ministry: s.ministry,
    verdict: s.accountability?.verdict ?? null, headline: s.headline,
  })));
}));

export default router;
