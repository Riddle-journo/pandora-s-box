# TODO — labelling, for the owner

Read `eval/README.md` first: it is the rubric, and a label written without it is
not comparable to one written with it.

State of the eval set as of the harness being built (all numbers measured off
`data/pandoros.db`, read-only):

| | count |
| --- | --- |
| leads in `investigation_leads` | **3,016** |
| leads that have ever been through L2/L3 (have a verdict) | **2** (both `COINCIDENCE`, both about the same member) |
| human decisions in `lead_feedback` | **2** (both `dismissed`, both `network_hub`) |
| labels already in `eval/labels.jsonl` | **2** — auto-seeded from those decisions |
| **scoreable today** (decided label **and** a verdict) | **0** |

The harness works; the data does not overlap yet. The two labelled leads have
never been investigated, and the two investigated leads have never been labelled.
`node scripts/eval-investigator.js` therefore prints `NOTHING TO SCORE` — which is
the correct answer, not a bug.

Fixing that is two commands and an evening of reading.

---

## Step 1 (2 minutes) — label the only two leads that already have verdicts

This alone takes the harness from 0 scoreable to 2 and proves the loop end to end.

```bash
node scripts/label-leads.js --verdict COINCIDENCE --limit 5
```

Both are the leads worked through in `eval/README.md` §Worked examples
(`f1c8bda1` REGULATORY_SELF_DEALING, `e82a46b5` DONOR_REWARD) — the labeller will
show you the named subject locally. Form your own view; the README argues both are
`false_positive`, which would mean the investigator got both right.

## Step 2 (30 s) — re-read the two seeded rows

They were seeded from `dismissed`, the **weak** signal (the ops console uses
`dismiss` to park things, which is not the same as "wrong"). Both are subject-less
`NETWORK_HUB` hubs, and there is a real argument for `undecidable`.

```bash
node scripts/label-leads.js --detector network_hub --limit 5   # the unlabelled hubs
```

To overwrite a seeded row, label the same lead again — the file is append-only and
the **last** line per lead wins. The lead ids are
`8194674c-2d09-419f-8c2d-6807a2cc15ee` and `f3678b2a-4119-48f3-bc94-d53e553c3742`.

## Step 3 (the real work) — create predictions to score

There is nothing to measure until the investigator has run on a spread of leads.
Two ways, both fine:

**Ops console, lead by lead** (`npm run ops` → `#/ops` → a lead → *investigate*).
Queues one `investigate_lead` job each. Slow, but you pick the leads, which is
what stratification needs.

**CLI, in bulk:**

```bash
node server/synthesis/investigate.js --top 40
```

Caveat that matters: `--top N` orders by `signal_score`, and the top of that list
is almost entirely `NETWORK_HUB` hubs (scores 1015, 575, 471 …) — the *worst*
stratum to spend the budget on, because those leads have no subject and mostly
label `undecidable`. Prefer `--id <politician-id>` for a handful of
representatives, or the ops console's run-on-a-SET, so the batch is person-level
leads across several detectors.

Cost: every lead is one bounded L2 tool-loop plus one L3 referee call, capped by
the `engine.investigator.*` tunables (max steps / max tool calls) in the ops
console Tuning tab. Lower them first if you want a cheaper sweep.

## Step 4 — label 30–50, stratified

Target **30–50 total labels**, with **at least 20 decided** (`true_positive` or
`false_positive`; `undecidable` rows are counted but excluded from every rate).
Below ~20 decided, `--min-sample 5` will suppress most cells and you will be
reading the word *INSUFFICIENT DATA* rather than a score. That is the harness
working as designed.

Suggested allocation, weighted by how much volume the stratum carries **and** how
badly a mistake there hurts:

