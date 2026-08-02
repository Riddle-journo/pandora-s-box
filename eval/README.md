# Investigation-quality eval — the labelling rubric

The repo has ~490 tests that prove the **code** behaves. None of them can tell you
whether the AI Investigator is **right**. This directory is the measuring
instrument: a set of human labels on real leads, and a scorer that turns them into
precision, recall, and a confidence-calibration table.

Until this exists, every prompt edit, model swap, or threshold change to
`server/synthesis/investigator.js` is an unmeasured bet. After it exists, a change
is a number that moved.

```
eval/labels.jsonl      one JSON object per human judgement, append-only
eval/runs/*.json       one file per scoring run (the trend + the delta baseline)
eval/README.md         this rubric — what a label MEANS
eval/TODO-LABELING.md  what the owner must do next, with exact commands
```

---

## What is being labelled

A **lead** is a candidate finding in `investigation_leads`: a detector spotted a
shape (an asset-to-income jump, a declared company in a sector the member's
questions concentrate on, an unusual award pattern) and wrote a headline, a
detail, and a set of cited evidence URLs. The AI Investigator (L2) then either
dismisses it or promotes it, with a verdict tier and a confidence, and an L3
"defence counsel" pass can downgrade it to COINCIDENCE.

You are **not** labelling whether the model's reasoning was eloquent. You are
labelling one thing:

> **If this lead were published tomorrow with the evidence attached, would it
> stand up?**

---

## The three labels

### `true_positive`

All three must hold. Any one failing is not a true positive.

1. **The adverse fact is real.** Not "plausible", not "consistent with" — the
   record says it. An asset jump of 400% is real if two affidavits show it. A
   "shell company marker" is real if the registry actually says struck-off /
   dormant / a shared address.
2. **It is about the right person.** The single worst failure mode in this system
   is attaching an adverse record to a namesake. If the link between the record
   and the representative rests on a name match alone — no DIN, no constituency,
   no date of birth, no affidavit cross-reference — it is **not** a true positive,
   however juicy it reads.
3. **It is citable from the evidence attached to this lead.** Open the cited
   rows in the labeller. If the number in the headline cannot be traced to one of
   them, the lead is not publishable even if it happens to be true. A claim you
   would have to go and find a *new* source for is at best `undecidable`.

A true positive does **not** have to prove wrongdoing. "This member's declared
assets rose 41x across two terms, per these two affidavits" is a true positive:
real, correctly attributed, cited. Whether it is a scandal is the reader's call.

### `false_positive`

Any one of these is enough.

- **Misattributed identity.** The record belongs to a different person (or a
  different company with a similar name). Suspect this first, always.
- **Statistical artifact.** The flag is an artefact of the method, not the world:
  a Benford deviation on 12 data points; an "outlier" against a peer group of
  four; a growth spike that is a unit change (lakh vs crore), a currency
  redenomination, a re-filed affidavit, or a missing prior-year row read as zero.
  A denominator problem — a per-capita or utilisation ratio computed against the
  wrong base — belongs here.
- **An innocent explanation fully accounts for it.** Not "could conceivably
  explain" — *fully accounts for*. A minister's department covering a sector her
  declared mutual fund happens to touch. A party-level electoral-bond total
  attributed to an individual member who had no role in it. A committee seat held
  a decade before the transaction. If the ordinary, lawful account leaves nothing
  unexplained, this is a false positive, and that is exactly the judgement the L3
  referee is supposed to make.
- **The evidence does not support the claim.** The headline says a number the
  cited row does not contain, or the cited row is a directory page / index /
  404-shaped body with no content. A confident verdict built on an empty
  evidence row is a false positive, not an undecidable.

### `undecidable`

Use this when the answer needs a record **nobody has**, and be strict about it —
`undecidable` is an honest verdict, but it is also the easy way out, and a set
that is 60% undecidable measures nothing.

Legitimate uses:

- The mechanism turns on something genuinely unpublished: who beneficially owns
  an intermediate company, an unfiled annual return, an internal file noting.
- Identity is neither confirmed nor refuted and no free record can settle it —
  two plausible people, no DIN, no DOB in either source.
- The lead is a **hub / cluster artefact about no single person** (`NETWORK_HUB`,
  some `FLAG_CLUSTER` rows). "MPLADS under-utilisation appears across 128
  members" is a real pattern but not an accountability claim about anybody; it is
  a research prompt. If you want the eval to reflect that, label it
  `undecidable` with that note — *see the caveat on seeded dismissals below*.

Not a legitimate use: "I would need to read more of the source." Read it. The
labeller prints it.

---

## Worked examples

> **This file is committed to a repository with a public remote, so it names
> nobody.** The examples below are real leads, de-identified: the subject is
> referred to by role, and company/committee specifics are generalized. Lead ids
> stay because they resolve only against the local private database — run the
> labeller to see the full, named context on your own machine. Never paste a
> person's name, a specific holding, or verbatim Investigator output into this
> file or any other committed document: the private Investigator branch produces
> unadjudicated adverse allegations about living people, and publishing one — even
> as a teaching example, even one we are calling FALSE — is the exact harm this
> project's admin gate exists to prevent.

