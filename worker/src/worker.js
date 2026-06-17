// THE WINDOW — Cloudflare Worker (free tier) for KickOff Oracle.
//
// The Worker is the ONLY writer to KV. The static app (GitHub Pages) calls it.
// Server-side window check is the integrity core: the Worker fetches the
// deployed matches.json and rejects any pick outside [KO−60m, KO). Never trust
// the client clock.
//
// KV data model (multi-league — a pick is global, scores in every league):
//   user:{uid}        → {nickname, leagues:[code...]}
//   league:{code}     → {name, created, members:[uid...], joinedAt:{uid:ts}}
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
  makeRecovery,
  normRecovery,
  planMerge,
  findOrphans,
  normNick,
} from "./logic.js";

const MATCHES_TTL_MS = 5 * 60 * 1000; // in-memory matches.json cache

// ---- module-scope matches cache (per warm isolate) ----
let _matches = null;
let _matchesAt = 0;
export function __resetCaches() { _matches = null; _matchesAt = 0; } // test-only isolation hook
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
// league.joinedAt[uid] is the scoring baseline for that uid in that league:
// matches that kicked off before this timestamp do not count in this league.
// Legacy leagues lack joinedAt, so those members deliberately keep historical
// scoring rather than having live tables unexpectedly reset.
async function resolveMembers(env, league) {
  const uids = (league && league.members) || [];
  const names = (league && league.names) || {};
  const joinedAt = (league && league.joinedAt) || {};
  const users = await Promise.all(uids.map((uid) => kvGet(env, `user:${uid}`)));
  return uids.map((uid, i) => ({
    uid,
    nick: names[uid] || (users[i] && users[i].nickname) || "Anon",
    since: Number.isFinite(joinedAt[uid]) ? joinedAt[uid] : 0,
  }));
}

async function loadPicksByMatch(env, matchIds) {
  const entries = await Promise.all(
    matchIds.map(async (id) => [id, (await kvGet(env, `picks:${id}`)) || {}])
  );
  return Object.fromEntries(entries);
}

// A unique, unused recovery code (3 memorable words).
async function freshRecoveryCode(env) {
  let c;
  for (let i = 0; i < 8; i++) {
    c = makeRecovery(randBytes);
    if (!(await kvGet(env, `recovery:${c}`))) return c;
  }
  return c;
}

// The global nickname is just a default: set it once (first time), and let
// explicit /nick (no code) or per-league overrides change what's displayed.
// Also mints a recovery code on first sight so any device can re-adopt this uid.
async function ensureUser(env, uid, nickname) {
  const u = (await kvGet(env, `user:${uid}`)) || { nickname: "", leagues: [] };
  if (nickname && !u.nickname) u.nickname = normNick(nickname);
  if (!u.code) {
    u.code = await freshRecoveryCode(env);
    await kvPut(env, `recovery:${u.code}`, uid); // reverse lookup for /restore
    await kvPut(env, `user:${uid}`, u); // persist now so we don't mint duplicates
  }
  return u;
}

// The league creator is the admin. Older leagues predate the `owner` field —
// fall back to the first member (the creator was added first) so admin still works.
const leagueOwner = (league) => league.owner || (league.members && league.members[0]);

// Drop standings caches so membership/nickname edits show up immediately.
async function bustTables(env, codes) {
  await Promise.all([...new Set(codes)].map((c) => env.KV.delete(`table:${c}`)));
}

// Freshest FT scores, pushed by build.py to KV `results:ft` ({matchId: [s1,s2]}).
// This is what lets tables update right after the whistle without waiting for
// Pages to redeploy matches.json.
async function getResults(env) {
  return (await kvGet(env, "results:ft")) || {};
}

// Match list (metadata from Pages) with the freshest FT scores overlaid.
async function scoredMatches(env) {
  const matches = await getMatches(env);
  const results = await getResults(env);
  return matches.map((m) => {
    const r = results[m.id];
    return r ? { ...m, score1: r[0], score2: r[1], status: "FT" } : m;
  });
}

