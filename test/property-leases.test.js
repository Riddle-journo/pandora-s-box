// Unit tests for the real-estate (RERA) + mineral/mining-lease extractor.
// The pure builders (reraRecords / mineralRecords) are exercised against inline
// fixture `content` — one RERA register row and one mineral-lease row — asserting
// the low-confidence identity-unverified claims AND the promoter/lessee firm
// relationships. Importing the module transitively loads server/store.js (opens a
// SQLite handle at import), so PANDOROS_DB_PATH is redirected to a per-pid temp DB
// BEFORE the import, exactly like test/ledger-detectors.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-propleases-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
}

const {
  reraRecords, mineralRecords, parseLeaseRow, extractParty,
  PROPERTY_LEASES_VERSION, MINERAL_SOURCE_TYPES, RERA_SOURCE_TYPES,
} = await import("../server/extractors/property-leases.js");

test("extractParty finds a firm and classifies company vs govt org", () => {
  assert.equal(extractParty("Sunrise Developers Private Limited").name, "Sunrise Developers Private Limited");
  assert.equal(extractParty("Sunrise Developers Private Limited").kind, "company");
  assert.equal(extractParty("West Bengal Minerals Development Corporation").kind, "org");
  assert.equal(extractParty("Village Rampur near the river"), null);
});

test("RERA row → linked_rera_project claim + promoter_of_rera_project relationship", () => {
  const content =
    "MahaRERA registered projects (2 matching rows, dataset of 41000):\n" +
    "• Sunrise Developers Private Limited | Sunrise Heights | P51700012345 | Registered | 12-Jan-2022 | Pune\n" +
    "• Ganga Realty LLP | Ganga Vista | P52100098765 | Registered | 03-Mar-2021 | Thane";
  const out = reraRecords({ content, source_type: "l1_maharera_projects" });

  assert.equal(out.claims.length, 2);
  assert.equal(out.events.length, 2);
  assert.equal(out.relationships.length, 2);

  const c0 = out.claims[0];
  assert.equal(c0.claim_type, "linked_rera_project");
  assert.equal(c0.status, "unverified");
  assert.ok(c0.confidence >= 0.15 && c0.confidence <= 0.3, "claim confidence in 0.15–0.3");
  assert.equal(c0.as_of_date, "2022-01-12");
  assert.ok(/Sunrise Heights/.test(c0.object_text), "object_text carries the project");
  assert.ok(/P51700012345/.test(c0.object_text), "object_text carries the registration");
  assert.equal(c0.data.status, "Registered");
  assert.equal(c0.data.source, "l1_maharera_projects");
  assert.equal(c0.data.note.length > 0, true);

  const r0 = out.relationships[0];
  assert.equal(r0.rel_type, "promoter_of_rera_project");
  assert.equal(r0.dst_name, "Sunrise Developers Private Limited");
  assert.equal(r0.dst_kind, "company");
  assert.equal(r0.valid_from, "2022-01-12");
  assert.equal(r0.data.identity_unverified, true);
  assert.ok(r0.confidence <= 0.3);
});

test("mineral-lease row → linked_mineral_lease claim + holds_mineral_lease relationship", () => {
  const content =
    "Punjab Sand Portal — operational mining sites (1 matching row, dataset of 900):\n" +
    "• Sood Minerals and Mining Company | Village Rampur | District: Ludhiana | Sand | Operational | 21-07-2022";
  const out = mineralRecords({ content, source_type: "l1_punjab_sand_mines" });

  assert.equal(out.claims.length, 1);
  assert.equal(out.relationships.length, 1);

  const c = out.claims[0];
  assert.equal(c.claim_type, "linked_mineral_lease");
  assert.equal(c.status, "unverified");
  assert.ok(c.confidence >= 0.15 && c.confidence <= 0.3);
  assert.equal(c.as_of_date, "2022-07-21");
  assert.equal(c.data.mineral, "Sand");
  assert.equal(c.data.status, "Operational");
  assert.equal(c.data.district, "Ludhiana");
  assert.ok(/Sand/.test(c.object_text) && /Operational/.test(c.object_text));

  const r = out.relationships[0];
  assert.equal(r.rel_type, "holds_mineral_lease");
  assert.ok(/^Sood /.test(r.dst_name), `firm captured, got ${r.dst_name}`);
  assert.equal(r.dst_kind, "company");
  assert.equal(r.data.identity_unverified, true);
});

test("WB mining body row (empty title | pdf-url | body) derives site from the pdf filename", () => {
  const content =
    "WB mining RFP/DSR PDFs (body-text) (1 matching row, dataset of 408):\n" +
    "•  | https://www.wbindustries.gov.in/files/Mines/DSR/Jhargram%20Modified%20DSR%20Octber%202025.pdf | " +
    "…forwarded to Ganpati Minerals Private Limited, the successful bidder for the block…";
  const out = mineralRecords({ content, source_type: "l1_mega_wb_mines_body" });

  assert.equal(out.claims.length, 1);
  const c = out.claims[0];
  assert.equal(c.claim_type, "linked_mineral_lease");
  assert.ok(/Jhargram/.test(c.object_text), `site from filename, got "${c.object_text}"`);
  assert.equal(out.relationships.length, 1);
  assert.equal(out.relationships[0].dst_name, "Ganpati Minerals Private Limited");
});

test("no matched rows → empty emission", () => {
  assert.deepEqual(mineralRecords({ content: "Some header with no bullet rows", source_type: "l1_mega_wb_mines_body" }), {});
});

test("registered source_types are as expected (only the on-disk live cache)", () => {
  assert.deepEqual(MINERAL_SOURCE_TYPES, ["l1_mega_wb_mines_body"]);
  assert.deepEqual(RERA_SOURCE_TYPES, []);
  assert.equal(PROPERTY_LEASES_VERSION, "property-leases-v1");
});

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});
