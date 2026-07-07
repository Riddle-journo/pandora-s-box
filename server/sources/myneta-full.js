// MyNeta full-affidavit scraper — fetches the ACTUAL CONTENTS of a candidate's
// sworn ECI affidavit page (not just a pointer): every criminal case with its
// FIR/case number, court, and IPC/BNS sections; education; profession; and the
// asset/liability totals. Returns one evidence item carrying real `content`
// text that GLM reads directly.
//
// This is the richest court-admissible content we can fetch reliably, and we
// already hold all ~3,600 candidate URLs from the bulk import.

import { parseRupees } from "../util/numbers.js";
import { textToSector } from "../data/sectors.js";

const UA = { "User-Agent": "Mozilla/5.0 (PandorosBox public-accountability research)" };

const strip = (s) =>
  (s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();

// Pull every <tr> of a table by id into arrays of cell-text.
function tableRows(html, tableId) {
  const m = html.match(new RegExp(`<table[^>]*id=['"]?${tableId}['"]?[^>]*>([\\s\\S]*?)</table>`, "i"));
  if (!m) return [];
  return [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(([, row]) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(([, c]) => strip(c)))
    .filter((cells) => cells.length > 1);
}

// Grab the text after a label, cut at the earliest of the given stop strings.
function fieldAfter(html, label, stops = [], maxLen = 240) {
  const i = html.indexOf(label);
  if (i < 0) return null;
  let chunk = strip(html.slice(i + label.length, i + label.length + maxLen * 8));
  for (const stop of stops) {
    const j = chunk.indexOf(stop);
    if (j > 0) chunk = chunk.slice(0, j);
  }
  return chunk.trim().slice(0, maxLen) || null;
}

// ── Affidavit company & property extraction (A3 / C.0) ──────────────────
// The movable- and immovable-asset tables share the layout:
//   [Sr, Description, self, spouse, huf, dependent1, dependent2, dependent3, total]
// so the column a value sits in tells us WHO owns it. This is the richest
// untapped source for the conflict engine: which companies/property the
// candidate + spouse + dependents actually hold, and where.
const OWNER_COL = { 2: "self", 3: "spouse", 4: "huf", 5: "dependent", 6: "dependent", 7: "dependent" };
// A declared rupee value as MyNeta prints it: "6,90,91,90,000 690 Cr" / "67,49,000 67 Lacs+".
const VAL_RE = /[\d,]{5,}[^A-Za-z]*(?:thou|lac|lakh|crore|cr)s?\+?/gi;
const isNil = (s) => !s || /^nil$/i.test(String(s).trim());
// Firms almost always end in one of these — keeps only real company names.
const FIRM_RE = /\b(ltd|limited|llp|pvt|private|incorporated|company|industr|mills|corp|infra|enterpris|holding|ventur|associat|trust|foundation|bank|finance|fintech|motors|steel|power|cement|chemical|pharma|textil|agro|buildcon|realty|estate|developer|distiller|sugar|brewer|mines|mineral|energy|solar|petroleum|technolog|systems|solutions|advisory|hospitality|resorts?)\b/i;

function extractCompanyNames(cell) {
  if (isNil(cell)) return [];
  // Split on each declared value AND on standalone "0" (a zero-value holding —
  // MyNeta lists many, and without this the firm names mush together).
  return cell
    .split(/[\d,]{5,}[^A-Za-z]*(?:thou|lac|lakh|crore|cr)s?\+?|(?:^|\s)0(?=\s|$)/gi)
    .map((s) => s
      .replace(/^[a-z](?=[A-Z])/, "")            // stray list-marker letter, e.g. "lReceivable"
      .replace(/^(?:receivable from|loan to|advance to|due from|debentures?[-\s]*)/i, "")
      .replace(/\bm\/s\.?\s*/gi, "")
      .replace(/^[^A-Za-z]+/, "")                // drop leading roman numeral / punctuation
      .replace(/\s+/g, " ").trim())
    .filter((n) => n.length >= 4 && FIRM_RE.test(n));
}

// Movable-asset "shares/bonds/loans-to-firms" rows → declared company interests.
function parseInterests(html) {
  const out = []; const seen = new Set();
  for (const r of tableRows(html, "movable_assets")) {
    const desc = (r[1] ?? "").toLowerCase();
    if (!/shares in companies|bonds|debenture|personal loan|advance given/.test(desc)) continue;
    for (const col of [2, 3, 4, 5, 6, 7]) {
      for (const name of extractCompanyNames(r[col])) {
        const key = `${name.toLowerCase()}|${OWNER_COL[col]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, owner: OWNER_COL[col], sector: textToSector(name) });
      }
    }
  }
  return out;
}

// Immovable-asset rows → declared property with location + district + value.
function parseProperties(html) {
  const out = [];
  for (const r of tableRows(html, "immovable_assets")) {
    const desc = r[1] ?? "";
    if (!desc || /^total/i.test(desc) || /^sr\s*no/i.test(desc) || /^description/i.test(desc)) continue;
    for (const col of [2, 3, 4, 5, 6, 7]) {
      const cell = r[col];
      if (isNil(cell)) continue;
      const vals = [...cell.matchAll(VAL_RE)];
      const last = vals.length ? vals[vals.length - 1] : null;
      // The exact rupee figure is the long comma-number; the trailing "N Crore+"
      // is a decorative approximation — parse ONLY the number (never the scale
      // word, which would multiply an already-full figure by a crore).
      const numOnly = last ? (last[0].match(/[\d,]{5,}/) ?? [])[0] : null;
      const value_rupees = numOnly ? parseRupees(numOnly) : null;
      // Location is the text before the value, cut at MyNeta's boilerplate
      // sub-labels ("Total Area", "Built Up", "Whether Inherited"…) that bleed in.
      const location = (last ? cell.slice(0, last.index) : cell)
        .split(/\b(?:total area|built up|whether inherited|self acquired|purchas|inherited)\b/i)[0]
        .replace(/[\s,.]+$/, "").replace(/\s+/g, " ").trim();
      if (location.length < 3) continue;
      const dm = location.match(/dist(?:t|rict)?[:\-.\s]+([a-z. ]{3,30})/i);
      const district = dm ? dm[1].replace(/[.\s]+$/, "").trim()
        : ((location.split(",").map((s) => s.trim()).filter(Boolean).pop()) ?? "").slice(0, 40);
      out.push({ property_type: desc, location: location.slice(0, 120), district, value_rupees, owner: OWNER_COL[col] });
    }
  }
  return out;
}

export async function fetchMyNetaProfile(p) {
  if (!p.myneta_url) return [];
  let html;
  try {
    const res = await fetch(p.myneta_url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    html = await res.text();
  } catch { return []; }

  const lines = [];

  // ── Criminal cases ──────────────────────────────────────────────────
  const crimCount = html.match(/Criminal Cases:\s*<\/?[^>]*>?\s*(\d+)/i)?.[1]
                 ?? strip(html.match(/Criminal Cases:[\s\S]{0,40}/i)?.[0] ?? "").match(/(\d+)/)?.[1];
  if (crimCount != null) {
    lines.push(`CRIMINAL CASES DECLARED: ${crimCount} (charges, not convictions).`);
    const rows = tableRows(html, "cases");
    // First row is the header; data rows follow. Columns (typical):
    // Serial | FIR No | Case No | Court | IPC Sections | Other Acts | Charges Framed | Date | Appeal | Status
    for (const r of rows.slice(1)) {
      if (r.length < 5) continue;
      const [, fir, caseNo, court, ipc, otherActs, charges] = r;
      const parts = [
        fir && fir !== "-" ? `FIR ${fir}` : null,
        caseNo && caseNo !== "-" ? `Case ${caseNo}` : null,
        court ? `Court: ${court}` : null,
        ipc ? `IPC/BNS sections: ${ipc}` : null,
        otherActs && otherActs.length > 1 && otherActs !== "-" ? `Other acts: ${otherActs}` : null,
        charges ? `Charges framed: ${charges}` : null,
      ].filter(Boolean);
      if (parts.length) lines.push(`  • ${parts.join("; ")}.`);
    }
  }

  // ── Education ────────────────────────────────────────────────────────
  const edu = fieldAfter(html, "Educational Details", ["Details of PAN", "Self Profession", "PAN and status"], 200);
  if (edu) lines.push(`EDUCATION: ${edu.replace(/^Category:\s*/i, "")}.`);

  // ── Profession ───────────────────────────────────────────────────────
  const prof = fieldAfter(html, "Self Profession:", ["Other Elections", "Movable", "Liabilities", "Disclaimer"], 140);
  if (prof) lines.push(`PROFESSION: ${prof}.`);

  // ── Assets & liabilities ─────────────────────────────────────────────
  // MyNeta renders these as `Assets: </td><td> <b>Rs&nbsp;20,39,61,862</b>` —
  // HTML tags and &nbsp; sit between the label and the figure, so the match
  // must skip markup (the old strict regex silently missed most pages).
  const GAP = String.raw`(?:<[^>]*>|&nbsp;|\s)*`;
  const totalAssets = html.match(new RegExp(`Assets:${GAP}Rs${GAP}([\\d,]+)`, "i"))?.[1];
  const totalLiab   = html.match(new RegExp(`Liabilities:${GAP}Rs${GAP}([\\d,]+)`, "i"))?.[1];
  if (totalAssets) lines.push(`TOTAL DECLARED ASSETS: Rs ${totalAssets}.`);
  if (totalLiab)   lines.push(`TOTAL DECLARED LIABILITIES: Rs ${totalLiab}.`);

  // ── Asset growth across elections (disproportionate-growth signal) ──
  // MyNeta lists the candidate's declarations in prior elections.
  const otherElec = fieldAfter(html, "Other Elections", ["Click here", "Print Profile", "Crime-O-Meter", "Disclaimer"], 300);
  if (otherElec && /\d/.test(otherElec)) lines.push(`PRIOR-ELECTION DECLARATIONS (for asset-growth comparison): ${otherElec}`);

  // ── Income-tax return history ────────────────────────────────────────
  const pan = fieldAfter(html, "PAN and status of Income Tax return", ["Movable Assets", "Immovable", "Liabilities Details"], 300);
  if (pan) lines.push(`INCOME-TAX RETURN HISTORY: ${pan.replace(/^Relation Type PAN Given.*?ITR\s*/i, "")}.`);

  if (!lines.length) return [];

  // Structured numbers for the deterministic computed-flags layer (analyzer.js).
  // These are parsed ONCE, in code, so downstream arithmetic never relies on the
  // LLM reading formatted text.
  const numbers = {
    total_assets: parseRupees(totalAssets),
    total_liabilities: parseRupees(totalLiab),
    criminal_cases: crimCount != null ? Number(crimCount) : null,
  };
  if (numbers.total_assets != null)
    numbers.net_worth = numbers.total_assets - (numbers.total_liabilities ?? 0);
  // A3/C.0: declared company interests + property (merged, never overwriting the
  // totals/cases above). Only set when rows actually parsed — never fabricated.
  const interests = parseInterests(html);
  const properties = parseProperties(html);
  if (interests.length) numbers.interests = interests;
  if (properties.length) numbers.properties = properties;
  const election_year = Number((p.myneta_url.match(/(20\d{2})/) ?? [])[1]) || null;
  // Attach numbers only when something actually parsed — an all-null object
  // would just block future upgrade passes without carrying any information.
  const hasNumbers = Object.values({ ...numbers, election_year }).some((v) => v != null);

  return [{
    politician_id: p.id,
    source_type: "eci_affidavit",
    tier: 1,
    admissible: true,
    title: `Full sworn ECI affidavit (assets, criminal cases, education) — ${p.name}`,
    url: p.myneta_url,
    date: null,
    summary: "Complete contents of the candidate's sworn ECI affidavit, scraped from ADR/MyNeta — the primary court-admissible record.",
    content: lines.join("\n"),
    ...(hasNumbers ? { numbers: { ...numbers, election_year } } : {}),
  }];
}
