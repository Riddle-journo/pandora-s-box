// The fetcher layer's TLS policy and its failure observability.
//
// Before this, `insecure: true` meant "rejectUnauthorized:false, unconditionally
// and forever", and GDELT held a module-level insecure https.Agent for the whole
// process. Both are now verified-FIRST with a downgrade only on a certificate-
// trust error, and every downgrade records its host. What that buys: a chain
// fixed upstream silently becomes verified again, and the genuinely-unverified
// hosts feeding the accusation engine become visible.
//
// Every case below uses an injected fetch stub. Nothing here touches the network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(os.tmpdir(), `pandoros-test-fetchtls-${process.pid}.db`);
process.env.PANDOROS_DB_PATH = DB_PATH;
// Failure telemetry writes a fetch_failures row. It is OFF for test runs by
// default precisely so an unrelated test can never append to the live 432 MB
// corpus; this suite opts in explicitly, against the temp DB set above.
process.env.PANDOROS_FETCH_TELEMETRY = "1";
for (const suffix of ["", "-wal", "-shm"]) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch { /* nothing to clean */ }
}

const { fetchTextEx, fetchText } = await import("../server/fetchers/http.js");
const { gdeltJson } = await import("../server/sources/gdelt-fetch.js");
const {
  insecureTlsInventory, resetInsecureTlsInventory,
} = await import("../server/util/tls-policy.js");
const {
  fetchFailureInventory, resetFetchFailureInventory, noteFetchFailure, markStale,
} = await import("../server/fetchers/observe.js");
const { sourceHealth, fetchFailureHealth } = await import("../server/store/store.js");
// GDELT requests take a slot on the shared 5s-per-host gate; clearing it between
// cases keeps the suite fast without weakening what is being asserted.
const { resetLimiter } = await import("../server/util/host-limiter.js");

test.after(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch { /* handle not released yet */ }
  }
});

const tlsErr = (code) => Object.assign(new Error("fetch failed"), { cause: { code } });
const netErr = (code) => Object.assign(new Error("fetch failed"), { cause: { code } });
const okRes = (body) => ({
  ok: true, status: 200,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  text: async () => body,
  headers: new Map(),
});

function reset() {
  resetInsecureTlsInventory();
  resetFetchFailureInventory();
  resetLimiter();
}
const failureKeys = () => fetchFailureInventory().map((f) => f.key);

// ── http.js: the `insecure: true` opt-in path ──────────────────────────

test("insecure:true still tries VERIFIED TLS first and stays verified when that works", async () => {
  reset();
  let calls = 0;
  const fetchImpl = async () => { calls++; return okRes("<html>ok</html>"); };

  const r = await fetchTextEx("https://wbindustries.gov.in/x.html", { insecure: true, fetchImpl });

  assert.equal(r.ok, true);
  assert.equal(r.text, "<html>ok</html>");
  assert.equal(calls, 1, "exactly one verified attempt, no insecure retry");
  assert.equal(r.tls_insecure, false, "the bytes were authenticated");
  assert.deepEqual(insecureTlsInventory(), [], "nothing recorded as unverified");
  assert.deepEqual(failureKeys(), [], "a success records no failure");
});

test("a NON-certificate failure never downgrades — it is reported as the failure it is", async () => {
  for (const code of ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "ECONNREFUSED"]) {
    reset();
    const thrown = netErr(code);
    const r = await fetchTextEx("https://vigilancebureau.punjab.gov.in/x.php", {
      insecure: true, fetchImpl: async () => { throw thrown; },
    });
    assert.equal(r.ok, false, `${code} fails`);
    assert.equal(r.tls_insecure, false);
    assert.equal(r.error, thrown, `${code}: the original error survives, unreplaced`);
    assert.deepEqual(insecureTlsInventory(), [],
      `${code} must not widen the unverified surface — an unverified retry cannot fix DNS or a reset`);
  }
});

