// PIB / ministry project-announcement fetcher (C.2). Feeds PROJECT_FRONT_RUNNING
// its missing TIMING half: when did the government ANNOUNCE a project in a
// district? Cross that date against a relative/self property already declared in
// that same district (from the affidavit, A3) and a mere location overlap becomes
// a timing signal — property that predates the announcement.
//
// Free, no key. PIB release pages are plain HTML; we read the ones that name the
// politician (their own announcements) and extract {title, date, state, district,
// ministry}. Parsing is best-effort — district names in free text are noisy — so
// everything downstream treats a project as a LEAD input, never a finding.
import { fetchText, htmlToText, fetchPdfText, mapLimit, contextAround, isPdf, sleep , TIMEOUT_DEFAULT } from "./http.js";
import { noteFetchFailure, noteParseMiss } from "./observe.js";

// Indian states + UTs — used to anchor a location in free release text.
export const STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa",
  "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal", "Delhi", "Jammu and Kashmir",
  "Ladakh", "Puducherry", "Chandigarh", "Andaman and Nicobar",
];

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";

// Pull a date (returns ISO-ish "YYYY-MM-DD" or "YYYY" when only a year is found).
export function extractDate(text) {
  const t = String(text ?? "");
  let m = t.match(new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\s+(20\\d{2})\\b`, "i"));
  if (m) {
    const mi = new RegExp(MONTHS, "i").source.split("|").findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
  }
  m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(20\d{2})\b/);
  return m ? m[1] : null;
}

// Best-effort {state, district} from a release's text.
export function extractLocation(text) {
  const t = String(text ?? "");
  const state = STATES.find((s) => new RegExp(`\\b${s.replace(/ /g, "\\s+")}\\b`, "i").test(t)) ?? null;
  // District: the capitalised token(s) immediately before the word "district".
  let district = null;
  const dm = t.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s+district\b/);
  if (dm) district = dm[1].trim();
  // Fallback: "in <Place>," or "at <Place>," near a project verb.
  if (!district) {
    const im = t.match(/\b(?:in|at)\s+([A-Z][a-zA-Z]+)\b/);
    if (im && !STATES.some((s) => s.toLowerCase() === im[1].toLowerCase())) district = im[1];
  }
  return { state, district };
}

// Parse one release's text into a project record, or null if nothing usable.
export function parseProject(text, { title = null, ministry = null } = {}) {
  const date = extractDate(text);
  const { state, district } = extractLocation(text);
  if (!date && !district) return null; // nothing to time or place a project by
  return {
    title: (title || String(text).split("\n")[0] || "").slice(0, 200).trim(),
    date, state, district, ministry,
  };
}

// PIB release-detail links live behind ASP.NET pages whose paths carry the
// bureau's own (real, long-standing) misspelling "PressRelese" alongside the
// correct "PressRelease" — e.g. PressReleasePage.aspx, PressReleaseIframePage.aspx,
// PressReleseDetail.aspx, PressReleseDetailm.aspx — all keyed by ?PRID=. Anything
// else on the listing (nav, social, photo/video galleries) is not a release.
const RELEASE_HREF = /Press(?:Release|Relese)[\w]*\.aspx/i;

// PURE. Pull the individual press-release links out of a PIB listing page's raw
// HTML and absolutise them against `baseUrl` (default the PIB origin). Returns
// [{title, href}] with duplicates collapsed; never throws, [] on empty/no-match.
export function parseReleaseLinks(html, baseUrl = "https://pib.gov.in") {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/<a\b[^>]*?href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    // href attributes routinely HTML-encode the query separators (&amp;); decode
    // so the resolved URL is actually fetchable, not literal "amp;" in the query.
    const rawHref = m[1].replace(/&amp;/gi, "&").trim();
    if (!RELEASE_HREF.test(rawHref)) continue;
    let href;
    try { href = new URL(rawHref, baseUrl).href; } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    const title = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ title, href });
  }
  return out;
}

export async function fetchPIBProjects(p) {
  if (process.env.PIB_PROJECTS_DISABLE === "1") return [];
  // PIB search-by-name page (best-effort; returns [] silently on any failure).
  const listUrl = process.env.PIB_LIST_URL || "https://pib.gov.in/AllReleasem.aspx";
  let html;
  try { html = await fetchText(listUrl, { timeoutMs: TIMEOUT_DEFAULT, source: "pib_projects" }); }
  catch (err) { noteFetchFailure("pib_projects", "listing", err, { url: listUrl, politician_id: p.id }); return []; }
  if (!html) return [];
  const text = htmlToText(html, 30000);
  const i = text.toLowerCase().indexOf(p.name.toLowerCase());
  if (i < 0) return [];
  const ctx = text.slice(Math.max(0, i - 400), i + p.name.length + 1200);

  // Level 1 — the listing-skim item (the original behaviour). This is also the
  // fallback: if the deep follow-through fails, we return exactly this (or []).
  const listingProject = parseProject(ctx, { title: `PIB release mentioning ${p.name}`, ministry: p.office || null });
  const listingItem = listingProject ? {
    politician_id: p.id,
    source_type: "project_announcement",
    tier: 4,
    admissible: true,
    title: `Project/scheme announcement — ${p.name}`,
    url: listUrl,
    date: listingProject.date,
    summary: `A government project/scheme announcement associated with ${p.name}${listingProject.district ? ` (district: ${listingProject.district})` : ""}. Used only to time declared-property overlaps — a lead input, not a finding.`,
    content: ctx.slice(0, 4000),
    numbers: { projects: [listingProject] },
  } : null;

  // Level 2 — follow through to the FULL press-release body. Best-effort and
  // fail-silent: any error here degrades to the listing-skim behaviour above.
  let deepItems = [];
  try {
    const parsed = Number.parseInt(process.env.PIB_FULLTEXT_LIMIT ?? "4", 10);
    const limit = Number.isFinite(parsed) && parsed >= 0 ? parsed : 4;
    const links = parseReleaseLinks(html, "https://pib.gov.in").slice(0, limit);
    const fetched = await mapLimit(links, 3, async (link) => {
      await sleep(700); // polite pacing between PIB hits
      const body = isPdf(link.href)
        ? await fetchPdfText(link.href, { maxLen: 6000 })
        : htmlToText(await fetchText(link.href, { timeoutMs: TIMEOUT_DEFAULT }), 6000);
      const excerpt = contextAround(body, p.name, 800);
      if (!excerpt) return null; // the release doesn't actually name the politician
      const proj = parseProject(excerpt, { title: link.title || `PIB release naming ${p.name}`, ministry: p.office || null });
      return {
        politician_id: p.id,
        source_type: "project_announcement",
        tier: 4,
        admissible: true,
        title: `Project/scheme announcement — ${link.title ? link.title.slice(0, 160) : p.name}`,
        url: link.href,
        date: proj?.date ?? null,
        summary: `Full text of a PIB release naming ${p.name}${proj?.district ? ` (district: ${proj.district})` : ""}. Used only to time declared-property overlaps — a lead input, not a finding.`,
        content: excerpt.slice(0, 4000),
        numbers: { projects: proj ? [proj] : [] },
      };
    });
    deepItems = fetched.filter(Boolean);
  } catch (err) {
    // Degrading to the listing-skim item drops every release BODY, which is
    // the part the extractor actually reads — never do that silently.
    noteFetchFailure("pib_projects", "release_bodies", err, { politician_id: p.id, url: listUrl });
    deepItems = [];
  }

  const out = [];
  if (listingItem) out.push(listingItem);
  out.push(...deepItems);
  return out;
}
