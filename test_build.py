"""Tests for build.py's Wikipedia finality gate. Run: python3 -m unittest test_build"""
import unittest
from datetime import datetime, timedelta
import build

UK = build.UK
NOW = datetime(2026, 6, 12, 12, 0, 0, tzinfo=UK)
KEY = ("south korea", "czech republic")
KSTR = "|".join(KEY)


def iso(mins_ago):
    return (NOW - timedelta(minutes=mins_ago)).isoformat()


class TestWikiFinality(unittest.TestCase):
    def test_changing_score_never_settles(self):
        # last poll saw 2–0; this poll shows 2–1 → the match is live, do NOT settle it
        prev = {KSTR: {"score": [2, 0], "first_seen": iso(10)}}
        wiki = {KEY: {"score": [2, 1], "finished": False}}
        confirmed, pending = build.confirm_wikipedia(wiki, prev, NOW)
        self.assertEqual(confirmed, {}, "a changed score must not be confirmed")
        self.assertEqual(pending[KSTR]["score"], [2, 1], "tracks the new score")
        self.assertEqual(pending[KSTR]["first_seen"], NOW.isoformat(), "timer reset on change")

    def test_stable_two_polls_confirms(self):
        # same score seen 6 min ago and still the same now → stable → final
        prev = {KSTR: {"score": [2, 1], "first_seen": iso(6)}}
        wiki = {KEY: {"score": [2, 1], "finished": False}}
        confirmed, _ = build.confirm_wikipedia(wiki, prev, NOW)
        self.assertEqual(confirmed[KEY], [2, 1])

    def test_same_score_too_soon_waits(self):
        # same score but only 2 min apart → not yet two polls (≥5 min) → wait
        prev = {KSTR: {"score": [2, 1], "first_seen": iso(2)}}
        wiki = {KEY: {"score": [2, 1], "finished": False}}
        confirmed, pending = build.confirm_wikipedia(wiki, prev, NOW)
        self.assertEqual(confirmed, {})
        self.assertEqual(pending[KSTR]["first_seen"], iso(2), "keeps the original sighting time")

    def test_page_finished_confirms_immediately(self):
        # attendance recorded → full-time → accept without waiting
        wiki = {KEY: {"score": [2, 1], "finished": True}}
        confirmed, pending = build.confirm_wikipedia(wiki, {}, NOW)
        self.assertEqual(confirmed[KEY], [2, 1])
        self.assertNotIn(KSTR, pending)

    def test_first_sighting_waits(self):
        wiki = {KEY: {"score": [2, 1], "finished": False}}
        confirmed, pending = build.confirm_wikipedia(wiki, {}, NOW)
        self.assertEqual(confirmed, {})
        self.assertEqual(pending[KSTR]["first_seen"], NOW.isoformat())


class TestParseFinished(unittest.TestCase):
    BOX = ("{{#invoke:football box|main\n"
           "|date={{Start date|2026|6|11}}\n"
           "|team1={{#invoke:flag|fb-rt|KOR}}\n"
           "|score={{score link|x|2–1}}\n"
           "|team2={{#invoke:flag|fb|CZE}}\n"
           "|attendance=%s\n"
           "|referee=X\n}}")

    def test_attendance_means_finished(self):
        res = build._parse_football_boxes(self.BOX % "62,103")
        self.assertEqual(res[KEY], {"score": [2, 1], "finished": True})

    def test_no_attendance_not_finished(self):
        res = build._parse_football_boxes(self.BOX % "")
        self.assertEqual(res[KEY]["score"], [2, 1])
        self.assertFalse(res[KEY]["finished"], "no attendance yet → not full-time")


class TestGoalMinuteSort(unittest.TestCase):
    def test_stoppage_time_sorts_after_base_minute(self):
        minutes = ["31", "45+5", "7", "73", "90+8", None]
        ordered = sorted(minutes, key=build.goal_minute_sort_key)
        self.assertEqual(ordered, ["7", "31", "45+5", "73", "90+8", None])


class TestFallbackPrecedence(unittest.TestCase):
    """ESPN carries a definitive FT flag, so it fills immediately; BALLDONTLIE /
    Wikipedia stay gated to KO+2h; manual override is last."""
    # fake teams/date that are NOT in RESULTS_OVERRIDE, so the override never
    # interferes with the gating assertions
    M = {"team1": "Testland", "team2": "Mockia"}
    KO = datetime(2026, 7, 1, 17, 0, 0, tzinfo=UK)
    K = ("testland", "mockia")
    OVR = "Testland|Mockia|2026-07-01"

    def fb(self, now, espn=None, bdl=None, wiki=None):
        return build.fallback_score(self.M, self.KO, now, espn or {}, bdl or {}, wiki or {})

    def test_espn_fills_immediately_no_ko_plus_2h_wait(self):
        # only 30 min after KO — bdl/wiki would be gated, but ESPN is trusted now
        now = self.KO + timedelta(minutes=30)
        self.assertEqual(self.fb(now, espn={self.K: [0, 0]}), [0, 0])

    def test_espn_reverse_key_orientation(self):
        now = self.KO + timedelta(minutes=30)
        # ESPN listed the fixture the other way round (Mockia home)
        self.assertEqual(self.fb(now, espn={(self.K[1], self.K[0]): [1, 0]}), [0, 1])

    def test_espn_beats_bdl_and_wiki(self):
        now = self.KO + timedelta(hours=3)
        out = self.fb(now, espn={self.K: [0, 0]}, bdl={self.K: [2, 1]}, wiki={self.K: [3, 3]})
        self.assertEqual(out, [0, 0], "ESPN takes precedence over bdl/wiki")

    def test_bdl_wiki_still_gated_to_ko_plus_2h(self):
        now = self.KO + timedelta(minutes=30)  # before +2h
        self.assertIsNone(self.fb(now, bdl={self.K: [2, 1]}),
                          "bdl/wiki must NOT fill before KO+2h when ESPN has nothing")

    def test_bdl_fills_after_2h_when_no_espn(self):
        now = self.KO + timedelta(hours=2, minutes=1)
        self.assertEqual(self.fb(now, bdl={self.K: [2, 1]}), [2, 1])

    def test_manual_override_last_resort(self):
        now = self.KO + timedelta(hours=3)
        build.RESULTS_OVERRIDE[self.OVR] = [4, 2]
        try:
            self.assertEqual(self.fb(now), [4, 2])
        finally:
            build.RESULTS_OVERRIDE.pop(self.OVR, None)


if __name__ == "__main__":
    unittest.main()
