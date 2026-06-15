#!/usr/bin/env python3
"""
gen_intel.py — one-off generator for WC26 "Match Intel" cards.

Makes the hand-authored MATCH_INTEL feature automatic for every named-nation
fixture, in the exact tongue-in-cheek geography/scale/latitude voice of the 8
original entries baked into index.html.

NOT wired into the 5-min cron. Run by hand, review the output + reports, then
paste the generated MATCH_INTEL / COUNTRY_MAPS into index.html.

Integrity rules (per the approved plan):
  * Prose is grounded ONLY in the verified facts in COUNTRY_FACTS below — the
    model is told to use nothing else and to never invent figures.
  * A fixture the model can't ground in an accurate, interesting contrast is
    FLAGGED as thin (THIN: ...) rather than padded.
  * Country maps come from Wikimedia Commons locator files resolved via the
    hash-free Special:FilePath/<file>?width=330 endpoint, each verified to
    return a 200 image; graceful fallback chain; anything unresolved is listed.

API key is read from the ANTHROPIC_API_KEY env var (never printed/stored).

OPERATIONAL NOTE
----------------
* MANUAL one-off. This is NOT wired into the 15-min refresh cron and must
  never be — it calls a paid API and writes app content, not data.
* Requires ANTHROPIC_API_KEY in the environment (read from os.environ).
  Install deps in a venv first:  pip install anthropic
* As of the first run (Jun 2026) only the 72 group-stage fixtures could be
  generated; the 32 knockout matches were still placeholders (2A v 2B,
  W73 v W75, ...). Once the group stage ends and the bracket fills with real
  nations, re-run `python tools/gen_intel.py --full` to generate the
  remaining ~32 (already-present fixtures are skipped automatically).
* Maps: `--maps-only intel_full.json` re-resolves all 48 nation maps cheaply
  (no API spend) and is throttled to stay under Wikimedia rate limits.
* DEPLOY per the usual procedure: take a fresh origin/main worktree, paste the
  new MATCH_INTEL / COUNTRY_MAPS entries into index.html (keep hand-authored
  originals verbatim), bump window.__BUILD AND sw.js VERSION, node --check the
  app script, commit + push (rebase past data-refresh races). See HANDOFF.md.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL = "claude-opus-4-8"
MAP_WIDTH = 330
THIN_MIN_CHARS = 140          # outputs shorter than this are flagged thin
COMMONS_FILEPATH = "https://commons.wikimedia.org/wiki/Special:FilePath/"

# ---------------------------------------------------------------------------
# Verified geographic facts. Stable encyclopedic data (areas in km², capitals,
# latitude bands, and geographic hooks). This is the ONLY material the model is
# allowed to use. Keep figures conservative and checkable.
# ---------------------------------------------------------------------------
COUNTRY_FACTS = {
  "Algeria":      {"area": 2381741, "capital": "Algiers",     "lat": "19°N–37°N", "notes": "largest country in Africa by area; ~80% Sahara desert; Mediterranean coast in the north, Atlas mountains, Saharan interior."},
  "Argentina":    {"area": 2780400, "capital": "Buenos Aires","lat": "22°S–55°S", "notes": "8th-largest country on Earth; Andes along the west, Pampas plains, Patagonia in the far south reaching toward Tierra del Fuego."},
  "Australia":    {"area": 7692024, "capital": "Canberra",    "lat": "10°S–43°S", "notes": "smallest continent / 6th-largest country; an island nation between the Indian and Pacific Oceans; vast arid interior ('the Outback')."},
  "Austria":      {"area": 83879,   "capital": "Vienna",      "lat": "46°N–49°N", "notes": "landlocked Alpine country in central Europe; ~62% of the land is mountainous; the Danube runs through it."},
  "Belgium":      {"area": 30528,   "capital": "Brussels",    "lat": "49°N–52°N", "notes": "small, densely populated lowland country on the North Sea; flat coastal plain rising to the Ardennes forest in the southeast."},
  "Bosnia & Herzegovina": {"area": 51197, "capital": "Sarajevo", "lat": "42°N–45°N", "notes": "mountainous Balkan country, almost landlocked — just ~20 km of Adriatic coast at Neum; Dinaric Alps dominate."},
  "Brazil":       {"area": 8515767, "capital": "Brasília",    "lat": "5°N–34°S",  "notes": "largest country in South America, 5th-largest on Earth; contains most of the Amazon basin and rainforest; borders all but two South American nations."},
  "Canada":       {"area": 9984670, "capital": "Ottawa",      "lat": "42°N–83°N", "notes": "2nd-largest country on Earth; longest coastline of any nation; vast boreal forest and Arctic tundra; co-hosts WC26."},
  "Cape Verde":   {"area": 4033,    "capital": "Praia",       "lat": "15°N–17°N", "notes": "volcanic archipelago of 10 islands in the Atlantic ~570 km off West Africa; highest point is the active Pico do Fogo (2,829 m)."},
  "Colombia":     {"area": 1141748, "capital": "Bogotá",      "lat": "4°S–13°N",  "notes": "only South American country with both Pacific and Caribbean coastlines; the Andes split into three ranges here; Amazon in the south."},
  "Croatia":      {"area": 56594,   "capital": "Zagreb",      "lat": "42°N–46°N", "notes": "crescent-shaped country on the Adriatic; over a thousand islands along a deeply indented Dalmatian coast."},
  "Curaçao":      {"area": 444,     "capital": "Willemstad",  "lat": "12°N",      "notes": "444 km² island in the southern Caribbean off the Venezuelan coast; arid, flat, outside the main hurricane belt."},
  "Czech Republic": {"area": 78871, "capital": "Prague",      "lat": "48°N–51°N", "notes": "landlocked central-European country; the Bohemian basin ringed by low mountains; the European watershed runs through it."},
  "DR Congo":     {"area": 2344858, "capital": "Kinshasa",    "lat": "5°N–13°S",  "notes": "2nd-largest country in Africa; straddles the equator; the Congo River basin and the world's 2nd-largest rainforest."},
  "Ecuador":      {"area": 283561,  "capital": "Quito",       "lat": "1°N–5°S",   "notes": "named after the equator, which bisects it; Andes down the middle, Amazon to the east, and the Galápagos Islands far offshore."},
  "Egypt":        {"area": 1010408, "capital": "Cairo",       "lat": "22°N–32°N", "notes": "almost entirely Saharan desert; the Nile valley is a thin green ribbon where nearly everyone lives; spans Africa into the Sinai in Asia."},
  "England":      {"area": 130279,  "capital": "London",      "lat": "50°N–56°N", "notes": "largest of the four UK nations, occupying the south and centre of the island of Great Britain; lowland south, Pennine hills in the north."},
  "France":       {"area": 551695,  "capital": "Paris",       "lat": "41°N–51°N", "notes": "the 'Hexagon'; largest country in the EU; Mont Blanc (4,808 m) is the highest peak in western Europe; Atlantic, Channel and Mediterranean coasts."},
  "Germany":      {"area": 357022,  "capital": "Berlin",      "lat": "47°N–55°N", "notes": "most populous EU country; central-European lowlands in the north rising to the Alps in the south; the Rhine and Danube rise here."},
  "Ghana":        {"area": 238535,  "capital": "Accra",       "lat": "5°N–11°N",  "notes": "West African country on the Gulf of Guinea; the Greenwich meridian passes through it, putting it near 0°,0°; Lake Volta is among the world's largest reservoirs."},
  "Haiti":        {"area": 27750,   "capital": "Port-au-Prince","lat": "18°N–20°N","notes": "occupies the mountainous western third of the island of Hispaniola; name means 'land of high mountains'; on a major fault line."},
  "Iran":         {"area": 1648195, "capital": "Tehran",      "lat": "25°N–40°N", "notes": "high, arid plateau ringed by the Zagros and Alborz mountains; two great salt deserts in the interior; coasts on the Caspian and the Persian Gulf."},
  "Iraq":         {"area": 438317,  "capital": "Baghdad",     "lat": "29°N–37°N", "notes": "Mesopotamia — the land between the Tigris and Euphrates; fertile river plain giving way to western desert; a narrow Gulf outlet."},
  "Ivory Coast":  {"area": 322463,  "capital": "Yamoussoukro","lat": "4°N–11°N",  "notes": "West African country on the Gulf of Guinea, just north of the equator; tropical south, savanna north."},
  "Japan":        {"area": 377975,  "capital": "Tokyo",       "lat": "24°N–46°N", "notes": "volcanic archipelago of 6,852 islands along the Pacific Ring of Fire; ~73% mountainous; highly seismic."},
  "Jordan":       {"area": 89342,   "capital": "Amman",       "lat": "29°N–33°N", "notes": "largely desert plateau; contains the Dead Sea shore, the lowest land on Earth (~430 m below sea level); only a tiny Red Sea coast at Aqaba."},
  "Mexico":       {"area": 1972550, "capital": "Mexico City", "lat": "14°N–32°N", "notes": "high central plateau between two Sierra Madre ranges; Pacific and Gulf/Caribbean coasts; co-hosts WC26."},
  "Morocco":      {"area": 446550,  "capital": "Rabat",       "lat": "21°N–36°N", "notes": "Atlantic and Mediterranean coasts; the Atlas mountains separate the coast from the Sahara; nearest African point to Europe across Gibraltar."},
  "Netherlands":  {"area": 41850,   "capital": "Amsterdam",   "lat": "50°N–54°N", "notes": "much of the land sits at or below sea level at the Rhine–Meuse delta; roughly a sixth of it was reclaimed from the sea behind dikes."},
  "New Zealand":  {"area": 268021,  "capital": "Wellington",  "lat": "34°S–47°S", "notes": "two main islands in the South Pacific, one of the most isolated nations on Earth; the Southern Alps and many active volcanoes; far from any neighbour."},
  "Norway":       {"area": 385207,  "capital": "Oslo",        "lat": "58°N–71°N", "notes": "long, narrow Scandinavian country reaching above the Arctic Circle; deeply fjorded coast; one of the most mountainous countries in Europe."},
  "Panama":       {"area": 75417,   "capital": "Panama City", "lat": "7°N–10°N",  "notes": "narrow S-shaped isthmus joining North and South America; the Panama Canal cuts across it linking the Atlantic and Pacific."},
  "Paraguay":     {"area": 406752,  "capital": "Asunción",    "lat": "19°S–27°S", "notes": "landlocked heart of South America; the Paraguay River splits the humid east from the dry Gran Chaco plains in the west."},
  "Portugal":     {"area": 92212,   "capital": "Lisbon",      "lat": "37°N–42°N", "notes": "westernmost country of mainland Europe, on the Atlantic edge of Iberia; includes the Azores and Madeira far out in the Atlantic."},
  "Qatar":        {"area": 11586,   "capital": "Doha",        "lat": "24°N–26°N", "notes": "small, flat desert peninsula jutting into the Persian Gulf; highest natural point is barely above 100 m; almost no fresh surface water."},
  "Saudi Arabia": {"area": 2149690, "capital": "Riyadh",      "lat": "16°N–32°N", "notes": "fills most of the Arabian Peninsula; contains the Rub' al Khali ('Empty Quarter'), the world's largest continuous sand desert; Red Sea and Gulf coasts."},
  "Scotland":     {"area": 77933,   "capital": "Edinburgh",   "lat": "55°N–61°N", "notes": "northern third of Great Britain; rugged Highlands and ~790 islands; deeply indented Atlantic and North Sea coasts."},
  "Senegal":      {"area": 196712,  "capital": "Dakar",       "lat": "12°N–17°N", "notes": "westernmost country of mainland Africa (Pointe des Almadies); flat Atlantic-facing Sahel; nearly surrounds The Gambia."},
  "South Africa": {"area": 1221037, "capital": "Pretoria",    "lat": "22°S–35°S", "notes": "occupies Africa's southern tip where the Atlantic and Indian Oceans meet; a high interior plateau ringed by the Drakensberg escarpment; surrounds Lesotho."},
  "South Korea":  {"area": 100210,  "capital": "Seoul",       "lat": "33°N–39°N", "notes": "occupies the southern half of the Korean peninsula; ~70% mountainous; thousands of islands off a ragged southern and western coast."},
  "Spain":        {"area": 505990,  "capital": "Madrid",      "lat": "36°N–44°N", "notes": "fills most of the Iberian peninsula; a high central Meseta plateau ringed by mountains; second-most-mountainous country in Europe; Madrid is near the geographic centre."},
  "Sweden":       {"area": 450295,  "capital": "Stockholm",   "lat": "55°N–69°N", "notes": "long Scandinavian country stretching from the 55th to the 69th parallel, reaching above the Arctic Circle; thousands of lakes and a Baltic archipelago."},
  "Switzerland":  {"area": 41285,   "capital": "Bern",        "lat": "46°N–48°N", "notes": "landlocked Alpine country; the Alps cover ~60% of it; source of the Rhine and Rhône; many villages sit above 1,000 m."},
  "Tunisia":      {"area": 163610,  "capital": "Tunis",       "lat": "30°N–37°N", "notes": "northernmost country in Africa; fertile Mediterranean north giving way to the Sahara in the south; the Atlas range tails off here."},
  "Turkey":       {"area": 783562,  "capital": "Ankara",      "lat": "36°N–42°N", "notes": "spans two continents — Thrace in Europe and Anatolia in Asia — split by the Bosphorus; surrounded by the Black, Aegean and Mediterranean Seas."},
  "USA":          {"area": 9833517, "capital": "Washington, D.C.","lat": "25°N–49°N (contiguous)", "notes": "3rd- or 4th-largest country on Earth; spans a continent from Atlantic to Pacific across multiple time zones; co-hosts and main WC26 host."},
  "Uruguay":      {"area": 181034,  "capital": "Montevideo",  "lat": "30°S–35°S", "notes": "smallest Spanish-speaking country in South America; gently rolling grassland (no real mountains); Atlantic coast and the wide Río de la Plata estuary."},
  "Uzbekistan":   {"area": 448978,  "capital": "Tashkent",    "lat": "37°N–46°N", "notes": "one of only two doubly-landlocked countries on Earth (every neighbour is itself landlocked); Kyzylkum desert and the shrunken Aral Sea."},
}

# Map locator-file candidates per nation. First candidate that resolves to a
# 200 image wins. The 26 nations already shipping in index.html keep their
# existing working URLs (loaded from index.html); the rest resolve here.
MAP_CANDIDATES = {
  "Algeria":      ["Algeria_on_the_globe_(Africa_centered).svg"],
  "Argentina":    ["Argentina_on_the_globe_(South_America_centered).svg"],
  "Austria":      ["Austria_on_the_globe_(Europe_centered).svg", "EU-Austria.svg"],
  "Belgium":      ["Belgium_on_the_globe_(Europe_centered).svg"],
  "Bosnia & Herzegovina": ["Bosnia_and_Herzegovina_on_the_globe_(Europe_centered).svg"],
  "Cape Verde":   ["Cape_Verde_on_the_globe_(Africa_centered).svg"],
  "Colombia":     ["Colombia_on_the_globe_(Americas_centered).svg", "Colombia_(orthographic_projection).svg"],
  "Croatia":      ["Croatia_on_the_globe_(Europe_centered).svg"],
  "Czech Republic": ["Czech_Republic_on_the_globe_(Europe_centered).svg", "EU-Czechia.svg"],
  "DR Congo":     ["Democratic_Republic_of_the_Congo_on_the_globe_(Africa_centered).svg"],
  "Egypt":        ["Egypt_on_the_globe_(Afro-Eurasia_centered).svg", "Egypt_on_the_globe_(Africa_centered).svg"],
  "Ghana":        ["Ghana_on_the_globe_(Africa_centered).svg"],
  "Iran":         ["Iran_on_the_globe_(Afro-Eurasia_centered).svg", "Iran_(orthographic_projection).svg"],
  "Iraq":         ["Iraq_on_the_globe_(Afro-Eurasia_centered).svg", "Iraq_(orthographic_projection).svg"],
  "Jordan":       ["Jordan_on_the_globe_(Afro-Eurasia_centered).svg", "Jordan_(orthographic_projection).svg"],
  "New Zealand":  ["New_Zealand_on_the_globe_(Polynesia_centered).svg", "New_Zealand_on_the_globe_(Oceania_centered).svg"],
  "Norway":       ["Norway_on_the_globe_(Europe_centered).svg", "EU-Norway.svg"],
  "Panama":       ["Panama_on_the_globe_(Americas_centered).svg", "PAN_orthographic.svg"],
  "Paraguay":     ["Paraguay_on_the_globe_(South_America_centered).svg"],
  "Saudi Arabia": ["Saudi_Arabia_on_the_globe_(Afro-Eurasia_centered).svg", "Saudi_Arabia_(orthographic_projection).svg"],
  "Senegal":      ["Senegal_on_the_globe_(Africa_centered).svg"],
  "South Korea":  ["South_Korea_on_the_globe_(Southeast_Asia_centered).svg", "South_Korea_on_the_globe_(Asia_centered).svg"],
  "Uruguay":      ["Uruguay_on_the_globe_(South_America_centered).svg"],
  "Uzbekistan":   ["Uzbekistan_on_the_globe_(Afro-Eurasia_centered).svg", "Uzbekistan_(orthographic_projection).svg"],
}

DRY_RUN_FIXTURES = [("Spain", "Cape Verde"), ("France", "Senegal")]

# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """You write one-line "Match Intel" notes for a World Cup TV-guide app. Each note is a single tongue-in-cheek paragraph comparing the GEOGRAPHY of the two nations playing — scale, latitude, terrain, coastlines, islands, deserts, elevation, hemisphere, position on the map. Dry, witty, factual. Football is never mentioned.