// Compute + write a league's standings cache. The cache has NO time-to-live:
// it's invalidated explicitly when results change (/settle) or membership
// changes (bustTables), so read traffic never triggers a write.
async function recomputeLeague(env, code) {
  const league = await kvGet(env, `league:${code}`);
  if (!league) return null;
  const members = await resolveMembers(env, league);
  const ft = (await scoredMatches(env))
    .filter((m) => m.status === "FT" && m.score1 != null)
    .sort((a, b) => Date.parse(a.ukKickoff) - Date.parse(b.ukKickoff))
    .map((m) => ({ id: m.id, s1: m.score1, s2: m.score2, koMs: Date.parse(m.ukKickoff) }));
  const picksByMatch = await loadPicksByMatch(env, ft.map((m) => m.id));
  const rows = computeTable(members, ft, picksByMatch);
  // POSITION-MOVEMENT ARROWS (additive): annotate each row with movement vs its
  // index in prev:{code} (frozen at the last settle). Index-based, matching the
  // visible table order. Reads ONLY prev:{code}; does not affect scoring/order.
  // No prior position (just joined / first settle) → "new" → client shows a dash.
  const prevPos = ((await kvGet(env, `prev:${code}`)) || {}).pos || {};
  rows.forEach((r, i) => {
    const was = prevPos[r.uid];
    r.move = (was == null) ? "new" : (i < was ? "up" : i > was ? "down" : "same");
  });
  await kvPut(env, `table:${code}`, { rows, ts: Date.now() });
  return rows;
}

// Read path: serve the cached table (one KV read, no write); recompute on miss.
async function standings(env, code) {
  const cached = await kvGet(env, `table:${code}`);
  if (cached) return cached.rows;
  return await recomputeLeague(env, code);
}

// ---- route handlers ----
async function createLeague(env, body) {
  const uid = String(body.uid || "").trim();
  if (!uid) return j({ error: "uid required" }, 400, env);
  const name = String(body.name || "").trim().slice(0, 40) || "New League";
  const now = Date.now();
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
  await kvPut(env, `league:${code}`, { name, created: now, owner: uid, members: [uid], names, joinedAt: { [uid]: now } });
  await kvPut(env, `user:${uid}`, user);
  return j({ code, name, recovery: user.code }, 200, env);
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
  league.joinedAt = league.joinedAt || {};
  if (!Number.isFinite(league.joinedAt[uid])) league.joinedAt[uid] = Date.now();
  await kvPut(env, `league:${code}`, league);
  await kvPut(env, `user:${uid}`, user);
  await bustTables(env, [code]); // recompute so the new member shows immediately (0 pts)
  return j({ code, name: league.name, recovery: user.code }, 200, env);
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
  if (league.names) delete league.names[uid];
  if (league.joinedAt) delete league.joinedAt[uid];
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
  if (league.names) delete league.names[target];
  if (league.joinedAt) delete league.joinedAt[target];
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

// This device's identity: nickname, recovery code (to save), and its leagues.
// Mints a recovery code on first call. The client shows the code in the League tab.
async function getMe(env, url) {
  const uid = (url.searchParams.get("uid") || "").trim();
  if (!uid) return j({ error: "uid required" }, 400, env);
  const u = await ensureUser(env, uid);
  return j({ uid, nickname: u.nickname || "", recovery: u.code, leagues: u.leagues || [] }, 200, env);
}

// Adopt an existing identity from its recovery code (RESTORE). The code is the
// secret; we return the uid so the new device becomes that same player.
async function restore(env, body) {
  const code = normRecovery(body.code);
  if (!code) return j({ error: "code required" }, 400, env);
  const uid = await kvGet(env, `recovery:${code}`);
  if (!uid) return j({ error: "no identity for that code" }, 404, env);
  const u = (await kvGet(env, `user:${uid}`)) || {};
  return j({ uid, nickname: u.nickname || "", recovery: code, leagues: u.leagues || [] }, 200, env);
}

// SMART JOIN helper: is `nickname` already taken by a member of league `code`?
// Lets the client offer "Are you [name]? Restore instead" rather than duplicating.
async function whois(env, url) {
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  const nm = normNick(url.searchParams.get("nickname")).toLowerCase();
  const uid = (url.searchParams.get("uid") || "").trim();
  if (!code) return j({ taken: false }, 200, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ taken: false }, 200, env);
  const members = await resolveMembers(env, league);
  const hit = members.find((m) => m.nick.toLowerCase() === nm && m.uid !== uid);
  return j({ taken: !!hit, name: hit ? hit.nick : null }, 200, env);
}

