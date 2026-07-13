// Phase 1 — the pure directorship-extraction core. No DB, no network: drives
// extractDirectorships() over real-shaped snippets from the three free sources it
// will run against (Indian Kanoon judgments, ICIJ leak connections, ED/CBI press
// releases), plus the negative cases that must NOT manufacture a directorship.
import test from "node:test";
import assert from "node:assert/strict";
import { extractDirectorships, normalizeCompany } from "../server/directorship-extract.js";

const find = (rows, coNormPart) => rows.find((r) => r.company_norm.includes(coNormPart));

test("legal judgment: person + role + company, attributed to the subject", () => {
  const text = "In the matter, the petitioner Shri Ramesh Kumar Agarwal, Managing Director of ABC Infrastructure Private Limited, was arrayed as accused no. 2.";
  const rows = extractDirectorships(text, { subjectName: "Ramesh Kumar Agarwal" });
  const r = find(rows, "abc infrastructure");
  assert.ok(r, "should extract ABC Infrastructure");
  assert.equal(r.company, "ABC Infrastructure Private Limited");
  assert.equal(r.role, "Managing Director");
  assert.equal(r.person, "Shri Ramesh Kumar Agarwal");
  assert.equal(r.person_is_subject, true);
  assert.ok(r.confidence >= 0.8, `confidence ${r.confidence}`);
});

test("role AFTER company, person after role: 'M/s X Ltd, whose director Suresh Reddy...'", () => {
  const text = "The CBI named M/s XYZ Steels Private Limited, whose director Suresh Kumar Reddy allegedly diverted funds.";
  const rows = extractDirectorships(text, { subjectName: "Suresh Kumar Reddy" });
  const r = find(rows, "xyz steels");
  assert.ok(r, "should extract XYZ Steels");
  assert.equal(r.company, "XYZ Steels Private Limited");
  assert.match(r.role, /director/i);
  assert.ok(r.person && /Suresh/.test(r.person));
  assert.equal(r.person_is_subject, true);
});

test("ICIJ ALLCAPS connections: two companies with leak roles", () => {
  const text = "Connections: Officer of MERIDIAN HOLDINGS LIMITED (British Virgin Islands). Beneficial Owner of SUNRISE VENTURES LTD registered in Panama.";
  const rows = extractDirectorships(text, { subjectName: "Anil Meridian" });
  const meridian = find(rows, "meridian holdings");
  const sunrise = find(rows, "sunrise ventures");
  assert.ok(meridian, "MERIDIAN HOLDINGS LIMITED");
  assert.ok(sunrise, "SUNRISE VENTURES LTD");
  assert.match(sunrise.role, /Beneficial Owner/i);
  // "Officer" is a generic role → damped confidence.
  assert.ok(meridian.confidence <= 0.65, `officer conf ${meridian.confidence}`);
});

test("LLP + Designated Partner", () => {
  const text = "Smt. Kavita Nair, Designated Partner of Global Exports LLP, filed the return late.";
  const rows = extractDirectorships(text, { subjectName: "Kavita Nair" });
  const r = find(rows, "global exports");
  assert.ok(r, "Global Exports LLP");
  assert.equal(r.role, "Designated Partner");
  assert.equal(r.person_is_subject, true);
});

test("company only, no named person, but subject token nearby → medium lead", () => {
  const text = "It was alleged that Rajesh Bhandari controlled operations at Skyline Realtors Private Limited as its Promoter throughout.";
  const rows = extractDirectorships(text, { subjectName: "Rajesh Bhandari" });
  const r = find(rows, "skyline realtors");
  assert.ok(r);
  assert.equal(r.role, "Promoter");
  assert.equal(r.subject_nearby, true);
  assert.ok(r.confidence >= 0.7 && r.confidence < 0.8, `conf ${r.confidence}`);
});

test("bare lead: role + company, subject entirely absent → low confidence", () => {
  const text = "The Director of Coastal Cement Limited testified about the tender.";
  const rows = extractDirectorships(text, { subjectName: "Someone Unrelated" });
  const r = find(rows, "coastal cement");
  assert.ok(r);
  assert.equal(r.person_is_subject, false);
  assert.equal(r.subject_nearby, false);
  assert.equal(r.confidence, 0.45);
});

test("negative: lowercase prose 'was not limited' is not a company", () => {
  const text = "The scope of the enquiry was not limited to the tender in question.";
  const rows = extractDirectorships(text, { subjectName: "X Y" });
  assert.equal(rows.length, 0, JSON.stringify(rows));
});

test("negative: a role with no company nearby yields nothing", () => {
  const text = "He served as Director for many years before retiring to his village.";
  const rows = extractDirectorships(text, { subjectName: "X Y" });
  assert.equal(rows.length, 0);
});

test("negative: sentence-opener 'The' is not pulled into the company name", () => {
  const text = "The Limited review of accounts found nothing. Separately, Ashok Menon, Director of Vertex Systems Private Limited, resigned.";
  const rows = extractDirectorships(text, { subjectName: "Ashok Menon" });
  // 'The Limited' must NOT appear as a company; Vertex Systems must.
  assert.ok(!rows.some((r) => /^the /i.test(r.company)), "no 'The ...' company");
  assert.ok(find(rows, "vertex systems"), "Vertex Systems extracted");
});

test("dedup: same company+role+person mentioned twice collapses to one", () => {
  const text = "Vikram Sethi, Director of Pinnacle Motors Limited. Later, Vikram Sethi, Director of Pinnacle Motors Limited, again.";
  const rows = extractDirectorships(text, { subjectName: "Vikram Sethi" });
  const hits = rows.filter((r) => r.company_norm.includes("pinnacle motors"));
  assert.equal(hits.length, 1, JSON.stringify(hits));
});

test("normalizeCompany folds Pvt/Private and Ltd/Limited", () => {
  assert.equal(normalizeCompany("ABC Infrastructure Private Limited"), normalizeCompany("ABC Infrastructure Pvt Ltd"));
});

// ── Regression: real-data name-boundary bugs found on the first live run ──────
test("regression: a role word before the company is NOT swallowed into the name", () => {
  // "…Nath Director Greatshine Holdings Pvt Ltd" must yield the COMPANY only,
  // not "Nath Director Greatshine Holdings Pvt Ltd".
  const rows = extractDirectorships("Maanik Nath, Director of Greatshine Holdings Private Limited", { subjectName: "Maanik Nath" });
  const r = find(rows, "greatshine holdings");
  assert.ok(r);
  assert.equal(r.company, "Greatshine Holdings Private Limited");
  assert.ok(!/director|nath/i.test(r.company), `leaked into name: ${r.company}`);
});

test("regression: ICIJ 'Jurisdiction Status Data From <ENTITY>' header is stripped", () => {
  const rows = extractDirectorships("Officer of Incorporation Jurisdiction Status Data From SUPER-MAX MALTA LTD", { subjectName: "Someone" });
  const r = find(rows, "super max malta"); // company_norm folds the hyphen to a space
  assert.ok(r, JSON.stringify(rows.map((x) => x.company)));
  assert.equal(r.company, "SUPER-MAX MALTA LTD");
});

test("empty / tiny input is safe", () => {
  assert.deepEqual(extractDirectorships("", { subjectName: "X" }), []);
  assert.deepEqual(extractDirectorships("hi", { subjectName: "X" }), []);
  assert.deepEqual(extractDirectorships(null, {}), []);
});
