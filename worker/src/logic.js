// Pure, runtime-agnostic logic for THE WINDOW.
// No Cloudflare or Node APIs in here — so it runs identically in the Worker
// and under plain `node` for tests. This is the integrity core; keep it pure.

export const WINDOW_MS = 60 * 60 * 1000; // window opens at KO − 60 min

// Window state for a match, given kick-off and "now" as epoch ms.
//   'pre'  → before the window opens (too early to pick)
//   'open' → in [KO−60m, KO)  (picks accepted, picks stay hidden)
//   'shut' → at/after KO       (no more picks; picks revealed)
export function windowState(koMs, nowMs) {
  if (nowMs < koMs - WINDOW_MS) return "pre";
  if (nowMs < koMs) return "open";
  return "shut";
}

// Score one prediction against the actual result. SIMPLE scoring (Adam, final):
//   exact score        → 3 pts
//   correct result W/D/L → 1 pt
//   otherwise / no pick → 0 pts
// No bankers, no multipliers — do not reintroduce.
// Returns {pts, exact, hit, settled}. settled=false when the match has no result yet.
export function scorePick(pred, actual) {
  if (!actual || actual.s1 == null || actual.s2 == null)
    return { pts: 0, exact: false, hit: false, settled: false };
  if (!pred || pred.s1 == null || pred.s2 == null)
    return { pts: 0, exact: false, hit: false, settled: true };
  const exact = pred.s1 === actual.s1 && pred.s2 === actual.s2;
  if (exact) return { pts: 3, exact: true, hit: true, settled: true };
  const sign = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
  const correct = sign(pred.s1, pred.s2) === sign(actual.s1, actual.s2);
  return { pts: correct ? 1 : 0, exact: false, hit: correct, settled: true };
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

// Compute a league standings table.
//   members      : [{uid, nick}]
//   ftMatches    : finished matches, CHRONOLOGICAL, [{id, s1, s2}]
//   picksByMatch : { [matchId]: { [uid]: {s1, s2} } }   (global picks)
// Returns rows sorted by pts desc, then exact desc, then nick — shape the UI's
// league table renders directly: {nick, pts, exact, streak, uid}.
export function computeTable(members, ftMatches, picksByMatch) {
  const rows = members.map((mem) => {
    let pts = 0,
      exact = 0;
    const outcomes = [];
    for (const m of ftMatches) {
      const pick = (picksByMatch[m.id] || {})[mem.uid];
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
// at least one pick, newest first. Picks are scored once the match is FT.
//   matches      : full match list (each {id, team1, team2, ukKickoff, status, s1, s2})
//   nowMs        : epoch ms
// Returns [{matchId, match, ko, picks:[{uid, nick, s1, s2, hit, exact, pts, settled}]}].
export function buildReveals(members, matches, picksByMatch, nowMs) {
  const nickOf = Object.fromEntries(members.map((m) => [m.uid, m.nick]));
  const out = [];
  for (const m of matches) {
    const koMs = Date.parse(m.ukKickoff);
    if (windowState(koMs, nowMs) !== "shut") continue; // hide until window shuts
    const picks = picksByMatch[m.id] || {};
    const memberPicks = members
      .filter((mem) => picks[mem.uid])
      .map((mem) => {
        const p = picks[mem.uid];
        const res = scorePick(p, { s1: m.score1, s2: m.score2 });
        return {
          uid: mem.uid,
          nick: nickOf[mem.uid] || "?",
          s1: p.s1,
          s2: p.s2,
          hit: res.hit,
          exact: res.exact,
          pts: res.pts,
          settled: res.settled,
        };
      });
    if (!memberPicks.length) continue;
    out.push({
      matchId: m.id,
      match: `${m.team1} v ${m.team2}`,
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
