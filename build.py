#!/usr/bin/env python3
"""
World Cup 2026 UK TV Guide — data builder.

Fetches the openfootball public-domain fixture/result feed, converts every
kick-off to UK time, merges in the UK TV channel for each match, computes
live group standings, and writes data/matches.json for the app.

Run locally:  python3 build.py
Run in CI:    see .github/workflows/refresh.yml (every 15 min, free)
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

FEED = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
OUT = Path(__file__).parent / "data" / "matches.json"
UK = ZoneInfo("Europe/London")


def goal_minute_sort_key(minute):
    if minute is None:
        return (1, 0, 0, "")
    text = str(minute).strip()
    match = re.match(r"^(\d+)(?:\+(\d+))?", text)
    if not match:
        return (0, 999, 999, text)
    base = int(match.group(1))
    added = int(match.group(2) or 0)
    return (0, base, added, text)

# ---------------------------------------------------------------------------
# UK TV channels — group stage confirmed by BBC/ITV. Knockout channels are
# announced by the broadcasters after each draw; update KNOCKOUT_CHANNELS as
# they confirm (key: "YYYY-MM-DD HH:MM" UK kick-off, value: channel).
# Known editorial picks: England's R32, R16 and SF are BBC; a QF would be ITV;
# the final is on both. Scotland's R32 (if they advance) expected BBC.
# ---------------------------------------------------------------------------
GROUP_CHANNELS = {
    # key: "team1|team2" exactly as in the openfootball feed
    "Mexico|South Africa": "ITV1",
    "South Korea|Czech Republic": "ITV1",
    "Canada|Bosnia & Herzegovina": "BBC One",
    "USA|Paraguay": "BBC One",
    "Qatar|Switzerland": "ITV1",
    "Brazil|Morocco": "BBC One",
    "Haiti|Scotland": "BBC One",
    "Australia|Turkey": "ITV1",
    "Germany|Curaçao": "ITV1",
    "Netherlands|Japan": "ITV1",
    "Ivory Coast|Ecuador": "BBC One",
    "Sweden|Tunisia": "ITV1",
    "Spain|Cape Verde": "ITV1",
    "Belgium|Egypt": "BBC One",
    "Saudi Arabia|Uruguay": "ITV1",
    "Iran|New Zealand": "BBC One",
    "France|Senegal": "BBC One",
    "Iraq|Norway": "BBC One",
    "Argentina|Algeria": "ITV1",
    "Austria|Jordan": "BBC One",
    "Portugal|DR Congo": "BBC One",
    "England|Croatia": "ITV1",
    "Ghana|Panama": "ITV1",
    "Uzbekistan|Colombia": "BBC One",
    "Czech Republic|South Africa": "BBC One",
    "Switzerland|Bosnia & Herzegovina": "ITV1",
    "Canada|Qatar": "ITV1",
    "Mexico|South Korea": "BBC One",
    "USA|Australia": "BBC One",
    "Scotland|Morocco": "ITV1",
    "Brazil|Haiti": "ITV1",
    "Turkey|Paraguay": "ITV1",
    "Netherlands|Sweden": "BBC One",
    "Germany|Ivory Coast": "ITV1",
    "Ecuador|Curaçao": "BBC One",
    "Tunisia|Japan": "BBC One",
    "Spain|Saudi Arabia": "BBC One",
    "Belgium|Iran": "ITV1",
    "Uruguay|Cape Verde": "BBC One",
    "New Zealand|Egypt": "ITV1",
    "Argentina|Austria": "BBC One",
    "France|Iraq": "BBC One",
    "Norway|Senegal": "ITV1",
    "Jordan|Algeria": "ITV1",
    "Portugal|Uzbekistan": "ITV1",
    "England|Ghana": "BBC One",
    "Panama|Croatia": "BBC One",
    "Colombia|DR Congo": "ITV1",
    "Bosnia & Herzegovina|Qatar": "ITV4",
    "Switzerland|Canada": "ITV1",
    "Morocco|Haiti": "BBC Two",
    "Scotland|Brazil": "BBC One",
    "Czech Republic|Mexico": "BBC One",
    "South Africa|South Korea": "BBC Two",
    "Curaçao|Ivory Coast": "BBC Two",
    "Ecuador|Germany": "BBC One",
    "Japan|Sweden": "BBC Two",
    "Tunisia|Netherlands": "BBC One",
    "Paraguay|Australia": "ITV4",
    "Turkey|USA": "ITV1",
    "Norway|France": "ITV1",
    "Senegal|Iraq": "ITV4",
    "Cape Verde|Saudi Arabia": "ITV4",
    "Uruguay|Spain": "ITV1",
    "Egypt|Iran": "BBC Two",
    "New Zealand|Belgium": "BBC One",
    "Croatia|Ghana": "ITV4",
    "Panama|England": "ITV1",
    "Colombia|Portugal": "BBC One",
    "DR Congo|Uzbekistan": "BBC Two",
    "Algeria|Austria": "BBC Two",
    "Jordan|Argentina": "BBC One",
}

KNOCKOUT_CHANNELS = {
    # Fill in as BBC/ITV announce picks after each draw, e.g.:
    # "2026-06-29 21:30": "BBC One",
    "2026-07-19 20:00": "BBC & ITV",   # the final is shown on both, as is custom
}

FLAGS = {
    "Algeria": "🇩🇿", "Argentina": "🇦🇷", "Australia": "🇦🇺", "Austria": "🇦🇹",
    "Belgium": "🇧🇪", "Bosnia & Herzegovina": "🇧🇦", "Brazil": "🇧🇷",
    "Canada": "🇨🇦", "Cape Verde": "🇨🇻", "Colombia": "🇨🇴", "Croatia": "🇭🇷",
    "Curaçao": "🇨🇼", "Czech Republic": "🇨🇿", "DR Congo": "🇨🇩",
    "Ecuador": "🇪🇨", "Egypt": "🇪🇬", "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "France": "🇫🇷",
    "Germany": "🇩🇪", "Ghana": "🇬🇭", "Haiti": "🇭🇹", "Iran": "🇮🇷",
    "Iraq": "🇮🇶", "Ivory Coast": "🇨🇮", "Japan": "🇯🇵", "Jordan": "🇯🇴",
    "Mexico": "🇲🇽", "Morocco": "🇲🇦", "Netherlands": "🇳🇱",
    "New Zealand": "🇳🇿", "Norway": "🇳🇴", "Panama": "🇵🇦", "Paraguay": "🇵🇾",
    "Portugal": "🇵🇹", "Qatar": "🇶🇦", "Saudi Arabia": "🇸🇦",
    "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "Senegal": "🇸🇳", "South Africa": "🇿🇦",
    "South Korea": "🇰🇷", "Spain": "🇪🇸", "Sweden": "🇸🇪",
    "Switzerland": "🇨🇭", "Tunisia": "🇹🇳", "Turkey": "🇹🇷", "USA": "🇺🇸",
    "Uruguay": "🇺🇾", "Uzbekistan": "🇺🇿",
}

STAGE = {
    "Round of 32": ("R32", 4), "Round of 16": ("R16", 5),
    "Quarter-final": ("QF", 6), "Semi-final": ("SF", 7),
    "Match for third place": ("3rd Place", 8), "Final": ("Final", 9),
}

# ---------------------------------------------------------------------------
# THE TELLY SUPERCOMPUTER — Elo-seeded Monte Carlo tournament simulator.
# Seeds: eloratings.net scale (top teams per published Jan 2026 table; others
# estimated — v2 task: refresh all 48 seeds from eloratings.net). Ratings
# self-correct as real results land via the standard Elo update below, so
# the model sharpens automatically every matchday.
# ---------------------------------------------------------------------------
ELO = {
    "Spain": 2171, "Argentina": 2113, "France": 2063, "England": 2042,
    "Colombia": 1998, "Brazil": 1979, "Portugal": 1976, "Netherlands": 1959,
    "Croatia": 1933, "Ecuador": 1933, "Norway": 1922, "Germany": 1910,
    "Switzerland": 1897, "Uruguay": 1890, "Turkey": 1880, "Japan": 1879,
    "Senegal": 1869, "Belgium": 1849, "Morocco": 1840, "Mexico": 1810,
    "Austria": 1800, "USA": 1790, "Iran": 1760, "Sweden": 1750,
    "South Korea": 1740, "Paraguay": 1740, "Algeria": 1740, "Australia": 1730,
    "Canada": 1730, "Czech Republic": 1720, "Egypt": 1720, "Ivory Coast": 1720,
    "Tunisia": 1700, "Scotland": 1700, "Bosnia & Herzegovina": 1660,
    "Ghana": 1650, "Qatar": 1620, "Saudi Arabia": 1620, "Panama": 1610,
    "DR Congo": 1610, "Iraq": 1600, "South Africa": 1600, "Uzbekistan": 1600,
    "Jordan": 1580, "Cape Verde": 1550, "New Zealand": 1500, "Haiti": 1480,
    "Curaçao": 1450,
}

VENUE_COUNTRY = {
    "Mexico City": "Mexico", "Guadalajara (Zapopan)": "Mexico",
    "Monterrey (Guadalupe)": "Mexico", "Toronto": "Canada",
    "Vancouver": "Canada",
}  # every other venue is USA
HOME_BONUS = 100
SIMS = 4000


def venue_bonus(team, ground):
    return HOME_BONUS if VENUE_COUNTRY.get(ground, "USA") == team else 0


def elo_update(played):
    """Standard eloratings.net update (K=60 World Cup, goal-diff multiplier)."""
    import math
    elo = dict(ELO)
    for m in played:
        t1, t2, s1, s2 = m["team1"], m["team2"], m["score1"], m["score2"]
        if t1 not in elo or t2 not in elo:
            continue
        d = (elo[t1] + venue_bonus(t1, m["ground"])) - (elo[t2] + venue_bonus(t2, m["ground"]))
        we = 1 / (1 + 10 ** (-d / 400))
        w = 1.0 if s1 > s2 else (0.5 if s1 == s2 else 0.0)
        gd = abs(s1 - s2)
        g = 1 if gd <= 1 else (1.5 if gd == 2 else (11 + gd) / 8)
        delta = 60 * g * (w - we)
        elo[t1] += delta
        elo[t2] -= delta
    return elo


def lambdas(elo, m):
    """Expected goals for each side from the Elo difference."""
    d = (elo.get(m["team1"], 1600) + venue_bonus(m["team1"], m["ground"])) \
        - (elo.get(m["team2"], 1600) + venue_bonus(m["team2"], m["ground"]))
    l1 = min(3.4, max(0.25, 1.35 * 10 ** (d / 1100)))
    l2 = min(3.4, max(0.25, 1.35 * 10 ** (-d / 1100)))
    return l1, l2


def match_probs(elo, m):
    """Analytic P(win/draw/loss) from a Poisson goal grid."""
    import math
    l1, l2 = lambdas(elo, m)
    p1 = [math.exp(-l1) * l1 ** k / math.factorial(k) for k in range(11)]
    p2 = [math.exp(-l2) * l2 ** k / math.factorial(k) for k in range(11)]
    w = sum(p1[a] * p2[b] for a in range(11) for b in range(11) if a > b)
    d = sum(p1[k] * p2[k] for k in range(11))
    return round(w, 3), round(d, 3), round(max(0.0, 1 - w - d), 3)


def _poisson(lam, rnd):
    L, k, p = pow(2.718281828, -lam), 0, 1.0
    while True:
        p *= rnd.random()
        if p <= L:
            return k
        k += 1


def simulate(matches, elo, base_tables):
    """Monte Carlo the rest of the tournament SIMS times."""
    import random
    rnd = random.Random(26)
    group_ms = [m for m in matches if m["stage"] == "Group"]
    ko_ms = [m for m in matches if m["stage"] != "Group"]
    reach = {t: {"r32": 0, "r16": 0, "qf": 0, "sf": 0, "final": 0, "win": 0} for t in ELO}

    def sim_match(t1, t2, ground):
        l1, l2 = lambdas(elo, {"team1": t1, "team2": t2, "ground": ground})
        return _poisson(l1, rnd), _poisson(l2, rnd)

    for _ in range(SIMS):
        # --- group stage: real results stand, the rest are sampled ---
        tb = {g: {t: dict(row) for t, row in rows.items()} for g, rows in base_tables.items()}
        for m in group_ms:
            if m["score1"] is not None:
                continue
            s1, s2 = sim_match(m["team1"], m["team2"], m["ground"])
            for team, gf, ga in ((m["team1"], s1, s2), (m["team2"], s2, s1)):
                r = tb[m["group"]][team]
                r["pts"] += 3 if gf > ga else (1 if gf == ga else 0)
                r["gd"] += gf - ga
                r["gf"] += gf
        ranked = {g: sorted(rows.values(), key=lambda x: (-x["pts"], -x["gd"], -x["gf"], rnd.random()))
                  for g, rows in tb.items()}
        firsts = {g: r[0]["team"] for g, r in ranked.items()}
        seconds = {g: r[1]["team"] for g, r in ranked.items()}
        thirds = sorted(((g, r[2]) for g, r in ranked.items()),
                        key=lambda x: (-x[1]["pts"], -x[1]["gd"], -x[1]["gf"], rnd.random()))
        qual_thirds = {g: row["team"] for g, row in thirds[:8]}

        # --- resolve R32 slots; assign qualified thirds to constrained slots ---
        winners = {}          # FIFA match number -> winning team
        third_slots = [(i, m) for i, m in enumerate(ko_ms) if "/" in m["team2"]]
        assigned, used = {}, set()
        for i, m in third_slots:  # greedy assignment within each slot's allowed groups
            allowed = m["team2"][1:].split("/")
            pick = next((g for g in allowed if g in qual_thirds and g not in used), None)
            if pick is None:
                pick = next((g for g in qual_thirds if g not in used), None)
            if pick:
                used.add(pick)
                assigned[i] = qual_thirds[pick]

        def resolve(label, idx):
            if label.startswith("W"):
                return winners.get(int(label[1:]))
            if label.startswith("L"):  # third-place match
                return losers.get(int(label[1:]))
            if "/" in label:
                return assigned.get(idx)
            g = label[1]
            return firsts[g] if label[0] == "1" else seconds[g]

        losers = {}
        for i, m in enumerate(ko_ms):
            num = 73 + i if m["round"] != "Final" else 104
            t1 = resolve(m["team1"], i)
            t2 = resolve(m["team2"], i)
            if not t1 or not t2:
                continue
            if m["round"] == "Round of 32":
                reach[t1]["r32"] += 1; reach[t2]["r32"] += 1
            elif m["round"] == "Round of 16":
                reach[t1]["r16"] += 1; reach[t2]["r16"] += 1
            elif m["round"] == "Quarter-final":
                reach[t1]["qf"] += 1; reach[t2]["qf"] += 1
            elif m["round"] == "Semi-final":
                reach[t1]["sf"] += 1; reach[t2]["sf"] += 1
            elif m["round"] == "Final":
                reach[t1]["final"] += 1; reach[t2]["final"] += 1
            if m["score1"] is not None and m["score1"] != m["score2"]:
                s1, s2 = m["score1"], m["score2"]
            else:
                s1, s2 = sim_match(t1, t2, m["ground"])
                if s1 == s2:  # extra time / pens: weight by Elo expectancy
                    d = elo.get(t1, 1600) - elo.get(t2, 1600)
                    s1, s2 = (1, 0) if rnd.random() < 1 / (1 + 10 ** (-d / 400)) else (0, 1)
            win, lose = (t1, t2) if s1 > s2 else (t2, t1)
            winners[num], losers[num] = win, lose
            if m["round"] == "Final":
                reach[win]["win"] += 1

    pct = lambda n: round(100 * n / SIMS, 1)
    return sorted(
        ({"team": t, "flag": FLAGS.get(t, "⚽"), "elo": round(elo.get(t, 1600)),
          "win": pct(r["win"]), "final": pct(r["final"]), "sf": pct(r["sf"]),
          "qf": pct(r["qf"]), "r16": pct(r["r16"])} for t, r in reach.items()),
        key=lambda x: (-x["win"], -x["final"], -x["elo"]))


def uk_datetime(date_str, time_str):
    """'2026-06-11' + '13:00 UTC-6' -> aware datetime in Europe/London."""
    m = re.match(r"(\d{1,2}):(\d{2})\s*UTC([+-]\d+)", time_str)
    h, mi, off = int(m.group(1)), int(m.group(2)), int(m.group(3))
    local = datetime.fromisoformat(date_str).replace(hour=h, minute=mi)
    utc = local - timedelta(hours=off)
    return utc.replace(tzinfo=timezone.utc).astimezone(UK)


# The 16 WC26 stadiums (lat, lon), keyed by the `ground` strings in the feed.
VENUE_COORDS = {
    "Atlanta": (33.7554, -84.4008),                       # Mercedes-Benz Stadium
    "Boston (Foxborough)": (42.0909, -71.2643),           # Gillette Stadium
    "Dallas (Arlington)": (32.7473, -97.0945),            # AT&T Stadium
    "Guadalajara (Zapopan)": (20.6818, -103.4626),        # Estadio Akron
    "Houston": (29.6847, -95.4107),                       # NRG Stadium
    "Kansas City": (39.0490, -94.4839),                   # Arrowhead Stadium
    "Los Angeles (Inglewood)": (33.9535, -118.3392),      # SoFi Stadium
    "Mexico City": (19.3029, -99.1505),                   # Estadio Azteca
    "Miami (Miami Gardens)": (25.9580, -80.2389),         # Hard Rock Stadium
    "Monterrey (Guadalupe)": (25.6694, -100.2444),        # Estadio BBVA
    "New York/New Jersey (East Rutherford)": (40.8136, -74.0744),  # MetLife Stadium
    "Philadelphia": (39.9008, -75.1675),                  # Lincoln Financial Field
    "San Francisco Bay Area (Santa Clara)": (37.4030, -121.9700),  # Levi's Stadium
    "Seattle": (47.5952, -122.3316),                      # Lumen Field
    "Toronto": (43.6332, -79.4185),                       # BMO Field
    "Vancouver": (49.2768, -123.1119),                    # BC Place
}

# WMO weather codes → (emoji, short text). Open-Meteo returns these codes.
WX_CODES = {
    0: ("☀️", "Clear"), 1: ("🌤️", "Mainly clear"), 2: ("⛅", "Partly cloudy"), 3: ("☁️", "Overcast"),
    45: ("🌫️", "Fog"), 48: ("🌫️", "Fog"),
    51: ("🌦️", "Light drizzle"), 53: ("🌦️", "Drizzle"), 55: ("🌧️", "Heavy drizzle"),
    56: ("🌧️", "Freezing drizzle"), 57: ("🌧️", "Freezing drizzle"),
    61: ("🌦️", "Light rain"), 63: ("🌧️", "Rain"), 65: ("🌧️", "Heavy rain"),
    66: ("🌧️", "Freezing rain"), 67: ("🌧️", "Freezing rain"),
    71: ("🌨️", "Light snow"), 73: ("🌨️", "Snow"), 75: ("❄️", "Heavy snow"), 77: ("🌨️", "Snow grains"),
    80: ("🌦️", "Showers"), 81: ("🌧️", "Showers"), 82: ("⛈️", "Violent showers"),
    85: ("🌨️", "Snow showers"), 86: ("🌨️", "Snow showers"),
    95: ("⛈️", "Thunderstorm"), 96: ("⛈️", "Thunderstorm with hail"), 99: ("⛈️", "Thunderstorm with hail"),
}


def add_weather(matches):
    """Attach a kick-off weather forecast to each upcoming match from Open-Meteo
    (free, no key). Grouped by venue+date → one API call each. Open-Meteo only
    forecasts ~16 days out, so distant matches simply get no weather yet; the
    15-min Action fills them in as they come into range. Never fails the build."""
    groups = {}  # (lat, lon, utc_date) -> [(match, "YYYY-MM-DDTHH:00 UTC")]
    for m in matches:
        if m["status"] == "FT":
            continue
        coords = VENUE_COORDS.get(m["ground"])
        if not coords:
            continue
        ko_utc = datetime.fromisoformat(m["ukKickoff"]).astimezone(timezone.utc)
        key = (coords[0], coords[1], ko_utc.strftime("%Y-%m-%d"))
        groups.setdefault(key, []).append((m, ko_utc.strftime("%Y-%m-%dT%H:00")))

    fetched = 0
    for (lat, lon, date), items in groups.items():
        url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
               f"&hourly=temperature_2m,weather_code&start_date={date}&end_date={date}&timezone=GMT")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "KickOffOracle-Build/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read())
        except Exception:
            continue  # out of forecast range or transient — skip quietly
        hourly = data.get("hourly", {})
        idx = {t: i for i, t in enumerate(hourly.get("time", []))}
        temps, codes = hourly.get("temperature_2m", []), hourly.get("weather_code", [])
        for m, hour_key in items:
            i = idx.get(hour_key)
            if i is None or temps[i] is None:
                continue
            emoji, desc = WX_CODES.get(codes[i], ("🌡️", ""))
            m["weather"] = {"temp": round(temps[i]), "code": codes[i], "icon": emoji, "desc": desc}
            fetched += 1
    if fetched:
        print(f"weather: {fetched} match forecasts from Open-Meteo")


# Manual final-score overrides for when the openfootball feed is slow to publish
# a result. Keyed "team1|team2|YYYY-MM-DD" (UK kick-off date), score is [team1,
# team2]. Used ONLY while the feed has no score for that match — once openfootball
# posts the real result it takes over, so entries here are safe to leave or remove.
RESULTS_OVERRIDE = {
    "Mexico|South Africa|2026-06-11": [2, 0],
    "Spain|Cape Verde|2026-06-15": [0, 0],  # FT 0-0 (ESPN + TheSportsDB); openfootball/Wikipedia lagged
    "Belgium|Egypt|2026-06-15": [1, 1],     # FT 1-1 (ESPN + TheSportsDB)
}

# ---------------------------------------------------------------------------
# MULTI-SOURCE RESULTS — so we never wait on openfootball.
# Precedence per match: openfootball (authoritative) → BALLDONTLIE (primary live,
# key-gated) → Wikipedia (free fallback) → RESULTS_OVERRIDE (manual). The last
# three only fill once a match is over (KO+2h) and openfootball still has no score.
# ---------------------------------------------------------------------------
SRC_UA = "KickOffOracle-Build/1.0 (https://abigwood.github.io/kickoff-oracle/; contact adambigwood@me.com)"

# FIFA 3-letter codes used in Wikipedia match templates → openfootball team names.
FIFA_CODE = {
    "MEX": "Mexico", "RSA": "South Africa", "KOR": "South Korea", "CZE": "Czech Republic",
    "CAN": "Canada", "BIH": "Bosnia & Herzegovina", "QAT": "Qatar", "SUI": "Switzerland",
    "BRA": "Brazil", "MAR": "Morocco", "HAI": "Haiti", "SCO": "Scotland",
    "USA": "USA", "PAR": "Paraguay", "AUS": "Australia", "TUR": "Turkey",
    "GER": "Germany", "CUW": "Curaçao", "CIV": "Ivory Coast", "ECU": "Ecuador",
    "NED": "Netherlands", "JPN": "Japan", "SWE": "Sweden", "TUN": "Tunisia",
    "BEL": "Belgium", "EGY": "Egypt", "IRN": "Iran", "NZL": "New Zealand",
    "ESP": "Spain", "CPV": "Cape Verde", "KSA": "Saudi Arabia", "URU": "Uruguay",
    "FRA": "France", "SEN": "Senegal", "IRQ": "Iraq", "NOR": "Norway",
    "ARG": "Argentina", "ALG": "Algeria", "AUT": "Austria", "JOR": "Jordan",
    "POR": "Portugal", "COD": "DR Congo", "UZB": "Uzbekistan", "COL": "Colombia",
    "ENG": "England", "CRO": "Croatia", "GHA": "Ghana", "PAN": "Panama",
}
# normalise team names so sources with different spellings still match
NAME_ALIAS = {
    "czechia": "czech republic", "korea republic": "south korea", "ir iran": "iran",
    "united states": "usa", "côte d'ivoire": "ivory coast", "cote d'ivoire": "ivory coast",
    "cabo verde": "cape verde", "bosnia and herzegovina": "bosnia & herzegovina",
    "türkiye": "turkey", "turkiye": "turkey", "congo dr": "dr congo", "curacao": "curaçao",
}


def _canon(name):
    n = re.sub(r"\{\{[^{}]*\}\}", "", str(name))
    n = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", n)
    n = n.strip().lower()
    return NAME_ALIAS.get(n, n)


def _wiki_page(page):
    url = ("https://en.wikipedia.org/w/api.php?action=parse&page="
           + urllib.parse.quote(page) + "&prop=wikitext&format=json&formatversion=2")
    req = urllib.request.Request(url, headers={"User-Agent": SRC_UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())["parse"]["wikitext"]


def _balanced(wt, start):
    depth, k = 0, start
    while k < len(wt):
        if wt[k:k + 2] == "{{":
            depth += 1; k += 2
        elif wt[k:k + 2] == "}}":
            depth -= 1; k += 2
            if depth == 0:
                return wt[start:k]
        else:
            k += 1
    return wt[start:k]


def _parse_football_boxes(wt):
    """Pull finished match scores from a 2026 WC Wikipedia page. Results use
    {{#invoke:football box|main ... |team1={{#invoke:flag|fb-rt|MEX}} |score=
    {{score link|...|2–0}} |team2={{#invoke:flag|fb|RSA}} ...}}."""
    out = {}
    for mm in re.finditer(r"\{\{\s*#invoke:football box\s*\|\s*main", wt):
        box = _balanced(wt, mm.start())
        t1 = re.search(r"\|\s*team1\s*=([^\n]*)", box)
        t2 = re.search(r"\|\s*team2\s*=([^\n]*)", box)
        sc = re.search(r"\|\s*score\s*=([^\n]*)", box)
        if not (t1 and t2 and sc):
            continue
        c1 = re.search(r"[A-Z]{3}", t1.group(1))
        c2 = re.search(r"[A-Z]{3}", t2.group(1))
        nums = re.findall(r"(\d+)\s*[–\-−]\s*(\d+)", sc.group(1))  # last pair = the score
        if not (c1 and c2 and nums):
            continue
        n1, n2 = FIFA_CODE.get(c1.group(0)), FIFA_CODE.get(c2.group(0))
        if not (n1 and n2):
            continue
        # finished/full-time signal: attendance is only recorded after the match
        att = re.search(r"\|\s*attendance\s*=([^\n]*)", box)
        finished = bool(att and re.search(r"\d", att.group(1)))
        out[(_canon(n1), _canon(n2))] = {"score": [int(nums[-1][0]), int(nums[-1][1])], "finished": finished}
    return out


def fetch_wikipedia_results(groups, knockout):
    """Free fallback — parse scores from the per-group / knockout Wikipedia pages.
    Only the pages we actually need are fetched (Wikipedia etiquette)."""
    pages = [f"2026 FIFA World Cup Group {g}" for g in sorted(groups)]
    if knockout:
        pages.append("2026 FIFA World Cup knockout stage")
    out = {}
    for p in pages:
        try:
            out.update(_parse_football_boxes(_wiki_page(p)))
        except Exception as e:
            print(f"wikipedia source skipped ({p}): {e}")
    if out:
        print(f"wikipedia: {len(out)} match scores seen on {len(pages)} page(s)")
    return out


def confirm_wikipedia(wiki, prev_pending, now):
    """Finality gate for Wikipedia scores. Accept a score only if EITHER the page
    marks the match finished (attendance recorded), OR the SAME score has now
    persisted across two polls >=5 min apart. A score that changed since the last
    poll is live — never settle it; carry it forward and re-check next run.
    Returns (confirmed {(c1,c2): [s1,s2]}, new_pending {key: {score, first_seen}})."""
    confirmed, pending = {}, {}
    for key, info in wiki.items():
        score = list(info["score"])
        k = "|".join(key)
        if info.get("finished"):
            confirmed[key] = score
            continue
        prev = prev_pending.get(k)
        if prev and list(prev.get("score", [])) == score:
            first = prev.get("first_seen", now.isoformat())
            pending[k] = {"score": score, "first_seen": first}  # keep the original sighting time
            try:
                if now - datetime.fromisoformat(first) >= timedelta(minutes=5):
                    confirmed[key] = score  # stable across two polls → final
            except Exception:
                pass
        else:
            # first sighting, or the score changed since last poll → it's live, wait
            pending[k] = {"score": score, "first_seen": now.isoformat()}
    return confirmed, pending


def fetch_balldontlie_results():
    """PRIMARY live source. No-op until BALLDONTLIE_KEY is set, then activates
    automatically. Fully defensive — any error returns {} so the build never
    breaks. The endpoint/field names may need a tweak once the real key reveals
    the live response shape (override BALLDONTLIE_BASE if so)."""
    key = os.environ.get("BALLDONTLIE_KEY")
    if not key:
        return {}
    base = os.environ.get("BALLDONTLIE_BASE") or "https://api.balldontlie.io/fifa/v1"
    out = {}
    try:
        url = base.rstrip("/") + "/games?" + urllib.parse.urlencode({"seasons[]": 2026, "per_page": 100})
        req = urllib.request.Request(url, headers={"Authorization": key, "User-Agent": SRC_UA})
        data = json.loads(urllib.request.urlopen(req, timeout=20).read())
        for g in data.get("data", []):
            status = str(g.get("status", "")).lower()
            if not ("final" in status or "ft" in status or "finished" in status):
                continue  # only completed games count
            ht, at = g.get("home_team") or {}, g.get("away_team") or {}
            hn = ht.get("name") or ht.get("full_name") or g.get("home_team_name")
            an = at.get("name") or at.get("full_name") or g.get("away_team_name")
            hs = g.get("home_team_score", g.get("home_score"))
            as_ = g.get("away_team_score", g.get("away_score"))
            if hn and an and hs is not None and as_ is not None:
                out[(_canon(hn), _canon(an))] = (int(hs), int(as_))
        if out:
            print(f"balldontlie: {len(out)} finished games (primary source live)")
    except Exception as e:
        print(f"balldontlie skipped: {e}")
    return out


def fallback_score(m, ko, now, bdl, wiki):
    """openfootball had no score for this match. Fill from other sources once the
    match is over (KO+2h): BALLDONTLIE first, then Wikipedia, then manual override."""
    if now >= ko + timedelta(hours=2):
        k = (_canon(m["team1"]), _canon(m["team2"]))
        kr = (k[1], k[0])
        for src in (bdl, wiki):
            if k in src:
                return list(src[k])
            if kr in src:
                return [src[kr][1], src[kr][0]]  # teams listed the other way round
    return RESULTS_OVERRIDE.get(f'{m["team1"]}|{m["team2"]}|{ko.strftime("%Y-%m-%d")}')


def main():
    try:
        with urllib.request.urlopen(FEED, timeout=30) as r:
            feed = json.load(r)
    except Exception as e:  # keep last good data on feed failure
        print(f"Feed fetch failed ({e}); keeping existing data.", file=sys.stderr)
        sys.exit(0 if OUT.exists() else 1)

    matches, standings = [], {}
    now = datetime.now(UK)

    # Pre-scan: which matches are over (KO+2h) but still have no openfootball
    # score? Fetch fallback sources only for the groups/stages that need them.
    need_groups, need_knockout = set(), False
    for m in feed["matches"]:
        fs1, fs2 = m.get("score1"), m.get("score2")
        if fs1 is None and isinstance(m.get("score"), dict):
            ft = m["score"].get("ft") or []
            if len(ft) == 2:
                fs1, fs2 = ft
        if fs1 is not None and fs2 is not None:
            continue
        try:
            ko0 = uk_datetime(m["date"], m["time"])
        except Exception:
            continue
        if now < ko0 + timedelta(hours=2):
            continue
        g = (m.get("group", "") or "").replace("Group ", "").strip()
        if len(g) == 1 and g.isalpha():
            need_groups.add(g.upper())
        else:
            need_knockout = True
    # two-poll finality state for Wikipedia scores, persisted across cron runs
    pending_file = OUT.parent / "wiki_pending.json"
    prev_pending = {}
    if pending_file.exists():
        try:
            prev_pending = json.loads(pending_file.read_text())
        except Exception:
            prev_pending = {}
    bdl_results, wiki_results, new_pending = {}, {}, {}
    if need_groups or need_knockout:
        bdl_results = fetch_balldontlie_results()                 # primary (key-gated)
        wiki_raw = fetch_wikipedia_results(need_groups, need_knockout)
        # only settle a wiki score if the page says finished, or it's stable across 2 polls
        wiki_results, new_pending = confirm_wikipedia(wiki_raw, prev_pending, now)
        if wiki_raw:
            print(f"wikipedia: {len(wiki_results)} confirmed final, {len(new_pending)} awaiting confirmation")
    pending_file.parent.mkdir(parents=True, exist_ok=True)
    pending_file.write_text(json.dumps(new_pending, ensure_ascii=False, indent=1))

    for i, m in enumerate(feed["matches"]):
        ko = uk_datetime(m["date"], m["time"])
        is_group = m["round"].startswith("Matchday")
        stage, order = ("Group", 1) if is_group else STAGE.get(m["round"], (m["round"], 3))
        key = f'{m["team1"]}|{m["team2"]}'
        channel = (GROUP_CHANNELS.get(key)
                   or KNOCKOUT_CHANNELS.get(ko.strftime("%Y-%m-%d %H:%M"))
                   or "TBC")
        s1, s2 = m.get("score1"), m.get("score2")
        # openfootball sometimes nests scores; be defensive
        if s1 is None and isinstance(m.get("score"), dict):
            ft = m["score"].get("ft") or []
            if len(ft) == 2:
                s1, s2 = ft
        # openfootball is authoritative; if it has no score, fill from other
        # sources (BALLDONTLIE → Wikipedia → manual override) once the match is over.
        if s1 is None or s2 is None:
            fb = fallback_score(m, ko, now, bdl_results, wiki_results)
            if fb:
                s1, s2 = fb
        played = s1 is not None and s2 is not None
        live = (not played) and ko <= now <= ko + timedelta(hours=2, minutes=15)

        events = []
        for side, team in (("goals1", m["team1"]), ("goals2", m["team2"])):
            for g in m.get(side) or []:
                nm = g.get("name") or g.get("scorer")
                if nm:
                    events.append({"name": nm, "minute": g.get("minute"),
                                   "team": team, "og": bool(g.get("owngoal")),
                                   "pen": bool(g.get("penalty"))})
        events.sort(key=lambda e: goal_minute_sort_key(e["minute"]))

        rec = {
            "id": i + 1,
            "stage": stage,
            "stageOrder": order,
            "round": m["round"],
            "group": m.get("group", "").replace("Group ", ""),
            "team1": m["team1"], "team2": m["team2"],
            "flag1": FLAGS.get(m["team1"], "⚽"), "flag2": FLAGS.get(m["team2"], "⚽"),
            "ground": m["ground"],
            "ukKickoff": ko.isoformat(),
            "ukDate": ko.strftime("%Y-%m-%d"),
            "ukTime": ko.strftime("%H:%M"),
            "channel": channel,
            "score1": s1, "score2": s2,
            "goals": events,
            "status": "FT" if played else ("LIVE" if live else "UPCOMING"),
        }
        matches.append(rec)

        if is_group and played:
            g = standings.setdefault(rec["group"], {})
            for team, gf, ga in ((m["team1"], s1, s2), (m["team2"], s2, s1)):
                t = g.setdefault(team, {"team": team, "flag": FLAGS.get(team, "⚽"),
                                        "p": 0, "w": 0, "d": 0, "l": 0,
                                        "gf": 0, "ga": 0, "gd": 0, "pts": 0})
                t["p"] += 1
                t["gf"] += gf
                t["ga"] += ga
                t["gd"] = t["gf"] - t["ga"]
                if gf > ga:
                    t["w"] += 1; t["pts"] += 3
                elif gf == ga:
                    t["d"] += 1; t["pts"] += 1
                else:
                    t["l"] += 1

    # ensure every group lists all four teams even before results
    for m in matches:
        if m["stage"] == "Group":
            g = standings.setdefault(m["group"], {})
            for team, flag in ((m["team1"], m["flag1"]), (m["team2"], m["flag2"])):
                g.setdefault(team, {"team": team, "flag": flag, "p": 0, "w": 0,
                                    "d": 0, "l": 0, "gf": 0, "ga": 0, "gd": 0, "pts": 0})

    tables = {
        grp: sorted(t.values(), key=lambda x: (-x["pts"], -x["gd"], -x["gf"], x["team"]))
        for grp, t in sorted(standings.items())
    }

    # --- Golden Boot: aggregate scorers from the feed (appear as results land) ---
    boot = {}
    for raw, rec in zip(feed["matches"], matches):
        for side, team in (("goals1", rec["team1"]), ("goals2", rec["team2"])):
            for g in raw.get(side) or []:
                name = g.get("name") or g.get("scorer")
                if not name or g.get("owngoal"):
                    continue
                k = (name, team)
                boot[k] = boot.get(k, 0) + 1
    scorers = sorted(({"name": n, "team": t, "flag": FLAGS.get(t, "⚽"), "goals": c}
                      for (n, t), c in boot.items()),
                     key=lambda x: (-x["goals"], x["name"]))[:25]

    # --- Telly Supercomputer: update Elo from real results, then simulate ---
    played_all = [m for m in matches if m["score1"] is not None]
    elo_now = elo_update(played_all)
    base = {g: {r["team"]: dict(r) for r in rows} for g, rows in tables.items()}
    predictions = simulate(matches, elo_now, base)
    mprobs = {str(m["id"]): match_probs(elo_now, m)
              for m in matches
              if m["status"] == "UPCOMING" and m["team1"] in ELO and m["team2"] in ELO}

    # merge YouTube highlight IDs found by find_highlights.py
    hl_file = OUT.parent / "highlights.json"
    if hl_file.exists():
        hl = json.loads(hl_file.read_text())
        for m in matches:
            if str(m["id"]) in hl:
                m["youtube"] = hl[str(m["id"])]

    add_weather(matches)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({
        "updated": now.isoformat(),
        "matches": matches,
        "groups": tables,
        "scorers": scorers,
        "predictions": {"sims": SIMS, "teams": predictions},
        "matchProbs": mprobs,
    }, ensure_ascii=False, indent=1)
    OUT.write_text(payload)
    # JS twin: lets index.html work when opened as a local file (no fetch/CORS)
    (OUT.parent / "matches.js").write_text("window.WC_DATA = " + payload + ";")
    print(f"Wrote {len(matches)} matches, {len(tables)} groups -> {OUT}")
    ping_settle(matches)


def ping_settle(matches):
    """Push finished-match results to THE WINDOW Worker so league tables update
    the moment a match ends (no waiting for Pages to redeploy this data). The
    Worker only recomputes when the result set actually changed. No-op unless
    both env vars are set, so local runs stay offline. Set in the GitHub Action:
    WINDOW_API + SETTLE_SECRET (Actions secret)."""
    api = os.environ.get("WINDOW_API")
    secret = os.environ.get("SETTLE_SECRET")
    if not api or not secret:
        return
    results = {str(m["id"]): [m["score1"], m["score2"]]
               for m in matches if m["status"] == "FT" and m["score1"] is not None}
    try:
        req = urllib.request.Request(
            api.rstrip("/") + "/settle",
            data=json.dumps({"secret": secret, "results": results}).encode(),
            # a real User-Agent is required: Cloudflare's edge blocks the default
            # "Python-urllib" signature with error 1010 before it reaches the Worker.
            headers={"content-type": "application/json", "User-Agent": "KickOffOracle-Build/1.0"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            print("settle pinged:", r.read().decode()[:120])
    except Exception as e:  # never fail the data build over a league refresh
        print("settle ping skipped:", e)


if __name__ == "__main__":
    main()
