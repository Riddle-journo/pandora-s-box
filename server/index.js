// Load .env by a path relative to THIS FILE, not process.cwd() — "dotenv/config"
// alone resolves against the caller's working directory, which silently finds
// nothing (ADMIN_TOKEN/AI_API_KEY undefined) when the process is launched from
// a different cwd (e.g. the dev-preview harness launches from the parent folder).
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import express from "express";
import { requireAdmin } from "./auth.js";
import {
  listPoliticians, listPoliticiansWithLatest, listPoliticiansWithCard, getPolitician, listEvidence,
  latestReport, reportHistory, latestCard, cardLeaderboardRows, addTip, listTips, reviewTip,
  listScandals, getScandal, listProposals, deleteScandal,
  listLeads, getLead, listLeadProposals, deleteLead, upsertLead,
  listStories, getStory, upsertStory,
  statsSummary, evidenceCoverage, politiciansMissing, jobCounts, evidenceCounts,
  sourceHealth, listJobs, getJob, enqueueJob,
  cancelJob, updateJob, requeueJob, trimJobs, reclaimRunningJobs, isQueuePaused, setQueuePaused,
  recordLeadFeedback, detectorPrecision, pingDb,
} from "./store.js";
import { tail as opsLogTail } from "./ops-log.js";
import { directorshipNetworkForGraph } from "./directorship-network.js";
import { canTransition, STORY_STATUSES } from "./story-generator.js";
import { issueChallenge, verifyPow, rateLimitTip, sanitizeTip, TIP_CATEGORIES } from "./safeguards.js";
import { PARAMETERS, SCORING } from "./scoring.js";
import { engineStatus, detectorById, runEngine } from "./engine.js";
import { listFlags, flagCounts, getFlag } from "./flags.js";
import { setSetting, coerceValue } from "./engine-settings.js";

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => { console.error("[uncaughtException]", err); process.exit(1); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Currency-string parser shared by report/leaderboard summarization helpers below.
const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/[\d.]+/); return m ? Number(m[0]) : null; };
const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if (req.path === "/healthz" || !req.path.startsWith("/api")) return;
    console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

// Basic security headers (no extra deps)
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  });
  next();
});