| stratum (detector) | leads in DB | label ~ | why this many |
| --- | --- | --- | --- |
| `conflict` (REGULATORY_SELF_DEALING, DONOR_REWARD, …) | 734 | **12** | biggest stratum, and both worked examples show sector-overlap flags firing without a mechanism |
| `asset_income_mismatch`, `da_ratio`, `spend_vs_income`, `net_worth_reconciliation` | 864 | **8** | numeric claims about a named person — the highest-stakes publishable material |
| `undeclared_criminal_case`, `criminal_escalation` | 1,194 | **6** | where identity misattribution does the most damage; check the DIN/DOB/constituency link every time |
| `generic_outlier`, `multivariate_outlier`, `income_outlier`, `benford`, `metric_changepoint` | 481 | **6** | where statistical artifacts live (small-n Benford, unit changes, missing prior year read as zero) |
| `mplads_completion_gap`, `fund_utilization` | 797 | **4** | denominator risk — ratios against the wrong base |
| `award_concentration`, `politician_linked_award`, `nexus_triangle` | 418 | **4** | tender/award attribution, usually name-match only |
| `network_hub` | 26 | **2 (the seeds)** | no subject; do not spend more here |

```bash
# work one stratum at a time; --random with a fixed seed keeps the sample reproducible
node scripts/label-leads.js --detector conflict --random --seed-n 7 --limit 12
node scripts/label-leads.js --detector asset_income_mismatch --random --seed-n 7 --limit 8
node scripts/label-leads.js --detector undeclared_criminal_case --random --seed-n 7 --limit 6
node scripts/label-leads.js --detector benford --limit 3
node scripts/label-leads.js --detector mplads_completion_gap --random --seed-n 7 --limit 4

# preview any of these without being prompted
node scripts/label-leads.js --dry-run --detector conflict --limit 12
```

Keys are `t` / `f` / `u` / `s` (skip) / `q` (quit). Progress is flushed to
`eval/labels.jsonl` after **every** decision, so quitting costs nothing and
re-running resumes exactly where you stopped. Write the one-line note every time —
it is the field that later turns a bad number into a fix.

## Step 5 — score, and keep the runs

```bash
node scripts/eval-investigator.js                  # persists eval/runs/<timestamp>.json
node scripts/eval-investigator.js --min-sample 3   # if you stop short of 20 decided
```

Each run diffs itself against the previous saved run, so the sequence of files in
`eval/runs/` is the record of whether a prompt change helped. Change **one** thing
at a time between runs.

---

## Strata that are thin, and will stay thin

These detectors have too few leads to ever reach a sample floor of 5, so their
per-detector precision will read *insufficient data* forever. Judge them
qualitatively from the notes instead of waiting for a rate:

`regulatory_self_dealing` (3), `donor_reward` (7), `party_income_spike` (6),
`party_spend_vs_donations` (5), `copy_paste_affidavit` (2),
`bond_contract_proximity` (2), `project_front_running` (2),
`declared_company_absent_from_registry` (1), `dynasty_concentration` (1).

(Detector names are not vector names: the `conflict` detector emits the
`REGULATORY_SELF_DEALING`, `DONOR_REWARD`, and related vectors. `--detector`
accepts either.)

Also thin, structurally: the **calibration table**. With ~30 decided labels you
should expect two or three populated buckets and an ECE the harness may still
withhold. Calibration is the metric that needs the most labels — budget a second
pass of 20–30 once the first score exists and you know which strata are noisy.

## Two things NOT to do

- **Do not run `--live` against `data/pandoros.db`.** It re-investigates with the
  current prompts, which *writes*: `investigateLead` upserts the lead, adds
  evidence rows, and appends a `glm_*` feedback row. The harness compares the
  resolved absolute path against the live file and refuses, so
  `PANDOROS_DB_PATH=data/pandoros.db` does **not** satisfy the gate — point it at a
  copy (`npm run db:backup`) or type `--allow-live-db` and own the consequence.
- **Do not treat the `glm_proposed` / `glm_dismissed` feedback rows as labels.**
  They are the model grading itself. The seeder excludes them by design; if you
  add them by hand the eval will score 100% and mean nothing.
