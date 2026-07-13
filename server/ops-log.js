// Per-job live-log ring buffer (in-memory, bounded). The worker writes progress
// lines here while a job runs; the ops console polls `tail()` to stream them.
//
// Purely in-process and best-effort: logs are lost on restart (that's fine — the
// authoritative job outcome lives in the `jobs` table). Bounded per job AND in the
// number of jobs retained, so a long-lived server can never leak memory.

const MAX_LINES_PER_JOB = 500;   // keep only the most recent N lines of a job
const MAX_JOBS = 200;            // and only the most recent N jobs' buffers

// jobId → { seq, lines: [{ n, at, line }] }. Insertion order = age, so the first
// key is the oldest — used to evict when MAX_JOBS is exceeded.
const buffers = new Map();

// Append one line to a job's buffer. `line` is trimmed of trailing newline; blank
// lines are ignored so child-process newline splitting doesn't spam the stream.
export function push(jobId, line) {
  if (jobId == null) return;
  const text = String(line ?? "").replace(/\r?\n$/, "");
  if (!text.trim()) return;

  let buf = buffers.get(jobId);
  if (!buf) {
    if (buffers.size >= MAX_JOBS) buffers.delete(buffers.keys().next().value); // evict oldest job
    buf = { seq: 0, lines: [] };
    buffers.set(jobId, buf);
  }
  buf.lines.push({ n: ++buf.seq, at: Date.now(), line: text });
  if (buf.lines.length > MAX_LINES_PER_JOB) buf.lines.splice(0, buf.lines.length - MAX_LINES_PER_JOB);
}

// Return lines for a job with sequence number > `since` (0 = from the start),
// plus the latest sequence so the caller can poll incrementally.
// Shape: { lines: [{ n, at, line }], last }.
export function tail(jobId, since = 0) {
  const buf = buffers.get(jobId);
  if (!buf) return { lines: [], last: 0 };
  const from = Number(since) || 0;
  return { lines: buf.lines.filter((l) => l.n > from), last: buf.seq };
}

// Drop a job's buffer (optional; buffers self-evict, but tests/reset may call it).
export function clear(jobId) {
  buffers.delete(jobId);
}
