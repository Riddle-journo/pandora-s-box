# Pandoro's Box — Operator Runbook

This is the non-technical operator's manual for running Pandoro's Box in production. Every section
has one copy-pasteable PowerShell command and the output you should expect to see. Run these from
the repo root: `C:\Users\DELL\Documents\coder pro\rate-my-rep`.

The app is managed by **PM2** (a process manager — a background program that keeps your app
process, here named `pandoros`, running and restarts it if it crashes).

---

## Start

```powershell
npm run prod:start
```

Expected output (a table with the app listed as `online`):

```
[PM2] Applying action restartProcessId on app [pandoros](ids: [ 0 ])
[PM2] [pandoros](0) ✓
┌────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐
│ id │ name        │ mode    │ ↺       │ status   │ cpu    │ mem  │ ...       │          │          │          │          │
├────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤
│ 0  │ pandoros    │ fork    │ 0       │ online   │ 0%     │ ...  │           │          │          │          │          │
└────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘
```

The key thing to check: the `status` column says **online**.

---

## Stop

```powershell
npm run prod:stop
```

Expected output (status changes to `stopped`):

```
[PM2] Applying action stopProcessId on app [pandoros](ids: [ 0 ])
[PM2] [pandoros](0) ✓
┌────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬...
│ 0  │ pandoros    │ fork    │ 0       │ stopped  │ 0%     │ 0b   │...
└────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴...
```

---

## Status

```powershell
npm run prod:status
```

Expected output: a table listing `pandoros` with its current `status` (`online` or `stopped`),
uptime, restart count (`↺`), CPU, and memory.

---

## Health

```powershell
curl.exe http://localhost:3000/healthz
```

Expected output (JSON, one line):

```json
{"ok":true,"uptime":7}
```

`"ok":true` means the server is up and can reach its database. If the app is stopped, this
command will instead fail to connect (e.g. `curl: (7) Failed to connect`) — that means Start it
first.

---

## Logs

```powershell
npm run prod:logs
```

Expected output: the last 100 lines from `logs/out.log` and `logs/err.log`, prefixed with
`pandoros`, e.g.:

```
[TAILING] Tailing last 100 lines for [pandoros] process (change the value with --lines option)
/path/to/logs/out.log last 100 lines:
0|pandoros | server listening on port 3000
```

This command prints the recent lines and exits on its own (it runs with `--nostream`), so
you get your prompt back — it does not keep tailing.

---

## Run all checks

```powershell
npm run check
```

This runs lint (static code-quality scan), the automated test suite, and a smoke test (a quick
end-to-end sanity check that boots the app and hits a few real endpoints). Expected output ends
with:

```
SMOKE PASS
```

If it ends with anything else (an error, a stack trace, `SMOKE FAIL`), something is broken —
see "When something is red" below.

---

## Backup now

```powershell
powershell -NoProfile -File scripts/backup.ps1
```

Expected output (from the underlying `db-maintenance.js backup` step):

```
[backup] wrote backups\pandoros-2026-07-14T12-34-56-789Z.db (XXX MB) in NNNms
```

(It may also print a `pruned` line if old backups were cleaned up.) This writes a fresh,
consistent copy of the database into `data\backups\`, named `pandoros-<timestamp>.db`. Old
backups are pruned automatically: `db-maintenance.js` keeps the newest 5 `pandoros-*.db` copies,
and `backup.ps1` additionally caps the whole `data\backups\` folder at its 14 most recent files.

---

## Restore from backup

**Do this only when the app is stopped.** The real backup filename pattern (from
`server/platform/db-maintenance.js`) is:

```
data\backups\pandoros-<ISO-timestamp-with-dashes>.db
```

e.g. `data\backups\pandoros-2026-07-14T08-44-51-524Z.db`. Newer backups have a later timestamp, so
the newest file is the one you want.

1. Stop the app:
   ```powershell
   npm run prod:stop
   ```
2. Copy the newest backup over the live database (PowerShell picks the newest file for you):
   ```powershell
   Copy-Item (Get-ChildItem data\backups\pandoros-*.db | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName data\pandoros.db -Force
   ```
   Expected output: none (a silent copy on success).
3. Delete the leftover write-ahead-log sidecar files so the restored copy is loaded cleanly:
   ```powershell
   Remove-Item data\pandoros.db-wal, data\pandoros.db-shm -ErrorAction SilentlyContinue
   ```
4. Start the app again:
   ```powershell
   npm run prod:start
   ```
   Confirm with the Health check above that `"ok":true`.

---

## After a reboot

If the computer restarts, PM2's process list needs to be reloaded:

```powershell
npx pm2 resurrect
```

Expected output:

```
[PM2] Restoring processes located in ...\.pm2\dump.pm2
[PM2] Process /pandoros restored
```

**Note:** `pm2 resurrect` only works if you previously ran `pm2 save` while the app was running
correctly. After any good Start (app confirmed `online` and Health returns `"ok":true`), run:

```powershell
npx pm2 save
```

so future reboots can restore it.

---

## Rotate API keys

API keys live in `.env` (never commit or print this file's values — only the key **names** below).
To rotate a key: generate a new one on the matching dashboard, then edit `.env` and replace that
key's value, then restart the app (`npm run prod:stop` then `npm run prod:start`) so it picks up
the change.

| Key name | Dashboard it comes from |
|---|---|
| `ADMIN_TOKEN` | Self-generated (a shared secret you choose yourself — not from an external dashboard) |
| `AI_API_KEY` | Your AI provider's dashboard (whichever provider `AI_BASE_URL` points at) |
| `GROQ_API_KEY` | Groq console (console.groq.com) |
| `GEMINI_API_KEY` | Google AI Studio (aistudio.google.com) |
| `DATA_GOV_IN_KEY` | data.gov.in API key dashboard |
| `INDIAN_KANOON_KEY` | Indian Kanoon API access dashboard |

Never paste key values into chat, logs, tickets, or this file.

---

## When something is red

If `npm run check` (or any task) fails and you need to back out of uncommitted changes, use the
per-task rollback ritual from `REFACTOR-PLAN.md`:

1. Confirm you actually want to discard local changes, then:
   ```powershell
   git checkout -- .
   git clean -fd
   ```
2. Retry the failed step **once**.
3. If it fails again: stop, note the task/issue in a local `SKIPPED.md`, and move on — do not
   keep retrying.

This ritual cannot touch `.env` or the database files — both are gitignored, so `git checkout`
and `git clean` leave them alone.

---

## Register daily 3am backup

**A human operator runs this once, not the assistant.** It registers a Windows Scheduled Task that
runs `scripts/backup.ps1` every day at 3:00 AM:

```powershell
schtasks /Create /SC DAILY /ST 03:00 /TN PandorosBackup /TR "powershell -NoProfile -File \"C:\Users\DELL\Documents\coder pro\rate-my-rep\scripts\backup.ps1\""
```

Expected output:

```
SUCCESS: The scheduled task "PandorosBackup" has successfully been created.
```