// ADMIN MERGE: fold a duplicate/orphan identity (dropUid) into a kept member
// (keepUid). Moves dropUid's picks onto keepUid (gaps only — never overwrites),
// removes dropUid from this league, and cleans up its records if it's now
// league-less. Admin-only; refuses if dropUid still belongs to other leagues.
async function mergeMember(env, body) {
  const uid = String(body.uid || "").trim();
  const code = String(body.code || "").trim().toUpperCase();
  const keepUid = String(body.keepUid || "").trim();
  const dropUid = String(body.dropUid || "").trim();
  if (!uid || !code || !keepUid || !dropUid) return j({ error: "uid, code, keepUid, dropUid required" }, 400, env);
  if (keepUid === dropUid) return j({ error: "keep and drop must differ" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  if (leagueOwner(league) !== uid) return j({ error: "only the league admin can merge" }, 403, env);
  if (!(league.members || []).includes(keepUid)) return j({ error: "keepUid must be a member of this league" }, 400, env);
  const dropUser = await kvGet(env, `user:${dropUid}`);
  if (dropUser && (dropUser.leagues || []).some((c) => c !== code))
    return j({ error: "that identity is in other leagues — merge can't run from here" }, 400, env);

  // load all picks, plan the moves (gaps only), then apply
  const list = await env.KV.list({ prefix: "picks:" });
  const picksByMatch = {};
  for (const k of list.keys) picksByMatch[k.name] = (await kvGet(env, k.name)) || {};
  const moves = planMerge(picksByMatch, keepUid, dropUid);
  let touched = 0;
  for (const key of Object.keys(picksByMatch)) {
    const p = picksByMatch[key];
    if (!p[dropUid]) continue;
    if (!p[keepUid]) p[keepUid] = p[dropUid]; // gap fill
    delete p[dropUid];
    await kvPut(env, key, p);
    touched++;
  }
  // remove drop from this league
  league.members = (league.members || []).filter((m) => m !== dropUid);
  if (league.names) delete league.names[dropUid];
  if (league.joinedAt) delete league.joinedAt[dropUid];
  await kvPut(env, `league:${code}`, league);
  // clean up the now league-less identity
  if (dropUser) {
    if (dropUser.code) await env.KV.delete(`recovery:${dropUser.code}`);
    await env.KV.delete(`user:${dropUid}`);
  }
  await bustTables(env, [code]);
  return j({ ok: true, movedPicks: moves.length, matchesTouched: touched }, 200, env);
}

// ORPHAN WATCHDOG report (admin view): orphans whose nickname matches a member
// of this league are the likely duplicates to merge.
async function getOrphans(env, url) {
  const code = (url.searchParams.get("code") || "").trim().toUpperCase();
  const uid = (url.searchParams.get("uid") || "").trim();
  if (!code) return j({ error: "code required" }, 400, env);
  const league = await kvGet(env, `league:${code}`);
  if (!league) return j({ error: "no such league" }, 404, env);
  if (leagueOwner(league) !== uid) return j({ error: "admin only" }, 403, env);
  const flagged = (await kvGet(env, "orphans:flagged")) || { items: [] };
  const memberNames = new Set((await resolveMembers(env, league)).map((m) => m.nick.toLowerCase()));
  const items = (flagged.items || []).filter((o) => memberNames.has((o.nick || "").toLowerCase()));
  return j({ code, generatedAt: flagged.generatedAt || null, orphans: items }, 200, env);
}

// Recompute the orphan watchdog list and store it (called inside settle).
async function refreshOrphans(env) {
  const lleagues = await env.KV.list({ prefix: "league:" });
  const memberUids = new Set();
  const memberNames = new Set();
  for (const k of lleagues.keys) {
    const lg = (await kvGet(env, k.name)) || {};
    const members = await resolveMembers(env, lg);
    for (const m of members) {
      memberUids.add(m.uid);
      memberNames.add(m.nick.toLowerCase());
    }
  }
  const lpicks = await env.KV.list({ prefix: "picks:" });
  const picksByMatch = {};
  for (const k of lpicks.keys) picksByMatch[k.name.slice("picks:".length)] = (await kvGet(env, k.name)) || {};
  const userCache = {};
  for (const o of Object.values(picksByMatch)) for (const uid of Object.keys(o)) {
    if (!memberUids.has(uid) && !(uid in userCache)) userCache[uid] = ((await kvGet(env, `user:${uid}`)) || {}).nickname || "?";
  }
  const items = findOrphans(picksByMatch, memberUids, (uid) => userCache[uid] || "?", memberNames);
  await kvPut(env, "orphans:flagged", { generatedAt: Date.now(), items });
  return items.length;
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

  // SERVER-SIDE WINDOW CHECK — the integrity core. Fails CLOSED: if the match or
  // its kick-off can't be verified for ANY reason, the pick is rejected.
  let matches;
  try {
    matches = await scoredMatches(env); // Pages metadata + freshest FT scores/status
  } catch {
    return j({ error: "can't verify kick-off right now — pick not saved", state: "unverified" }, 503, env);
  }
  const match = matches.find((m) => m.id === matchId);
  if (!match) return j({ error: "no such match" }, 404, env);
  if (!bothTeamsReal(match.team1, match.team2))
    return j({ error: "teams not confirmed yet", state: "na" }, 403, env);
  const koMs = Date.parse(match.ukKickoff);
  if (!Number.isFinite(koMs)) // unverifiable kick-off → fail closed
    return j({ error: "kick-off time unverifiable — pick not saved", state: "unverified" }, 422, env);
  // A finished/in-play match is shut regardless of clock or data freshness.
  if (match.status === "FT" || match.status === "LIVE" || match.score1 != null)
    return j({ error: "match already started — window shut", state: "shut" }, 403, env);
  // Otherwise open only strictly before kick-off (no post-shut swap).
  if (windowState(koMs, Date.now()) === "shut")
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
  const match = (await scoredMatches(env)).find((m) => m.id === matchId);
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
  const rows = await standings(env, code);
  const now = Date.now();
  // reveal feed: only shut-window matches, most recent 12 — bounds KV reads so
  // live-refresh polling stays well inside the free tier.
  const shut = (await scoredMatches(env))
    .filter((m) => windowState(Date.parse(m.ukKickoff), now) === "shut")
    .sort((a, b) => Date.parse(b.ukKickoff) - Date.parse(a.ukKickoff))
    .slice(0, 12);
  const picksByMatch = await loadPicksByMatch(env, shut.map((m) => m.id));
  const reveals = buildReveals(members, shut, picksByMatch, now);
  return j({ code, name: league.name, owner: leagueOwner(league), table: rows, reveals }, 200, env);
}

async function getTable(env, url) {
  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (!code) return j({ error: "code required" }, 400, env);
  const rows = await standings(env, code);
  if (rows == null) return j({ error: "no such league" }, 404, env);
  return j({ code, table: rows }, 200, env);
}

// stable compare of a {matchId:[s1,s2]} results map, order-independent
const normResults = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));

