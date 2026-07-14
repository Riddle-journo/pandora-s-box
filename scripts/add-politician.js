// Run: node scripts/add-politician.js
// Adds a real politician, pulls all evidence, generates the first AI report.
import { upsertPolitician, listPoliticians } from "../server/store.js";
import { ingestFor } from "../server/ingest.js";
import { generateReport } from "../server/report-generator.js";

// ---- ADD YOUR POLITICIANS HERE ----
// Find the myneta_url by searching https://www.myneta.info for the person's name.
const POLITICIANS = [
  {
    name: "Narendra Modi",
    party: "BJP",
    office: "MP",
    constituency: "Varanasi",
    state: "Uttar Pradesh",
    myneta_url: "https://www.myneta.info/ls2024/candidate.php?candidate_id=5515",
  },
  // Add more below, same format:
  // {
  //   name: "Rahul Gandhi",
  //   party: "INC",
  //   office: "MP",
  //   constituency: "Rae Bareli",
  //   state: "Uttar Pradesh",
  //   myneta_url: "https://www.myneta.info/ls2024/candidate.php?candidate_id=...",
  // },
];

for (const data of POLITICIANS) {
  // Skip if already in DB (won't duplicate)
  const existing = listPoliticians().find(
    (p) => p.name === data.name && p.constituency === data.constituency
  );
  if (existing) {
    console.log(`Already exists: ${data.name} — skipping add, will re-ingest`);
  }

  const p = upsertPolitician(data);
  console.log(`\n=== ${p.name} (${p.id}) ===`);

  console.log("Pulling evidence from all sources...");
  const n = await ingestFor(p);
  console.log(`  ${n} new evidence items collected`);

  console.log("Generating AI report with GLM-5.2...");
  try {
    const r = await generateReport(p.id);
    console.log(`  Grade: ${r.overall_grade}  Score: ${r.overall_score}/100`);
    console.log(`  "${r.headline}"`);
  } catch (err) {
    console.error(`  Report failed: ${err.message}`);
  }
}

console.log("\nDone. Open http://localhost:3000 to see the results.");