VOICE — study these eight real examples; match their register, structure and length exactly:

1. Haiti v Scotland: "Both occupy the rugged western/northern portion of a larger island, making this arguably a fixture between two mountainous edge-territories with strong coastal identities."
2. Qatar v Switzerland: "Qatar's highest natural point is lower than many Swiss villages, so this is basically sea-level peninsula football versus Alpine elevation football."
3. Australia v Turkey: "Both sit between major oceanic/cultural regions: Australia between the Indian and Pacific Oceans; Turkey between Europe, Asia, the Black Sea and the Mediterranean. Proper crossroads energy."
4. Brazil v Netherlands: "Brazil contains the Amazon basin; the Netherlands contains land that had to be argued back from the sea. One is vast river-world, the other is elite drainage engineering."
5. Germany v Curaçao: "Germany is the largest economy in central Europe, a landlocked mass of 357,000 km²; Curaçao is a 444 km² island in the southern Caribbean roughly the size of a medium German city district. The geographic disparity here is, statistically speaking, one of the most extreme at this World Cup."
6. Netherlands v Japan: "The Netherlands sits at sea level at the mouth of the Rhine delta, much of it below the North Sea waterline. Japan is a volcanic archipelago of 6,852 islands in the Pacific Ring of Fire. One country is defined by water it has reclaimed; the other by water it cannot control."
7. Ivory Coast v Ecuador: "Ivory Coast straddles the equatorial belt of West Africa on the Gulf of Guinea. Ecuador is literally named after the equator, which bisects it. Both nations sit within a few degrees of latitude zero — this may be the most equatorially proximate fixture of the group stage."
8. Sweden v Tunisia: "Sweden extends from the 55th to the 69th parallel north, reaching above the Arctic Circle. Tunisia's northernmost point is still further south than Sweden's southernmost city. They share essentially zero geographic overlap: one is a sub-Arctic peninsula, the other is the Mediterranean gateway to the Sahara."

