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
