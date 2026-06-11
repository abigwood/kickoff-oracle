// THE WINDOW — Cloudflare Worker (free tier) for KickOff Oracle.
//
// The Worker is the ONLY writer to KV. The static app (GitHub Pages) calls it.
// Server-side window check is the integrity core: the Worker fetches the
// deployed matches.json and rejects any pick outside [KO−60m, KO). Never trust
// the client clock.
//
// KV data model (multi-league — a pick is global, scores in every league):
//   user:{uid}        → {nickname, leagues:[code...]}
//   league:{code}     → {name, created, members:[uid...]}
//   picks:{matchId}   → {uid: {s1, s2, ts}}          (ONE pick per user/match)
//   table:{code}      → {rows, ts}                    (standings cache)
//
// Bindings (wrangler.toml):
//   KV            — Workers KV namespace
//   MATCHES_URL   — var, e.g. https://abigwood.github.io/kickoff-oracle/data/matches.json
//   ALLOWED_ORIGIN— var, e.g. https://abigwood.github.io
//   SETTLE_SECRET — secret, shared with the GitHub Action that pings /settle

import {
  windowState,
  bothTeamsReal,
  computeTable,
  buildReveals,
  makeCode,
  normNick,
} from "./logic.js";

const TABLE_TTL_MS = 60 * 1000; // recompute standings cache if older than this
const MATCHES_TTL_MS = 5 * 60 * 1000; // in-memory matches.json cache

// ---- module-scope matches cache (per warm isolate) ----
let _matches = null;
let _matchesAt = 0;
async function getMatches(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _matches && now - _matchesAt < MATCHES_TTL_MS) return _matches;
  const url = env.MATCHES_URL + (fresh ? `?t=${now}` : "");
  const r = await fetch(url, { cf: { cacheTtl: fresh ? 0 : 60 } });
  if (!r.ok) throw new Error(`matches fetch ${r.status}`);
  const data = await r.json();
  _matches = data.matches || [];
  _matchesAt = now;
  return _matches;
}

// ---- helpers ----
const j = (obj, status, env) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors(env) },
  });
const cors = (env) => ({
  "access-control-allow-origin": env.ALLOWED_ORIGIN || "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
});
const kvGet = (env, k) => env.KV.get(k, "json");
const kvPut = (env, k, v) => env.KV.put(k, JSON.stringify(v));
const randBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

// A member's display name is per-league: league.names[uid] overrides the user's
// global nickname (which stays the default/fallback for leagues with no override).
async function resolveMembers(env, league) {
  const uids = (league && league.members) || [];
  const names = (league && league.names) || {};
  const users = await Promise.all(uids.map((uid) => kvGet(env, `user:${uid}`)));
  return uids.map((uid, i) => ({ uid, nick: names[uid] || (users[i] && users[i].nickname) || "Anon" }));
}

async function loadPicksByMatch(env, matchIds) {
  const entries = await Promise.all(
    matchIds.map(async (id) => [id, (await kvGet(env, `picks:${id}`)) || {}])
  );
  return Object.fromEntries(entries);
}

// The global nickname is just a default: set it once (first time), and let
// explicit /nick (no code) or per-league overrides change what's displayed.
async function ensureUser(env, uid, nickname) {
  const u = (await kvGet(env, `user:${uid}`)) || { nickname: "", leagues: [] };
  if (nickname && !u.nickname) u.nickname = normNick(nickname);
  return u;
}

// The league creator is the admin. Older leagues predate the `owner` field —
// fall back to the first member (the creator was added first) so admin still works.
const leagueOwner = (league) => league.owner || (league.members && league.members[0]);

// Drop standings caches so membership/nickname edits show up immediately.
async function bustTables(env, codes) {
  await Promise.all([...new Set(codes)].map((c) => env.KV.delete(`table:${c}`)));
}

async function standings(env, code, { useCache = true } = {}) {
  if (useCache) {
    const cached = await kvGet(env, `table:${code}`);
    if (cached && Date.now() - cached.ts < TABLE_TTL_MS) return cached.rows;
  }
  const league = await kvGet(env, `league:${code}`);
  if (!league) return null;
  const members = await resolveMembers(env, league);
  const matches = await getMatches(env);
  const ft = matches
    .filter((m) => m.status === "FT" && m.score1 != null)
    .sort((a, b) => Date.parse(a.ukKickoff) - Date.parse(b.ukKickoff))
    .map((m) => ({ id: m.id, s1: m.score1, s2: m.score2 }));
  const picksByMatch = await loadPicksByMatch(env, ft.map((m) => m.id));
  const rows = computeTable(members, ft, picksByMatch);
  await kvPut(env, `table:${code}`, { rows, ts: Date.now() });
  return rows;
}

