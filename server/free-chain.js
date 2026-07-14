// Free-model chain — the ONLY LLM plumbing the Summarizer branch may use.
//
// An ordered chain of FREE (provider, model) entries, all OpenAI-compatible.
// Entries whose apiKey env is missing are skipped, so the chain degrades
// gracefully to whatever keys you have. Rotation advances on any rate-limit /
// quota error (60s cooldown per entry). When EVERY entry is unavailable the
// calls return null — callers MUST degrade gracefully (e.g. keep template
// prose). Nothing in this module ever calls a paid model.
//
// NOTE: OpenRouter's free catalogue changes over time (models get retired or
// move to paid). Verify slugs occasionally: GET https://openrouter.ai/api/v1/models
// and keep entries whose pricing.prompt/completion are "0" and id ends ":free".
import "dotenv/config";
import { makeClient, parseModelJson } from "./llm.js";
import { acquire, penalize } from "./util/host-limiter.js";

// Cross-job pacing: parallel card jobs each calling the free chain would burst
// the free-tier providers into 429s. One shared slot per second smooths that
// out; the per-entry 60s cooldown below still handles hard rate-limits.
const FREE_LLM_INTERVAL_MS = 1000;

export const FREE_CHAIN = [
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "openai/gpt-oss-120b:free" },
  { provider: "groq",       baseURL: "https://api.groq.com/openai/v1",                        key: process.env.GROQ_API_KEY, model: "llama-3.3-70b-versatile" },
  { provider: "google",     baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", key: process.env.GEMINI_API_KEY, model: "gemini-2.0-flash" },
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "meta-llama/llama-3.3-70b-instruct:free" },
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "qwen/qwen3-next-80b-a3b-instruct:free" },
  { provider: "openrouter", baseURL: "https://openrouter.ai/api/v1",                          key: process.env.AI_API_KEY,  model: "google/gemma-4-31b-it:free" },
].filter((e) => e.key); // drop entries with no key

// One OpenAI client per distinct (baseURL,key), built lazily and reused.
const _clients = new Map();
function chainClient(entry) {
  const id = `${entry.baseURL}::${entry.key}`;
  if (!_clients.has(id)) _clients.set(id, makeClient(entry.baseURL, entry.key));
  return _clients.get(id);
}

const _cooldownUntil = new Map(); // chain index → epoch ms until which it's skipped
export function isRateLimit(err) {
  const s = err?.status ?? err?.code;
  return s === 429 || /rate.?limit|quota|resource_exhausted|too many requests/i.test(err?.message ?? "");
}

// Try the chain in order, skipping cooling-down entries, rotating on rate-limit.
// Returns { text, model } on success, or null when every entry is unavailable
// (all cooling down / all errored).
export async function freeComplete({ system, user, maxTokens = 4000, temperature = 0.5, tag = "free" }) {
  const now = Date.now();
  const order = FREE_CHAIN
    .map((e, i) => ({ e, i }))
    .filter(({ i }) => (_cooldownUntil.get(i) ?? 0) <= now);
  for (const { e, i } of order) {
    await acquire("free-llm", FREE_LLM_INTERVAL_MS); // shared cross-job gate
    try {
      const res = await chainClient(e).chat.completions.create({
        model: e.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature,
        max_tokens: maxTokens,
      });
      const text = res.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("empty response");
      return { text, model: `${e.provider}:${e.model}` };
    } catch (err) {
      if (isRateLimit(err)) {
        _cooldownUntil.set(i, Date.now() + 60_000); // 60s cooldown, then re-enters rotation
        penalize("free-llm", 5000); // and slow the whole pool's next free call a little
        console.warn(`[${tag}]   ${e.provider}:${e.model} rate-limited → rotating`);
        continue;
      }
      console.warn(`[${tag}]   ${e.provider}:${e.model} failed (${err.message}) → rotating`);
      continue; // non-rate-limit errors: try the next free entry too
    }
  }
  return null; // nothing available right now
}

// Like freeComplete, but parses the reply as JSON (fence-tolerant via
// parseModelJson). Returns { data, model } or null on chain exhaustion /
// unparseable output.
export async function freeJson({ system, user, maxTokens = 4000, temperature = 0.4, tag = "free" }) {
  const out = await freeComplete({ system, user, maxTokens, temperature, tag });
  if (!out) return null;
  try {
    return { data: parseModelJson(out.text), model: out.model };
  } catch (err) {
    console.warn(`[${tag}]   ${out.model} returned unparseable JSON (${err.message})`);
    return null;
  }
}