async function settle(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET)
    return j({ error: "forbidden" }, 403, env);
  // build.py pushes {results: {matchId: [s1,s2]}} for finished matches so tables
  // can update the instant the whistle blows — no waiting for Pages to redeploy.
  // Fallback (manual pings without a body): derive results from a fresh Pages fetch.
  let results = body.results;
  if (!results) {
    results = {};
    for (const m of await getMatches(env, { fresh: true }))
      if (m.status === "FT" && m.score1 != null) results[m.id] = [m.score1, m.score2];
  }
  // Frugal: if the result set hasn't changed since last time, do nothing — no
  // writes. This is what keeps a fast (5-min) cron inside the KV free tier.
  const prev = await getResults(env);
  if (!body.force && normResults(prev) === normResults(results))
    return j({ ok: true, unchanged: true }, 200, env);
  await kvPut(env, "results:ft", results);
  const list = await env.KV.list({ prefix: "league:" });
  let n = 0;
  for (const k of list.keys) {
    const code = k.name.slice("league:".length);
    // POSITION-MOVEMENT ARROWS (additive): snapshot the CURRENT table positions —
    // i.e. the standings as they were BEFORE this settle's result — into prev:{code}.
    // Only happens here, only when results actually changed (or force), so the
    // baseline is "before the most recently settled match" and is frozen until the
    // next settle. Reads only the derived table:{code} cache; never picks/identity.
    const cur = await kvGet(env, `table:${code}`);
    if (cur && Array.isArray(cur.rows)) {
      const pos = {};
      cur.rows.forEach((r, i) => { pos[r.uid] = i; });
      await kvPut(env, `prev:${code}`, { pos, ts: Date.now() });
    }
    await recomputeLeague(env, code);
    n++;
  }
  const orphans = await refreshOrphans(env); // watchdog: flag picks under league-less uids
  return j({ ok: true, leagues: n, orphans, changed: true }, 200, env);
}