// ---- Public API ----
app.get("/healthz", (_req, res) => {
  try {
    res.json({ ok: pingDb(), uptime: Math.round(process.uptime()) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});
app.get("/api/parameters", (_req, res) => res.json(PARAMETERS));
app.get("/api/methodology", (_req, res) => res.json({ parameters: PARAMETERS, scoring: SCORING }));
app.get("/api/tip-categories", (_req, res) => res.json(TIP_CATEGORIES));

// Browse list. `latest` (grade/score/headline) now comes from the Summarizer
// card when one exists, falling back to the legacy dossier during transition.
app.get("/api/politicians", (_req, res) => {
  const withCard = listPoliticiansWithCard();
  const repFallback = new Map(listPoliticiansWithLatest().map((p) => [p.id, p.latest]));
  res.json(withCard.map((p) => ({ ...p, latest: p.card ?? repFallback.get(p.id) ?? null })));
});

app.get("/api/politicians/:id", (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

// ---- Summarizer report card (Branch 1) — the public politician page ----
app.get("/api/politicians/:id/card", (req, res) => {
  const c = latestCard("politician", req.params.id);
  if (!c) return res.status(404).json({ error: "no card yet" });
  res.json(c);
});

// Legacy GLM dossiers are a frozen archive (retired in favour of the card).
// Kept admin-only for journalist context; not part of the public surface.
app.get("/api/politicians/:id/report", requireAdmin, (req, res) => {
  const r = latestReport(req.params.id);
  if (!r) return res.status(404).json({ error: "no report yet" });
  res.json(r);
});

app.get("/api/politicians/:id/reports", requireAdmin, (req, res) => res.json(reportHistory(req.params.id)));
app.get("/api/politicians/:id/evidence", (req, res) => res.json(listEvidence(req.params.id)));

// ---- Head-to-head comparison ----
// /api/compare?ids=a,b[,c]  → each politician + a flattened, comparable summary
// of their latest report (scores, signals, record counts) for a side-by-side.
app.get("/api/compare", (req, res) => {
  const ids = String(req.query.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4);
  if (ids.length < 2) return res.status(400).json({ error: "Provide at least 2 ids: /api/compare?ids=a,b" });

  const out = ids.map((id) => {
    const p = getPolitician(id);
    if (!p) return null;
    const c = latestCard("politician", id);
    if (c) return { politician: p, summary: cardCompareSummary(c) };
    const r = latestReport(id); // transition fallback for un-carded reps
    return { politician: p, summary: r ? compareSummary(r) : null };
  }).filter(Boolean);

  if (out.length < 2) return res.status(404).json({ error: "Two valid politicians required." });
  res.json(out);
});

// Flatten a Summarizer card into the comparison fields. All values are the
// card's computed facts — deterministic, source-linked numbers.
function cardCompareSummary(c) {
  const params = {};
  for (const pm of c.parameters ?? []) params[pm.key] = { score: pm.score, label: pm.label };
  const wealth = (c.sections ?? []).find((s) => s.key === "wealth");
  const series = wealth?.series ?? [];
  const latest = series.at(-1);
  const biz = (c.sections ?? []).find((s) => s.key === "business");
  const companies = Number(biz?.stats?.find((st) => /compan/i.test(st.label))?.value ?? 0);
  return {
    generated_at: c.generated_at,
    overall_grade: c.grade,
    overall_score: c.score,
    headline: c.headline,
    parameters: params,
    signals: {}, // dossier-only concept; comparison renders nothing for it
    criminal_cases: c.computed_facts?.criminal_cases ?? null,
    pending_cases: null, convicted_cases: null, // per-case detail not in v1 cards
    net_worth: latest?.display ?? c.computed_facts?.net_worth_display ?? null,
    net_worth_num: latest?.net_worth ?? c.computed_facts?.net_worth ?? null,
    asset_years: series.map((a) => ({ year: a.year, net_worth: a.display, net_worth_num: a.net_worth })),
    companies,
    asset_growth_x: c.computed_facts?.asset_growth_multiple ?? null,
  };
}

// Flatten a report into the fields a comparison cares about. Keeps the payload
// small and the frontend dumb — every comparable metric is pre-extracted here.
// (Transition fallback only — retired with the dossier.)
function compareSummary(r) {
  const params = {};
  for (const pm of r.parameters ?? []) params[pm.key] = { score: pm.score, label: pm.label, verdict: pm.verdict };
  const signals = {};
  for (const s of r.signals ?? []) signals[s.key] = { state: s.state, phrase: s.phrase, label: s.label };
  const assets = (r.assets ?? []).slice().sort((a, b) => String(a.election_year).localeCompare(String(b.election_year)));
  const latestAsset = assets.at(-1);
  return {
    generated_at: r.generated_at,
    overall_grade: r.overall_grade,
    overall_score: r.overall_score,
    headline: r.headline,
    parameters: params,
    signals,
    criminal_cases: (r.cases ?? []).length,
    pending_cases: (r.cases ?? []).filter((c) => c.status === "PENDING").length,
    convicted_cases: (r.cases ?? []).filter((c) => c.status === "CONVICTED").length,
    net_worth: latestAsset?.net_worth ?? null,
    net_worth_num: num(latestAsset?.net_worth),
    asset_years: assets.map((a) => ({ year: a.election_year, net_worth: a.net_worth, net_worth_num: num(a.net_worth) })),
    companies: (r.companies ?? []).length,
    party_switches: (r.party_switches ?? []).length,
    published_patterns: (r.pattern_flags ?? []).filter((f) => f.is_published).length,
    pattern_titles: (r.pattern_flags ?? []).filter((f) => f.is_published).map((f) => ({ title: f.title, severity: f.severity })),
    attendance: r.legislative_record?.attendance_pct ?? null,
    questions: r.legislative_record?.questions_asked ?? null,
    debates: r.legislative_record?.debates ?? null,
  };
}

// ---- Scandals / government accountability ----
// Searchable by level, sector, state, party, and free-text q (task #8).
app.get("/api/scandals", (req, res) => {
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
  res.json(items.filter((s) =>
    (!level  || s.govt_level === level) &&
    (!sector || s.sector === sector) &&
    (!state  || (s.state || "").toLowerCase() === state) &&
    (!party  || (s.party || "").toLowerCase().includes(party)) &&
    (!q      || `${s.title} ${s.headline} ${s.minister} ${s.ministry} ${s.party}`.toLowerCase().includes(q))));
});

// Distinct filter values for the scandal search UI.
app.get("/api/scandals/facets", (_req, res) => {
  const all = listScandals();
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  res.json({
    states: uniq(all.map((s) => s.state)),
    parties: uniq(all.map((s) => s.party)),
    sectors: uniq(all.map((s) => s.sector)),
  });
});

app.get("/api/scandals/:slug", (req, res) => {
  const s = getScandal(req.params.slug);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

// ---- Conflict-of-interest leads: ADMIN-ONLY (Investigator branch) ----
// The Investigator's output is never public. Leads are journalist work-product,
// reviewed at #/admin and shared externally by the owner — see the admin routes.

// ---- Issues: "Where India Stands" (task #5) ----
app.get("/api/issues", asyncH(async (_req, res) => {
  const { listIssues } = await import("./store.js");
  const { ISSUE_SEEDS } = await import("./data/issues.js");
  const done = listIssues();
  const bySlug = {}; for (const i of done) bySlug[i.slug] = i;
  // Return all seeds (so the page shows the full set) annotated with whether
  // an analysis has been generated yet.
  res.json(ISSUE_SEEDS.map((seed) => {
    const i = bySlug[seed.slug];
    return { slug: seed.slug, title: seed.title, icon: seed.icon ?? "", description: seed.description, generated: !!i };
  }));
}));
app.get("/api/issues/:slug", asyncH(async (req, res) => {
  const { getIssue } = await import("./store.js");
  const i = getIssue(req.params.slug);
  if (!i) return res.status(404).json({ error: "not generated yet" });
  res.json(i);
}));

// ---- Stories: ADMIN-ONLY (Investigator branch) ----
// Incident narratives are drafted for journalists, never published on-site.
// Read them via GET /api/admin/stories below.

// ---- Leaderboard: rank reps by various metrics (task #19) ----
app.get("/api/leaderboard", (req, res) => {
  const metric = req.query.metric || "worst";
  // Card-first: one indexed sweep over the latest cards (computed facts), with
  // a legacy-dossier fallback per un-carded rep during the transition.
  const cardRows = new Map(cardLeaderboardRows().map((r) => [r.id, r]));
  const rows = [];
  for (const p of listPoliticians()) {
    if (p.is_demo) continue;
    const c = cardRows.get(p.id);
    if (c) {
      rows.push({
        id: p.id, name: p.name, party: p.party, office: p.office, state: p.state,
        grade: c.grade, score: c.score,
        cases: c.cases ?? 0,
        net_worth: c.net_worth ?? null, net_worth_num: c.net_worth_num ?? null,
        asset_growth_x: c.asset_growth_x ?? null,
      });
      continue;
    }
    const r = latestReport(p.id);
    if (!r) continue;
    const assets = (r.assets ?? []).slice().sort((a, b) => String(a.election_year).localeCompare(String(b.election_year)));
    const first = assets[0], last = assets.at(-1);
    const growth = (first && last && num(first.net_worth) > 0) ? (num(last.net_worth) / num(first.net_worth)) : null;
    rows.push({
      id: p.id, name: p.name, party: p.party, office: p.office, state: p.state,
      grade: r.overall_grade, score: r.overall_score,
      cases: (r.cases ?? []).length,
      net_worth: last?.net_worth ?? null, net_worth_num: num(last?.net_worth),
      asset_growth_x: growth,
    });
  }
  const has = (v) => v != null && !Number.isNaN(v);
  const metrics = {
    worst:        { label: "Lowest accountability score", sort: (a, b) => (a.score ?? 999) - (b.score ?? 999), keep: (r) => has(r.score) && r.score >= 0 },
    best:         { label: "Highest accountability score", sort: (a, b) => (b.score ?? -1) - (a.score ?? -1), keep: (r) => has(r.score) && r.score >= 0 },
    most_cases:   { label: "Most criminal cases declared", sort: (a, b) => b.cases - a.cases, keep: (r) => r.cases > 0 },
    richest:      { label: "Highest declared net worth", sort: (a, b) => (b.net_worth_num ?? -1) - (a.net_worth_num ?? -1), keep: (r) => has(r.net_worth_num) },
    asset_growth: { label: "Fastest asset growth (×)", sort: (a, b) => (b.asset_growth_x ?? -1) - (a.asset_growth_x ?? -1), keep: (r) => has(r.asset_growth_x) },
  };
  const cfg = metrics[metric] ?? metrics.worst;
  const out = rows.filter(cfg.keep).sort(cfg.sort).slice(0, 50);
  res.json({ metric, label: cfg.label, metrics: Object.keys(metrics).map((k) => ({ key: k, label: metrics[k].label })), rows: out });
});

// ---- Follow the money: electoral-bond funding (party-level) ----
app.get("/api/funding/overview", asyncH(async (_req, res) => {
  const { fundingOverview } = await import("./data/electoral-bonds.js");
  res.json(fundingOverview());
}));
app.get("/api/funding/party/:party", asyncH(async (req, res) => {
  const { fundingForParty } = await import("./data/electoral-bonds.js");
  const f = fundingForParty(req.params.party);
  if (!f) return res.status(404).json({ error: "party not in disclosed electoral-bond data" });
  res.json(f);
}));
app.get("/api/politicians/:id/funding", asyncH(async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { fundingForParty } = await import("./data/electoral-bonds.js");
  res.json(fundingForParty(p.party) ?? { party: p.party, unavailable: true });
}));

// Government / ministry / party / government-term accountability scorecards.
// Ministry/party buckets are annotated with their canonical card key (when one
// resolves) so the UI can link each row to its report card.
app.get("/api/scorecards", asyncH(async (_req, res) => {
  const [{ buildScorecards }, { resolveMinistry, resolveParty }] =
    await Promise.all([import("./scorecard.js"), import("./data/ministries.js")]);
  const sc = buildScorecards();
  for (const b of sc.byMinistry) b.card_key = resolveMinistry(b.label)?.key ?? null;
  for (const b of sc.byParty) b.card_key = resolveParty(b.label)?.key ?? null;
  res.json(sc);
}));

// ---- Ministry & party report cards (Summarizer, computed on request) ----
app.get("/api/ministries", asyncH(async (_req, res) => {
  const [{ MINISTRIES, resolveMinistry }] = await Promise.all([import("./data/ministries.js")]);
  const counts = {};
  for (const s of listScandals()) {
    const k = resolveMinistry(s.ministry)?.key;
    if (k) counts[k] = (counts[k] ?? 0) + 1;
  }
  res.json(MINISTRIES.map((m) => ({ key: m.key, name: m.name, scope: m.scope, sectors: m.sectors ?? [], failures: counts[m.key] ?? 0 })));
}));

app.get("/api/ministries/:key(*)/card", asyncH(async (req, res) => {
  try {
    const { buildMinistryCard } = await import("./cards.js");
    res.json(buildMinistryCard(req.params.key));
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "not found" });
  }
}));

app.get("/api/parties", asyncH(async (_req, res) => {
  const { PARTIES, resolveParty } = await import("./data/ministries.js");
  const rosterCounts = {};
  for (const p of listPoliticians()) {
    if (p.is_demo) continue;
    const k = resolveParty(p.party)?.key;
    if (k) rosterCounts[k] = (rosterCounts[k] ?? 0) + 1;
  }
  res.json(PARTIES.map((p) => ({ key: p.key, name: p.name, reps: rosterCounts[p.key] ?? 0 })));
}));

app.get("/api/parties/:key/card", asyncH(async (req, res) => {
  try {
    const { buildPartyCard } = await import("./cards.js");
    res.json(buildPartyCard(req.params.key, req.query.scope || "union"));
  } catch (err) {
    console.error(err);
    res.status(404).json({ error: "not found" });
  }
}));

// Failures on a given politician's watch (links scandals → minister dossier).
// Matches both the stored minister_politician_id and a live name-token match,
// so it works for historical ministers added before linking existed.
app.get("/api/politicians/:id/scandals", asyncH(async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { resolveMinisterPolitician } = await import("./scandal-generator.js");
  const hits = listScandals().filter((s) =>
    s.minister_politician_id === p.id ||
    (s.minister_in_charge?.name && resolveMinisterPolitician(s.minister_in_charge.name) === p.id));
  res.json(hits.map((s) => ({
    slug: s.slug, title: s.title, date: s.date, sector: s.sector, signal: s.signal,
    portfolio: s.minister_in_charge?.portfolio ?? "", ministry: s.ministry,
    verdict: s.accountability?.verdict ?? null, headline: s.headline,
  })));
}));

// ---- Anonymous tips ----
app.get("/api/pow-challenge", (_req, res) => res.json(issueChallenge()));

app.post("/api/politicians/:id/tips", (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });

  const { challenge, nonce, category, text, website } = req.body ?? {};

  // Honeypot: real users never fill this hidden field.
  if (website) return res.status(204).end();

  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  if (!rateLimitTip(ip)) return res.status(429).json({ error: "Too many tips from this connection. Try again later." });

  if (!verifyPow(challenge, nonce)) return res.status(400).json({ error: "Proof-of-work failed or expired. Reload and retry." });
  if (!TIP_CATEGORIES.includes(category)) return res.status(400).json({ error: "Invalid category." });

  const cleaned = sanitizeTip(text);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });

  const tip = addTip({ politician_id: p.id, category, text: cleaned.text });
  res.status(201).json({
    ok: true,
    id: tip.id,
    note: "Received. Tips are human-reviewed and only influence reports once corroborated by verifiable records. No identifying information was stored.",
  });
});

