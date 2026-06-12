import { test } from "node:test";
import assert from "node:assert/strict";
import {
  windowState,
  bothTeamsReal,
  scorePick,
  streakLabel,
  computeTable,
  buildReveals,
  pickValid,
  makeCode,
  makeRecovery,
  normRecovery,
  planMerge,
  findOrphans,
} from "../src/logic.js";

const KO = Date.parse("2026-06-17T21:00:00+01:00"); // England v Croatia
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

test("window: open any time before KO, shuts at KO (integrity core)", () => {
  assert.equal(windowState(KO, KO - 3 * DAY), "open", "KO−3 days: accept");
  assert.equal(windowState(KO, KO - 60 * MIN), "open", "KO−60: open");
  assert.equal(windowState(KO, KO - 1 * MIN), "open", "KO−1 min: accept");
  assert.equal(windowState(KO, KO), "shut", "KO exactly: shut");
  assert.equal(windowState(KO, KO + 1 * MIN), "shut", "KO+1: reject");
});

test("picks only allowed once both teams are real", () => {
  assert.equal(bothTeamsReal("England", "Croatia"), true);
  assert.equal(bothTeamsReal("1A", "2B"), false, "group-placeholder");
  assert.equal(bothTeamsReal("W73", "L74"), false, "knockout-placeholder");
  assert.equal(bothTeamsReal("England", "3C/D/F"), false, "third-placed placeholder");
  assert.equal(bothTeamsReal("Côte d'Ivoire", "South Korea"), true, "apostrophes/spaces ok");
});

test("scoring — 3 exact / 1 result / 0 otherwise, no bankers", () => {
  const A = { s1: 2, s2: 0 };
  assert.deepEqual(scorePick({ s1: 2, s2: 0 }, A), { pts: 3, exact: true, hit: true, settled: true });
  assert.deepEqual(scorePick({ s1: 1, s2: 0 }, A), { pts: 1, exact: false, hit: true, settled: true });
  assert.deepEqual(scorePick({ s1: 1, s2: 1 }, A), { pts: 0, exact: false, hit: false, settled: true });
  assert.deepEqual(scorePick({ s1: 0, s2: 2 }, A), { pts: 0, exact: false, hit: false, settled: true });
  // draw result
  assert.equal(scorePick({ s1: 0, s2: 0 }, { s1: 1, s2: 1 }).pts, 1, "any draw = correct result");
  assert.equal(scorePick({ s1: 1, s2: 1 }, { s1: 1, s2: 1 }).pts, 3, "exact draw = 3");
  // unsettled / no pick
  assert.equal(scorePick({ s1: 1, s2: 0 }, { s1: null, s2: null }).settled, false);
  assert.equal(scorePick(null, A).pts, 0, "no pick = 0");
});

test("streak labels mirror the demo UI", () => {
  assert.equal(streakLabel([]), "—");
  assert.equal(streakLabel(["W", "W", "W"]), "W3");
  assert.equal(streakLabel(["W", "L"]), "L1");
  assert.equal(streakLabel(["W", "S"]), "😴1");
  assert.equal(streakLabel(["L", "W", "W"]), "W2");
});

test("pickValid — only a pre-KO timestamp counts (fails closed)", () => {
  assert.equal(pickValid({ s1: 1, s2: 0, ts: 99 }, 100), true, "ts < KO");
  assert.equal(pickValid({ s1: 1, s2: 0, ts: 100 }, 100), false, "ts == KO → invalid");
  assert.equal(pickValid({ s1: 1, s2: 0, ts: 101 }, 100), false, "ts > KO → invalid");
  assert.equal(pickValid({ s1: 1, s2: 0 }, 100), false, "no timestamp → invalid");
  assert.equal(pickValid({ s1: 1, s2: 0, ts: 99 }, null), false, "unknown KO → invalid (fail closed)");
  assert.equal(pickValid(null, 100), false);
});

