// Collusion clustering golden test: two companies sharing a PIN code and a
// distinctive address token must group; an unrelated company must stay separate.
// clusterCompanies() is not exported, so we exercise it through the public
// detectCollusion() which returns its clusters. Pure/code-only, but collusion.js
// imports the store, so we point the DB at a throwaway file before importing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PANDOROS_DB_PATH = path.join(os.tmpdir(), `pandoros-test-collusion-${process.pid}.db`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "collusion.json"), "utf8"));
const { detectCollusion, DETECTOR_VERSION } = await import("../server/collusion.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(process.env.PANDOROS_DB_PATH + suffix); } catch {}
  }
});

test("clusterCompanies groups shared-address firms and leaves unrelated ones out", () => {
  const { clusters } = detectCollusion({ companies: FX.companies });

  assert.equal(clusters.length, 1, "exactly one cluster forms");
  const cluster = clusters[0];
  const names = cluster.members.map((m) => m.name).sort();
  assert.deepEqual(names, ["Alpha Constructions Pvt Ltd", "Beta Infratech Pvt Ltd"]);
  assert.equal(cluster.pincode, "110001");
  assert.equal(cluster.token, "SUNRISE");

  // The unrelated firm (different PIN) is in no cluster.
  const allMembers = clusters.flatMap((c) => c.members.map((m) => m.name));
  assert.ok(!allMembers.includes("Gamma Traders Pvt Ltd"), "unrelated firm stays separate");
});

test("SHARED_CONTROL_CLUSTER leads are stamped with the detector version", () => {
  const { leads } = detectCollusion({ companies: FX.companies });
  const lead = leads.find((l) => l.vector === "SHARED_CONTROL_CLUSTER");
  assert.ok(lead, "a cluster lead is emitted");
  assert.equal(lead.detector_version, DETECTOR_VERSION);
  assert.equal(DETECTOR_VERSION, "collusion-v1");
});
