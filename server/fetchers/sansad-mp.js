// Digital Sansad (sansad.in) — COMPLETE parliamentary record for an MP via the
// site's open JSON REST API. No browser, no key. Pulls the full activity record:
// every question (subject, ministry, starred/unstarred, date + verbatim Q&A PDF
// text), every debate, every government assurance, committee memberships, the
// full positions-held career history, and participation counts.
//
// Lok Sabha (api_ls) is fully covered. Rajya Sabha (api_rs) covers identity,
// bio, and positions held (its Q&A/debate endpoints differ and are a TODO).
//
// Name → mpCode is resolved against a cached list of all sitting members
// (one API call per house per process), then matched by name + constituency.
//
// Tunable via env:
//   SANSAD_FULLTEXT_LIMIT  how many recent questions to fetch verbatim PDF text
//                          for (default 8; set 0 = metadata only/fast; 200 = all)
//   SANSAD_DISABLE=1       skip this fetcher entirely
import { fetchJson, fetchPdfText, mapLimit , TIMEOUT_DEFAULT, TIMEOUT_SLOW } from "./http.js";
import { ministryToSector, textToSector } from "../data/sectors.js";
import { recordAssertion } from "../entities.js";

// Record the member match as a strong_id assertion (mpsno). Wrapped so a
// recording failure can never bubble into fetchSansadMP's graceful catch and
// suppress the parliamentary evidence.
function assertMember(p, m, house) {
  try {
    recordAssertion({
      subject_kind: "person", raw_name: m.name, source: "sansad_mp",
      source_ref: String(m.id), politician_id: p.id, confidence: 0.95, method: "strong_id",
      evidence_url: `https://sansad.in/${house}/members#${m.id}`,
    });
  } catch { /* additive only */ }
}

const LS = "https://sansad.in/api_ls";
const RS = "https://sansad.in/api_rs";
const LOKSABHA = 18; // current Lok Sabha (2024–2029)
// Default 8 when the env var is unset OR empty (dotenv loads a blank line as "").
const _ftl = process.env.SANSAD_FULLTEXT_LIMIT;
const FULLTEXT_LIMIT = _ftl === undefined || _ftl === "" ? 8 : Number(_ftl);
// SANSAD_ALL_TERMS=1 → also pull questions/debates from EVERY past Lok Sabha the
// member served in (metadata only), not just the current term — maximum history.
const ALL_TERMS = process.env.SANSAD_ALL_TERMS === "1";

const HONORIFICS = new Set([
  "shri", "smt", "dr", "kumari", "ms", "mr", "mrs", "prof", "adv",
  "mohd", "md", "sardar", "col", "gen", "capt", "late", "shrimati", "thiru",
]);

function tokens(name) {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !HONORIFICS.has(t));
}

// ── Cached member directories (built once per process) ─────────────────
let lsDirPromise = null, rsDirPromise = null;

async function lsDirectory() {
  if (!lsDirPromise) lsDirPromise = (async () => {
    const url = `${LS}/member?loksabha=${LOKSABHA}&state=&party=&gender=&ageFrom=&ageTo=`
      + `&noOfTerms=&page=1&size=1000&searchText=&constituency=&sitting=1&locale=en&memberStatus=s`;
    const data = await fetchJson(url, { timeoutMs: TIMEOUT_SLOW });
    return (data?.membersDtoList ?? []).map((m) => ({
      id: m.mpsno,
      name: m.mpFirstLastName || `${m.firstName ?? ""} ${m.lastName ?? ""}`,
      constituency: m.constituency ?? "",
      toks: tokens(m.mpFirstLastName || `${m.firstName ?? ""} ${m.lastName ?? ""}`),
    }));
  })();
  return lsDirPromise;
}

async function rsDirectory() {
  if (!rsDirPromise) rsDirPromise = (async () => {
    const url = `${RS}/member/sitting-members?state=&party=&gender=&page=1&size=1000`
      + `&mpFlag=1&ageFrom=&ageTo=&terms=&search=&locale=en`;
    const data = await fetchJson(url, { timeoutMs: TIMEOUT_SLOW });
    return (data?.records ?? []).map((m) => ({
      id: m.mpsno,
      name: (m.name ?? "").replace(/^@\s*/, ""),
      constituency: m.state ?? "",
      toks: tokens((m.name ?? "").replace(/^@\s*/, "")),
    }));
  })();
  return rsDirPromise;
}