test("computeTable + buildReveals IGNORE picks timestamped at/after KO", () => {
  const members = [{ uid: "a", nick: "A" }, { uid: "b", nick: "B" }];
  const KOms = Date.parse("2026-06-12T03:00:00+01:00");
  const ft = [{ id: 2, s1: 2, s2: 1, koMs: KOms }];
  const picks = {
    2: {
      a: { s1: 2, s2: 1, ts: KOms - 1000 }, // valid (pre-KO) exact → 3
      b: { s1: 2, s2: 1, ts: KOms + 1000 }, // INVALID (post-KO) — must NOT score despite being exact
    },
  };
  const rows = computeTable(members, ft, picks);
  assert.equal(rows.find((r) => r.uid === "a").pts, 3, "valid pre-KO pick scores");
  assert.equal(rows.find((r) => r.uid === "b").pts, 0, "post-KO pick ignored in scoring");
  // reveals: the post-KO pick shows as no-pick, not as a scored pick
  const matches = [{ id: 2, team1: "X", team2: "Y", ukKickoff: "2026-06-12T03:00:00+01:00", status: "FT", score1: 2, score2: 1 }];
  const [rv] = buildReveals(members, matches, picks, KOms + 5 * 3600 * 1000);
  assert.equal(rv.picks.find((p) => p.uid === "a").pts, 3);
  assert.equal(rv.picks.find((p) => p.uid === "b").asleep, true, "post-KO pick revealed as no-pick");
});

test("computeTable — points sum across matches, sorted, multi-member", () => {
  const members = [
    { uid: "a", nick: "Smithy" },
    { uid: "b", nick: "Adam" },
    { uid: "c", nick: "Dave" },
  ];
  const ft = [
    { id: 1, s1: 2, s2: 0 },
    { id: 2, s1: 1, s2: 1 },
  ];
  const picks = {
    1: { a: { s1: 2, s2: 0 }, b: { s1: 1, s2: 0 }, c: { s1: 0, s2: 1 } },
    2: { a: { s1: 1, s2: 1 }, b: { s1: 0, s2: 0 } }, // Dave missed the window on match 2
  };
  const rows = computeTable(members, ft, picks);
  assert.deepEqual(rows.map((r) => [r.nick, r.pts, r.exact]), [
    ["Smithy", 6, 2], // 3 + 3
    ["Adam", 2, 0], // 1 + 1
    ["Dave", 0, 0], // wrong, then no pick
  ]);
  assert.equal(rows[2].streak, "😴1", "Dave's last outcome was no-pick");
});

test("buildReveals hides open windows, reveals shut ones, scores when FT", () => {
  const members = [
    { uid: "a", nick: "Smithy" },
    { uid: "b", nick: "Adam" },
    { uid: "c", nick: "Wrighty" }, // doesn't pick → should appear asleep
  ];
  const now = Date.parse("2026-06-17T22:00:00+01:00");
  const matches = [
    // shut + FT
    { id: 10, team1: "X", team2: "Y", ukKickoff: "2026-06-17T20:00:00+01:00", status: "FT", score1: 2, score2: 0 },
    // window still open (KO in the future) → must be hidden
    { id: 11, team1: "P", team2: "Q", ukKickoff: "2026-06-17T22:30:00+01:00", status: "UPCOMING", score1: null, score2: null },
  ];
  const ko10 = Date.parse("2026-06-17T20:00:00+01:00");
  const ko11 = Date.parse("2026-06-17T22:30:00+01:00");
  const picks = {
    10: { a: { s1: 2, s2: 0, ts: ko10 - 1000 }, b: { s1: 0, s2: 1, ts: ko10 - 1000 } },
    11: { a: { s1: 1, s2: 1, ts: ko11 - 1000 } },
  };
  const reveals = buildReveals(members, matches, picks, now);
  assert.equal(reveals.length, 1, "only the shut match is revealed");
  assert.equal(reveals[0].matchId, 10);
  // the reveal carries the final score + teams once settled (for the header/card)
  assert.deepEqual(
    { team1: reveals[0].team1, team2: reveals[0].team2, settled: reveals[0].settled, score1: reveals[0].score1, score2: reveals[0].score2 },
    { team1: "X", team2: "Y", settled: true, score1: 2, score2: 0 }
  );
  assert.equal(reveals[0].picks.length, 3, "whole league shown, incl. non-pickers");
  const smithy = reveals[0].picks.find((p) => p.nick === "Smithy");
  assert.equal(smithy.pts, 3);
  assert.equal(smithy.exact, true);
  const wrighty = reveals[0].picks.find((p) => p.nick === "Wrighty");
  assert.equal(wrighty.asleep, true, "no pick → asleep");
  assert.equal(wrighty.pts, 0);
});

