// Load .env by a path relative to THIS FILE, not process.cwd() — "dotenv/config"
// alone resolves against the caller's working directory, which silently finds
// nothing (ADMIN_TOKEN/AI_API_KEY undefined) when the process is launched from
// a different cwd (e.g. the dev-preview harness launches from the parent folder).
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import express from "express";
import crypto from "node:crypto";
import {
  listPoliticians, listPoliticiansWithLatest, getPolitician, listEvidence,
  latestReport, reportHistory, addTip, listTips, reviewTip,
  listScandals, getScandal, listProposals, deleteScandal,
  listLeads, getLead, listLeadProposals, deleteLead, upsertLead,
  listStories, getStory, upsertStory,
} from "./store.js";
import { canTransition, STORY_STATUSES } from "./story-generator.js";
import { issueChallenge, verifyPow, rateLimitTip, sanitizeTip, TIP_CATEGORIES } from "./safeguards.js";
import { PARAMETERS, SCORING, DOSSIER_CATEGORIES } from "./report-generator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

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
app.get("/api/parameters", (_req, res) => res.json(PARAMETERS));
app.get("/api/methodology", (_req, res) => res.json({ parameters: PARAMETERS, scoring: SCORING, dossier_categories: DOSSIER_CATEGORIES }));
app.get("/api/tip-categories", (_req, res) => res.json(TIP_CATEGORIES));

app.get("/api/politicians", (_req, res) => {
  res.json(listPoliticiansWithLatest());
});

app.get("/api/politicians/:id", (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json(p);
});

app.get("/api/politicians/:id/report", (req, res) => {
  const r = latestReport(req.params.id);
  if (!r) return res.status(404).json({ error: "no report yet" });
  res.json(r);
});

app.get("/api/politicians/:id/reports", (req, res) => res.json(reportHistory(req.params.id)));
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
    const r = latestReport(id);
    return { politician: p, summary: r ? compareSummary(r) : null };
  }).filter(Boolean);

  if (out.length < 2) return res.status(404).json({ error: "Two valid politicians required." });
  res.json(out);
});

// Flatten a report into the fields a comparison cares about. Keeps the payload
// small and the frontend dumb — every comparable metric is pre-extracted here.
function compareSummary(r) {
  const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/[\d.]+/); return m ? Number(m[0]) : null; };
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

// ---- Conflict-of-interest leads (published ONLY — never proposed/detected) ----
// A lead reaches the public ONLY after: L1 detector -> L2 investigator -> L3
// referee survives -> a human explicitly approves it via the admin queue below.
app.get("/api/conflicts", (_req, res) => {
  res.json(listLeads({ status: "published" }));
});

app.get("/api/politicians/:id/conflicts", (req, res) => {
  res.json(listLeads({ status: "published" }).filter((l) => l.actor_id === req.params.id));
});

// ---- Issues: "Where India Stands" (task #5) ----
app.get("/api/issues", async (_req, res) => {
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
});
app.get("/api/issues/:slug", async (req, res) => {
  const { getIssue } = await import("./store.js");
  const i = getIssue(req.params.slug);
  if (!i) return res.status(404).json({ error: "not generated yet" });
  res.json(i);
});

// ---- Stories: incident-centric narrative articles (published only) ----
app.get("/api/stories", (_req, res) => res.json(listStories({ status: "published" })));
app.get("/api/stories/:slug", (req, res) => {
  const s = getStory(req.params.slug);
  if (!s || s.status !== "published") return res.status(404).json({ error: "not found" });
  res.json(s);
});

// ---- Leaderboard: rank reps by various metrics (task #19) ----
app.get("/api/leaderboard", (req, res) => {
  const metric = req.query.metric || "worst";
  const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/[\d.]+/); return m ? Number(m[0]) : null; };
  const rows = [];
  for (const p of listPoliticians()) {
    if (p.is_demo) continue;
    const r = latestReport(p.id);
    if (!r) continue;
    const assets = (r.assets ?? []).slice().sort((a, b) => String(a.election_year).localeCompare(String(b.election_year)));
    const first = assets[0], last = assets.at(-1);
    const growth = (first && last && num(first.net_worth) > 0) ? (num(last.net_worth) / num(first.net_worth)) : null;
    rows.push({
      id: p.id, name: p.name, party: p.party, office: p.office, state: p.state,
      grade: r.overall_grade, score: r.overall_score,
      cases: (r.cases ?? []).length,
      pending: (r.cases ?? []).filter((c) => c.status === "PENDING").length,
      net_worth: last?.net_worth ?? null, net_worth_num: num(last?.net_worth),
      asset_growth_x: growth,
      patterns: (r.pattern_flags ?? []).filter((f) => f.is_published).length,
      attendance: num(r.legislative_record?.attendance_pct),
      questions: num(r.legislative_record?.questions_asked),
    });
  }
  const has = (v) => v != null && !Number.isNaN(v);
  const metrics = {
    worst:        { label: "Lowest accountability score", sort: (a, b) => (a.score ?? 999) - (b.score ?? 999), keep: (r) => has(r.score) && r.score >= 0 },
    best:         { label: "Highest accountability score", sort: (a, b) => (b.score ?? -1) - (a.score ?? -1), keep: (r) => has(r.score) && r.score >= 0 },
    most_cases:   { label: "Most criminal cases declared", sort: (a, b) => b.cases - a.cases, keep: (r) => r.cases > 0 },
    richest:      { label: "Highest declared net worth", sort: (a, b) => (b.net_worth_num ?? -1) - (a.net_worth_num ?? -1), keep: (r) => has(r.net_worth_num) },
    asset_growth: { label: "Fastest asset growth (×)", sort: (a, b) => (b.asset_growth_x ?? -1) - (a.asset_growth_x ?? -1), keep: (r) => has(r.asset_growth_x) },
    most_patterns:{ label: "Most flagged patterns", sort: (a, b) => b.patterns - a.patterns, keep: (r) => r.patterns > 0 },
    most_active:  { label: "Most questions asked", sort: (a, b) => (b.questions ?? -1) - (a.questions ?? -1), keep: (r) => has(r.questions) },
  };
  const cfg = metrics[metric] ?? metrics.worst;
  const out = rows.filter(cfg.keep).sort(cfg.sort).slice(0, 50);
  res.json({ metric, label: cfg.label, metrics: Object.keys(metrics).map((k) => ({ key: k, label: metrics[k].label })), rows: out });
});

