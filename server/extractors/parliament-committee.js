// Parliamentary Standing Committee report extractor (Phase 2, "links" pass).
//
// Source: an html-list L1 index of Standing Committee report PDFs (source_type
// `l1_standing_committee_reports`, from the `standing-committee-reports` fetcher).
// These reports scrutinise ministry spending and NAME specific ministries, PSUs,
// projects and firms whose irregularities the committee flags — but the match here
// is a RAW NAME MATCH of a politician against the report body (a committee member,
// a namesake, or a passing mention). Exactly like financial-links.js / indian-
// kanoon.js, that means LOW confidence + identity_unverified, never a hard fact.
//
// Two ledgers, per keep-all / universal-subject:
//   • CLAIMS  — one low-confidence `named_in_committee_report` per matched report
//     row (object_text = the report title/subject).
//   • RELATIONSHIPS — one `named_in_committee_report` edge per ministry / PSU /
//     statutory-body named in that report's body excerpt (dst_kind "org",
//     identity_unverified), so a later cross-entity detector can spot the SAME
//     ministry/PSU recurring across several politicians' reports.
// (No `events` row: committee reports carry no reliable date here, and the events
// ledger dedupes undated rows of the same kind — so a timeline entry would be
// lossy. Claims + relationships are the honest home for this evidence.)
//
// The extractor is a pure function of the evidence blob: it parses the `content`
// string that l1Match() builds for a readBodies source — rows shaped
//   `• <report title> | <pdf url> | <body excerpt>`
// — so it is unit-testable against an inline fixture with no DB.
import { registerExtractor, runExtraction } from "../extract.js";

export const PARLIAMENT_COMMITTEE_VERSION = "parliament-committee-v1";
export const PARLIAMENT_COMMITTEE_SOURCE_TYPE = "l1_standing_committee_reports";

const IDENTITY_NOTE =
  "Raw name match in a committee report — verify identity before treating as a finding (common names collide; may be a committee member, namesake, or passing mention).";

// Pull the named ministries / PSUs / statutory bodies out of a report body excerpt.
// These are the report's SUBJECTS (whose spending the committee scrutinises), not
// the politician — a universal-subject org edge the cross-entity detectors can join.
export function findEntities(text) {
  const found = new Set();
  const t = String(text ?? "");
  const clean = (s) => s.replace(/\s+/g, " ").replace(/^The\s+/i, "").trim();
  // Ministries / Departments — a Capitalized word run after "Ministry/Department of"
  // (stops at a lowercase joiner like "and", so two orgs never merge into one).
  for (const m of t.matchAll(/\b((?:Ministry|Department) of [A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/g)) {
    found.add(clean(m[1]));
  }
  // PSUs / companies / statutory bodies — a Capitalized word run (with optional
  // "of <Capitalized>" tails, e.g. "Corporation of India") that CONTAINS a
  // corporate/statutory keyword. No "and"/"the" joiners, so two adjacent orgs
  // never merge into one span.
  const WORD = "[A-Z][A-Za-z&.\\-]+";
  const RUN = `${WORD}(?:\\s+${WORD})*(?:\\s+of\\s+${WORD}(?:\\s+${WORD})*)?`;
  const KEY = /\b(Limited|Ltd|Corporation|Corpn|Nigam|Company|Authority|Board|Commission|Undertaking|Enterprises?)\b/;
  for (const m of t.matchAll(new RegExp(`\\b(${RUN})`, "g"))) {
    const cand = clean(m[1]);
    if (KEY.test(cand)) found.add(cand);
  }
  return [...found].filter((s) => s.length >= 5 && s.length <= 80).slice(0, 8);
}

// Parse the l1Match content blob into one object per matched report row.
// Row shape: `• <report title> | <pdf url> | <body excerpt>` (body may be absent).
export function parseCommitteeReports(content) {
  const rows = [];
  for (const line of String(content ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*•(.*)$/);
    if (!m) continue;
    // Strip exactly the single "• " separator space (l1Match writes `"• " + cells`),
    // so an EMPTY leading cell (` | url | body`) still splits into an empty title.
    const rest = m[1].startsWith(" ") ? m[1].slice(1) : m[1];
    if (!rest.trim() && !rest.includes("|")) continue;
    const parts = rest.split(" | ");
    const rawTitle = (parts[0] ?? "").trim();
    const url = (parts[1] ?? "").trim();
    const body = parts.slice(2).join(" | ").trim();
    // Fall back to a human-readable title derived from the PDF filename.
    let title = rawTitle;
    if (!title && url) {
      title = (url.split(/[?#]/)[0].split("/").pop() || "")
        .replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
    }
    if (!title && !url && !body) continue;
    rows.push({ title, url: url || null, body, entities: findEntities(body) });
  }
  return rows;
}

// Evidence blob → { claims, events, relationships }.
export function committeeRecords(data = {}) {
  const rows = parseCommitteeReports(data.content);
  if (!rows.length) return {};
  const claims = [], relationships = [];
  for (const r of rows) {
    const subject = (r.title || "committee report").slice(0, 200);
    claims.push({
      claim_type: "named_in_committee_report", object_text: subject,
      status: "unverified", confidence: 0.15,
      data: { url: r.url, entities: r.entities, note: IDENTITY_NOTE },
    });
    for (const ent of r.entities) {
      relationships.push({
        rel_type: "named_in_committee_report", dst_name: ent, dst_kind: "org",
        confidence: 0.15,
        data: { report: subject, url: r.url, source: "parliament_committee", identity_unverified: true },
      });
    }
  }
  return { claims, relationships };
}

registerExtractor(PARLIAMENT_COMMITTEE_SOURCE_TYPE, {
  version: PARLIAMENT_COMMITTEE_VERSION,
  extract: (ev) => committeeRecords(ev.data ?? {}),
});

export function runParliamentCommitteeExtraction() {
  return runExtraction({ sourceType: PARLIAMENT_COMMITTEE_SOURCE_TYPE });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/parliament-committee.js");
if (invokedDirectly) {
  console.log("[parliament-committee] extraction done:", JSON.stringify(runParliamentCommitteeExtraction()));
  process.exit(0);
}
