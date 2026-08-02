// W4 Task 1 — path-parameter validation (defense in depth).
//
// Prepared statements already make injection impossible, so these assertions are
// about ERROR QUALITY and a hard outer bound on what reaches the store: a
// malformed :param must fail fast with a 400 in the house error shape, while a
// well-formed-but-missing one keeps its historical 404. The regression that
// matters most is the opposite direction — a pattern that rejects an id or slug
// which works today — so the happy paths are pinned byte-for-byte too.
import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/server.js";

let srv;

// Everything under server/ is imported LAZILY, inside before(). A static import
// is evaluated before startTestServer() runs, and server/store/db.js resolves
// PANDOROS_DB_PATH at import time — so a static `import … from "../server/…"`
// here opens (and runs the schema DDL against) the REAL data/pandoros.db, and
// leaves the app under test wired to it via the module cache. Keep these lazy.
let PARAM_CHECKS;
let upsertFlag, upsertLead, upsertStory, getLead, getStory;
let MINISTRIES, PARTIES, ORGS;

before(async () => {
  srv = await startTestServer();
  ({ PARAM_CHECKS } = await import("../server/routes/util.js"));
  ({ upsertFlag } = await import("../server/detectors/flags.js"));
  ({ upsertLead, upsertStory, getLead, getStory } = await import("../server/store/store.js"));
  ({ MINISTRIES, PARTIES } = await import("../server/data/ministries.js"));
  ({ ORGS } = await import("../server/data/orgs.js"));
});

after(async () => {
  await srv.close();
});

const NUL = "%00";
const NUL_CHAR = String.fromCharCode(0);
const LONG = "a".repeat(65);

