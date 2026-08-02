// Parliament activity extractor (Phase 2F). Legislative-diligence counts from the
// three parliament sources that carry a countable line in `content`:
//   parliament_questions  — "Asked N question(s) in the 18th Lok Sabha."  → questions_asked
//   parliament_debates    — "Participated in N debate(s)."                → debates_participated
//   parliament_assurances — a bulleted list of assurances                → assurances_count
// (parliament_ls / parliament_rs are bare membership records — no activity count —
// so they get no fact here.) These pair with MPLADS to profile an MP's engagement.
import { registerExtractor, runExtraction } from "./extract.js";

export const PARLIAMENT_VERSION = "parliament-v1";

// "…in the 18th Lok Sabha" → "LS18". No term found → null.
function termPeriod(text) {
  const m = String(text ?? "").match(/(\d+)(?:st|nd|rd|th)\s+Lok\s+Sabha/i);
  return m ? `LS${m[1]}` : null;
}

export function questionsFacts(content) {
  const t = String(content ?? "");
  const m = t.match(/Asked\s+(\d+)\s+question/i);
  return m ? [{ metric: "questions_asked", value: Number(m[1]), unit: "count", period: termPeriod(t) }] : [];
}

export function debatesFacts(content) {
  const t = String(content ?? "");
  const m = t.match(/Participated\s+in\s+(\d+)\s+debate/i);
  return m ? [{ metric: "debates_participated", value: Number(m[1]), unit: "count", period: termPeriod(t) }] : [];
}

export function assurancesFacts(content) {
  const t = String(content ?? "");
  const n = (t.match(/^\s*[•\-•]/gm) ?? []).length; // count bulleted assurance items
  return n ? [{ metric: "assurances_count", value: n, unit: "count" }] : [];
}

registerExtractor("parliament_questions", { version: PARLIAMENT_VERSION, extract: (ev) => ({ facts: questionsFacts(ev.data?.content) }) });
registerExtractor("parliament_debates", { version: PARLIAMENT_VERSION, extract: (ev) => ({ facts: debatesFacts(ev.data?.content) }) });
registerExtractor("parliament_assurances", { version: PARLIAMENT_VERSION, extract: (ev) => ({ facts: assurancesFacts(ev.data?.content) }) });

export function runParliamentExtraction() {
  return {
    questions: runExtraction({ sourceType: "parliament_questions" }),
    debates: runExtraction({ sourceType: "parliament_debates" }),
    assurances: runExtraction({ sourceType: "parliament_assurances" }),
  };
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/parliament.js");
if (invokedDirectly) {
  console.log("[parliament] extraction done:", JSON.stringify(runParliamentExtraction()));
  process.exit(0);
}
