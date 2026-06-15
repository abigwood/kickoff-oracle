// Pure, runtime-agnostic logic for THE WINDOW.
// No Cloudflare or Node APIs in here — so it runs identically in the Worker
// and under plain `node` for tests. This is the integrity core; keep it pure.

// Window state for a match, given kick-off and "now" as epoch ms.
//   'open' → any time before KO   (picks accepted/changeable, stay hidden)
//   'shut' → at/after KO          (no more picks; picks revealed)
// (The old KO−60 opening was abolished — pick or change the score anytime
// before kick-off; the only rule is it shuts at KO.)
export function windowState(koMs, nowMs) {
  return nowMs < koMs ? "open" : "shut";
}

// Picks are only allowed once both teams are real. Knockout placeholders like
// "1A", "W73", "3C/D/F" contain digits or slashes; real team names never do.
export const isRealTeam = (t) => !!t && !/[\d/]/.test(t);
export const bothTeamsReal = (a, b) => isRealTeam(a) && isRealTeam(b);

// Score one prediction against the actual result. Hierarchy (Adam, final) —
// checked STRICTLY top-down, first match wins:
//   1. exact score (incl. exact draws, e.g. 1–1 v 1–1)        → 3 pts
//   2. correct draw, wrong score (e.g. 1–1 v 2–2)             → 2 pts
//   3. correct winner AND correct goal difference (2–1 v 3–2) → 2 pts
//   4. correct winner only, wrong GD                          → 1 pt
//   5. wrong outcome / no pick                                → 0 pts
// No bankers, no multipliers — do not reintroduce.
// exact MUST be tested before the draw/GD tiers so an exact draw scores 3, not 2.
// Returns {pts, exact, hit, settled}. hit = scored > 0. settled=false when the
// match has no result yet.
export function scorePick(pred, actual) {
  if (!actual || actual.s1 == null || actual.s2 == null)
    return { pts: 0, exact: false, hit: false, settled: false };
  if (!pred || pred.s1 == null || pred.s2 == null)
    return { pts: 0, exact: false, hit: false, settled: true };
  // 1. exact score (covers exact draws too — checked first)
  if (pred.s1 === actual.s1 && pred.s2 === actual.s2)
    return { pts: 3, exact: true, hit: true, settled: true };
  const sign = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
  const pOut = sign(pred.s1, pred.s2);
  const aOut = sign(actual.s1, actual.s2);
  // 2. correct draw, wrong scoreline (both draws, not exact)
  if (pOut === 0 && aOut === 0)
    return { pts: 2, exact: false, hit: true, settled: true };
  // 3. correct winner AND correct goal difference
  if (pOut === aOut && pred.s1 - pred.s2 === actual.s1 - actual.s2)
    return { pts: 2, exact: false, hit: true, settled: true };
  // 4. correct winner only, wrong GD
  if (pOut === aOut)
    return { pts: 1, exact: false, hit: true, settled: true };
  // 5. wrong outcome
  return { pts: 0, exact: false, hit: false, settled: true };
}

// Trailing streak label from a chronological list of per-match outcomes.
// outcome: "W" (scored ≥1), "L" (picked but 0), "S" (no pick / asleep).
// Mirrors the demo UI: "W3", "L1", "😴1", or "—" when there's nothing yet.
export function streakLabel(outcomes) {
  if (!outcomes.length) return "—";
  const last = outcomes[outcomes.length - 1];
  let n = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === last; i--) n++;
  const sym = last === "W" ? "W" : last === "L" ? "L" : "😴";
  return sym + n;
}

// DEFENCE-IN-DEPTH: a pick only counts if it was made strictly BEFORE kick-off.
// The /pick window check is the front door; this ensures that even if a bad pick
// ever lands in KV (future bug, manual edit), scoring and reveals ignore it.
// koMs == null means "kick-off unknown" → can't prove validity → treat as invalid.
export function pickValid(pick, koMs) {
  if (!pick) return false;
  if (koMs == null) return false;
  return typeof pick.ts === "number" && pick.ts < koMs;
}

// Compute a league standings table.
//   members      : [{uid, nick, since?}] where since is the time this uid
//                  joined this league. Legacy members without since keep all
//                  historical scoring for backwards compatibility.
//   ftMatches    : finished matches, CHRONOLOGICAL, [{id, s1, s2, koMs?}]
//   picksByMatch : { [matchId]: { [uid]: {s1, s2, ts} } }   (global picks)
// A pick timestamped at/after that match's koMs is ignored (counts as no pick).
// Returns rows sorted by pts desc, then exact desc, then nick — shape the UI's
// league table renders directly: {nick, pts, exact, streak, uid}.
export function computeTable(members, ftMatches, picksByMatch) {
  const rows = members.map((mem) => {
    let pts = 0,
      exact = 0;
    const outcomes = [];
    for (const m of ftMatches) {
      if (mem.since && m.koMs != null && m.koMs < mem.since) continue;
      let pick = (picksByMatch[m.id] || {})[mem.uid];
      if (m.koMs != null && pick && !pickValid(pick, m.koMs)) pick = undefined; // ignore post-KO picks
      const res = scorePick(pick, { s1: m.s1, s2: m.s2 });
      if (!pick) {
        outcomes.push("S");
        continue;
      }
      pts += res.pts;
      if (res.exact) exact++;
      outcomes.push(res.pts > 0 ? "W" : "L");
    }
    return { uid: mem.uid, nick: mem.nick, pts, exact, streak: streakLabel(outcomes) };
  });
  rows.sort((a, b) => b.pts - a.pts || b.exact - a.exact || a.nick.localeCompare(b.nick));
  return rows;
}