test("STRICT_TLS=1 refuses the downgrade outright and surfaces the cert error", async () => {
  reset();
  const prev = process.env.STRICT_TLS;
  process.env.STRICT_TLS = "1";
  try {
    const thrown = tlsErr("CERT_HAS_EXPIRED");
    const r = await fetchTextEx("https://wbindustries.gov.in/x.html", {
      insecure: true, fetchImpl: async () => { throw thrown; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, thrown);
    assert.deepEqual(insecureTlsInventory(), [], "strict mode fetches nothing unverified");
  } finally {
    if (prev === undefined) delete process.env.STRICT_TLS;
    else process.env.STRICT_TLS = prev;
  }
});

test("fetchText records the failure it flattens to \"\"", async () => {
  reset();
  const text = await fetchText("https://sebi.gov.in/enforcement/orders/?text=X", {
    retries: 0, source: "sebi", fetchImpl: async () => ({ ok: false, status: 503, headers: new Map() }),
  });
  assert.equal(text, "", "the flattened return is unchanged for callers");
  assert.deepEqual(failureKeys(), ["sebi#http_text"], "but the failure is no longer invisible");
  assert.match(fetchFailureInventory()[0].last_message, /503/);
});

// ── gdelt-fetch.js: the scoped, recorded downgrade ─────────────────────

test("GDELT: the verified path is the normal path and records nothing", async () => {
  reset();
  const data = await gdeltJson("https://api.gdeltproject.org/api/v2/doc/doc?q=x", {
    fetchImpl: async () => okRes(JSON.stringify({ articles: [{ title: "t" }] })),
    insecureFetchImpl: async () => { throw new Error("must not be reached"); },
  });
  assert.deepEqual(data, { articles: [{ title: "t" }] });
  assert.deepEqual(insecureTlsInventory(), []);
  assert.deepEqual(failureKeys(), []);
});

test("GDELT: a cert-trust error downgrades ONCE and RECORDS the host", async () => {
  reset();
  let insecureCalls = 0;
  const data = await gdeltJson("https://api.gdeltproject.org/api/v2/doc/doc?q=x", {
    fetchImpl: async () => { throw tlsErr("CERT_HAS_EXPIRED"); },
    insecureFetchImpl: async () => { insecureCalls++; return Buffer.from(JSON.stringify({ articles: [] })); },
  });

  assert.deepEqual(data, { articles: [] }, "the news pipeline keeps working");
  assert.equal(insecureCalls, 1);
  const inv = insecureTlsInventory();
  assert.equal(inv.length, 1, "the unverified fetch is inventoried, not invisible");
  assert.equal(inv[0].host, "api.gdeltproject.org");
  assert.equal(inv[0].last_code, "CERT_HAS_EXPIRED");
  assert.equal(inv[0].count, 1);
});

test("GDELT: a non-cert failure does NOT downgrade, and the reason is recorded", async () => {
  reset();
  let insecureCalls = 0;
  const data = await gdeltJson("https://api.gdeltproject.org/api/v2/doc/doc?q=x", {
    fetchImpl: async () => { throw netErr("ECONNRESET"); },
    insecureFetchImpl: async () => { insecureCalls++; return Buffer.from("{}"); },
  });
  assert.equal(data, null);
  assert.equal(insecureCalls, 0, "no unverified retry for a reset");
  assert.deepEqual(insecureTlsInventory(), []);
  assert.deepEqual(failureKeys(), ["gdelt#http"]);
});

test("GDELT: the downgrade stays SCOPED to gdeltproject.org even on a real cert error", async () => {
  reset();
  let insecureCalls = 0;
  const data = await gdeltJson("https://evil.example.com/api?q=x", {
    fetchImpl: async () => { throw tlsErr("SELF_SIGNED_CERT_IN_CHAIN"); },
    insecureFetchImpl: async () => { insecureCalls++; return Buffer.from("{}"); },
  });
  assert.equal(data, null);
  assert.equal(insecureCalls, 0, "every other host stays fully certificate-verified");
  assert.deepEqual(insecureTlsInventory(), []);
  assert.deepEqual(failureKeys(), ["gdelt#tls_out_of_scope"]);
});

test("GDELT: STRICT_TLS=1 blocks even the scoped downgrade", async () => {
  reset();
  const prev = process.env.STRICT_TLS;
  process.env.STRICT_TLS = "1";
  let insecureCalls = 0;
  try {
    const data = await gdeltJson("https://api.gdeltproject.org/api/v2/doc/doc?q=x", {
      fetchImpl: async () => { throw tlsErr("CERT_HAS_EXPIRED"); },
      insecureFetchImpl: async () => { insecureCalls++; return Buffer.from("{}"); },
    });
    assert.equal(data, null);
    assert.equal(insecureCalls, 0);
    assert.deepEqual(failureKeys(), ["gdelt#tls_strict"]);
  } finally {
    if (prev === undefined) delete process.env.STRICT_TLS;
    else process.env.STRICT_TLS = prev;
  }
});

test("GDELT: a 200 with a non-JSON body is recorded as a parse failure, not as \"no news\"", async () => {
  reset();
  const data = await gdeltJson("https://api.gdeltproject.org/api/v2/doc/doc?q=x", {
    fetchImpl: async () => okRes("Your query rate is too high. Please wait."),
    insecureFetchImpl: async () => { throw new Error("must not be reached"); },
  });
  assert.equal(data, null);
  assert.deepEqual(failureKeys(), ["gdelt#json_parse"]);
  assert.match(fetchFailureInventory()[0].last_message, /JSON|Unexpected/i);
});

// ── The instrumented catch path reaches the ledger — the RIGHT ledger ──

test("an instrumented failure lands in fetch_failures WITH the message, and NOT in fetch_runs", async () => {
  reset();
  await noteFetchFailure("myneta", "affidavit_parse", new Error("selector matched nothing"), { url: "https://myneta.info/x" });

  const row = fetchFailureHealth({ days: 1 }).find((f) => f.key === "myneta#affidavit_parse");
  assert.ok(row, "the failure is a first-class row in the failure ledger");
  assert.equal(row.count, 1);
  assert.equal(row.source, "myneta");
  assert.equal(row.phase, "affidavit_parse");
  assert.match(row.last_message, /selector matched nothing/,
    "the message survives instead of being flattened away");

  // THE POINT. fetch_runs.source is a closed vocabulary that sourceHealth()
  // groups by and classifyHealth() reads as "configured source"; a 0%-ok entry
  // there is classified ROTTED — "provably broken" — and gates automation.
  // Phase telemetry must never appear in it, or the rot detector manufactures rot.
  const runSources = sourceHealth(1).map((h) => h.source);
  assert.equal(runSources.includes("myneta#affidavit_parse"), false,
    "no `<source>#<phase>` pseudo-source in fetch_runs");
  assert.equal(runSources.some((s) => s.includes("#")), false,
    "no composite key of ANY kind reached the source vocabulary");
  assert.equal(runSources.includes("myneta"), false,
    "and the parent source did not gain a phantom failed run either");
});

test("an UNATTRIBUTED failure is visible in-process but never persisted", async () => {
  reset();
  // article-body.js fetches arbitrary news hosts with no `source` opt. A hostname
  // default here wrote hundreds of junk keys into the durable ledger per run.
  const text = await fetchText("https://some-random-outlet.example.com/story", {
    retries: 0, fetchImpl: async () => ({ ok: false, status: 403, headers: new Map() }),
  });
  assert.equal(text, "");
  const inv = fetchFailureInventory();
  assert.deepEqual(inv.map((f) => f.key), ["some-random-outlet.example.com#http_text"],
    "the operator can still see it this process");
  assert.equal(inv[0].ledger, false, "explicitly marked non-persistable");

  const persisted = fetchFailureHealth({ days: 1 }).map((f) => f.source);
  assert.equal(persisted.includes("some-random-outlet.example.com"), false,
    "no unbounded hostname cardinality in the durable ledger");
  assert.equal(sourceHealth(1).some((h) => h.source.includes("example.com")), false,
    "and certainly not in the source vocabulary");
});

test("noteFetchFailure never throws, whatever it is handed", async () => {
  reset();
  await noteFetchFailure("weird", "phase", null);
  await noteFetchFailure("weird", "phase2", "a bare string");
  await noteFetchFailure("weird", "phase3", Object.assign(new Error("boom"), { cause: { code: "EAI_AGAIN" } }));
  const inv = fetchFailureInventory();
  assert.deepEqual(inv.map((f) => f.key).sort(), ["weird#phase", "weird#phase2", "weird#phase3"]);
  assert.equal(inv.find((f) => f.key === "weird#phase").last_message, "unknown error");
  assert.match(inv.find((f) => f.key === "weird#phase3").last_message, /EAI_AGAIN: boom/);
});

test("repeat failures of the same phase are counted, not duplicated in the inventory", async () => {
  reset();
  await noteFetchFailure("dup", "fetch", new Error("first"));
  await noteFetchFailure("dup", "fetch", new Error("second"));
  const inv = fetchFailureInventory();
  assert.equal(inv.length, 1);
  assert.equal(inv[0].count, 2);
  assert.equal(inv[0].last_message, "second", "the inventory keeps the LATEST message");
});

// ── Freshness honesty ─────────────────────────────────────────────────

test("markStale stamps cached data additively, never replacing a field", () => {
  const rows = [{ name: "A Ltd", position: "director" }, { name: "B Ltd", position: "director" }];
  const marked = markStale(rows, "2026-07-01T00:00:00.000Z", { stale_reason: "quota cache" });

  assert.deepEqual(rows[0], { name: "A Ltd", position: "director" }, "the input is not mutated");
  assert.equal(marked.length, 2);
  for (const m of marked) {
    assert.equal(m.stale, true);
    assert.equal(m.stale_fetched_at, "2026-07-01T00:00:00.000Z");
    assert.equal(m.stale_reason, "quota cache");
    assert.equal(m.position, "director", "existing fields survive untouched");
  }
  // A single object and a missing timestamp both behave.
  assert.deepEqual(markStale({ a: 1 }), { a: 1, stale: true, stale_fetched_at: null });
  assert.equal(markStale(null), null);
});
