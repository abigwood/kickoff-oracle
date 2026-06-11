# KickOff Oracle — World Cup 2026 UK TV Guide

Every match, UK kick-off time, and which channel (BBC/ITV) it's on. Plus live
group tables, the knockout bracket, England's route to the final, clash alerts,
late-night "worth staying up?" tags and one-tap calendar reminders.

Free to run: static site + a 15-minute GitHub Action. No servers, no paid APIs.

## Run locally
Open `index.html` in a browser — it works straight from the file.
To refresh data: `python3 build.py` (needs Python 3.9+, stdlib only).

## Deploy free
Push to a public GitHub repo → enable GitHub Pages → enable Actions.
See HANDOFF.md for the full guide and v2 roadmap.

Data: openfootball (public domain). Channels: published BBC/ITV schedules —
always double-check on the day; broadcasters can reshuffle.