// ---- Admin: trigger report generation ----
app.post("/api/politicians/:id/generate", requireAdmin, asyncH(async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const mode = ["incremental", "full", "recheck"].includes(req.body?.mode) ? req.body.mode : "incremental";
  try {
    const { generateReport } = await import("./report-generator.js");
    const report = await generateReport(p.id, { mode });
    res.json({ ok: true, overall_grade: report.overall_grade, overall_score: report.overall_score, headline: report.headline });
  } catch (err) {
    console.error("[generate-endpoint]", err);
    res.status(500).json({ error: "internal error" });
  }
}));

// ---- Moderation (token-protected) ----

app.get("/api/admin/tips", requireAdmin, (req, res) => {
  res.json(listTips({ status: req.query.status }));
});

app.post("/api/admin/tips/:id/review", requireAdmin, (req, res) => {
  const { status, corroborated } = req.body ?? {};
  if (status && !["approved", "rejected", "pending"].includes(status))
    return res.status(400).json({ error: "bad status" });
  const tip = reviewTip(req.params.id, { status, corroborated });
  if (!tip) return res.status(404).json({ error: "not found" });
  res.json(tip);
});

// ---- Admin: auto-discovered scandal proposals (human neutrality gate) ----
app.get("/api/admin/scandal-proposals", requireAdmin, (_req, res) => res.json(listProposals()));

