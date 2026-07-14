// Paid-LLM usage ledger. Written by llm.js callWithRetry after every paid
// call (success AND final failure); read by the ops console. Append-only
// telemetry — nothing else joins against it.
import { db } from "./db.js";

/**
 * @param {{ module: string, model?: string, promptTokens?: number,
 *           completionTokens?: number, totalTokens?: number,
 *           durationMs?: number, attempts?: number, ok: boolean,
 *           error?: string }} row
 */
export function recordLlmUsage(row) {
  db.prepare(`INSERT INTO llm_usage
    (at, module, model, prompt_tokens, completion_tokens, total_tokens, duration_ms, attempts, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(),
    row.module,
    row.model ?? null,
    row.promptTokens ?? null,
    row.completionTokens ?? null,
    row.totalTokens ?? null,
    row.durationMs ?? null,
    row.attempts ?? null,
    row.ok ? 1 : 0,
    row.error ? String(row.error).slice(0, 500) : null,
  );
}

/**
 * Per-module/per-model token totals over the last `sinceDays` days, plus a
 * grand total — the ops-console LLM-spend panel.
 * @param {{ sinceDays?: number }} [opts]
 */
export function llmUsageSummary({ sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
  const byModule = db.prepare(`
    SELECT module, model,
           COUNT(*)                          AS calls,
           SUM(ok)                           AS ok_calls,
           SUM(COALESCE(prompt_tokens, 0))   AS prompt_tokens,
           SUM(COALESCE(completion_tokens,0)) AS completion_tokens,
           SUM(COALESCE(total_tokens, 0))    AS total_tokens,
           SUM(COALESCE(duration_ms, 0))     AS duration_ms
    FROM llm_usage WHERE at >= ?
    GROUP BY module, model
    ORDER BY total_tokens DESC`).all(since);
  const totals = db.prepare(`
    SELECT COUNT(*)                        AS calls,
           SUM(ok)                         AS ok_calls,
           SUM(COALESCE(total_tokens, 0))  AS total_tokens
    FROM llm_usage WHERE at >= ?`).get(since);
  return { sinceDays, byModule, totals };
}