// Build the reveal feed for a league: one block per shut-window match that has
// at least one eligible pick, newest first. Picks are scored once the match is FT.
//   matches      : full match list (each {id, team1, team2, ukKickoff, status, s1, s2})
//   nowMs        : epoch ms
// Returns [{matchId, match, ko, picks:[{uid, nick, s1, s2, hit, exact, pts, settled}]}].
export function buildReveals(members, matches, picksByMatch, nowMs) {
  const nickOf = Object.fromEntries(members.map((m) => [m.uid, m.nick]));
  const out = [];
  for (const m of matches) {
    const koMs = Date.parse(m.ukKickoff);
    if (windowState(koMs, nowMs) !== "shut") continue; // hide until window shuts
    const eligibleMembers = members.filter((mem) => !mem.since || !Number.isFinite(koMs) || koMs >= mem.since);
    if (!eligibleMembers.length) continue;
    const picks = picksByMatch[m.id] || {};
    if (!eligibleMembers.some((mem) => picks[mem.uid])) continue; // nobody engaged → no reveal
    const settled = m.score1 != null && m.score2 != null;
    // reveal the WHOLE league: everyone's pick, plus who fell asleep (no pick).
    const memberPicks = eligibleMembers.map((mem) => {
      const raw = picks[mem.uid];
      const p = pickValid(raw, koMs) ? raw : null; // a post-KO pick is treated as no pick
      if (!p)
        return { uid: mem.uid, nick: nickOf[mem.uid] || "?", asleep: true, s1: null, s2: null, hit: false, exact: false, pts: 0, settled };
      const res = scorePick(p, { s1: m.score1, s2: m.score2 });
      return { uid: mem.uid, nick: nickOf[mem.uid] || "?", s1: p.s1, s2: p.s2, hit: res.hit, exact: res.exact, pts: res.pts, settled: res.settled };
    });
    out.push({
      matchId: m.id,
      match: `${m.team1} v ${m.team2}`,
      team1: m.team1,
      team2: m.team2,
      settled,                                  // true once the match has a final score
      score1: settled ? m.score1 : null,
      score2: settled ? m.score2 : null,
      ko: m.ukKickoff,
      picks: memberPicks,
    });
  }
  out.sort((a, b) => Date.parse(b.ko) - Date.parse(a.ko));
  return out;
}

// 6-char entry code from a non-ambiguous alphabet (no 0/O/1/I).
// `rand` is an injected (n)=>Uint8Array-like for testability.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeCode(randBytes) {
  const bytes = randBytes(6);
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}

export function normNick(nick) {
  return String(nick || "").trim().slice(0, 24) || "Anon";
}

// Memorable recovery code: three words from a curated list, e.g. "otter-mango-comet".
// ~110^3 ≈ 1.3M combos — plenty for a mates' app, and easy to read out / save.
const RECOVERY_WORDS = (
  "amber apple arrow atlas bacon badge banjo beach bench berry bison blaze bloom brave bread brick brook " +
  "cabin candy cedar chess cider cloud clover comet coral crane cumin daisy delta diver dough eagle ember " +
  "fable falcon fern flint forge frost glade globe grape grove hazel honey ivory jelly jolly koala lemon " +
  "lilac llama lotus lunar mango maple marble meadow melon mint moss mocha noble ocean olive onion otter " +
  "panda peach pearl pecan piano pilot pixel plum poppy quartz quill quokka raven reef rhino river robin " +
  "rumba sable salsa sigma sloth solar spark spice stork sugar sunny swift tango tiger toast topaz tulip " +
  "umbra unity vapor vigor viola vivid walnut wheat willow zebra zesty"
).split(/\s+/).filter(Boolean);

export function makeRecovery(randBytes) {
  const b = randBytes(3);
  return [0, 1, 2].map((i) => RECOVERY_WORDS[b[i] % RECOVERY_WORDS.length]).join("-");
}

// Normalise a recovery code for comparison/storage: lowercase, words joined by single dashes.
export function normRecovery(code) {
  return String(code || "").toLowerCase().trim().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");
}

// Plan an identity merge: which of dropUid's picks should move to keepUid.
// Only fills GAPS — never overwrites a pick keepUid already made.
// picksByMatch: { matchId: { uid: pick } }. Returns [{matchId, pick}].
export function planMerge(picksByMatch, keepUid, dropUid) {
  const moves = [];
  for (const [matchId, byUid] of Object.entries(picksByMatch || {})) {
    if (byUid && byUid[dropUid] && !byUid[keepUid]) moves.push({ matchId, pick: byUid[dropUid] });
  }
  return moves;
}

// Find picks held by uids that belong to NO league (orphans). Flags likely
// duplicates by matching the orphan's nickname to a real member's name.
//   picksByMatch : { matchId: { uid: pick } }
//   memberUids   : Set of all uids that are members of some league
//   nickOf       : (uid) => nickname
//   memberNames  : lowercased Set of all member display names
export function findOrphans(picksByMatch, memberUids, nickOf, memberNames) {
  const byUid = {}; // uid -> {nick, matches:[]}
  for (const [matchId, picks] of Object.entries(picksByMatch || {})) {
    for (const uid of Object.keys(picks || {})) {
      if (memberUids.has(uid)) continue;
      (byUid[uid] = byUid[uid] || { uid, nick: nickOf(uid), matches: [] }).matches.push(matchId);
    }
  }
  return Object.values(byUid).map((o) => ({
    ...o,
    looksLikeMember: memberNames.has((o.nick || "").toLowerCase()),
  }));
}