// Strict match: every significant token of the politician's name must appear in
// the member's name (≥2 when the name has ≥2 tokens). Ambiguous ties are broken
// by constituency; if still ambiguous, no match (avoids wrong attribution).
function matchMember(p, dir) {
  const pt = tokens(p.name);
  if (!pt.length) return null;
  const need = pt.length >= 2 ? 2 : 1;

  const scored = dir
    .map((m) => {
      const matched = pt.filter((t) => m.toks.includes(t)).length;
      const allPresent = pt.every((t) => m.toks.includes(t));
      return { m, matched, allPresent, extra: m.toks.length - matched };
    })
    .filter((s) => s.matched >= need && (s.allPresent || pt.length >= 3))
    .sort((a, b) => b.matched - a.matched || a.extra - b.extra);

  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].matched === scored[1].matched) {
    // tie → require constituency to disambiguate
    const c = (p.constituency ?? "").toLowerCase().trim();
    const byCons = scored.find((s) => c && s.m.constituency.toLowerCase().includes(c));
    return byCons ? byCons.m : null;
  }
  return scored[0].m;
}

const clip = (s, n) => (s ?? "").toString()
  .replace(/<[^>]+>/g, " ")            // strip HTML tags (API returns <sup> etc.)
  .replace(/&[a-z#0-9]+;/gi, " ")      // strip HTML entities
  .replace(/\s+/g, " ").trim().slice(0, n);

// ── Shared: verbatim question-PDF fulltext ─────────────────────────────
// Factored out of the Lok Sabha path so Rajya Sabha reuses the SAME logic and
// the SAME SANSAD_FULLTEXT_LIMIT cap. Given a list of question records, take the
// first `limit` that carry a PDF path (read from `pathField`), download+parse
// each with bounded concurrency (mapLimit ..., 3), and return a formatted
// "VERBATIM …" block to append to the evidence content — or "" when disabled,
// when no record carries a path, or when nothing usable is extracted.
//
// Pure-ish + graceful: the PDF fetcher is injected (`fetchPdf`, defaulting to the
// real fetchPdfText) so it is unit-testable with no network; any per-PDF failure
// yields null and is skipped; it never throws.
export async function attachQuestionFulltext(records, {
  pathField,
  limit = FULLTEXT_LIMIT,
  fetchPdf = fetchPdfText,
  formatHeader = (q) => `Q.${q.quesNo} (${clip(q.date, 12)}, ${clip(q.ministry, 50)})`,
} = {}) {
  if (!Array.isArray(records) || !(limit > 0)) return "";
  const targets = records.filter((q) => q && q[pathField]).slice(0, limit);
  if (!targets.length) return "";
  const texts = await mapLimit(targets, 3, async (q) => {
    let t = "";
    try { t = await fetchPdf(q[pathField], { timeoutMs: TIMEOUT_SLOW, maxLen: 1600 }); }
    catch { /* graceful: a failed PDF just contributes no fulltext */ }
    return t && t.length > 120 ? `── ${formatHeader(q)} ──\n${t}` : null;
  });
  const got = texts.filter(Boolean);
  return got.length
    ? `\n\nVERBATIM QUESTION & ANSWER TEXT (most recent ${got.length}):\n${got.join("\n\n")}`
    : "";
}

// ── Lok Sabha: full record ─────────────────────────────────────────────
async function scrapeLS(p, m) {
  const id = m.id;
  const bioUrl = `https://sansad.in/ls/members/biography/${id}`;
  const items = [];

  const [profile, positions, qData, dData, aData, cData,
         pQ, pD, pB, pSM, pA, pC] = await Promise.all([
    fetchJson(`${LS}/member/${id}?locale=en`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/member/positionHeld?mpCode=${id}&locale=en`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/question/qetAllQuestionsForMember?lkNo=${LOKSABHA}&mpNo=${id}&pageNo=1&pageSize=300&locale=en`, { timeoutMs: TIMEOUT_SLOW }),
    fetchJson(`${LS}/debate/debate-search?debateTypeId=&loksabha=${LOKSABHA}&sessionNumber=&fromDate=&toDate=&searchKeyword=&page=1&size=300&mpCode=${id}&house=LS`, { timeoutMs: TIMEOUT_SLOW }),
    fetchJson(`${LS}/govtAssurance/assurances?mpCode=${id}&page=1&size=300&sortOrder=DESC&loksabha=${LOKSABHA}&locale=en`, { timeoutMs: TIMEOUT_SLOW }),
    fetchJson(`${LS}/committee/findCommitteeMembership?mpsno=${id}&lsno=${LOKSABHA}`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/question/participation?mpsno=${id}&loksabha=${LOKSABHA}`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/debate/participation?mpsno=${id}&loksabha=${LOKSABHA}&house=LS`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/debate/participationInBills?mpsno=${id}&loksabha=${LOKSABHA}&house=LS`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/debate/participationInSpecialMention?mpsno=${id}&loksabha=${LOKSABHA}&house=LS`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/govtAssurance/participation?mpsno=${id}&loksabha=${LOKSABHA}`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${LS}/committee/participation?mpsno=${id}&loksabha=${LOKSABHA}`, { timeoutMs: TIMEOUT_DEFAULT }),
  ]);

  // 1) Summary: identity, participation counts, positions, committees
  const counts = [
    `Questions asked: ${pQ?.participation ?? "?"}`,
    `Debates participated: ${pD?.participation ?? "?"}`,
    `Bills participated: ${pB?.participation ?? "?"}`,
    `Special mentions: ${pSM?.participation ?? "?"}`,
    `Govt assurances secured: ${pA?.participation ?? "?"}`,
    `Committee memberships: ${pC?.participation ?? "?"}`,
  ];
  const posLines = (Array.isArray(positions) ? positions : [])
    .map((x) => `• ${clip(x.period, 60)} — ${clip(x.positionHeld, 160)}`);
  const commLines = (cData?.committeeMembershipDtoList ?? [])
    .map((x) => `• ${clip(x.committeeName, 80)} (${clip(x.status, 40)}, ${clip(x.house, 20)})`);

  const summary = [
    `Lok Sabha member (${LOKSABHA}th) — ${profile?.fullName ?? p.name}`,
    profile?.constituency ? `Constituency: ${profile.constituency}, ${profile.state ?? ""}` : null,
    profile?.partyName ? `Party: ${profile.partyName}` : null,
    "",
    `PARTICIPATION (current Lok Sabha):`,
    ...counts.map((c) => `  ${c}`),
    posLines.length ? `\nPOSITIONS HELD (career & committees):\n${posLines.join("\n")}` : null,
    commLines.length ? `\nCOMMITTEE MEMBERSHIPS:\n${commLines.join("\n")}` : null,
  ].filter((x) => x != null).join("\n");

  // Structured "power" for the conflict-of-interest join (A2): the sectors this
  // member holds official power over — from ministerial positions and from the
  // ministries their questions target. Consumed by server/conflict.js. Attached
  // to THIS summary item only (never the per-question/debate sub-items).
  const posList = (Array.isArray(positions) ? positions : [])
    .map((x) => ({ title: clip(x.positionHeld, 160), period: clip(x.period, 60) }))
    .filter((x) => x.title);
  const ministries = [...new Set(posList.filter((x) => /minist/i.test(x.title)).map((x) => x.title))];
  const question_sectors = {};
  for (const q of (qData?.[0]?.listOfQuestions ?? [])) {
    const sec = ministryToSector(q.ministry) || textToSector(q.ministry) || textToSector(q.subjects);
    if (sec) question_sectors[sec] = (question_sectors[sec] ?? 0) + 1;
  }
  const summaryItem = evi(p, "parliament_ls", bioUrl,
    `Lok Sabha activity summary (Digital Sansad) — ${p.name}`,
    "Official Lok Sabha participation counts, positions held, and committee memberships from Digital Sansad's API.",
    summary);
  summaryItem.numbers = { power: { ministries, question_sectors, positions: posList } };
  items.push(summaryItem);

  // 2) Questions: complete list + verbatim PDF text for the most recent N
  const qList = qData?.[0]?.listOfQuestions ?? [];
  const qTotal = qData?.[0]?.totalRecordSize ?? qList.length;
  if (qList.length) {
    const indexLines = qList.map((q) =>
      `• [${clip(q.date, 12)}] ${clip(q.type, 10)} — ${clip(q.subjects, 140)} (${clip(q.ministry, 60)})`);

    // Verbatim PDF text for the most recent N questions, via the shared helper.
    // (The RS path calls the identical helper — see attachQuestionFulltext.)
    const verbatim = await attachQuestionFulltext(qList, { pathField: "questionsFilePath" });

    items.push(evi(p, "parliament_questions", `${bioUrl}#questions`,
      `Lok Sabha questions asked (${qTotal}) — ${p.name}`,
      `Complete list of ${qTotal} questions asked in the ${LOKSABHA}th Lok Sabha, with verbatim text for recent ones.`,
      `Asked ${qTotal} question(s) in the ${LOKSABHA}th Lok Sabha.\nFull list (date — type — subject — ministry):\n${indexLines.join("\n")}${verbatim}`));
  }

  // 3) Debates: complete list of topics
  const dRecords = dData?.records ?? [];
  const dTotal = dData?._metadata?.totalElements ?? dRecords.length;
  if (dRecords.length) {
    const lines = dRecords.map((d) =>
      `• [LS ${d.loksabha}, Session ${d.session}] ${clip(d.debateTitle, 200)}`);
    items.push(evi(p, "parliament_debates", `${bioUrl}#debates`,
      `Lok Sabha debates participated (${dTotal}) — ${p.name}`,
      `Complete list of ${dTotal} debates the member participated in (${LOKSABHA}th Lok Sabha).`,
      `Participated in ${dTotal} debate(s). Topics:\n${lines.join("\n")}`));
  }

  // 4) Government assurances
  const aRecords = aData?.records ?? [];
  if (aRecords.length) {
    const lines = aRecords.map((a) =>
      `• [${clip(a.date, 12)}] ${clip(a.subject, 160)} (${clip(a.ministry, 60)})`);
    items.push(evi(p, "parliament_assurances", `${bioUrl}#assurances`,
      `Lok Sabha government assurances (${aRecords.length}) — ${p.name}`,
      "Commitments the government gave on the floor in response to this member.",
      `Government assurances on this member's matters:\n${lines.join("\n")}`));
  }

  // 5) Past terms (full history) — questions & debates from every earlier Lok
  //    Sabha the member served in. Metadata only, to keep volume sane.
  if (ALL_TERMS) items.push(...await pastTermItems(p, id, bioUrl));

  return items;
}

// Questions + debates (metadata) from every Lok Sabha the member served in
// before the current one — the full historical record.
async function pastTermItems(p, id, bioUrl) {
  const served = await fetchJson(`${LS}/member/members-loksabha-session?mpCode=${id}`, { timeoutMs: TIMEOUT_DEFAULT });
  const terms = [...new Set((Array.isArray(served) ? served : [])
    .map((s) => s.loksabha).filter((n) => n && n < LOKSABHA))].sort((a, b) => b - a);
  const out = [];
  for (const ls of terms) {
    const [q, d] = await Promise.all([
      fetchJson(`${LS}/question/qetAllQuestionsForMember?lkNo=${ls}&mpNo=${id}&pageNo=1&pageSize=400&locale=en`, { timeoutMs: TIMEOUT_SLOW }),
      fetchJson(`${LS}/debate/debate-search?debateTypeId=&loksabha=${ls}&sessionNumber=&fromDate=&toDate=&searchKeyword=&page=1&size=400&mpCode=${id}&house=LS`, { timeoutMs: TIMEOUT_SLOW }),
    ]);
    const qList = q?.[0]?.listOfQuestions ?? [];
    const qTotal = q?.[0]?.totalRecordSize ?? qList.length;
    if (qList.length) {
      const lines = qList.map((x) => `• [${clip(x.date, 12)}] ${clip(x.type, 10)} — ${clip(x.subjects, 140)} (${clip(x.ministry, 60)})`);
      out.push(evi(p, "parliament_questions", `${bioUrl}#questions-ls${ls}`,
        `Lok Sabha ${ls} — questions asked (${qTotal}) — ${p.name}`,
        `All questions asked by the member in the ${ls}th Lok Sabha.`,
        `Asked ${qTotal} question(s) in the ${ls}th Lok Sabha:\n${lines.join("\n")}`.slice(0, 9000)));
    }
    const dRec = d?.records ?? [];
    const dTot = d?._metadata?.totalElements ?? dRec.length;
    if (dRec.length) {
      const lines = dRec.map((x) => `• [LS ${x.loksabha}, Session ${x.session}] ${clip(x.debateTitle, 200)}`);
      out.push(evi(p, "parliament_debates", `${bioUrl}#debates-ls${ls}`,
        `Lok Sabha ${ls} — debates participated (${dTot}) — ${p.name}`,
        `All debates the member participated in during the ${ls}th Lok Sabha.`,
        `Participated in ${dTot} debate(s) in the ${ls}th Lok Sabha:\n${lines.join("\n")}`.slice(0, 9000)));
    }
  }
  return out;
}

// ── Rajya Sabha: identity + positions ──
// NOTE (probed 2026-07-12): the RS Q&A/debate data is NOT reachable the way LS is.
// The LS per-member endpoints (question/qetAllQuestionsForMember, debate/debate-search,
// question|debate/participation) have NO working api_rs analogue — every path patterned
// on them returns 404, and the few that 403 need the RS site's internal CSRF/referer
// machinery, not a clean public JSON call. Only /member/bio-data and /member/position-held
// respond publicly. So RS members carry identity + bio + positions; their questions/debates
// would need a different (likely session-PDF or authenticated-search) source — left as a
// known external gap, not a quick endpoint swap.
async function scrapeRS(p, m) {
  const id = m.id;
  const [bio, positions] = await Promise.all([
    fetchJson(`${RS}/member/bio-data?mpCode=${id}&locale=en`, { timeoutMs: TIMEOUT_DEFAULT }),
    fetchJson(`${RS}/member/position-held?mpCode=${id}&locale=en`, { timeoutMs: TIMEOUT_DEFAULT }),
  ]);
  const posLines = (Array.isArray(positions) ? positions : [])
    .map((x) => `• ${clip(x.period, 60)} — ${clip(x.position, 160)}`);

  // RS question fulltext — reuse the EXACT Lok Sabha path via attachQuestionFulltext,
  // honouring the same SANSAD_FULLTEXT_LIMIT cap. The RS question JSON is NOT publicly
  // reachable today (see NOTE above: qetAllQuestionsForMember has no working api_rs
  // analogue), so `rsQuestions` is empty and the helper returns "" — RS content is
  // unchanged for now. When an RS question source IS wired, populate `rsQuestions`
  // with its records and set `pathField` to that JSON's PDF-path key. The LS analogue
  // is `questionsFilePath`; the RS field name is UNCONFIRMED — no reachable RS question
  // sample exists to read it from, so verify it against the live RS JSON before trusting
  // it (pass a custom `formatHeader` too if the RS record's number/date/ministry keys
  // differ from quesNo/date/ministry).
  const rsQuestions = [];
  const verbatim = await attachQuestionFulltext(rsQuestions, { pathField: "questionsFilePath" });

  const content = [
    `Rajya Sabha member — ${m.name}`,
    m.constituency ? `Represents: ${m.constituency}` : null,
    bio?.dateBirth ? `Date of birth: ${clip(bio.dateBirth, 20)}` : null,
    posLines.length ? `\nPOSITIONS HELD:\n${posLines.join("\n")}` : null,
  ].filter(Boolean).join("\n") + verbatim;

  return [evi(p, "parliament_rs", `https://sansad.in/rs/members#${id}`,
    `Rajya Sabha member record (Digital Sansad) — ${p.name}`,
    "Official Rajya Sabha member identity and positions-held history from Digital Sansad's API.",
    content)];
}

function evi(p, source_type, url, title, summary, content) {
  return { politician_id: p.id, source_type, tier: 2, admissible: true, url, date: null, title, summary, content };
}

export async function fetchSansadMP(p) {
  if (!["MP", "RS"].includes(p.office)) return [];
  if (process.env.SANSAD_DISABLE === "1") return [];

  try {
    const lsm = matchMember(p, await lsDirectory());
    if (lsm) { assertMember(p, lsm, "ls"); return await scrapeLS(p, lsm); }

    const rsm = matchMember(p, await rsDirectory());
    if (rsm) { assertMember(p, rsm, "rs"); return await scrapeRS(p, rsm); }
  } catch { /* graceful: API hiccup → no parliamentary evidence this run */ }

  return [];
}