app.post("/api/admin/scandal-proposals/:slug/approve", requireAdmin, asyncH(async (req, res) => {
  const p = getScandal(req.params.slug);
  if (!p || p.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  try {
    const { generateScandal } = await import("./scandal-generator.js");
    // The proposal already carries the seed fields; generate the full analysis.
    const s = await generateScandal(p);
    res.json({ ok: true, slug: s.slug, verdict: s.accountability?.verdict, signal: s.signal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
}));

app.post("/api/admin/scandal-proposals/:slug/reject", requireAdmin, (req, res) => {
  const p = getScandal(req.params.slug);
  if (!p || p.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  deleteScandal(req.params.slug);
  res.json({ ok: true, rejected: req.params.slug });
});

// ---- Admin: conflict-of-interest investigation leads (Investigator branch) ----
// A lead that survived the L2 Investigator + L3 Referee lands here as
// status:"proposed". NOTHING in this branch is ever public: "approve" now
// means "cleared — shared externally" (with a journalist, off-platform). The
// status enum (detected → proposed → published | dismissed) is unchanged to
// avoid a data migration; 'published' is relabelled in the admin UI.
app.get("/api/admin/investigation-leads", requireAdmin, (_req, res) => res.json(listLeadProposals()));

// All leads regardless of status (the admin's full Investigator work-queue).
app.get("/api/admin/conflicts", requireAdmin, (req, res) => {
  res.json(listLeads(req.query.status ? { status: req.query.status } : {}));
});

// Admin-only directorship network for one politician (Phase 6 / Plans C1+C2). Includes
// Tofler-derived (private) edges, so it is NEVER on the public report — admin route only.
app.get("/api/admin/politicians/:id/directorship-network", requireAdmin, (req, res) => {
  res.json(directorshipNetworkForGraph(req.params.id));
});

// Shared approve/reject mutation for a lead, used by both the #/admin lead
// routes and the ops-console action route. The caller fetches `lead` and
// enforces its own existence/status guards (which differ between routes);
// this performs the common state change and feedback record. On "approve" it
// returns the published lead; on "reject" it deletes and returns null.
function decideLeadShared(lead, decision, source) {
  if (decision === "approve") {
    const published = upsertLead({ ...lead, status: "published", published_at: new Date().toISOString() });
    recordLeadFeedback(lead, "approved", { source });
    return published;
  }
  recordLeadFeedback(lead, "rejected", { source });
  deleteLead(lead.id);
  return null;
}

app.post("/api/admin/investigation-leads/:id/approve", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || lead.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  const published = decideLeadShared(lead, "approve", "admin");
  res.json({ ok: true, id: published.id, vector: published.vector, actor_name: published.actor_name });
});

app.post("/api/admin/investigation-leads/:id/reject", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || lead.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  decideLeadShared(lead, "reject", "admin");
  res.json({ ok: true, rejected: req.params.id });
});

// ---- Admin: incident-centric story drafts (human publish gate) ----
// Stories are generated as status:'draft' and advance draft → proposed →
// published | rejected. They are invisible to /api/stories until published.
app.get("/api/admin/stories", requireAdmin, (req, res) => {
  res.json(listStories({ status: req.query.status ?? "draft" }));
});

app.post("/api/admin/stories/:id/status", requireAdmin, (req, res) => {
  const to = req.body?.status;
  if (!STORY_STATUSES.includes(to)) return res.status(400).json({ error: "bad status" });
  const story = getStory(req.params.id);
  if (!story) return res.status(404).json({ error: "not found" });
  if (!canTransition(story.status, to))
    return res.status(409).json({ error: `illegal transition ${story.status} → ${to}` });
  const updated = upsertStory({ ...story, status: to });
  res.json({ ok: true, id: updated.id, slug: updated.slug, status: updated.status });
});

// ════════════════════════════════════════════════════════════════════════════
// Admin: Ops Console — DB monitoring + command control (all requireAdmin)
// Read endpoints expose store aggregates; the single write endpoint enqueues
// whitelisted jobs onto the existing queue (drained by the in-process worker).
// ════════════════════════════════════════════════════════════════════════════

// Job types the console may enqueue. Anything else is rejected.
const OPS_JOB_TYPES = new Set([
  // Summarizer (free)
  "generate_card", "cards_all",
  // Ingest / maintenance
  "ingest_all", "ingest_politician", "source_health", "roster_update",
  "mega_refresh", "repair_myneta", "cppp_ingest", "reset_data",
  // Analysis store (free extraction + detectors; prose uses the FREE chain only)
  "extract_all", "extract_prose",
  // Investigator (admin-only output; GLM budget)
  "investigate_politician", "investigate_all", "run_synthesis", "draft_stories", "anomaly_scan",
  // Anomaly Engine (free code + free enrichment) + precision GLM trigger
  "engine_scan", "engine_synthesis", "investigate_lead", "cppp_scan",
  // Editorial (GLM, human-gated)
  "discover_scandals",
  // Legacy dossier (transition only)
  "generate_report",
]);
// Destructive types → the exact confirm phrase the UI must echo before enqueue.
const OPS_DANGER = { reset_data: "RESET" };

// Overview tiles: counts, grade histogram, per-source coverage, missing-data gaps.
app.get("/api/admin/ops/summary", requireAdmin, (_req, res) => {
  res.json({ ...statsSummary(), coverage: evidenceCoverage(), missing: politiciansMissing() });
});

// Source health over N days (fetch_runs ledger) classified into rotted/stale.
app.get("/api/admin/ops/health", requireAdmin, asyncH(async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 14));
  const rows = sourceHealth(days);
  try {
    const [{ classifyHealth }, { FETCHER_NAMES }] = await Promise.all([import("./health.js"), import("./ingest.js")]);
    res.json({ days, ...classifyHealth(rows, FETCHER_NAMES) });
  } catch (err) {
    res.json({ days, rows, rotted: [], stale: [], warn: err.message });
  }
}));