RULES:
- Use ONLY the facts supplied in the user message. Do not add any figure, place, latitude, area, or claim that is not in the supplied facts. Never invent or estimate numbers.
- One paragraph, roughly 150–380 characters. No line breaks.
- Find the single most striking honest geographic contrast or similarity (scale gap, latitude gap, landlocked-vs-island, desert-vs-Arctic, equator proximity, hemisphere, crossroads position). Lead with it.
- Germany v Curaçao aside, do not claim a comparison is "the most extreme/proximate at this World Cup" unless the supplied facts clearly justify it.
- If the two fact sets do not support an accurate AND interesting geographic note, output exactly: THIN: <short reason> — do NOT pad with filler or football.
- Output ONLY the finished paragraph text (or the THIN line). No preamble, no quotation marks, no notes."""


def fixture_user_msg(t1, t2, f1, f2):
    def block(name, f):
        return (f"{name}\n"
                f"- area: {f['area']:,} km²\n"
                f"- capital: {f['capital']}\n"
                f"- latitude span: {f['lat']}\n"
                f"- geography: {f['notes']}")
    return (f"Write the Match Intel note for this fixture.\n\n"
            f"{block(t1, f1)}\n\n{block(t2, f2)}")


# ---------------------------------------------------------------------------
# Load existing state from the live index.html
# ---------------------------------------------------------------------------
def load_existing():
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    cm = re.search(r"const COUNTRY_MAPS = \{(.*?)\n\};", html, re.S).group(1)
    maps = dict(re.findall(r'"([^"]+)":\s*"(https[^"]+)"', cm))
    mi = re.search(r"const MATCH_INTEL = \{(.*?)\n\};", html, re.S).group(1)
    existing_intel = re.findall(r'"([^"|]+\|[^"]+)":', mi)
    return maps, set(existing_intel)


def named_fixtures():
    data = json.load(open(os.path.join(ROOT, "data", "matches.json")))
    out = []
    for m in data["matches"]:
        t1, t2 = m["team1"], m["team2"]
        if t1 in COUNTRY_FACTS and t2 in COUNTRY_FACTS:
            out.append((t1, t2))
    return out


# ---------------------------------------------------------------------------
# Map resolution (Wikimedia Commons, hash-free FilePath, verified)
# ---------------------------------------------------------------------------
def filepath_url(filename):
    return COMMONS_FILEPATH + urllib.parse.quote(filename) + f"?width={MAP_WIDTH}"


def resolves_to_image(url, retries=4):
    """True only on a genuine 200 image. 429 (rate limit) is retried with
    backoff and never reported as a miss; other errors are misses."""
    req = urllib.request.Request(url, headers={"User-Agent": "wc26-intel/1.0 (map check)"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                ct = r.headers.get("Content-Type", "")
                return (r.status == 200 and ct.startswith("image/")), ct
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 * (attempt + 1) + 1)   # polite backoff
                continue
            return False, f"HTTP {e.code}"
        except Exception as e:
            return False, str(e)
    return None, "429 (rate-limited after retries)"   # None = unknown, not a miss


def resolve_maps(nations, existing_maps):
    """Return (resolved {nation:url}, missing [nation,...]) for the given nations.
    Throttled to stay under Wikimedia rate limits; 429s are retried, not
    counted as misses."""
    resolved, missing = {}, []
    for nation in nations:
        if nation in existing_maps:
            resolved[nation] = existing_maps[nation]      # already live & working
            continue
        ok_url = None
        for cand in MAP_CANDIDATES.get(nation, []):
            url = filepath_url(cand)
            ok, info = resolves_to_image(url)
            tag = "OK " if ok else ("?? " if ok is None else "no ")
            print(f"    map {nation:22} {tag} {cand}  {info if not ok else ''}", file=sys.stderr)
            time.sleep(1.0)                               # be polite to Commons
            if ok:
                ok_url = url
                break
        if ok_url:
            resolved[nation] = ok_url
        else:
            missing.append(nation)
    return resolved, missing


# ---------------------------------------------------------------------------
# Intel generation via the Message Batches API
# ---------------------------------------------------------------------------
def generate_intel(fixtures):
    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    client = anthropic.Anthropic()   # reads ANTHROPIC_API_KEY from env
    # custom_id must match ^[a-zA-Z0-9_-]{1,64}$ — slugify and map back.
    slug_to_key = {}
    requests = []
    for i, (t1, t2) in enumerate(fixtures):
        key = f"{t1}|{t2}"
        cid = f"fx{i:03d}"
        slug_to_key[cid] = key
        requests.append(Request(
            custom_id=cid,
            params=MessageCreateParamsNonStreaming(
                model=MODEL,
                max_tokens=512,
                system=[{"type": "text", "text": SYSTEM_PROMPT,
                         "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user",
                           "content": fixture_user_msg(t1, t2,
                                                       COUNTRY_FACTS[t1], COUNTRY_FACTS[t2])}],
            ),
        ))

    batch = client.messages.batches.create(requests=requests)
    print(f"  batch {batch.id} created with {len(requests)} request(s); polling…", file=sys.stderr)
    while True:
        batch = client.messages.batches.retrieve(batch.id)
        if batch.processing_status == "ended":
            break
        rc = batch.request_counts
        print(f"    status={batch.processing_status} "
              f"processing={rc.processing} succeeded={rc.succeeded} errored={rc.errored}",
              file=sys.stderr)
        time.sleep(15)

    results, usage = {}, {"in": 0, "cache_w": 0, "cache_r": 0, "out": 0}
    for res in client.messages.batches.results(batch.id):
        cid = slug_to_key[res.custom_id]
        if res.result.type != "succeeded":
            results[cid] = {"error": res.result.type}
            continue
        msg = res.result.message
        text = "".join(b.text for b in msg.content if b.type == "text").strip()
        u = msg.usage
        usage["in"] += u.input_tokens
        usage["cache_w"] += getattr(u, "cache_creation_input_tokens", 0) or 0
        usage["cache_r"] += getattr(u, "cache_read_input_tokens", 0) or 0
        usage["out"] += u.output_tokens
        results[cid] = {"text": text}
    return results, usage


def cost_estimate(u):
    # Batches = 50% of standard. Opus 4.8 standard: $5 in / $25 out per 1M.
    IN, CW, CR, OUT = 2.50, 2.50 * 1.25, 2.50 * 0.10, 12.50  # per 1M tokens
    c = (u["in"] * IN + u["cache_w"] * CW + u["cache_r"] * CR + u["out"] * OUT) / 1_000_000
    return c


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------
def run(fixtures, label):
    existing_maps, existing_intel = load_existing()
    nations = sorted({n for fx in fixtures for n in fx})
    print(f"[{label}] {len(fixtures)} fixture(s), {len(nations)} nation(s)\n", file=sys.stderr)

    print("  resolving maps…", file=sys.stderr)
    maps, missing_maps = resolve_maps(nations, existing_maps)

    print("\n  generating intel via Batches API…", file=sys.stderr)
    results, usage = generate_intel(fixtures)

    intel, thin = {}, []
    for t1, t2 in fixtures:
        cid = f"{t1}|{t2}"
        r = results.get(cid, {})
        if "error" in r:
            thin.append({"fixture": cid, "reason": f"API {r['error']}", "text": ""})
            continue
        text = r["text"]
        if text.startswith("THIN:"):
            thin.append({"fixture": cid, "reason": text[5:].strip(), "text": ""})
            continue
        intel[cid] = [{"k": "Map", "t": text}]
        if len(text) < THIN_MIN_CHARS:
            thin.append({"fixture": cid, "reason": f"short ({len(text)} chars)", "text": text})

    out = {
        "label": label,
        "model": MODEL,
        "fixtures_total": len(fixtures),
        "intel": intel,
        "new_maps": {n: u for n, u in maps.items() if n not in existing_maps},
        "thin_report": thin,
        "missing_map_report": missing_maps,
        "usage_tokens": usage,
        "cost_usd_batches": round(cost_estimate(usage), 4),
    }
    path = os.path.join(ROOT, f"intel_{label}.json")
    json.dump(out, open(path, "w"), indent=2, ensure_ascii=False)
    print(f"\n  wrote {path}", file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="2 fixtures: Spain|Cape Verde, France|Senegal")
    g.add_argument("--full", action="store_true", help="all named-nation fixtures")
    g.add_argument("--maps-only", metavar="JSON", help="re-resolve maps (no API spend) and patch the map sections of an existing intel JSON")
    args = ap.parse_args()

    if args.maps_only:
        # Cheap path: re-resolve maps for all 48 with throttling, rewrite the
        # new_maps / missing_map_report keys in an existing intel file.
        existing_maps, _ = load_existing()
        nations = sorted(COUNTRY_FACTS)
        maps, missing = resolve_maps(nations, existing_maps)
        out = json.load(open(args.maps_only))
        out["new_maps"] = {n: u for n, u in maps.items() if n not in existing_maps}
        out["missing_map_report"] = missing
        json.dump(out, open(args.maps_only, "w"), indent=2, ensure_ascii=False)
        print(json.dumps({"new_maps": out["new_maps"], "missing_map_report": missing}, indent=2, ensure_ascii=False))
        return

    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")

    if args.dry_run:
        out = run(DRY_RUN_FIXTURES, "dryrun")
    else:
        out = run(named_fixtures(), "full")

    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
