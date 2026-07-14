// Load .env by a path relative to THIS FILE, not process.cwd() — "dotenv/config"
// alone resolves against the caller's working directory, which silently finds
// nothing (ADMIN_TOKEN/AI_API_KEY undefined) when the process is launched from
// a different cwd (e.g. the dev-preview harness launches from the parent folder).
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { createRequire } from "node:module";
import express from "express";
import compression from "compression";
const pkgVersion = createRequire(import.meta.url)("../package.json").version;
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
import adminOpsRouter from "./routes/admin-ops.js";
import adminRouter from "./routes/admin.js";
import contentRouter from "./routes/content.js";
import { decideLeadShared, asyncH } from "./routes/util.js";

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => { console.error("[uncaughtException]", err); process.exit(1); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Currency-string parser shared by report/leaderboard summarization helpers below.
const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/[\d.]+/); return m ? Number(m[0]) : null; };
const app = express();
// gzip every compressible response (JSON payloads here reach hundreds of KB);
// must be registered before static so assets compress too.
app.use(compression());
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
    res.json({
      ok: pingDb(),
      uptime: Math.round(process.uptime()),
      version: pkgVersion,
      queue: jobCounts(),
    });
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

// Admin moderation + Investigator work-queue routes (incl. the admin-gated
// legacy report routes) split out to ./routes/admin.js (Task 5.4). Mounted here
// — where the first moved route (GET /api/politicians/:id/report) used to
// register — so route order is preserved. The router keeps the full original
// path strings, so no mount prefix.
app.use(adminRouter);
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

// Public content routes (scandals, issues, funding, scorecards, ministry/party
// cards, politician-watch scandals) split out to ./routes/content.js (Task 5.5).
// Mounted here — where the first moved route (GET /api/scandals) used to
// register — so route order is preserved (incl. /api/scandals/facets before
// /api/scandals/:slug). The router keeps the full original path strings, so no
// mount prefix.
app.use(contentRouter);

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

// ════════════════════════════════════════════════════════════════════════════
// Admin: Ops Console — DB monitoring + command control (all requireAdmin)
// Read endpoints expose store aggregates; the single write endpoint enqueues
// whitelisted jobs onto the existing queue (drained by the in-process worker).
// ════════════════════════════════════════════════════════════════════════════

// Ops Console routes (~20 "/api/admin/ops/*" endpoints) split out to
// ./routes/admin-ops.js (Task 5.3). Mounted here — where the first ops route
// used to register — so route order is preserved. The router keeps the full
// original path strings, so no mount prefix.
app.use(adminOpsRouter);

app.use((err, req, res, next) => {
  console.error("[http]", req.method, req.path, err);
  res.status(500).json({ ok: false, error: "internal error" });
});

if (process.env.PB_NO_LISTEN !== "1") {
  const { validateStartupConfig } = await import("./config.js");
  const { fatal, warnings } = validateStartupConfig();
  for (const w of warnings) console.warn(`[config] WARNING: ${w}`);
  if (fatal.length > 0) {
    for (const f of fatal) console.error(`[config] FATAL: ${f}`);
    process.exit(1);
  }
  const PORT = process.env.PORT || 3000;
  let stopWorker = null;
  const server = app.listen(PORT, async () => {
    console.log(`Pandoro's Box running at http://localhost:${PORT}`);
    // One-launch ops console: run the job worker IN-PROCESS so button-clicks in the
    // console actually execute. The recurring SCHEDULER stays OFF by default (this
    // is a manual-control tool — nothing auto-runs unless OPS_SCHEDULER=1). Disable
    // the worker entirely with OPS_INPROC_WORKER=0 (e.g. to run worker.js separately).
    if (process.env.OPS_INPROC_WORKER !== "0") {
      try {
        const { startInProcessWorker } = await import("./worker.js");
        stopWorker = startInProcessWorker({ scheduler: process.env.OPS_SCHEDULER === "1" });
        console.log(`[ops] in-process worker started (scheduler ${process.env.OPS_SCHEDULER === "1" ? "ON" : "OFF"}). Open /#/ops.`);
      } catch (err) {
        console.error("[ops] failed to start in-process worker:", err.message);
      }
    }
  });

  // Graceful shutdown: stop claiming jobs (in-flight ones drain), stop accepting
  // connections, checkpoint + close the DB, then exit. A second signal — or a
  // drain that takes >10s — force-exits. (worker.js's own SIGINT handler only
  // runs when worker.js is the entrypoint, so there's no double handling here.)
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) { console.error(`[shutdown] second ${signal} — forcing exit`); process.exit(130); }
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining…`);
    setTimeout(() => { console.error("[shutdown] drain timed out after 10s — forcing exit"); process.exit(1); }, 10_000).unref();
    try { if (typeof stopWorker === "function") stopWorker(); } catch (err) { console.error("[shutdown] stopWorker:", err.message); }
    server.close(async () => {
      try {
        const { closeDb } = await import("./store/db.js");
        closeDb();
      } catch (err) {
        console.error("[shutdown] closeDb:", err.message);
      }
      console.log("[shutdown] clean exit");
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

export { app };