// Filtered roster rows (pre-pagination). Shared by the roster grid AND the
// "run on a set" batch endpoint, so the set a filter enqueues is byte-identical
// to the set the grid shows.
function rosterRows({ office, state, hasReport, hasEvidence, q } = {}) {
  const evCounts = evidenceCounts();
  const repFallback = new Map(listPoliticiansWithLatest().map((p) => [p.id, p.latest]));
  let rows = listPoliticiansWithCard().filter((p) => !p.is_demo).map((p) => {
    const latest = p.card ?? repFallback.get(p.id) ?? null;
    return {
      id: p.id, name: p.name, office: p.office ?? "", state: p.state ?? "",
      constituency: p.constituency ?? "", party: p.party ?? "",
      grade: latest?.grade ?? null, score: latest?.score ?? null,
      generated_at: latest?.generated_at ?? null, evidence: evCounts[p.id] ?? 0,
    };
  });
  if (office) rows = rows.filter((p) => p.office.toLowerCase() === String(office).toLowerCase());
  if (state) rows = rows.filter((p) => p.state.toLowerCase() === String(state).toLowerCase());
  if (hasReport === "1") rows = rows.filter((p) => p.grade != null);
  if (hasReport === "0") rows = rows.filter((p) => p.grade == null);
  if (hasEvidence === "1") rows = rows.filter((p) => p.evidence > 0);
  if (hasEvidence === "0") rows = rows.filter((p) => p.evidence === 0);
  if (q) {
    const s = String(q).toLowerCase();
    rows = rows.filter((p) => p.name.toLowerCase().includes(s) || p.constituency.toLowerCase().includes(s));
  }
  return rows;
}