// ---- route handlers ----
async function createLeague(env, body) {
  const uid = String(body.uid || "").trim();
  if (!uid) return j({ error: "uid required" }, 400, env);
  const name = String(body.name || "").trim().slice(0, 40) || "New League";
  // generate a code that isn't already taken
  let code;
  for (let i = 0; i < 6; i++) {
    code = makeCode(randBytes);
    if (!(await kvGet(env, `league:${code}`))) break;
  }
  const user = await ensureUser(env, uid, body.nickname);
  if (!user.leagues.includes(code)) user.leagues.push(code);
  const names = {};
  if (body.nickname) names[uid] = normNick(body.nickname); // creator's name in THIS league
  await kvPut(env, `league:${code}`, { name, created: Date.now(), owner: uid, members: [uid], names });
  await kvPut(env, `user:${uid}`, user);
  return j({ code, name }, 200, env);
}

async function joinLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return j({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  const user = await ensureUser(env, uid, body.nickname);
  if (!league.members.includes(uid)) league.members.push(uid);
  if (!user.leagues.includes(code)) user.leagues.push(code);
  league.names = league.names || {};
  if (body.nickname) league.names[uid] = normNick(body.nickname); // your name in THIS league
  await kvPut(env, `league:${code}`, league);
  await kvPut(env, `user:${uid}`, user);
  return j({ code, name: league.name }, 200, env);
}

// Edit your OWN display name. With a league `code`, sets it only in that league
// (per-league name); without a code, sets the global default used as the
// fallback for leagues where you haven't set a league-specific name. Identity is
// the uid — only the device holding it can send this, which is the ownership check.
async function setNickname(env, body) {
  const uid = String(body.uid || "").trim();
  const raw = String(body.nickname || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid) return j({ error: "uid required" }, 400, env);
  if (!raw) return j({ error: "nickname required" }, 400, env);
  if (code) {
    const league = await kvGet(env, `league:${code}`);
    if (!league) return j({ error: "no such league" }, 404, env);
    if (!(league.members || []).includes(uid)) return j({ error: "join the league first" }, 403, env);
    league.names = league.names || {};
    league.names[uid] = normNick(raw); // your name in THIS league only
    await kvPut(env, `league:${code}`, league);
    await bustTables(env, [code]);
    return j({ ok: true, code, nickname: normNick(raw) }, 200, env);
  }
  const user = await ensureUser(env, uid, raw);
  user.nickname = normNick(raw); // global default
  await kvPut(env, `user:${uid}`, user);
  await bustTables(env, user.leagues || []); // reflect the new name immediately
  return j({ ok: true, uid, nickname: user.nickname }, 200, env);
}

// Leave a league (remove your own entrant). Your picks stay intact globally, so
// they keep scoring in your OTHER leagues — they just stop counting in this one.
async function leaveLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  if (!uid || !code) return j({ error: "uid and code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  const wasOwner = leagueOwner(league) === uid;
  league.members = (league.members || []).filter((m) => m !== uid);
  let deleted = false;
  if (wasOwner) {
    if (league.members.length) league.owner = league.members[0]; // hand admin to the next member
    else {
      await env.KV.delete(`league:${code}`); // last one out — bin the empty league
      await env.KV.delete(`table:${code}`);
      deleted = true;
    }
  }
  if (!deleted) await kvPut(env, `league:${code}`, league);
  const user = await kvGet(env, `user:${uid}`);
  if (user) {
    user.leagues = (user.leagues || []).filter((c) => c !== code);
    await kvPut(env, `user:${uid}`, user);
  }
  if (!deleted) await bustTables(env, [code]);
  return j({ ok: true, deleted }, 200, env);
}

// Admin only: remove another member from your league.
async function kickMember(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  const target = String(body.target || "").trim();
  if (!uid || !code || !target) return j({ error: "uid, code and target required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  if (leagueOwner(league) !== uid)
    return j({ error: "only the league admin can remove members" }, 403, env);
  if (target === leagueOwner(league))
    return j({ error: "the admin can't be removed — leave the league instead" }, 400, env);
  league.members = (league.members || []).filter((m) => m !== target);
  await kvPut(env, `league:${code}`, league);
  const tu = await kvGet(env, `user:${target}`);
  if (tu) {
    tu.leagues = (tu.leagues || []).filter((c) => c !== code);
    await kvPut(env, `user:${target}`, tu);
  }
  await bustTables(env, [code]);
  return j({ ok: true }, 200, env);
}

// Admin only: rename the league.
async function renameLeague(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  const name = String(body.name || "").trim().slice(0, 40);
  if (!uid || !code || !name) return j({ error: "uid, code and name required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  if (leagueOwner(league) !== uid)
    return j({ error: "only the league admin can rename it" }, 403, env);
  league.name = name;
  await kvPut(env, `league:${code}`, league);
  return j({ ok: true, name }, 200, env);
}

async function makePick(env, body) {
  const uid = String(body.uid || "").trim();
  const matchId = Number(body.matchId);
  const s1 = Number(body.s1),
    s2 = Number(body.s2);
  if (!uid || !Number.isInteger(matchId))
    return j({ error: "uid and matchId required" }, 400, env);
  if (![s1, s2].every((n) => Number.isInteger(n) && n >= 0 && n <= 20))
    return j({ error: "scores must be 0–20" }, 400, env);

  // SERVER-SIDE WINDOW CHECK — the integrity core. Never trust the client.
  const matches = await getMatches(env);
  const match = matches.find((m) => m.id === matchId);
  if (!match) return j({ error: "no such match" }, 404, env);
  if (!bothTeamsReal(match.team1, match.team2))
    return j({ error: "teams not confirmed yet", state: "na" }, 403, env);
  // open until KO; at/after KO it's shut (no post-shut swap). Pre-KO overwrites freely.
  if (windowState(Date.parse(match.ukKickoff), Date.now()) === "shut")
    return j({ error: "window has shut", state: "shut" }, 403, env);

  // optionally keep nickname fresh + ensure membership exists
  if (body.nickname) {
    const user = await ensureUser(env, uid, body.nickname);
    await kvPut(env, `user:${uid}`, user);
  }
  const picks = (await kvGet(env, `picks:${matchId}`)) || {};
  picks[uid] = { s1, s2, ts: Date.now() };
  await kvPut(env, `picks:${matchId}`, picks);
  return j({ ok: true, matchId, s1, s2 }, 200, env);
}

async function getPicks(env, url) {
  const code = (url.searchParams.get("code") || "").toUpperCase();
  const matchId = Number(url.searchParams.get("matchId"));
  if (!code || !Number.isInteger(matchId))
    return j({ error: "code and matchId required" }, 400, env);
  const matches = await getMatches(env);
  const match = matches.find((m) => m.id === matchId);
  if (!match) return j({ error: "no such match" }, 404, env);
  // picks stay hidden until the window shuts (KO)
  if (windowState(Date.parse(match.ukKickoff), Date.now()) !== "shut")
    return j({ error: "window still open — picks hidden" }, 403, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  const members = await resolveMembers(env, league);
  const picksByMatch = await loadPicksByMatch(env, [matchId]);
  const [reveal] = buildReveals(members, [match], picksByMatch, Date.now());
  return j(reveal || { matchId, match: `${match.team1} v ${match.team2}`, picks: [] }, 200, env);
}

async function getState(env, url) {
  // Aggregate for the UI: a league's table + reveal feed in one round-trip.
  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (!code) return j({ error: "code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  const members = await resolveMembers(env, league);
  const matches = await getMatches(env);
  const rows = await standings(env, code);
  const picksByMatch = await loadPicksByMatch(env, matches.map((m) => m.id));
  const reveals = buildReveals(members, matches, picksByMatch, Date.now()).slice(0, 12);
  return j({ code, name: league.name, owner: leagueOwner(league), table: rows, reveals }, 200, env);
}

async function getTable(env, url) {
  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (!code) return j({ error: "code required" }, 400, env);
  const rows = await standings(env, code);
  if (rows == null) return j({ error: "no such league" }, 404, env);
  return j({ code, table: rows }, 200, env);
}

async function settle(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET)
    return j({ error: "forbidden" }, 403, env);
  // Recompute + warm every league's standings cache. Called by the Action's
  // build step after a data refresh when matches finish.
  await getMatches(env, { fresh: true });
  const list = await env.KV.list({ prefix: "league:" });
  let n = 0;
  for (const k of list.keys) {
    const code = k.name.slice("league:".length);
    await standings(env, code, { useCache: false });
    n++;
  }
  return j({ ok: true, leagues: n }, 200, env);
}

// Full KV export for backups (secret-gated, same secret as /settle). Paginates
// list so it survives growth. The caller is expected to store it privately
// (encrypted) — it contains uids, nicknames and picks.
async function exportAll(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET)
    return j({ error: "forbidden" }, 403, env);
  const data = {};
  let cursor;
  do {
    const res = await env.KV.list({ cursor });
    for (const k of res.keys) {
      const raw = await env.KV.get(k.name);
      try {
        data[k.name] = JSON.parse(raw);
      } catch {
        data[k.name] = raw;
      }
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return j({ exportedAt: Date.now(), count: Object.keys(data).length, data }, 200, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET") {
        if (path === "/" || path === "/health") return j({ ok: true, service: "the-window" }, 200, env);
        if (path === "/picks") return await getPicks(env, url);
        if (path === "/table") return await getTable(env, url);
        if (path === "/state") return await getState(env, url);
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (path === "/league") return await createLeague(env, body);
        if (path === "/join") return await joinLeague(env, body);
        if (path === "/nick") return await setNickname(env, body);
        if (path === "/leave") return await leaveLeague(env, body);
        if (path === "/kick") return await kickMember(env, body);
        if (path === "/rename") return await renameLeague(env, body);
        if (path === "/pick") return await makePick(env, body);
        if (path === "/settle") return await settle(env, body);
        if (path === "/export") return await exportAll(env, body);
      }
      return j({ error: "not found" }, 404, env);
    } catch (err) {
      return j({ error: "server error", detail: String(err && err.message || err) }, 500, env);
    }
  },
};
