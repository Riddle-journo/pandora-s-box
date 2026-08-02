// Party-finance extractor — turns the enriched `party_finance` evidence (ADR/MyNeta
// party financial returns) into ledger facts attributed to the PARTY entity, not
// the politician whose evidence row happened to carry the scrape. This is the
// universal-subject override in action: every fact sets entity_id = the party
// entity (kind='party', deduped by its stable MyNeta party id), so the same
// party's figures — which ride on hundreds of its members' evidence rows —
// resolve to ONE subject and aggregate cleanly.
//
// Metrics (values normalised to absolute rupees; the source reports "in lacs"):
//   party_total_assets / party_total_liabilities / party_total_income /
//     party_total_expenditure — top-line totals, one per financial year, parsed
//     from the MULTI-YEAR SUMMARY (a long series). NB the two pairs are equal by
//     accounting identity (a balance sheet balances → Assets = Liabilities; the
//     I&E account balances via surplus carried over → Income = Expenditure) —
//     that is real data, not duplication, so both are emitted honestly.
//   party_donations_income — Voluntary Contributions / donations (an Income line)
//   party_election_expenditure — Election/General Propaganda spend (an Expenditure
//     line). Both come from the DETAILED BREAKDOWN — the distinct, accountability-
//     relevant composition the summary omits — one per recent financial year.
//
// Because the same party's figures repeat across every member's evidence row, the
// batch runner (runPartyFinanceExtraction) extracts from ONE deterministic
// representative row per party — writing each shared fact once (still cited to a
// real evidence row) instead of once per member — while a single-row extract()
// still works for the generic framework and for tests.
import { registerExtractor, extractFromEvidence } from "./extract.js";
import { db } from "../store/store.js";
import { ensureEntity } from "../entities/entities.js";

export const PARTY_FINANCE_VERSION = "party-finance-v1";

const LAC = 100000;
const toInr = (lacStr) => {
  const n = Number(String(lacStr).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * LAC) : null;
};
// FY label "2024-25" → ISO date of the financial-year end (31 March 2025).
const fyEndDate = (label) => {
  const m = /^(\d{4})-\d{2}$/.exec(label);
  return m ? `${Number(m[1]) + 1}-03-31` : null;
};
// The party summary URL carries MyNeta's stable party id (…&id=3) — the party
// entity's strong id, so all of a party's member rows resolve to one entity.
const partyIdFromUrl = (url) => String(url ?? "").match(/[?&]id=(\d+)/)?.[1] ?? null;

// Extract the party's own name from an evidence row. The possessive title/header
// ("Party financials — <PARTY> (<politician>'s party)") is unreliable because the
// politician's name can itself carry parentheses (nicknames like "(Guddu)",
// "(SC)"/"(ST)" suffixes) — a naive [^()]* suffix then fails and the party is
// dropped. So prefer the fetcher's `summary`, where the party name is cleanly
// delimited by " (ADR/ECI data)" and the politician name is nowhere near; fall
// back to a title/header pattern whose "'s party" suffix tolerates one level of
// nested parentheses.
const NAME_SUFFIX = "\\((?:[^()]|\\([^()]*\\))*'s party\\)";
function partyName(data) {
  return (data?.summary?.match(/records of (.+?) \(ADR\/ECI data\)/)?.[1]
       ?? data?.title?.match(new RegExp(`^Party financials — (.+?) ${NAME_SUFFIX}\\s*$`))?.[1]
       ?? data?.content?.match(new RegExp(`^PARTY FINANCIALS — (.+?) ${NAME_SUFFIX}`, "m"))?.[1]
       ?? "").trim();
}

// Resolve (or create) the PARTY entity this evidence belongs to.
function partyEntity(data) {
  const mid = partyIdFromUrl(data?.url);
  const name = partyName(data);
  if (!name || !mid) return null;
  return ensureEntity({ kind: "party", name, strongIds: { myneta_party_id: mid }, source: "party_finance" });
}

// One fact per (metric, financial year).
function fact(entity_id, metric, lacStr, label, fyLabel) {
  const value = toInr(lacStr);
  if (value == null) return null;
  return {
    entity_id, subject_kind: "party", metric, value, unit: "inr",
    as_of_date: fyEndDate(fyLabel), period: `FY${fyLabel}`,
    data: { financial_year: fyLabel, source_label: label, value_lacs: Number(String(lacStr).replace(/,/g, "")), reported_unit: "inr_lacs" },
  };
}