// Clamp copy-pasted page/pageSize query params into a safe range and derive the
// row offset. Preserves the previous inline Math.max/Math.min behavior exactly.
function pageParams(query, { defLimit, maxLimit }) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.max(1, Math.min(maxLimit, Number(query.pageSize) || defLimit));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// Roster explorer: filter/paginate reps + per-rep evidence count and latest grade.
app.get("/api/admin/ops/roster", requireAdmin, (req, res) => {
  const { page, pageSize } = pageParams(req.query, { defLimit: 50, maxLimit: 500 });
  const rows = rosterRows(req.query);
  const total = rows.length;
  const start = (page - 1) * pageSize;
  res.json({ total, page, pageSize, rows: rows.slice(start, start + pageSize) });
});

// Job queue: counts by status + recent jobs (newest first).
app.get("/api/admin/ops/jobs", requireAdmin, (req, res) => {
  const jobs = listJobs({ status: req.query.status })
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
    .slice(0, 200);
  res.json({ counts: jobCounts(), jobs });
});

// One job + its captured live log (poll with ?since=<lastSeq>).
app.get("/api/admin/ops/jobs/:id", requireAdmin, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json({ job, log: opsLogTail(req.params.id, Number(req.query.since) || 0) });
});

// Live log only (lighter poll for the log drawer).
app.get("/api/admin/ops/logs/:id", requireAdmin, (req, res) => {
  res.json(opsLogTail(req.params.id, Number(req.query.since) || 0));
});

// ── Anomaly Engine: status, tuning, dry runs, flags, leads ──────────────────

// Full engine surface: every detector + group, tunables meta, resolved values,
// live flag counts. The ops console renders its Engine + Tuning panels from this.
app.get("/api/admin/ops/engine", requireAdmin, (_req, res) => {
  res.json(engineStatus());
});

// Live threshold editing. Body: { settings: { "engine.<id>.<param>": value | null } }
// null clears the override (back to the code default). Values are validated
// against the detector's tunable metadata before persisting.
app.put("/api/admin/ops/engine/settings", requireAdmin, (req, res) => {
  const changes = req.body?.settings ?? {};
  const applied = [], errors = [];
  for (const [key, raw] of Object.entries(changes)) {
    const m = key.match(/^engine\.([\w-]+)\.([\w-]+)$/);
    const det = m && detectorById(m[1]);
    const meta = det?.tunables?.[m?.[2]];
    if (!meta) { errors.push({ key, error: "unknown setting" }); continue; }
    try {
      applied.push(setSetting(key, raw === null ? null : coerceValue(meta, raw)));
    } catch (err) { errors.push({ key, error: err.message }); }
  }
  res.status(errors.length && !applied.length ? 400 : 200).json({ applied, errors });
});

// Synchronous dry run for threshold tuning: computes candidate flags under the
// CURRENT settings and returns counts + sample headlines — writes nothing.
// Scope with ?detector=<id> (recommended: the full sweep takes ~20s inline).
app.post("/api/admin/ops/engine/dryrun", requireAdmin, asyncH(async (req, res) => {
  try {
    const { detector, politicianId } = req.body ?? {};
    const r = await runEngine({
      dryRun: true,
      detectors: detector ? [detector] : null,
      politicianId: politicianId || null,
      log: () => {},
    });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: "internal error" }); }
}));

// Per-detector precision from the human-decision ledger — the feedback loop's
// report. Suggestion-only; the console shows it, nothing auto-tunes.
app.get("/api/admin/ops/precision", requireAdmin, (req, res) => {
  const minSample = Math.max(1, Number(req.query.minSample) || 5);
  res.json({ minSample, detectors: detectorPrecision({ minSample }) });
});