test("buildReveals before settlement: shut window, no score yet → settled:false, no result", () => {
  const members = [{ uid: "a", nick: "A" }];
  const koMs = Date.parse("2026-06-17T20:00:00+01:00");
  const matches = [{ id: 5, team1: "X", team2: "Y", ukKickoff: "2026-06-17T20:00:00+01:00", status: "LIVE", score1: null, score2: null }];
  const picks = { 5: { a: { s1: 1, s2: 0, ts: koMs - 1000 } } };
  const [rv] = buildReveals(members, matches, picks, koMs + 30 * 60 * 1000); // after KO, before FT
  assert.equal(rv.settled, false);
  assert.equal(rv.score1, null);
  assert.equal(rv.score2, null);
  assert.equal(rv.match, "X v Y");
});

test("makeCode — 6 chars, unambiguous alphabet, deterministic given bytes", () => {
  const code = makeCode((n) => new Uint8Array(n).fill(0));
  assert.equal(code.length, 6);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/, "no 0/O/1/I");
  assert.equal(makeCode(() => Uint8Array.from([0, 1, 2, 3, 4, 5])), "ABCDEF");
});

test("recovery code — three readable words; normRecovery canonicalises input", () => {
  const c = makeRecovery((n) => new Uint8Array(n).fill(0));
  assert.match(c, /^[a-z]+-[a-z]+-[a-z]+$/, "word-word-word");
  // user might type spaces/caps/extra dashes — all normalise to the same key
  assert.equal(normRecovery("Otter Mango Comet"), "otter-mango-comet");
  assert.equal(normRecovery("  OTTER--mango_comet "), "otter-mango-comet");
});

test("planMerge — moves only gaps, never overwrites the kept identity's pick", () => {
  const picks = {
    "picks:1": { keep: { s1: 2, s2: 0 }, drop: { s1: 1, s2: 1 } }, // keep already has one → not moved
    "picks:2": { drop: { s1: 3, s2: 0 } },                          // only drop → moved
    "picks:3": { other: { s1: 0, s2: 0 } },                         // neither → ignored
  };
  const moves = planMerge(picks, "keep", "drop");
  assert.deepEqual(moves, [{ matchId: "picks:2", pick: { s1: 3, s2: 0 } }]);
});

test("findOrphans — flags league-less uids and marks nickname matches", () => {
  const picks = {
    "1": { memberA: { s1: 1, s2: 0 }, ghost: { s1: 2, s2: 2 } },
    "2": { ghost: { s1: 0, s2: 1 }, rando: { s1: 1, s2: 1 } },
  };
  const memberUids = new Set(["memberA"]);
  const nickOf = (u) => ({ ghost: "Boat", rando: "Nobody" }[u] || "?");
  const memberNames = new Set(["boat", "woody"]); // "Boat" is a real member elsewhere
  const orphans = findOrphans(picks, memberUids, nickOf, memberNames);
  const ghost = orphans.find((o) => o.uid === "ghost");
  assert.deepEqual(ghost.matches.sort(), ["1", "2"]);
  assert.equal(ghost.looksLikeMember, true, "nickname matches a member → likely duplicate");
  assert.equal(orphans.find((o) => o.uid === "rando").looksLikeMember, false);
});