// One-time migration: mint a recovery code for every existing user that lacks
// one, without touching nicknames, leagues or picks. Secret-gated, idempotent.
async function migrateCodes(env, body) {
  if (!env.SETTLE_SECRET || body.secret !== env.SETTLE_SECRET)
    return j({ error: "forbidden" }, 403, env);
  const list = await env.KV.list({ prefix: "user:" });
  let assigned = 0;
  for (const k of list.keys) {
    const u = await kvGet(env, k.name);
    if (!u || u.code) continue;
    u.code = await freshRecoveryCode(env);
    await kvPut(env, `recovery:${u.code}`, k.name.slice("user:".length));
    await kvPut(env, k.name, u);
    assigned++;
  }
  return j({ ok: true, assigned }, 200, env);
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
  // Cloudflare Cron Trigger (reliable, unlike GitHub's throttled scheduler):
  // every 5 min it asks the GitHub Action to refresh data. No-op without the
  // token, so the Worker still deploys before the secret is set.
  async scheduled(event, env, ctx) {
    if (!env.GH_DISPATCH_TOKEN) {
      console.log("scheduled: GH_DISPATCH_TOKEN not set — skipping");
      return;
    }
    ctx.waitUntil(
      fetch("https://api.github.com/repos/abigwood/kickoff-oracle/actions/workflows/refresh.yml/dispatches", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "kickoff-oracle-window",
        },
        body: JSON.stringify({ ref: "main" }),
      }).then(async (r) => console.log("dispatch refresh →", r.status, r.status === 204 ? "ok" : await r.text()))
        .catch((e) => console.log("dispatch error:", String(e)))
    );
  },
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
        if (path === "/me") return await getMe(env, url);
        if (path === "/whois") return await whois(env, url);
        if (path === "/orphans") return await getOrphans(env, url);
      }
      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (path === "/league") return await createLeague(env, body);
        if (path === "/join") return await joinLeague(env, body);
        if (path === "/restore") return await restore(env, body);
        if (path === "/merge") return await mergeMember(env, body);
        if (path === "/nick") return await setNickname(env, body);
        if (path === "/leave") return await leaveLeague(env, body);
        if (path === "/kick") return await kickMember(env, body);
        if (path === "/rename") return await renameLeague(env, body);
        if (path === "/pick") return await makePick(env, body);
        if (path === "/settle") return await settle(env, body);
        if (path === "/export") return await exportAll(env, body);
        if (path === "/migrate-codes") return await migrateCodes(env, body);
      }
      return j({ error: "not found" }, 404, env);
    } catch (err) {
      return j({ error: "server error", detail: String(err && err.message || err) }, 500, env);
    }
  },
};
