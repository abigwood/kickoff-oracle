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
    async delete(k) { m.delete(k); },
    async list({ prefix } = {}) {
      return { keys: [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
    },
    _dump: m,
  };
}

const MATCHES = {
  matches: [
    { id: 50, team1: "England", team2: "Croatia", ukKickoff: KO, status: "UPCOMING", score1: null, score2: null },
    { id: 99, team1: "1A", team2: "2B", ukKickoff: KO, status: "UPCOMING", score1: null, score2: null }, // placeholder teams
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

  // --- WINDOW EDGES (server-side, integrity core; new rule: open until KO) ---
  const wayEarly = await call(env, "POST", "/pick", {
    body: { uid: "adam", matchId: 50, s1: 1, s2: 0 }, now: koMs - 3 * 24 * 60 * MIN,
  });
  assert.equal(wayEarly.status, 200, "KO−3 days accepted (no more KO−60 gate)");

  const changePre = await call(env, "POST", "/pick", {
    body: { uid: "adam", matchId: 50, s1: 2, s2: 1 }, now: koMs - 1 * MIN,
  });
  assert.equal(changePre.status, 200, "KO−1 min: change accepted and overwrites");

  const smithyPick = await call(env, "POST", "/pick", {
    body: { uid: "smithy", matchId: 50, s1: 1, s2: 1 }, now: koMs - 5 * MIN,
  });
  assert.equal(smithyPick.status, 200);

  const tooLate = await call(env, "POST", "/pick", {
    body: { uid: "adam", matchId: 50, s1: 0, s2: 0 }, now: koMs + 1 * MIN,
  });
  assert.equal(tooLate.status, 403, "KO+1 rejected — no swaps after shut");
  assert.equal(tooLate.json.state, "shut");

  // the pre-KO change took effect; the rejected post-KO swap did NOT overwrite it
  const stored = await env.KV.get("picks:50", "json");
  assert.deepEqual({ s1: stored.adam.s1, s2: stored.adam.s2 }, { s1: 2, s2: 1 }, "pre-KO change kept, post-KO swap ignored");

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

test("ownership: nick edit, leave, admin kick/rename, and cross-league pick integrity", async () => {
  const env = makeEnv();
  const at = (off) => ({ now: koMs + off * MIN });
  // L1 owned by Adam; L2 owned by Smithy; both are members of both.
  const L1 = (await call(env, "POST", "/league", { body: { uid: "adam", nickname: "Adma", name: "L ONE" } })).json.code;
  await call(env, "POST", "/join", { body: { uid: "smithy", nickname: "Smithy", code: L1 } });
  const L2 = (await call(env, "POST", "/league", { body: { uid: "smithy", nickname: "Smithy", name: "L TWO" } })).json.code;
  await call(env, "POST", "/join", { body: { uid: "adam", nickname: "Adma", code: L2 } });

  // both pick match 50 while the window is open
  await call(env, "POST", "/pick", { body: { uid: "adam", matchId: 50, s1: 2, s2: 1 }, ...at(-30) });
  await call(env, "POST", "/pick", { body: { uid: "smithy", matchId: 50, s1: 0, s2: 0 }, ...at(-30) });
  MATCHES.matches[0] = { ...MATCHES.matches[0], status: "FT", score1: 2, score2: 1 };

  // --- per-league nickname edit (self) reflects in that league only ---
  const badName = (await call(env, "GET", `/state?code=${L1}`, at(180))).json.table.find((r) => r.uid === "adam");
  assert.equal(badName.nick, "Adma", "starts with the typo");
  const ne = await call(env, "POST", "/nick", { body: { uid: "adam", code: L1, nickname: "Adam" } });
  assert.equal(ne.status, 200);
  const fixed = (await call(env, "GET", `/state?code=${L1}`, at(180))).json.table.find((r) => r.uid === "adam");
  assert.equal(fixed.nick, "Adam", "nick fixed in L1 immediately (cache busted)");
  assert.equal(fixed.pts, 3, "Adam's exact 2–1 scores");
  const stillL2 = (await call(env, "GET", `/state?code=${L2}`, at(180))).json.table.find((r) => r.uid === "adam");
  assert.equal(stillL2.nick, "Adma", "renaming in L1 does NOT change the name in L2");

  // --- ownership enforcement: Adam is NOT the admin of L2 (Smithy is) ---
  const badRename = await call(env, "POST", "/rename", { body: { uid: "adam", code: L2, name: "HIJACK" } });
  assert.equal(badRename.status, 403, "non-admin rename rejected");
  const badKick = await call(env, "POST", "/kick", { body: { uid: "adam", code: L2, target: "smithy" } });
  assert.equal(badKick.status, 403, "non-admin kick rejected");

  // --- admin actions on L1 (Adam IS the admin) ---
  const rn = await call(env, "POST", "/rename", { body: { uid: "adam", code: L1, name: "THE REAL CUP" } });
  assert.equal(rn.status, 200);
  assert.equal((await call(env, "GET", `/state?code=${L1}`, at(180))).json.name, "THE REAL CUP");
  const cantKickSelf = await call(env, "POST", "/kick", { body: { uid: "adam", code: L1, target: "adam" } });
  assert.equal(cantKickSelf.status, 400, "admin can't kick themselves — must leave");

  // --- cross-league pick integrity: Adam leaves L1, picks still score in L2 ---
  const lv = await call(env, "POST", "/leave", { body: { uid: "adam", code: L1 } });
  assert.equal(lv.status, 200);
  const s1 = await call(env, "GET", `/state?code=${L1}`, at(180));
  assert.equal(s1.json.table.find((r) => r.uid === "adam"), undefined, "Adam gone from L1 table");
  assert.equal(s1.json.owner, "smithy", "admin handed to remaining member on owner-leave");
  const s2 = await call(env, "GET", `/state?code=${L2}`, at(180));
  const adamInL2 = s2.json.table.find((r) => r.uid === "adam");
  assert.equal(adamInL2.pts, 3, "Adam's pick still counts in L2 — pick was never deleted");
  // the global pick record is intact
  const picks = await env.KV.get("picks:50", "json");
  assert.deepEqual({ s1: picks.adam.s1, s2: picks.adam.s2 }, { s1: 2, s2: 1 });

  // --- admin kick removes a member from their league ---
  await call(env, "POST", "/join", { body: { uid: "dave", nickname: "Dave", code: L2 } });
  const kick = await call(env, "POST", "/kick", { body: { uid: "smithy", code: L2, target: "dave" } });
  assert.equal(kick.status, 200, "admin kick succeeds");
  assert.equal((await call(env, "GET", `/state?code=${L2}`, at(180))).json.table.find((r) => r.uid === "dave"), undefined);

  MATCHES.matches[0] = { id: 50, team1: "England", team2: "Croatia", ukKickoff: KO, status: "UPCOMING", score1: null, score2: null };
});

test("per-league names: one uid, different name per league; picks shared; reveals league-correct; migration", async () => {
  const env = makeEnv();
  const at = (off) => ({ now: koMs + off * MIN });
  const A = (await call(env, "POST", "/league", { body: { uid: "u1", nickname: "Adam", name: "MATES" } })).json.code;
  const B = (await call(env, "POST", "/league", { body: { uid: "u1", nickname: "Adam", name: "BROS" } })).json.code;
  // same person, different display name in league B
  assert.equal((await call(env, "POST", "/nick", { body: { uid: "u1", code: B, nickname: "Biggers" } })).status, 200);
  // a non-member can't set a name in a league they're not in
  assert.equal((await call(env, "POST", "/nick", { body: { uid: "stranger", code: A, nickname: "Hax" } })).status, 403);

  // ONE shared pick scores in both leagues
  await call(env, "POST", "/pick", { body: { uid: "u1", matchId: 50, s1: 2, s2: 1 }, ...at(-30) });
  MATCHES.matches[0] = { ...MATCHES.matches[0], status: "FT", score1: 2, score2: 1 };
  const sa = (await call(env, "GET", `/state?code=${A}`, at(180))).json;
  const sb = (await call(env, "GET", `/state?code=${B}`, at(180))).json;
  assert.equal(sa.table.find((r) => r.uid === "u1").nick, "Adam");
  assert.equal(sb.table.find((r) => r.uid === "u1").nick, "Biggers");
  assert.equal(sa.table.find((r) => r.uid === "u1").pts, 3, "shared pick scores in A");
  assert.equal(sb.table.find((r) => r.uid === "u1").pts, 3, "...and in B");
  // reveals show the league-correct name for the SAME uid
  assert.equal(sa.reveals[0].picks.find((p) => p.uid === "u1").nick, "Adam");
  assert.equal(sb.reveals[0].picks.find((p) => p.uid === "u1").nick, "Biggers");

  // migration: a legacy league with no names map falls back to the global nickname
  await env.KV.put("league:OLD123", JSON.stringify({ name: "Legacy", owner: "u1", members: ["u1"] }));
  const old = (await call(env, "GET", "/state?code=OLD123", at(180))).json;
  assert.equal(old.table.find((r) => r.uid === "u1").nick, "Adam", "legacy → global fallback");

  MATCHES.matches[0] = { id: 50, team1: "England", team2: "Croatia", ukKickoff: KO, status: "UPCOMING", score1: null, score2: null };
});

test("/export — secret-gated full KV backup", async () => {
  const env = makeEnv();
  const code = (await call(env, "POST", "/league", { body: { uid: "u1", nickname: "Adam", name: "MATES" } })).json.code;
  const denied = await call(env, "POST", "/export", { body: {} });
  assert.equal(denied.status, 403, "export without the secret is forbidden");
  const dump = await call(env, "POST", "/export", { body: { secret: "s3cr3t" } });
  assert.equal(dump.status, 200);
  assert.ok(dump.json.count >= 2, "exports league + user keys");
  assert.equal(dump.json.data[`league:${code}`].name, "MATES", "values are included and parsed");
  assert.ok(dump.json.data["user:u1"], "user record present");
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
  const placeholder = await call(env, "POST", "/pick", { body: { uid: "adam", matchId: 99, s1: 1, s2: 0 }, now: koMs - 30 * MIN });
  assert.equal(placeholder.status, 403, "can't pick a match with placeholder teams");
  assert.equal(placeholder.json.state, "na");
});