// Find the first "Label Rs.<amount>" item on a section line whose label matches.
function pickItem(body, sectionRe, labelRe) {
  const line = body.split("\n").find((l) => sectionRe.test(l)) ?? "";
  for (const part of line.split("|")) {
    const m = /^\s*(.*?)\s+Rs\.([\d,]+\.?\d*)/.exec(part);
    if (m && labelRe.test(m[1])) return { label: m[1].trim(), amount: m[2] };
  }
  return null;
}

export function partyFinanceFacts(evidence) {
  const data = evidence?.data ?? {};
  const content = String(data.content ?? "");
  const entity_id = partyEntity(data);
  if (!entity_id) return [];
  const facts = [];

  // 1) Top-line totals per year from the MULTI-YEAR SUMMARY, e.g.:
  //    "… 2024-25 Rs. 12,17,117.68 lacs Rs. 12,17,117.68 lacs Rs. 6,76,914.98 lacs Rs. 6,76,914.98 lacs …"
  const summary = content.split(/MULTI-YEAR SUMMARY/i)[1] ?? "";
  const rowRe = /(\d{4}-\d{2})\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*lacs\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*lacs\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*lacs\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s*lacs/gi;
  for (const m of summary.matchAll(rowRe)) {
    const [, fy, assets, liab, income, exp] = m;
    facts.push(fact(entity_id, "party_total_assets", assets, "Total Assets", fy));
    facts.push(fact(entity_id, "party_total_liabilities", liab, "Total Liabilities", fy));
    facts.push(fact(entity_id, "party_total_income", income, "Total Income", fy));
    facts.push(fact(entity_id, "party_total_expenditure", exp, "Total Expenditure", fy));
  }

  // 2) Accountability-relevant line items from the DETAILED BREAKDOWN.
  const detail = (content.split(/DETAILED BREAKDOWN/i)[1] ?? "").split(/MULTI-YEAR SUMMARY/i)[0];
  const blocks = detail.split(/FY (\d{4}-\d{2}):/).slice(1); // [fy, body, fy, body, …]
  for (let i = 0; i + 1 < blocks.length; i += 2) {
    const fy = blocks[i], body = blocks[i + 1];
    const donations = pickItem(body, /^\s*Income:/, /voluntary contribution|donation/i);
    if (donations) facts.push(fact(entity_id, "party_donations_income", donations.amount, donations.label, fy));
    const election = pickItem(body, /^\s*Expenditure:/, /election|propaganda/i);
    if (election) facts.push(fact(entity_id, "party_election_expenditure", election.amount, election.label, fy));
  }

  return facts.filter(Boolean);
}

registerExtractor("party_finance", { version: PARTY_FINANCE_VERSION, extract: (ev) => ({ facts: partyFinanceFacts(ev) }) });

// Batch runner: extract from ONE deterministic representative evidence row per
// party (the lexicographically-smallest evidence id sharing a party summary url),
// so the shared party facts are written once — each cited to a real evidence row —
// rather than once per member. Idempotent (same representative every run, and the
// ledger dedupes on metric+entity+date+evidence+version).
export function runPartyFinanceExtraction() {
  const rows = db.prepare(
    "SELECT id, politician_id, data FROM evidence WHERE json_extract(data,'$.source_type')='party_finance'"
  ).all();
  const repByParty = new Map();
  for (const r of rows) {
    const d = JSON.parse(r.data);
    const key = partyIdFromUrl(d.url) ?? d.url ?? r.id;
    const cur = repByParty.get(key);
    if (!cur || r.id < cur.id) repByParty.set(key, { id: r.id, politician_id: r.politician_id, d });
  }
  const total = { evidence: 0, parties: repByParty.size, facts: 0, skipped: 0 };
  const run = db.transaction((reps) => {
    for (const rep of reps) {
      const out = extractFromEvidence({
        id: rep.id, politician_id: rep.politician_id,
        source_type: "party_finance", tier: rep.d.tier, date: rep.d.date, data: rep.d,
      });
      total.evidence++; total.facts += out.facts; total.skipped += out.skipped;
    }
  });
  run([...repByParty.values()]);
  return total;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("extractors/party-finance.js");
if (invokedDirectly) {
  console.log("[party-finance] extraction done:", JSON.stringify(runPartyFinanceExtraction()));
  process.exit(0);
}