// ---- Follow the money: electoral-bond funding (party-level) ----
app.get("/api/funding/overview", async (_req, res) => {
  const { fundingOverview } = await import("./data/electoral-bonds.js");
  res.json(fundingOverview());
});
app.get("/api/funding/party/:party", async (req, res) => {
  const { fundingForParty } = await import("./data/electoral-bonds.js");
  const f = fundingForParty(req.params.party);
  if (!f) return res.status(404).json({ error: "party not in disclosed electoral-bond data" });
  res.json(f);
});
app.get("/api/politicians/:id/funding", async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const { fundingForParty } = await import("./data/electoral-bonds.js");
  res.json(fundingForParty(p.party) ?? { party: p.party, unavailable: true });
});

// Government / ministry / party / government-term accountability scorecards.
app.get("/api/scorecards", async (_req, res) => {
  const { buildScorecards } = await import("./scorecard.js");
  res.json(buildScorecards());
});

// Failures on a given politician's watch (links scandals → minister dossier).
// Matches both the stored minister_politician_id and a live name-token match,
// so it works for historical ministers added before linking existed.
app.get("/api/politicians/:id/scandals", async (req, res) => {
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
});

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
app.post("/api/politicians/:id/generate", requireAdmin, async (req, res) => {
  const p = getPolitician(req.params.id);
  if (!p) return res.status(404).json({ error: "not found" });
  const mode = ["incremental", "full", "recheck"].includes(req.body?.mode) ? req.body.mode : "incremental";
  try {
    const { generateReport } = await import("./report-generator.js");
    const report = await generateReport(p.id, { mode });
    res.json({ ok: true, overall_grade: report.overall_grade, overall_score: report.overall_score, headline: report.headline });
  } catch (err) {
    console.error("[generate-endpoint]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Moderation (token-protected) ----
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || "";
  const expected = process.env.ADMIN_TOKEN || "";
  const ok =
    expected.length > 0 &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  next();
}

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

app.post("/api/admin/scandal-proposals/:slug/approve", requireAdmin, async (req, res) => {
  const p = getScandal(req.params.slug);
  if (!p || p.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  try {
    const { generateScandal } = await import("./scandal-generator.js");
    // The proposal already carries the seed fields; generate the full analysis.
    const s = await generateScandal(p);
    res.json({ ok: true, slug: s.slug, verdict: s.accountability?.verdict, signal: s.signal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/scandal-proposals/:slug/reject", requireAdmin, (req, res) => {
  const p = getScandal(req.params.slug);
  if (!p || p.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  deleteScandal(req.params.slug);
  res.json({ ok: true, rejected: req.params.slug });
});

// ---- Admin: conflict-of-interest investigation leads (human gate) ----
// A lead that survived the L2 Investigator + L3 Referee lands here as
// status:"proposed". It is invisible to /api/conflicts until explicitly
// approved — the same neutrality/defamation gate as scandal proposals.
app.get("/api/admin/investigation-leads", requireAdmin, (_req, res) => res.json(listLeadProposals()));

app.post("/api/admin/investigation-leads/:id/approve", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || lead.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  const published = upsertLead({ ...lead, status: "published", published_at: new Date().toISOString() });
  res.json({ ok: true, id: published.id, vector: published.vector, actor_name: published.actor_name });
});

app.post("/api/admin/investigation-leads/:id/reject", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || lead.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  deleteLead(req.params.id);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Pandoro's Box running at http://localhost:${PORT}`);
  // Report generation is run manually (node server/report-generator.js …).
  // The weekly cron scheduler has been removed; set it up later if wanted.
});


