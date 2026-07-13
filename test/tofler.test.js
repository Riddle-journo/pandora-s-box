// Phase-1 Tofler enrichment tests: the lead→company resolver, the HTML director
// parser, and the end-to-end enrich (mocked fetch, throwaway DB) proving
// selectivity, dedup, and that directors persist as mca_company evidence.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-tofler-${process.pid}.db`);
// A prior run whose test.after() unlink failed (common on Windows, where the
// SQLite handle isn't released synchronously) leaves this file behind; PID reuse
// then reopens it dirty and flakes exact-count/idempotency assertions. Delete any
// leftover BEFORE the store opens it so every run starts from an empty DB.
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

process.env.TOFLER_DELAY_MS = "0"; // no real waiting in tests

const {
  companyTargetsFromLead, parseToflerDirectors, companyKey, companyDirectorsUrl, isCin, slugify,
  fetchToflerDirectors,
} = await import("../server/fetchers/tofler.js");
const { enrichLeadsWithTofler } = await import("../server/tofler-enrich.js");
const store = await import("../server/store.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

const CIN = "U74999DL2015PTC276819";

test("isCin / slugify / key basics", () => {
  assert.ok(isCin(CIN));
  assert.ok(!isCin("ACME PRIVATE LIMITED"));
  assert.equal(slugify("Acme & Co. Pvt Ltd"), "acme-co-pvt-ltd");
  assert.equal(companyKey({ cin: CIN }), CIN);
  assert.equal(companyKey({ name: "Acme Co" }), "name:acme-co");
});

test("companyTargetsFromLead resolves each company-bearing kind", () => {
  // company
  assert.deepEqual(
    companyTargetsFromLead({ beneficiary_kind: "company", beneficiary: "Acme Traders", beneficiary_cin: CIN }),
    [{ name: "Acme Traders", cin: CIN }],
  );
  // company_cluster → all members, deduped
  const cl = companyTargetsFromLead({
    beneficiary_kind: "company_cluster",
    cluster: { members: [{ name: "A Ltd", cin: CIN }, { name: "B Ltd", cin: null }, { name: "A Ltd", cin: CIN }] },
  });
  assert.equal(cl.length, 2);
  // tender → awardee; entity id that IS a CIN is kept as cin
  assert.deepEqual(
    companyTargetsFromLead({ beneficiary_kind: "tender", awardee_name: "Winner Infra", awardee_entity_id: CIN }),
    [{ name: "Winner Infra", cin: CIN }],
  );
  // non-company lead → nothing
  assert.deepEqual(companyTargetsFromLead({ beneficiary_kind: "person", beneficiary: "X" }), []);
});

test("parseToflerDirectors extracts DIN+name and dedups", () => {
  const html = `
    <table>
      <tr><td><a href="/rahul-sharma/director/00123456">Rahul Sharma</a></td></tr>
      <tr><td><a href="/priya-nair/director/09876543">Priya Nair</a></td></tr>
      <tr><td><a href="/rahul-sharma/director/00123456">Rahul Sharma</a></td></tr>
    </table>`;
  const dirs = parseToflerDirectors(html);
  assert.equal(dirs.length, 2);
  assert.deepEqual(dirs.find((d) => d.din === "00123456"), { name: "Rahul Sharma", din: "00123456" });
});

test("companyDirectorsUrl needs a CIN; name-only → null", () => {
  assert.equal(companyDirectorsUrl({ name: "Acme", cin: CIN }), `https://www.tofler.in/acme/company/${CIN}/directors`);
  assert.equal(companyDirectorsUrl({ name: "Acme" }), null);
});

test("fetchToflerDirectors resolves a name-only target via injected resolveCin", async () => {
  const html = `<a href="/x/director/00111222">Some Director</a>`;
  const resolveCin = async (name) => {
    assert.equal(name, "Namefirst Traders");
    return { cin: CIN, name: "NAMEFIRST TRADERS PRIVATE LIMITED" };
  };
  const fetchImpl = async (url) => { assert.ok(url.includes(CIN)); return html; };
  const res = await fetchToflerDirectors({ name: "Namefirst Traders" }, { fetchImpl, resolveCin });
  assert.equal(res.cin, CIN);
  assert.equal(res.resolved_by, "name");
  assert.equal(res.directors.length, 1);
});

test("fetchToflerDirectors returns null when a name can't be resolved to a CIN", async () => {
  const res = await fetchToflerDirectors({ name: "Unfindable Co" }, {
    fetchImpl: async () => { throw new Error("should not fetch"); },
    resolveCin: async () => null,
  });
  assert.equal(res, null);
});

test("enrich is OFF unless forced/env-enabled", async () => {
  const r = await enrichLeadsWithTofler([{ beneficiary_kind: "company", beneficiary: "X", beneficiary_cin: CIN }]);
  assert.equal(r.enabled, false);
  assert.equal(r.fetched, 0);
});

test("enrich fetches flagged companies, dedups, and persists directors as evidence", async () => {
  // Seed a politician the flag can attach evidence to.
  store.upsertPolitician({ id: "pol1", name: "Test MP" });

  const html = `<a href="/rahul-sharma/director/00123456">Rahul Sharma</a>
                <a href="/priya-nair/director/09876543">Priya Nair</a>`;
  let calls = 0;
  const fetchImpl = async (url) => { calls++; assert.ok(url.includes(CIN)); return html; };

  // Two leads point at the SAME company (one with an actor) → one fetch only.
  const leads = [
    { beneficiary_kind: "company", beneficiary: "Acme Traders", beneficiary_cin: CIN, actor_id: "pol1" },
    { beneficiary_kind: "tender", awardee_name: "Acme Traders", awardee_entity_id: CIN, actor_id: "pol1" },
  ];
  const r = await enrichLeadsWithTofler(leads, { force: true, fetchImpl });
  assert.equal(r.enabled, true);
  assert.equal(r.targets, 1, "same CIN collapses to one target");
  assert.equal(r.fetched, 1, "network hit exactly once");
  assert.equal(calls, 1);

  // Cached: a second run does NOT re-fetch.
  const r2 = await enrichLeadsWithTofler(leads, { force: true, fetchImpl });
  assert.equal(r2.fetched, 0);
  assert.equal(r2.cached, 1);

  // Directors persisted as mca_company evidence the detectors can read.
  const ev = store.listEvidence("pol1").find((e) => e.source_type === "mca_company");
  assert.ok(ev, "mca_company evidence written");
  const co = ev.numbers.companies[0];
  assert.equal(co.cin, CIN);
  assert.equal(co.directors.length, 2);
});

test("enrich handles a NAME-ONLY flag (no CIN) end-to-end via resolveCin", async () => {
  store.upsertPolitician({ id: "pol2", name: "Test MP 2" });
  const CIN2 = "U01100MH2011PTC111222";
  const html = `<a href="/d/director/00333444">Named Director</a>`;
  const resolveCin = async () => ({ cin: CIN2, name: "SHELL NAMEONLY PRIVATE LIMITED" });
  const fetchImpl = async (url) => { assert.ok(url.includes(CIN2)); return html; };

  const leads = [{ beneficiary_kind: "company", beneficiary: "Shell Nameonly", actor_id: "pol2" }];
  const r = await enrichLeadsWithTofler(leads, { force: true, fetchImpl, resolveCin });
  assert.equal(r.fetched, 1);
  assert.equal(r.evidence, 1);

  const ev = store.listEvidence("pol2").find((e) => e.source_type === "mca_company");
  assert.ok(ev, "name-only flag produced evidence");
  assert.equal(ev.numbers.companies[0].cin, CIN2);
});