// Flags browser: filter by detector/severity/status/subject, paginated.
app.get("/api/admin/ops/flags", requireAdmin, (req, res) => {
  const { page, pageSize, offset } = pageParams(req.query, { defLimit: 50, maxLimit: 200 });
  const { total, rows } = listFlags({
    detector: req.query.detector || undefined,
    severity: req.query.severity || undefined,
    status: req.query.status || "active",
    politicianId: req.query.politicianId || undefined,
    q: req.query.q || undefined,
    limit: pageSize, offset,
  });
  res.json({ total, page, pageSize, counts: flagCounts(), rows });
});

app.get("/api/admin/ops/flags/:id", requireAdmin, (req, res) => {
  const flag = getFlag(req.params.id);
  if (!flag) return res.status(404).json({ error: "not found" });
  res.json(flag);
});

// Lead pipeline browser — every status (detected → proposed → published /
// dismissed), searchable, with the full evidence citations in each row.
app.get("/api/admin/ops/leads", requireAdmin, (req, res) => {
  const { page, pageSize } = pageParams(req.query, { defLimit: 50, maxLimit: 200 });
  let rows = listLeads({ status: req.query.status || undefined });
  if (req.query.vector) rows = rows.filter((l) => l.vector === req.query.vector);
  if (req.query.q) {
    const s = String(req.query.q).toLowerCase();
    rows = rows.filter((l) =>
      (l.actor_name ?? "").toLowerCase().includes(s) ||
      (l.headline ?? "").toLowerCase().includes(s) ||
      (l.vector ?? "").toLowerCase().includes(s));
  }
  const byStatus = {};
  for (const l of listLeads({})) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
  const vectors = [...new Set(listLeads({}).map((l) => l.vector))].sort();
  res.json({ total: rows.length, page, pageSize, byStatus, vectors, rows: rows.slice((page - 1) * pageSize, page * pageSize) });
});

// Lead actions from the console. approve/reject mirror the #/admin gate (and
// keep its status rules); investigate enqueues a single-lead GLM job; dismiss
// parks a detected lead without deleting its history.
app.post("/api/admin/ops/leads/:id/action", requireAdmin, (req, res) => {
  const { action } = req.body ?? {};
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ error: "no such lead" });
  if (action === "approve") {
    if (lead.status !== "proposed") return res.status(409).json({ error: "only proposed leads can be approved" });
    const published = decideLeadShared(lead, "approve", "ops");
    return res.json({ ok: true, status: published.status });
  }
  if (action === "reject") {
    if (lead.status !== "proposed") return res.status(409).json({ error: "only proposed leads can be rejected" });
    decideLeadShared(lead, "reject", "ops");
    return res.json({ ok: true, rejected: true });
  }
  if (action === "dismiss") {
    const updated = upsertLead({ ...lead, status: "dismissed", dismissed_at: new Date().toISOString() });
    recordLeadFeedback(lead, "dismissed", { source: "ops" });
    return res.json({ ok: true, status: updated.status });
  }
  if (action === "investigate") {
    const job = enqueueJob({ type: "investigate_lead", payload: { leadId: lead.id } });
    return res.json({ ok: true, jobId: job.id });
  }
  res.status(400).json({ error: `unknown action: ${action}` });
});

// Enqueue a whitelisted job. Destructive types require the exact confirm phrase.
app.post("/api/admin/ops/jobs", requireAdmin, (req, res) => {
  const { type, payload = {} } = req.body ?? {};
  if (!OPS_JOB_TYPES.has(type)) return res.status(400).json({ error: `job type not allowed: ${type}` });
  const requiredPhrase = OPS_DANGER[type];
  if (requiredPhrase) {
    if (payload.confirmPhrase !== requiredPhrase)
      return res.status(400).json({ error: `danger job requires confirmPhrase "${requiredPhrase}"` });
    payload.confirm = true; // the handler's defensive second gate
  }
  const job = enqueueJob({ type, payload });
  res.json({ ok: true, id: job.id, type: job.type, status: job.status });
});

// ── Queue control: pause / cancel / edit / requeue / trim ───────────────────

// Worker state: paused flag, per-status counts, and the running job (if any).
app.get("/api/admin/ops/queue", requireAdmin, (_req, res) => {
  res.json({ paused: isQueuePaused(), counts: jobCounts(), running: listJobs({ status: "running" }) });
});

// Pause/resume the worker. Paused = it stops CLAIMING new jobs; the job already
// running finishes (a serial worker can't be interrupted mid-flight).
app.post("/api/admin/ops/queue/pause", requireAdmin, (req, res) => {
  const paused = !!(req.body?.paused);
  setQueuePaused(paused);
  res.json({ ok: true, paused });
});

// Recover zombie 'running' jobs (orphaned by a crash/restart) back to queued.
// Defaults to only touching jobs stuck >10 min, so a genuinely-active job on a
// live worker is left alone; pass olderThanMinutes:0 to force-reclaim all.
app.post("/api/admin/ops/queue/reclaim", requireAdmin, (req, res) => {
  const mins = req.body?.olderThanMinutes;
  const olderThanMs = mins === 0 ? 0 : Number(mins ?? 10) * 60_000;
  res.json({ ok: true, reclaimed: reclaimRunningJobs({ olderThanMs }) });
});

