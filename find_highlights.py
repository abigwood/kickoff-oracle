#!/usr/bin/env python3
"""
find_highlights.py — match official YouTube highlight uploads to fixtures.

Uses YouTube channel RSS feeds (free, no API key): each feed lists a
channel's latest ~15 uploads with titles. We match titles to finished
fixtures (both team names present) and store the video ID, which the app
renders as a standard YouTube EMBED of the broadcaster's own upload.

RIGHTS: embed only — never download, re-host or proxy the video. If a
channel disables embedding, YouTube's player automatically shows a
"Watch on YouTube" link instead, which is an acceptable fallback.

SETUP (one-time): fill in verified official channel IDs below. Verify
you have the official broadcaster channels — do not add unofficial
re-upload channels.

Run by the GitHub Action after build.py.
"""

import json
import re
import urllib.request
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).parent
CHANNELS = {
    "NBC Sports": "UCqZQlzSHbVJrwrn5XvzrzcA",
}
MANUAL_OVERRIDES = {
    # BBC Football upload is UK-playable; the FOX upload auto-matched for this
    # match is region-blocked in the UK YouTube embed.
    "8": "hcefv-X6Z7I",
}
RSS = "https://www.youtube.com/feeds/videos.xml?channel_id={}"
NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}

ALIASES = {  # name variants that appear in video titles
    "USA": ["usa", "united states"], "South Korea": ["south korea", "korea republic"],
    "Ivory Coast": ["ivory coast", "cote d'ivoire", "côte d'ivoire"],
    "Bosnia & Herzegovina": ["bosnia"], "Czech Republic": ["czech republic", "czechia"],
    "Turkey": ["turkey", "turkiye", "türkiye"], "DR Congo": ["dr congo", "congo dr"],
}


def names(team):
    return ALIASES.get(team, [team.lower()])


def main():
    data = json.loads((ROOT / "data" / "matches.json").read_text())
    done = [m for m in data["matches"] if m["status"] == "FT"]
    if not done or not CHANNELS:
        print("Nothing to do (no FT matches or no channel IDs configured).")
        return

    out_file = ROOT / "data" / "highlights.json"
    found = json.loads(out_file.read_text()) if out_file.exists() else {}
    found.update(MANUAL_OVERRIDES)

    videos = []
    for label, cid in CHANNELS.items():
        try:
            with urllib.request.urlopen(RSS.format(cid), timeout=30) as r:
                tree = ElementTree.parse(r)
            for e in tree.findall("a:entry", NS):
                videos.append({
                    "id": e.find("yt:videoId", NS).text,
                    "title": e.find("a:title", NS).text.lower(),
                    "channel": label,
                })
        except Exception as ex:
            print(f"{label}: feed failed ({ex})")

    for m in done:
        if str(m["id"]) in found:
            continue
        hl = re.compile(r"\b(highlights?|hls?)\b", re.I)
        for v in videos:
            if (any(n in v["title"] for n in names(m["team1"]))
                    and any(n in v["title"] for n in names(m["team2"]))
                    and hl.search(v["title"])):
                found[str(m["id"])] = v["id"]
                print(f'Matched {m["team1"]} v {m["team2"]} -> {v["channel"]} {v["id"]}')
                break

    out_file.write_text(json.dumps(found, indent=1) + "\n")
    print(f"{len(found)} highlight(s) stored.")


if __name__ == "__main__":
    main()
