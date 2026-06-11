// End-to-end test of the Worker request path with an in-memory KV and a
// stubbed matches feed. Exercises the full lifecycle and the server-side
// window enforcement (the part the client must never be trusted on).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const KO = "2026-06-17T21:00:00+01:00";
const koMs = Date.parse(KO);
const MIN = 60 * 1000;

// ---- in-memory KV stub ----
function makeKV() {
  const m = new Map();
  return {
    async get(k, type) {
      const v = m.get(k);
      if (v == null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) { m.set(k, v); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
    },
    _dump: m,
  };
}

const MATCHES = {
  matches: [
    { id: 50, team1: "England", team2: "Croatia", ukKickoff: KO, status: "UPCOMING", score1: null, score2: null },
  ],
};

function makeEnv() {
  return {
    KV: makeKV(),
    MATCHES_URL: "https://example.test/data/matches.json",
    ALLOWED_ORIGIN: "https://abigwood.github.io",
    SETTLE_SECRET: "s3cr3t",
  };
}

// drive the worker; `now` (ms) sets the simulated clock for window checks.
async function call(env, method, path, { body, now } = {}) {
  const realNow = Date.now;
  if (now != null) Date.now = () => now;
  // reset module matches cache by stubbing fetch fresh each call
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(MATCHES), { headers: { "content-type": "application/json" } });
  try {
    const req = new Request("https://w.test" + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const res = await worker.fetch(req, env);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, cors: res.headers.get("access-control-allow-origin") };
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
}

test("full lifecycle: create → join → pick window edges → reveal gating → settle", async () => {
  const env = makeEnv();

  // create a league (Adam)
  const created = await call(env, "POST", "/league", {
    body: { uid: "adam", nickname: "Adam", name: "THE BANTER CUP" },
  });
  assert.equal(created.status, 200);
  assert.equal(created.cors, "https://abigwood.github.io", "CORS pinned to Pages origin");
  const code = created.json.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);

  // a mate joins
  const joined = await call(env, "POST", "/join", { body: { uid: "smithy", nickname: "Smithy", code } });
  assert.equal(joined.status, 200);

  // --- WINDOW EDGES (server-side, integrity core) ---
  const tooEarly = await call(env, "POST", "/pick", {
    body: { uid: "adam", matchId: 50, s1: 2, s2: 1 }, now: koMs - 61 * MIN,
  });
  assert.equal(tooEarly.status, 403, "KO−61 rejected");
  assert.equal(tooEarly.json.state, "pre");

  const ok = await call(env, "POST", "/pick", {
    body: { uid: "adam", matchId: 50, s1: 2, s2: 1 }, now: koMs - 59 * MIN,
  });
  assert.equal(ok.status, 200, "KO−59 accepted");

  const smithyPick = await call(env, "POST", "/pick", {
    body: { uid: "smithy", matchId: 50, s1: 1, s2: 1 }, now: koMs - 5 * MIN,
  });
  assert.equal(smithyPick.status, 200, "KO−5 accepted");

  const tooLate = await call(env, "POST", "/pick", {
    body: { uid: "adam", matchId: 50, s1: 0, s2: 0 }, now: koMs + 1 * MIN,
  });
  assert.equal(tooLate.status, 403, "KO+1 rejected — no swaps after shut");
  assert.equal(tooLate.json.state, "shut");

  // the rejected late swap must NOT have overwritten the locked pick
  const stored = await env.KV.get("picks:50", "json");
  assert.deepEqual({ s1: stored.adam.s1, s2: stored.adam.s2 }, { s1: 2, s2: 1 }, "original pick intact");

  // --- REVEAL GATING ---
  const hidden = await call(env, "GET", `/picks?code=${code}&matchId=50`, { now: koMs - 1 * MIN });
  assert.equal(hidden.status, 403, "picks hidden while window open");

  const shown = await call(env, "GET", `/picks?code=${code}&matchId=50`, { now: koMs + 1 * MIN });
  assert.equal(shown.status, 200, "picks revealed once shut");
  assert.equal(shown.json.picks.length, 2);

  // --- SCORING after the match finishes ---
  MATCHES.matches[0] = { ...MATCHES.matches[0], status: "FT", score1: 2, score2: 1 };

  const table = await call(env, "GET", `/table?code=${code}`, { now: koMs + 3 * 60 * MIN });
  assert.equal(table.status, 200);
  const rows = table.json.table;
  const adamRow = rows.find((r) => r.nick === "Adam");
  const smithyRow = rows.find((r) => r.nick === "Smithy");
  assert.equal(adamRow.pts, 3, "Adam nailed 2–1 → exact → 3");
  assert.equal(adamRow.exact, 1);
  assert.equal(smithyRow.pts, 0, "Smithy 1–1 vs 2–1 → wrong result → 0");
  assert.equal(rows[0].nick, "Adam", "leader first");

  // --- /state aggregate for the UI ---
  const state = await call(env, "GET", `/state?code=${code}`, { now: koMs + 3 * 60 * MIN });
  assert.equal(state.status, 200);
  assert.equal(state.json.name, "THE BANTER CUP");
  assert.equal(state.json.table.length, 2);
  assert.equal(state.json.reveals[0].matchId, 50);

  // --- /settle secret gating ---
  const noSecret = await call(env, "POST", "/settle", { body: { results: [] } });
  assert.equal(noSecret.status, 403, "settle without secret forbidden");
  const settled = await call(env, "POST", "/settle", { body: { secret: "s3cr3t" }, now: koMs + 3 * 60 * MIN });
  assert.equal(settled.status, 200);
  assert.equal(settled.json.leagues, 1);

  // reset fixture for re-runs
  MATCHES.matches[0] = { id: 50, team1: "England", team2: "Croatia", ukKickoff: KO, status: "UPCOMING", score1: null, score2: null };
});

test("validation: bad scores and missing fields are rejected", async () => {
  const env = makeEnv();
  await call(env, "POST", "/league", { body: { uid: "adam", nickname: "Adam" } });
  const noUid = await call(env, "POST", "/pick", { body: { matchId: 50, s1: 1, s2: 0 }, now: koMs - 30 * MIN });
  assert.equal(noUid.status, 400);
  const badScore = await call(env, "POST", "/pick", { body: { uid: "adam", matchId: 50, s1: -1, s2: 0 }, now: koMs - 30 * MIN });
  assert.equal(badScore.status, 400);
  const noMatch = await call(env, "POST", "/pick", { body: { uid: "adam", matchId: 999, s1: 1, s2: 0 }, now: koMs - 30 * MIN });
  assert.equal(noMatch.status, 404);
});
