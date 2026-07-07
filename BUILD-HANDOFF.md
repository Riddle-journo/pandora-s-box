# Build handoff — read this first

You are building a feature for "Pandoro's Box" (an Express + SQLite + vanilla-JS project in
this folder). The full design is in `C:\Users\DELL\.claude\plans\elegant-hatching-simon.md`.

---
## (For the human: paste THIS as your first message to the cheaper model, nothing else)
> Read `BUILD-HANDOFF.md` in this project, then read the plan file it points to. Follow the
> BUILDER RULES. Start at task A1 and do the tasks in order, one at a time, running each task's
> TEST before moving on. Do not skip ahead. When you finish a task, tell me the task number, show
> me the test output, and wait for me to say "continue" before starting the next task.
---

## How to work (follow this exactly)
1. Open the plan file. Read the top section titled **"BUILDER RULES"** and obey all 6 rules at
   all times.
2. Then read **PART 4 — BUILD SPEC**. It is a numbered list of tasks: A1, A2, A3, A4, then B1,
   B2, B3, B4, then C1…, then D.
3. **Do the tasks strictly in order. Do ONE task at a time.** Do not skip ahead.
4. For each task: make ONLY the change that task describes, then run the `TEST:` line inside
   that task. If the test output matches what the task says to expect, move to the next task.
   If it does not match, fix it before moving on — do not continue with a failing test.
5. Obey every `DO NOT:` line in a task — those are the mistakes that break the project.
6. Do not start Phase B until every Phase A test passes. Do not start Phase C until Phase B
   works (especially task B4's security gate).

## The 3 things you must NOT get wrong
- **Rule 3 / tasks A2, A3:** when a fetcher gets new data, ATTACH a `numbers` object to the
  evidence row. NEVER delete or replace its `content` field.
- **Task B2:** the "L2 Investigator" and the "L3 Referee" are TWO SEPARATE calls to the AI, not
  one combined prompt. Keep them separate — that separation is the whole point.
- **Task B4:** an "investigation lead" must NEVER be shown to the public until an admin has
  explicitly approved it. The endpoint `/api/conflicts` must return nothing until approval. Prove
  this with the task's test before you consider B4 done.

## If you get stuck
Stop on that one task. Do not guess or half-build past it. Report: which task number, what you
tried, and the exact error or wrong output. (The two tasks most likely to be fiddly are A2 — the
`numbers.power` shape from the Sansad data — and A3 — parsing the MyNeta HTML tables.)

## Verifying at the end
When all tasks are done, run the 5 steps under **"End-to-end verification"** at the bottom of the
plan file.