// Bulk-trim jobs (clear done/dead, drop all queued, etc). Never touches running.
// Registered BEFORE the :id routes so "trim" isn't captured as a job id.
app.post("/api/admin/ops/jobs/trim", requireAdmin, (req, res) => {
  const { status, type, olderThanDays } = req.body ?? {};
  const olderThanMs = olderThanDays != null ? Number(olderThanDays) * 86400_000 : undefined;
  res.json({ ok: true, deleted: trimJobs({ status, type, olderThanMs }) });
});

// Run a whitelisted fan-out over a SPECIFIC SET of reps — explicit ids, or
// everyone matching the current roster filter (resolved server-side so the client
// never has to enumerate the whole roster). Caps the set so a mis-set filter can't
// flood the queue (or the GLM budget).
const BATCH_ACTIONS = {
  ingest:      (ids)          => [enqueueJob({ type: "ingest_all", payload: { politicianIds: ids } })],
  cards:       (ids, payload) => [enqueueJob({ type: "cards_all", payload: { politicianIds: ids, prose: payload?.prose, ingest: payload?.ingest } })],
  engine:      (ids)          => ids.map((pid) => enqueueJob({ type: "engine_scan", payload: { politicianId: pid } })),
  investigate: (ids, payload) => ids.map((pid) => enqueueJob({ type: "investigate_politician", payload: { politicianId: pid, top: payload?.top ?? 10 } })),
};
app.post("/api/admin/ops/jobs/batch", requireAdmin, (req, res) => {
  const { action, politicianIds, filter, payload = {} } = req.body ?? {};
  const fn = BATCH_ACTIONS[action];
  if (!fn) return res.status(400).json({ error: `unknown batch action: ${action}` });
  let ids = Array.isArray(politicianIds) ? politicianIds.filter(Boolean) : null;
  if (!ids || !ids.length) ids = rosterRows(filter ?? {}).map((p) => p.id); // whole current filter
  if (!ids.length) return res.status(400).json({ error: "no reps matched" });
  if (ids.length > 2000) return res.status(400).json({ error: `set too large (${ids.length} > 2000)` });
  // engine/investigate fan out one job PER rep — cap those tighter (queue + $ budget).
  if ((action === "engine" || action === "investigate") && ids.length > 200)
    return res.status(400).json({ error: `${action} on a set is capped at 200 reps (${ids.length} requested) — narrow the filter` });
  const jobs = fn(ids, payload).filter(Boolean);
  res.json({ ok: true, action, reps: ids.length, jobs: jobs.length, ids: jobs.map((j) => j.id) });
});

// Cancel a single QUEUED job (running jobs can't be yanked from a serial worker).
app.post("/api/admin/ops/jobs/:id/cancel", requireAdmin, (req, res) => {
  const r = cancelJob(req.params.id);
  res.status(r.ok ? 200 : 409).json(r);
});

// Re-run a done/dead/failed job (fresh attempt, due now). Danger types must be
// re-enqueued from their own card so the confirm phrase is re-typed.
app.post("/api/admin/ops/jobs/:id/requeue", requireAdmin, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "not found" });
  if (OPS_DANGER[job.type]) return res.status(400).json({ ok: false, error: `re-run ${job.type} from its danger card (needs confirm)` });
  const r = requeueJob(req.params.id);
  res.status(r.ok ? 200 : 409).json(r);
});

// Edit a QUEUED job — priority / run_at / payload. Editing a danger job's payload
// could smuggle past the confirm gate, so that's refused.
app.patch("/api/admin/ops/jobs/:id", requireAdmin, (req, res) => {
  const { priority, payload, runAt } = req.body ?? {};
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "not found" });
  if (payload !== undefined && OPS_DANGER[job.type])
    return res.status(400).json({ ok: false, error: `cannot edit payload of danger job ${job.type}` });
  const r = updateJob(req.params.id, { priority, payload, runAt });
  res.status(r.ok ? 200 : 409).json(r);
});

app.use((err, req, res, next) => {
  console.error("[http]", req.method, req.path, err);
  res.status(500).json({ ok: false, error: "internal error" });
});

if (process.env.PB_NO_LISTEN !== "1") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    console.log(`Pandoro's Box running at http://localhost:${PORT}`);
    // One-launch ops console: run the job worker IN-PROCESS so button-clicks in the
    // console actually execute. The recurring SCHEDULER stays OFF by default (this
    // is a manual-control tool — nothing auto-runs unless OPS_SCHEDULER=1). Disable
    // the worker entirely with OPS_INPROC_WORKER=0 (e.g. to run worker.js separately).
    if (process.env.OPS_INPROC_WORKER !== "0") {
      try {
        const { startInProcessWorker } = await import("./worker.js");
        startInProcessWorker({ scheduler: process.env.OPS_SCHEDULER === "1" });
        console.log(`[ops] in-process worker started (scheduler ${process.env.OPS_SCHEDULER === "1" ? "ON" : "OFF"}). Open /#/ops.`);
      } catch (err) {
        console.error("[ops] failed to start in-process worker:", err.message);
      }
    }
  });
}

export { app };


