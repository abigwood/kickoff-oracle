#!/usr/bin/env python3
"""
harvest_photos.py — pull free-licensed player photos from Wikipedia/Commons.

Run on a machine with open internet (Mac mini / Claude Code), NOT in a
sandbox. For every player in data/squads.json it:
  1. Batch-queries the Wikipedia API (50 titles/call) for each article's
     lead image thumbnail (prop=pageimages).
  2. Queries Commons for that file's licence + author (prop=imageinfo,
     iiprop=extmetadata).
  3. KEEPS the photo only if the licence is free (CC BY / CC BY-SA /
     public domain). Non-free fair-use images are skipped — the album's
     drawn bust is the fallback, by design.
  4. Downloads thumbnails to img/players/<slug>.jpg (so the live site
     never hotlinks) and writes photo + credit into squads.json, then
     regenerates data/squads.js.

Usage: python3 harvest_photos.py [Team ...]   (default: all teams with players)

Attribution is rendered on each sticker's flip side — required by CC
licences and already wired up in album.html.
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
SQ = ROOT / "data" / "squads.json"
IMG = ROOT / "img" / "players"
API = "https://en.wikipedia.org/w/api.php"
UA = {"User-Agent": "KickOffOracle/1.0 (personal World Cup app; contact via repo)"}
FREE = re.compile(r"(cc[- ]by|public domain|pd-|cc0)", re.I)

# Add disambiguated Wikipedia titles here when a plain name misses or
# lands on the wrong person. NEVER guess blindly — verify the article.
TITLE_OVERRIDES = {
    "Reece James": "Reece James (footballer, born 1999)",
    "Elliot Anderson": "Elliot Anderson (footballer, born 2002)",
    "Morgan Rogers": "Morgan Rogers (footballer, born 2002)",
    "Anthony Gordon": "Anthony Gordon (footballer, born 2001)",
    "Dean Henderson": "Dean Henderson",
}


def api(params):
    params.update({"format": "json", "redirects": 1})
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def main():
    data = json.loads(SQ.read_text())
    teams = sys.argv[1:] or [t for t, v in data["teams"].items() if v["players"]]
    IMG.mkdir(parents=True, exist_ok=True)

    for team in teams:
        players = data["teams"][team]["players"]
        titles = [TITLE_OVERRIDES.get(p["name"], p["name"]) for p in players]
        by_title = {}

        for i in range(0, len(titles), 50):
            chunk = titles[i:i + 50]
            res = api({"action": "query", "titles": "|".join(chunk),
                       "prop": "pageimages", "piprop": "thumbnail|name",
                       "pithumbsize": 480})
            redirect = {r["to"]: r["from"] for r in res["query"].get("redirects", [])}
            for page in res["query"]["pages"].values():
                t = redirect.get(page.get("title"), page.get("title"))
                if "thumbnail" in page:
                    by_title[t] = {"thumb": page["thumbnail"]["source"],
                                   "file": "File:" + page["pageimage"]}
            time.sleep(0.5)

        # licence + author per image file
        files = sorted({v["file"] for v in by_title.values()})
        meta = {}
        for i in range(0, len(files), 50):
            res = api({"action": "query", "titles": "|".join(files[i:i + 50]),
                       "prop": "imageinfo", "iiprop": "extmetadata"})
            for page in res["query"]["pages"].values():
                try:
                    em = page["imageinfo"][0]["extmetadata"]
                    meta[page["title"]] = {
                        "license": em.get("LicenseShortName", {}).get("value", ""),
                        "artist": re.sub(r"<[^>]+>", "", em.get("Artist", {}).get("value", "")).strip(),
                    }
                except (KeyError, IndexError):
                    pass
            time.sleep(0.5)

        kept = skipped = 0
        for p, title in zip(players, titles):
            hit = by_title.get(title)
            if not hit:
                continue
            m = meta.get(hit["file"], {})
            if not FREE.search(m.get("license", "")):
                skipped += 1
                continue  # non-free image: bust fallback stays
            dest = IMG / f"{slug(p['name'])}.jpg"
            req = urllib.request.Request(hit["thumb"], headers=UA)
            dest.write_bytes(urllib.request.urlopen(req, timeout=30).read())
            p["photo"] = f"img/players/{dest.name}"
            p["credit"] = f"{m.get('artist', 'Wikimedia Commons')} · {m['license']}"
            kept += 1
            time.sleep(0.3)
        print(f"{team}: {kept} photos, {skipped} skipped (non-free), "
              f"{len(players) - kept - skipped} no image -> drawn bust")

    SQ.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    (ROOT / "data" / "squads.js").write_text(
        "window.WC_SQUADS = " + SQ.read_text() + ";")
    print("squads.json + squads.js updated.")


if __name__ == "__main__":
    main()
