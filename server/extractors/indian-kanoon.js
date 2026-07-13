// Indian Kanoon extractor (Phase 2E) — the first extractor to populate the CLAIMS
// and EVENTS ledgers (facts stays untouched here). The evidence is a web-search
// result: "Indian Kanoon returned N judgment(s) matching '<name>'", with the
// judgment list in `content`. The source itself says "verify identity", so this is
// a RAW NAME MATCH, not a verified court record — most hits are namesakes or the
// person merely mentioned. So every judgment becomes:
//   • a CLAIM  named_in_court_judgment — status 'unverified', confidence 0.2 (low),
//              object_text = the case title. The confidence/status are exactly why
//              claims (not facts) is the right home: a detector only escalates one
//              once it is corroborated.
//   • an EVENT court_judgment (dated) — the temporal footprint, identity_unverified
//              flagged in data. (Same-date judgments for one person dedupe.)
import { registerExtractor, runExtraction } from "../extract.js";

export const INDIAN_KANOON_VERSION = "indian-kanoon-v1";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

// "6 June, 2019" → "2019-06-06". Manual parse (no Date()) for determinism.
export function parseKanoonDate(s) {
  const m = String(s ?? "").match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

// Pure: scraped indian_kanoon content → [{ case_title, date }], deduped.
export function kanoonJudgments(content) {
  const chunks = String(content ?? "").split(/•\s*Full Document/i).slice(1); // [0] is the header line
  const out = [];
  const seen = new Set();
  for (const ch of chunks) {
    const m = ch.match(/^\s*(.+?)\s+on\s+(\d{1,2}\s+[A-Za-z]+,?\s+\d{4})/s);
    if (!m) continue;
    const case_title = m[1].replace(/\s+/g, " ").trim().slice(0, 200);
    const date = parseKanoonDate(m[2]);
    const key = `${case_title.toLowerCase()}|${date ?? ""}`;
    if (!case_title || seen.has(key)) continue;
    seen.add(key);
    out.push({ case_title, date });
  }
  return out;
}

registerExtractor("indian_kanoon", {
  version: INDIAN_KANOON_VERSION,
  extract: (ev) => {
    const judgments = kanoonJudgments(ev.data?.content);
    return {
      claims: judgments.map((j) => ({
        claim_type: "named_in_court_judgment",
        object_text: j.case_title,
        as_of_date: j.date,
        status: "unverified",
        confidence: 0.2, // raw name match from a web search; identity unverified
        data: { note: "Indian Kanoon name match — verify identity before use" },
      })),
      events: judgments.map((j) => ({
        kind: "court_judgment",
        at: j.date,
        data: { case_title: j.case_title, identity_unverified: true, confidence: 0.2 },
      })),
    };
  },
});

export function runIndianKanoonExtraction() {
  return runExtraction({ sourceType: "indian_kanoon" });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/indian-kanoon.js");
if (invokedDirectly) {
  console.log("[indian-kanoon] extraction done:", JSON.stringify(runIndianKanoonExtraction()));
  process.exit(0);
}