Three real leads from this database. Short on purpose; the labeller prints the
full context.

### 1. `f1c8bda1` — REGULATORY_SELF_DEALING, score 54

> Member holds declared business interest(s) in a sector while the office's
> parliamentary attention concentrates in that same sector. Two declared
> sector interests; office attention weight on the sector = 18.

The investigator returned **COINCIDENCE at 0.82** and its own evidence-against is
the reason: the relevant committee role was two Lok Sabha terms earlier, the
current term's committees include no body covering that sector, and "18" is an
aggregate attention weight with no question text behind it. Nothing links a
specific question to that specific company.

**Correct label: `false_positive`** — an innocent explanation (declared, legal
holding + a decade-old unrelated committee seat + a generic sector overlap) fully
accounts for it. Note the *shape* of the failure: a sector-overlap detector with
no mechanism test will do this at scale.

### 2. `e82a46b5` — DONOR_REWARD, score 22

> The member's party drew electoral-bond funding from a sector the member's
> office also covers. Large party-level sector total; member's weight on that
> sector = 18.

**Correct label: `false_positive`**, and note *why* precisely: the adverse fact
(the party-level funding total) is real, but it is **about the wrong subject** — a
party-level number surfaced on an individual member's record. The lead's own
detail text even says "Party-level funding is inherited, not personal". That is
misattribution of subject, which is the same family of error as a namesake mix-up.
The investigator got this right at 0.88.

### 3. `8194674c` — NETWORK_HUB, no named subject, score 1015

> "MPLADS utilisation (under-utilised) appears in leads tied to 128 different
> representatives — a possible network hub."

A human dismissed this in the ops console, so it is seeded here as
`false_positive`. Read as an accountability claim it *is* a false positive: there
is no subject, no mechanism, and a score of 1015 purely because 128 members share
a signal. But it is a defensible **research** signal — arguably `undecidable`.
It is the clearest example of why the seeded rows below need re-reading by hand.

---

## How the score is computed

Definitions live in the header of `scripts/eval-investigator.js`; the ones that
change how you should read the output:

- **GATE** — the binary decision that actually matters: SUBSTANTIATED or
  SUGGESTIVE surfaces the lead into a human's queue (`status: proposed`);
  COINCIDENCE buries it. *Gate precision* = how much of the queue is real work.
  *Gate recall* = how much real material the referee threw away. On an
  accountability platform, precision is the reputational risk and recall is the
  opportunity cost — you will usually trade recall for precision, deliberately.
- **Per-tier** — precision and recall per verdict tier. For COINCIDENCE these
  read backwards: high COINCIDENCE recall is the **leak rate** (real leads
  buried), so lower is better.
- **Confidence calibration** — the artifact that tells you whether the model's
  numbers mean anything. Confidence is stated about the *verdict*, so 0.9 on
  COINCIDENCE means "confidently innocent"; the scorer converts everything to
  **P(the adverse claim is real)** = confidence, or 1 − confidence for
  COINCIDENCE. A well-calibrated model puts ~80% real leads in the 0.8–1.0
  bucket. A **negative `gap`** (observed below predicted) is over-confidence — the
  failure mode that gets a platform sued.
- **Per-detector precision** — which detectors generate the noise. A lead
  attributed to several detectors counts once for each, matching
  `store/content.js` `detectorPrecision` so the two reports are comparable.
- **Small samples** — every rate prints its numerator and denominator, and
  anything under `--min-sample` (default 5) is printed as *insufficient data*
  rather than a percentage. "100% precision" over n=1 is a lie told with
  arithmetic. Do not quote a number the harness marked insufficient. This applies
  everywhere, including the two places that used to escape it: **gate `f1`** is
  suffixed `— INSUFFICIENT DATA` whenever the precision or recall it is built from
  is thin (f1 carries no counts of its own, so it inherits theirs), and the
  **DELTA section** prints both sides with their counts and brackets any side
  below the floor — `gate.precision 50% (1/2) [INSUFFICIENT] → 100% (2/2)
  [INSUFFICIENT]`. A movement between two thin numbers is not evidence.
- **Ambiguous confidence** — the investigator prompt states no scale, so a bare
  `7` could be 7% or 7-out-of-10. The scorer reads it as a percent (the case that
  occurs today is `82` → 0.82) but **counts the guess** and prints a warning under
  the calibration table. If that counter is ever non-zero, pin the scale in the
  prompt before believing a single calibration row.
- **Labels resolve by id, then by key** — a lead that was purged and re-detected
  gets a new `id` but keeps its `key`, so each label is looked up by `lead_id` and
  then by the `lead_key` it stored. A key-resolved match is marked
  `resolved_by: "lead_key"` in the run's pair list and counted as `key_resolved`.
  `missing_lead` now means the row was **deliberately purged**: rejecting a lead
  soft-deletes it (`status: rejected`, row retained) precisely so a human "false
  positive" label keeps something to score against.
