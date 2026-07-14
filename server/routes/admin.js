// ════════════════════════════════════════════════════════════════════════════
// Admin: moderation + Investigator work-queue routes (all requireAdmin)
// The admin-gated legacy report routes plus the tips / scandal-proposal /
// investigation-lead / conflict / directorship-network / story routes.
// Split out of server/index.js (Task 5.4) — routes keep their FULL original
// path strings and their original relative registration order.
// ════════════════════════════════════════════════════════════════════════════
import express from "express";
import { requireAdmin } from "../auth.js";
import {
  latestReport, reportHistory, listTips, reviewTip,
  listProposals, getScandal, deleteScandal,
  listLeadProposals, listLeads, getLead,
  listStories, getStory, upsertStory,
} from "../store.js";
import { directorshipNetworkForGraph } from "../directorship-network.js";
import { canTransition, STORY_STATUSES } from "../story-generator.js";
import { decideLeadShared } from "./util.js";

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const router = express.Router();

// Legacy GLM dossiers are a frozen archive (retired in favour of the card).
// Kept admin-only for journalist context; not part of the public surface.
router.get("/api/politicians/:id/report", requireAdmin, (req, res) => {
  const r = latestReport(req.params.id);
  if (!r) return res.status(404).json({ error: "no report yet" });
  res.json(r);
});

router.get("/api/politicians/:id/reports", requireAdmin, (req, res) => res.json(reportHistory(req.params.id)));

// ---- Moderation (token-protected) ----

router.get("/api/admin/tips", requireAdmin, (req, res) => {
  res.json(listTips({ status: req.query.status }));
});

router.post("/api/admin/tips/:id/review", requireAdmin, (req, res) => {
  const { status, corroborated } = req.body ?? {};
  if (status && !["approved", "rejected", "pending"].includes(status))
    return res.status(400).json({ error: "bad status" });
  const tip = reviewTip(req.params.id, { status, corroborated });
  if (!tip) return res.status(404).json({ error: "not found" });
  res.json(tip);
});

// ---- Admin: auto-discovered scandal proposals (human neutrality gate) ----
router.get("/api/admin/scandal-proposals", requireAdmin, (_req, res) => res.json(listProposals()));

router.post("/api/admin/scandal-proposals/:slug/approve", requireAdmin, asyncH(async (req, res) => {
  const p = getScandal(req.params.slug);
  if (!p || p.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  try {
    const { generateScandal } = await import("../scandal-generator.js");
    // The proposal already carries the seed fields; generate the full analysis.
    const s = await generateScandal(p);
    res.json({ ok: true, slug: s.slug, verdict: s.accountability?.verdict, signal: s.signal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  }
}));

router.post("/api/admin/scandal-proposals/:slug/reject", requireAdmin, (req, res) => {
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
router.get("/api/admin/investigation-leads", requireAdmin, (_req, res) => res.json(listLeadProposals()));

// All leads regardless of status (the admin's full Investigator work-queue).
router.get("/api/admin/conflicts", requireAdmin, (req, res) => {
  res.json(listLeads(req.query.status ? { status: req.query.status } : {}));
});

// Admin-only directorship network for one politician (Phase 6 / Plans C1+C2). Includes
// Tofler-derived (private) edges, so it is NEVER on the public report — admin route only.
router.get("/api/admin/politicians/:id/directorship-network", requireAdmin, (req, res) => {
  res.json(directorshipNetworkForGraph(req.params.id));
});

// decideLeadShared moved to ./routes/util.js (shared by these #/admin lead
// routes and the ops-console action route, now in ./routes/admin-ops.js).

router.post("/api/admin/investigation-leads/:id/approve", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || lead.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  const published = decideLeadShared(lead, "approve", "admin");
  res.json({ ok: true, id: published.id, vector: published.vector, actor_name: published.actor_name });
});

router.post("/api/admin/investigation-leads/:id/reject", requireAdmin, (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead || lead.status !== "proposed") return res.status(404).json({ error: "no such proposal" });
  decideLeadShared(lead, "reject", "admin");
  res.json({ ok: true, rejected: req.params.id });
});

// ---- Admin: incident-centric story drafts (human publish gate) ----
// Stories are generated as status:'draft' and advance draft → proposed →
// published | rejected. They are invisible to /api/stories until published.
router.get("/api/admin/stories", requireAdmin, (req, res) => {
  res.json(listStories({ status: req.query.status ?? "draft" }));
});

router.post("/api/admin/stories/:id/status", requireAdmin, (req, res) => {
  const to = req.body?.status;
  if (!STORY_STATUSES.includes(to)) return res.status(400).json({ error: "bad status" });
  const story = getStory(req.params.id);
  if (!story) return res.status(404).json({ error: "not found" });
  if (!canTransition(story.status, to))
    return res.status(409).json({ error: `illegal transition ${story.status} → ${to}` });
  const updated = upsertStory({ ...story, status: to });
  res.json({ ok: true, id: updated.id, slug: updated.slug, status: updated.status });
});

export default router;
