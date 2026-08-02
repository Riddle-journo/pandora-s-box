// Shared LLM plumbing for the generator/analyzer modules.
import OpenAI from "openai";

export const AI_BASE = process.env.AI_BASE_URL || "https://openrouter.ai/api/v1";
export const MODEL   = process.env.AI_MODEL    || "z-ai/glm-5.2";
export const AI_KEY  = process.env.AI_API_KEY  || "";

// OpenRouter ranks callers by these headers; other providers reject unknown ones.
const attribution = { "HTTP-Referer": "https://pandoros-box.app", "X-Title": "Pandoro's Box" };

export function makeClient(baseURL = AI_BASE, apiKey = AI_KEY) {
  return new OpenAI({
    baseURL, apiKey,
    defaultHeaders: baseURL.includes("openrouter") ? attribution : {},
  });
}

// Models wrap JSON in prose or ```json fences; recover the first object either way.
export function parseModelJson(raw) {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "");
  try { return JSON.parse(text); }
  catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model returned no valid JSON.");
    return JSON.parse(m[0]);
  }
}

export const arr = (x) => (Array.isArray(x) ? x : []);

// Rate-limit classifier shared by the paid path (below) and the free chain's
// rotation (free-chain.js imports it from here). Providers sometimes 200-with-
// error or throw generic errors, hence the message sniffing.
export function isRateLimit(err) {
  const s = err?.status ?? err?.code;
  return s === 429 || /rate.?limit|quota|resource_exhausted|too many requests/i.test(err?.message ?? "");
}

const isRetryable = (err) =>
  isRateLimit(err) ||
  (typeof err?.status === "number" && err.status >= 500) ||
  err?.status === undefined; // no HTTP status at all = connection/timeout error

function retryAfterMsFrom(err) {
  const h = err?.headers?.["retry-after"] ?? err?.headers?.get?.("retry-after");
  const secs = Number(h);
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, 30_000) : null;
}

// One retry-and-account loop for every PAID LLM call. Replaces the six
// per-module 2-attempt loops that each reinvented this: 429 honours
// Retry-After (capped 30s), 5xx/connection errors get jittered exponential
// backoff, 400/401/403 fail fast. Every call — success or final failure —
// lands one row in the llm_usage ledger under `module`.
//
//   const response = await callWithRetry(client, params, { module: "report-generator" });
//
// `params` may be a function (attempt) => params, so callers that lower the
// temperature on retry (the malformed-JSON recovery trick) keep doing so.
/**
 * @param {any} client OpenAI-SDK-shaped client (chat.completions.create)
 * @param {object | ((attempt: number) => object)} params
 * @param {{ module?: string, attempts?: number, baseDelayMs?: number,
 *           sleepImpl?: (ms: number) => Promise<void> }} [opts]
 */
export async function callWithRetry(client, params, { module = "unknown", attempts = 3, baseDelayMs = 1000, sleepImpl } = {}) {
  const { recordLlmUsage } = await import("../store/llm-usage.js");
  const sleep = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const p = typeof params === "function" ? params(attempt) : params;
    try {
      const response = await client.chat.completions.create(p);
      const u = response?.usage ?? {};
      recordLlmUsage({
        module, model: p?.model,
        promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, totalTokens: u.total_tokens,
        durationMs: Date.now() - t0, attempts: attempt, ok: true,
      });
      return response;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === attempts) break;
      const backoff = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
      await sleep(retryAfterMsFrom(err) ?? backoff);
    }
  }
  const pFinal = typeof params === "function" ? params(attempts) : params;
  recordLlmUsage({
    module, model: pFinal?.model,
    durationMs: Date.now() - t0, attempts, ok: false, error: lastErr?.message,
  });
  throw lastErr;
}