- **Numeric flags need values.** `--min-sample`, `--limit`, `--width`, `--seed-n`,
  `--max-leads` and `--delay-ms` error out if you type the flag without a number,
  instead of quietly becoming 1 (`Number(true) === 1`, which would have turned the
  sample floor off). `--min-sample 0` deliberately disables the floor.

`undecidable` labels are excluded from every rate but always counted, so a set
that has quietly become mostly-undecidable is visible rather than flattering.

---

## Labelling discipline

- **Label the record, not the person.** Prominence is not evidence.
- **Do not read the model's verdict first if you can avoid it** — the labeller
  prints it, because a labeller also needs to check whether the verdict is
  *citable*, but anchoring on it turns the eval into agreement-measurement.
  Form your own view from the headline + evidence, then read down.
- **Prior human decisions are shown and are not binding.** Disagree when the
  record says so; that disagreement is signal about the ops workflow.
- **Notes are the highest-value field.** A one-line "why" (`namesake — no DIN`,
  `unit change lakh→crore`, `party-level number on a personal record`) is what
  later turns a bad score into a fix. Write one every time.
- **Relabelling is legitimate.** The file is append-only and the last line per
  lead wins; earlier lines stay as an audit trail of the rubric tightening.

### Caveat on the seeded rows

`labels.jsonl` is seeded from the `lead_feedback` ledger, which records real human
decisions from the admin/ops UI:

| `lead_feedback.decision` | seeded label | strength |
| --- | --- | --- |
| `approved` (human published it) | `true_positive` | strong |
| `rejected` (human rejected a proposed lead) | `false_positive` | strong |
| `dismissed` (human parked a detected lead) | `false_positive` | **weak** |
| `glm_proposed` / `glm_dismissed` (`source: glm`) | *not a label* | — |

The GLM rows are excluded deliberately: they are the **prediction**. Seeding them
would make the eval circular and it would score a perfect 100%.

A `dismissed` row can mean "wrong" but it can also mean "not now" — the ops
console uses it to park things. Every seeded dismissal says so in its note.
Re-read them by hand before quoting a headline number.

---

## Commands

```bash
# import existing human decisions as labels (idempotent)
node scripts/label-leads.js --seed

# see what you would be labelling, prompt nothing
node scripts/label-leads.js --dry-run --limit 20

# label interactively (t / f / u / s / q, then a one-line note)
node scripts/label-leads.js --limit 20

# stratify: by detector, by stored verdict, or the never-investigated ones
node scripts/label-leads.js --detector conflict --limit 10
node scripts/label-leads.js --verdict SUGGESTIVE --limit 10
node scripts/label-leads.js --verdict none --random --seed-n 7 --limit 10

# score (default --stored: no LLM calls, no cost, read-only)
node scripts/eval-investigator.js
node scripts/eval-investigator.js --min-sample 3 --json
node scripts/eval-investigator.js --no-save          # don't persist a run file

# re-investigate the labelled leads with the CURRENT prompts (costs money AND
# writes to the DB — point it at a COPY first)
npm run db:backup
PANDOROS_DB_PATH=data/backups/<copy>.db \
  node scripts/eval-investigator.js --live --confirm-spend --max-leads 10
```

Both tools open the database **read-only** in every mode except `--live`, so a
scoring run can never alter the data it measures. `--live` refuses to run unless
you pass `--confirm-spend` **and** the target database is not `data/pandoros.db`.
The check compares **resolved absolute paths**, so setting
`PANDOROS_DB_PATH=data/pandoros.db` does not get you past it — merely *having* the
variable set proves nothing about which file it points at. The only override is an
explicit `--allow-live-db`, which means "yes, mutate the real database".

Both CLIs load `.env` (`dotenv/config`) before anything else, so `AI_API_KEY` and
a `PANDOROS_DB_PATH` set in `.env` are both honoured; an inline
`PANDOROS_DB_PATH=… node …` still wins, because dotenv never overrides a variable
that is already set.

## Suggested npm scripts

Not added to `package.json` — that file is owned elsewhere. Paste when convenient:

```json
"eval:seed":  "node scripts/label-leads.js --seed",
"eval:label": "node scripts/label-leads.js --limit 20",
"eval":       "node scripts/eval-investigator.js"
```

## CI

There is no `.github/workflows` in this repo, and this workstream did not create
one. When CI is added, the command that belongs in it is:

```bash
node --test test/eval-harness.test.js
```

That guards the scoring **maths** (zero-denominator, single-sample, calibration
bucketing, the feedback→label mapping, resumability) with no DB and no network.

Do **not** put `node scripts/eval-investigator.js` in CI: it reads a 432 MB local
database that does not exist on a runner. If you later want the score gated,
commit a small fixture DB and a fixture labels file and run
`PANDOROS_DB_PATH=test/fixtures/eval.db node scripts/eval-investigator.js --labels test/fixtures/eval-labels.jsonl --no-save`.