describe("malformed path params -> 400", () => {
  // Percent-encoded NUL, over-length ids, and characters outside the id charset.
  const BAD_ID_PATHS = [
    `/api/politicians/${NUL}`,
    `/api/politicians/abc${NUL}def`,
    `/api/politicians/${LONG}`,
    "/api/politicians/has%20space",
    "/api/politicians/has%2Fslash%2Fparts",
    `/api/politicians/${NUL}/card`,
    `/api/politicians/${LONG}/card`,
    `/api/politicians/${NUL}/evidence`,
    `/api/politicians/${LONG}/evidence`,
    `/api/politicians/${NUL}/funding`,
    `/api/politicians/${NUL}/scandals`,
  ];

  for (const p of BAD_ID_PATHS) {
    it(`GET ${p} -> 400`, async () => {
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 400, `${p} should be rejected`);
      const body = await res.json();
      assert.equal(body.error, "invalid id");
    });
  }

  it("POST /api/politicians/<NUL>/tips -> 400 before any tip work", async () => {
    const res = await fetch(srv.baseUrl + `/api/politicians/${NUL}/tips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "other", text: "x" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid id");
  });

  const BAD_SLUG_PATHS = [
    `/api/scandals/${NUL}`,
    "/api/scandals/-leading-hyphen",
    "/api/scandals/has%20space",
    `/api/scandals/${"s".repeat(129)}`,
    `/api/issues/${NUL}`,
    "/api/issues/has%20space",
  ];
  for (const p of BAD_SLUG_PATHS) {
    it(`GET ${p} -> 400`, async () => {
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 400, `${p} should be rejected`);
      assert.equal((await res.json()).error, "invalid slug");
    });
  }

  it("GET /api/parties/<NUL>/card -> 400", async () => {
    const res = await fetch(srv.baseUrl + `/api/parties/${NUL}/card`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid key");
  });

  it("GET /api/ministries/<NUL>/card -> 400", async () => {
    const res = await fetch(srv.baseUrl + `/api/ministries/union${NUL}finance/card`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid key");
  });

  it("GET /api/orgs/<NUL>/card -> 400", async () => {
    const res = await fetch(srv.baseUrl + `/api/orgs/psu${NUL}nhai/card`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid key");
  });

  it("GET /api/funding/party/<NUL> -> 400", async () => {
    const res = await fetch(srv.baseUrl + `/api/funding/party/Bharatiya${NUL}Janata%20Party`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid party");
  });

  it("GET /api/funding/party/<101 chars> -> 400", async () => {
    const res = await fetch(srv.baseUrl + "/api/funding/party/" + "P".repeat(101));
    assert.equal(res.status, 400);
  });
});

describe("well-formed-but-missing params keep their historical 404", () => {
  const NOT_FOUND = [
    "/api/politicians/nonexistent-id",
    "/api/politicians/nonexistent-id/card",
    "/api/scandals/no-such-scandal-2099",
    "/api/issues/no-such-issue",
    "/api/parties/notreal/card",
    "/api/ministries/definitely%2Fnot%2Freal/card",
    "/api/orgs/junk/nope/card",
    "/api/politicians/nonexistent-id/funding",
    "/api/politicians/nonexistent-id/scandals",
  ];
  for (const p of NOT_FOUND) {
    it(`GET ${p} -> 404, not 400`, async () => {
      const res = await fetch(srv.baseUrl + p);
      assert.equal(res.status, 404, `${p} must stay a 404`);
    });
  }

  it("a well-formed UUID id still 404s (not 400)", async () => {
    const res = await fetch(srv.baseUrl + "/api/politicians/" + crypto.randomUUID());
    assert.equal(res.status, 404);
  });

  it("GET /api/politicians/<uuid>/evidence returns the legacy empty array", async () => {
    const res = await fetch(srv.baseUrl + "/api/politicians/" + crypto.randomUUID() + "/evidence");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });
});

describe("validation runs after the admin gate", () => {
  // Why the 401 must win: an unauthenticated caller must not be able to tell a
  // route that exists (400 "invalid id") from one that does not (404). Nothing
  // about rate limiting motivates this ordering — express-rate-limit's
  // skipSuccessfulRequests skips statusCode < 400, so a 400 is counted exactly
  // like a 401 and validating first would not have opened a free probing
  // channel. That same counting rule is the real side effect of adding
  // validation at all: GET /api/admin/ops/logs/:id used to return 200 for any
  // id, so malformed ids were free; now they are 400s, and 20 of them inside
  // the 15-minute window will 429 a legitimate admin (RATE_LIMIT_ADMIN_MAX).
  const ADMIN_PATHS = [
    ["GET", `/api/politicians/${NUL}/report`],
    ["GET", `/api/admin/ops/jobs/${NUL}`],
    ["GET", `/api/admin/ops/flags/${NUL}`],
    ["POST", `/api/admin/tips/${NUL}/review`],
    ["POST", `/api/admin/investigation-leads/${NUL}/approve`],
    ["POST", `/api/admin/ops/leads/${NUL}/action`],
  ];
  for (const [method, p] of ADMIN_PATHS) {
    it(`${method} ${p} without a token -> 401, not 400`, async () => {
      const res = await fetch(srv.baseUrl + p, { method });
      assert.equal(res.status, 401);
    });
  }

  it("with a valid token, a malformed admin id -> 400", async () => {
    const res = await fetch(srv.baseUrl + `/api/admin/ops/jobs/${NUL}`, {
      headers: { "x-admin-token": srv.adminToken },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid id");
  });

  it("with a valid token, a well-formed missing admin id -> 404", async () => {
    const res = await fetch(srv.baseUrl + "/api/admin/ops/jobs/" + crypto.randomUUID(), {
      headers: { "x-admin-token": srv.adminToken },
    });
    assert.equal(res.status, 404);
  });
});

describe("patterns accept the shapes real data actually uses", () => {
  // Mirrors what was verified against the 432 MB live DB: every politician /
  // job / flag / lead id is a crypto.randomUUID(); slugs are kebab-case with
  // years; ministry and org keys are "scope/name"; party names carry spaces,
  // ampersands, dots, parentheses and en dashes.
  it("id accepts UUIDs and legacy slug-style ids", () => {
    for (const v of [crypto.randomUUID(), "narendra-modi", "rep_00123", "A1", "a".repeat(64)]) {
      assert.ok(PARAM_CHECKS.id(v), v);
    }
    for (const v of ["", "a".repeat(65), "has space", "a/b", "a.b", "" + NUL_CHAR + ""]) {
      assert.ok(!PARAM_CHECKS.id(v), JSON.stringify(v));
    }
  });

  it("slug accepts real scandal and issue slugs", () => {
    for (const v of ["2g-spectrum-2008", "abg-shipyard-2022", "civil-rights-liberties", "a.b_c-d"]) {
      assert.ok(PARAM_CHECKS.slug(v), v);
    }
    for (const v of ["", "-leading", ".leading", "has space", "a/b"]) {
      assert.ok(!PARAM_CHECKS.slug(v), JSON.stringify(v));
    }
  });

  // These loop over the SHIPPED CATALOGUES rather than a hand-written fixture:
  // the card routes accept exactly the keys in these arrays, so adding an entry
  // whose key falls outside the charset (say "psu/oil&gas" or "state/uttar
  // pradesh") has to fail HERE, at the point the key is added, instead of 400ing
  // that one org in production with a green suite.
  it("key accepts every party key in PARTIES", () => {
    assert.ok(PARTIES.length >= 18, `PARTIES looks empty (${PARTIES.length}) — the loop below would pass vacuously`);
    const bad = PARTIES.map((p) => p.key).filter((k) => !PARAM_CHECKS.key(k));
    assert.deepEqual(bad, [], "these party keys would 400 on /api/parties/:key/card");
    assert.ok(!PARAM_CHECKS.key("union/finance"), "flat key must reject slashes");
  });

  it("pathkey accepts every ministry and org key in MINISTRIES/ORGS", () => {
    assert.ok(ORGS.length >= 286, `ORGS looks short (${ORGS.length}) — check the catalogue import`);
    assert.ok(MINISTRIES.length >= 213, `MINISTRIES looks short (${MINISTRIES.length})`);
    const keys = [...new Set([...MINISTRIES, ...ORGS].map((o) => o.key))];
    const bad = keys.filter((k) => !PARAM_CHECKS.pathkey(k));
    assert.deepEqual(bad, [], "these catalogue keys would 400 on the ministry/org card routes");
    assert.ok(!PARAM_CHECKS.pathkey("union/fin" + NUL_CHAR + "ance"));
  });

  // Flag/lead ENGINE KEYS: the shapes engine.js actually emits, sampled from the
  // live DB (7,274 flag keys / 3,016 lead keys). These are what the id-OR-key
  // routes have to accept, and they are why those routes use the "ref" kind.
  it("ref accepts real engine keys (pipes, slashes, unicode, 700+ chars)", () => {
    const sub = crypto.randomUUID();
    for (const v of [
      `asset_income_mismatch|${sub}|2023`,
      `income_outlier|${sub}|STAT_INCOME_OUTLIER|${sub}|income 2020→2021`,
      `conflict|${sub}|DONOR_REWARD|${sub}|Logistics / Conglomerate donors to BJP`,
      `CPPP_DATE_INTEGRITY|cppp:buyer_org:BORDER ROADS ORGANISATION/BORDER ROADS ORGN HQ CE P CHETAK BIKANER|dates`,
      `conflict|${sub}|REGULATORY_SELF_DEALING|${sub}|` + "Equity Shares Astha Green Energy Ventures India Pvt Ltd 7000 Nos Face Value Rs-10 (2)".repeat(8),
      sub,
    ]) {
      assert.ok(PARAM_CHECKS.ref(v), JSON.stringify(v.slice(0, 60)) + ` (len ${v.length})`);
      // The kind that shipped first rejected every one of these but the uuid.
      if (v !== sub) assert.ok(!PARAM_CHECKS.id(v), "the narrow id kind is what broke these");
    }
    for (const v of ["", "a".repeat(1025), "bad" + NUL_CHAR + "key", "bad\nkey", "bad\tkey"]) {
      assert.ok(!PARAM_CHECKS.ref(v), JSON.stringify(v.slice(0, 20)));
    }
  });

  it("party accepts real party names verbatim", () => {
    for (const v of [
      "Bharatiya Janata Party",
      "Communist Party of India (Marxist-Leninist) Liberation",
      "Nationalist Congress Party – Sharadchandra Pawar",
      "Jammu & Kashmir Peoples Democratic Party",
      "Rashtriya Janata Dal / Janata Dal",
      "A.I.A.D.M.K.",
    ]) {
      assert.ok(PARAM_CHECKS.party(v), v);
    }
    for (const v of ["", "P".repeat(101), "Bad" + NUL_CHAR + "Party", "Bad\nParty"]) {
      assert.ok(!PARAM_CHECKS.party(v), JSON.stringify(v));
    }
  });
});

// ── The regression that shipped: routes whose store lookup is "id = ? OR key = ?"
// (or "OR slug = ?") were given the narrow uuid-shaped `id` kind, so every
// non-uuid address for those rows started 400ing. These drive the REAL routes
// with rows written through the real store, addressed BOTH ways.
describe("id-OR-key routes accept the engine key, not just the uuid", () => {
  const admin = () => ({ "x-admin-token": srv.adminToken });

  it("GET /api/admin/ops/flags/:id resolves a flag by uuid AND by engine key", async () => {
    const sub = crypto.randomUUID();
    const key = `asset_income_mismatch|${sub}|2023`;
    const flag = upsertFlag({
      key, detector: "asset_income_mismatch", severity: "big", score: 80,
      politician_id: sub, headline: "assets grew faster than declared income",
      rationale: "fixture", evidence: [], data: {},
    });

    const byId = await fetch(srv.baseUrl + "/api/admin/ops/flags/" + flag.id, { headers: admin() });
    assert.equal(byId.status, 200);
    assert.equal((await byId.json()).key, key);

    const byKey = await fetch(srv.baseUrl + "/api/admin/ops/flags/" + encodeURIComponent(key), { headers: admin() });
    assert.equal(byKey.status, 200, "the engine key is a documented address for a flag");
    assert.equal((await byKey.json()).id, flag.id);
  });

  it("GET /api/admin/ops/flags/:id resolves the awkward key shapes too", async () => {
    const sub = crypto.randomUUID();
    // A key with "/" in the fingerprint (424 live flags have one) and a long
    // unicode-bearing one (max live key length is 735 chars).
    const keys = [
      `conflict|${sub}|DONOR_REWARD|${sub}|Logistics / Conglomerate donors to BJP`,
      `income_outlier|${sub}|STAT_INCOME_OUTLIER|${sub}|income 2020→2021 ` + "x".repeat(600),
    ];
    for (const key of keys) {
      upsertFlag({ key, detector: "conflict", severity: "small", score: 1, politician_id: sub, headline: "h", rationale: "r", evidence: [], data: {} });
      const res = await fetch(srv.baseUrl + "/api/admin/ops/flags/" + encodeURIComponent(key), { headers: admin() });
      assert.equal(res.status, 200, `len ${key.length} key must resolve`);
      assert.equal((await res.json()).key, key);
    }
  });

  it("POST /api/admin/investigation-leads/:id/reject accepts a lead engine key", async () => {
    const actor = crypto.randomUUID();
    const key = `ASSET_INCOME_MISMATCH|${actor}|2021`;
    upsertLead({ key, vector: "ASSET_INCOME_MISMATCH", actor_id: actor, actor_name: "Fixture Rep", status: "proposed", headline: "h", signal_score: 7 });

    const res = await fetch(srv.baseUrl + `/api/admin/investigation-leads/${encodeURIComponent(key)}/reject`, {
      method: "POST", headers: admin(),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    // Soft-delete semantics are owned elsewhere; assert only that the key
    // addressed the right row.
    assert.equal(getLead(key).status, "rejected");
  });

  it("POST /api/admin/ops/leads/:id/action accepts a lead engine key", async () => {
    const actor = crypto.randomUUID();
    const key = `REGULATORY_SELF_DEALING|${actor}|Equity Shares / Holdings (2)`;
    upsertLead({ key, vector: "REGULATORY_SELF_DEALING", actor_id: actor, actor_name: "Fixture Rep", status: "proposed", headline: "h", signal_score: 9 });

    const res = await fetch(srv.baseUrl + `/api/admin/ops/leads/${encodeURIComponent(key)}/action`, {
      method: "POST", headers: { ...admin(), "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "dismissed");
  });

  it("POST /api/admin/stories/:id/status accepts a 65-80 char slugify() slug", async () => {
    // slugify() in publishing/story-generator.js ends with .slice(0, 80), so this
    // length is reachable by design; the 64-char `id` kind 400'd it.
    const slug = "alleged-irregularities-in-the-allocation-of-coal-blocks-by-the-ministry-of-coal";
    assert.ok(slug.length > 64 && slug.length <= 80, `fixture must sit in the broken window (len ${slug.length})`);
    assert.ok(PARAM_CHECKS.slug(slug) && !PARAM_CHECKS.id(slug), "this is exactly the shape the id kind rejected");
    const story = upsertStory({ slug, status: "draft", headline: "Coal block allocation", generated_at: Date.now() });

    const bySlug = await fetch(srv.baseUrl + `/api/admin/stories/${slug}/status`, {
      method: "POST", headers: { ...admin(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "proposed" }),
    });
    assert.equal(bySlug.status, 200, "a long-but-legal slug must reach canTransition");
    assert.equal((await bySlug.json()).status, "proposed");

    const byId = await fetch(srv.baseUrl + `/api/admin/stories/${story.id}/status`, {
      method: "POST", headers: { ...admin(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    });
    assert.equal(byId.status, 200);
    assert.equal(getStory(slug).status, "published");
  });

  // The permissive kinds are still a real filter: control characters and absurd
  // lengths must not reach the store.
  it("the permissive kinds still reject control chars and over-long values", async () => {
    const cases = [
      `/api/admin/ops/flags/${NUL}`,
      `/api/admin/ops/flags/${encodeURIComponent("a".repeat(1025))}`,
      `/api/admin/stories/${"s".repeat(129)}/status`,
    ];
    for (const p of cases) {
      const res = await fetch(srv.baseUrl + p, { method: p.endsWith("/status") ? "POST" : "GET", headers: admin() });
      assert.equal(res.status, 400, `${p.slice(0, 60)} must still be a 400`);
      assert.equal((await res.json()).error, "invalid id");
    }
  });
});
