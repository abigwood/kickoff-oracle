# HANDOFF — World Cup 2026 UK TV Guide ("KickOff Oracle")

Read this first. You are continuing a build started in a Claude.ai chat session.
The owner is Adam. Goal: a free-to-build, free-to-run, iPhone-optimised browser
app showing every WC26 match with UK kick-off time and BBC/ITV channel, plus
groups, bracket, England view — and in v2, value bets and availability.

## What exists and works (v1, built 11 June 2026)

- `index.html` — single-file app, mobile-first, no build step, no frameworks.
  Tabs: Today (countdown hero + today's matches), Fixtures (team filter),
  Groups (12 live-computed tables), Bracket (horizontal scroll, R32→Final),
  England (fixtures + route-to-final channel map + v2 placeholder).
  Features: BBC/ITV channel chips, LIVE badge, 🌙 "Late one" tag with a
  1–3 dot worth-staying-up score, ⚡ clash detector for simultaneous kick-offs,
  per-match ＋ button that downloads an .ics calendar event.
- `build.py` — fetches openfootball feed (public domain), converts kick-offs
  to Europe/London, merges the GROUP_CHANNELS map (all 72 group games,
  verified against published BBC/ITV schedules), computes standings, writes
  `data/matches.json` AND `data/matches.js` (the .js twin makes the app work
  opened as a local file; the app then fetch-refreshes from the .json when hosted).
- `.github/workflows/refresh.yml` — cron every 15 min, runs build.py, commits
  data if changed. Free on a public repo.
- Data verified: 104 matches, all group channels present, UK times spot-checked
  (Mexico v South Africa 20:00 ITV1; England v Croatia 17 Jun 21:00 ITV1 ✓).

## Deploy (do this first, ~5 min)

1. `git init && git add -A && git commit -m "v1"` then push to a new PUBLIC
   GitHub repo (public = free Actions minutes + free Pages).
2. Settings → Pages → deploy from branch `main`, root. App is live at
   `https://<user>.github.io/<repo>/`.
3. Actions tab → enable workflows → run "Refresh match data" once manually.
4. On iPhone: open in Safari → Share → Add to Home Screen.

## v2 backlog (priority order)

1. **"THE WINDOW" — mates' score-prediction league. BUILD THIS FIRST.**
   Concept: for every match, a prediction window opens at kick-off minus 60
   minutes (when line-ups drop) and slams shut at kick-off. Players predict
   the exact score inside the window only. Picks are hidden until the window
   shuts, then revealed to the whole league simultaneously. A running league
   table updates automatically as results land.

   **Architecture (free):** Cloudflare Worker + Workers KV, free tier
   (100k req/day — far beyond a mates' league). No accounts: a league is a
   generated 6-char code shared in the group chat; each player sets a
   nickname (kept in localStorage — fine on the deployed site, but never
   rely on localStorage inside claude.ai artifact previews). The static app
   calls the Worker; the Worker is the only writer to KV.

   **MULTI-LEAGUE (Adam requirement, final): a player can be in any
   number of leagues at once (mates league + bros league + ...), each
   with its own 6-char entry code, all running simultaneously. A player
   predicts each match ONCE; that single pick scores in every league
   they belong to. The UI league switcher is already built (pills at the
   top of the League tab, plus Join/Create which prompts for a code).**

   **KV data model (multi-league):**
   - `user:{uid}` → {nickname, leagues: [code...]}   (uid = device-generated
     ID in localStorage; nickname set on first join. Simple identity is
     fine for mates — note in UI that clearing Safari data loses identity;
     a "recovery word" is a nice-to-have, not a blocker)
   - `league:{code}` → {name, created, members: [uid...]}
   - `picks:{matchId}` → {uid: {s1, s2, ts}}          (ONE pick per user
     per match, global — NOT per league)
   - `table:{code}` → computed standings cache
   /pick stores once; /settle recomputes every league containing that uid.
   /join adds uid to league.members and code to user.leagues.

   **Worker endpoints (JSON, CORS-allow the Pages origin only):**
   - POST /league → create, returns {code}
   - POST /join {code, nickname}
   - POST /pick {code, nickname, matchId, s1, s2, banker?}
     → SERVER-SIDE window check: Worker loads matches.json from the Pages
     site (cache ~5 min), rejects unless now ∈ [KO−60m, KO). This is the
     integrity core — never trust the client clock.
   - GET /picks?code&matchId → 403 while window open (picks stay hidden),
     full reveal once shut.
   - GET /table?code → standings.
   - POST /settle {results} (shared secret via Actions secret) → recompute
     tables; called by build.py in the existing 15-min Action when matches
     finish.

   **Scoring — SIMPLE, per Adam (final):**
   - 🎯 Exact score: 3 points.
   - Correct result (W/D/L): 1 point.
   - Missed window: 0 points. No bankers, no multipliers, no odds-based
     scoring — Adam explicitly stripped these. Do not reintroduce.
   - Highest total at the end of the tournament wins.

   **UI: ALREADY BUILT (11 June, late session)** — League tab, score
   steppers, banker toggle, lock-in with hidden-until-shut state, window
   countdown, reveal strips, league table, invite share button. Currently
   in DEMO mode (mock league "THE BANTER CUP", picks held in-memory).
   To go live: deploy the Worker, then set `window.WC_API = "<worker url>"`
   before the main script and replace the demo LEAGUE const with fetched
   data + complete the fetch() calls at the marked comment.
   Reveal cards (built): each reveal block has a "Share reveal card"
   button - client-side canvas generates a 1080x1350 PNG of everyone's
   picks and fires the iOS share sheet (navigator.share with files;
   falls back to download). When the Worker is live, also surface this
   button on match cards the moment a window shuts.
   Original UI spec for reference:
   - Match card: window open → "WINDOW OPEN · shuts in 14:32" countdown +
     two score steppers + banker toggle. Before: "Window opens at 13:05".
     After KO: reveal strip showing everyone's picks side by side.
   - New "League" tab: create/join, table (Pts, exact scores, bankers hit,
     streak), latest reveal feed. Nav is at 6 tabs — fold League into Stats
     or replace England with a configurable "My Team" to stay at 6.
   - "Invite mates" → share sheet with ?league=CODE link.

   **Build order:** Worker + KV first (wrangler CLI, free Cloudflare
   account — Adam to create/login), then UI, then /settle in the Action.
   Test the window edges: pick at KO−61 (reject), KO−59 (accept),
   KO+1 (reject), and a banker swap attempt after shut (reject).

2. **DONE in v1.1 (11 June, late session): Telly Supercomputer + Golden Boot.**
   build.py now seeds Elo ratings for all 48 teams (top teams from the
   published Jan 2026 eloratings.net table, the rest estimated), updates Elo
   from real results (K=60, goal-diff multiplier, +100 host bonus at MEX/CAN
   venues), runs 4,000 Monte Carlo tournament sims (group sims respect real
   results; thirds assigned to bracket slots greedily within FIFA's allowed
   group sets), and outputs `predictions` + per-match `matchProbs` + `scorers`
   (parsed from feed `goals1/goals2`, own goals excluded). The app has a Stats
   tab and win/draw/win strips on upcoming match cards.
   Remaining tuning: (a) refresh all 48 Elo seeds from eloratings.net,
   (b) calibration — Elo→goals exponent is d/1100; sanity-check the favourite's
   win % against published supercomputers and tune toward ~/1200 if still hot,
   (c) thirds assignment could use full backtracking instead of greedy,
   (d) standings tiebreakers are pts/GD/GF only.
3. **Knockout channels.** As BBC/ITV announce picks after the group draw,
   add entries to `KNOCKOUT_CHANNELS` in build.py (key = UK "YYYY-MM-DD HH:MM").
   Could automate by scraping, but manual is fine — ~32 entries over 3 weeks.
4. **Value bet finder.** Sources: The Odds API (free tier, 500 credits/month —
   Adam to create free key, store as GitHub Actions secret `ODDS_API_KEY`) for
   bookmaker odds; Opta supercomputer match probabilities are published free
   on theanalyst.com. In build.py: implied prob = 1/decimal odds (normalise
   the overround); flag where model prob exceeds implied prob by >3pts.
   Budget: refresh odds max 4×/day to stay inside 500 credits. Render as a
   "Value" tab. Include a clear "information, not betting advice" note.
5. **Availability tracker.** BALLDONTLIE FIFA WC API (free key) has rosters,
   lineups, events. Track yellow cards → one-from-suspension list per team;
   show confirmed line-ups/formations ~60 min before KO on the match card.
6. **Highlights (BUILT tonight, needs channel IDs).** FT match cards show
   a goal timeline (scorer, minute, pens/OGs — parsed from the feed) and,
   when data/highlights.json has a video for that match, a "Watch official
   highlights" button that lazy-loads a youtube-nocookie EMBED of the
   broadcaster's own upload. find_highlights.py auto-matches uploads to
   fixtures via free channel RSS feeds and runs in the 15-min Action.
   ONE-TIME TASK: fill CHANNELS in find_highlights.py with the verified
   official BBC Sport / ITV Sport / FIFA channel IDs (never unofficial
   re-upload channels). RIGHTS: embed only — never download/re-host;
   embed-disabled videos auto-fall back to a Watch-on-YouTube tap-out.
   Legacy idea superseded by this: goals deep-links. On FT matches, link to the BBC Sport / ITVX match
   page (don't host clips — rights). URL pattern can be scraped or constructed.
7. **Service worker** for offline + faster loads (cache index.html + data,
   stale-while-revalidate).
8. **Push notifications** are NOT free/simple on iOS web apps — skip; the
   .ics calendar export covers reminders.
9. **The Album (album.html — Panini-style squad pages, shipped tonight).**
   England's confirmed 26 is seeded in data/squads.json; the other 47 teams
   show "Pack not opened". v2 tasks: (a) ingest all squads from the Sky
   Sports squad-lists article or Wikipedia "2026 FIFA World Cup squads"
   (name, position, club per player) into squads.json + regenerate the
   squads.js twin; (b) add real shirt numbers (announced per federation —
   never guess them); (c) fill the GROUPS map in album.html for all 48.
   PHOTOS: run `python3 harvest_photos.py` (needs open internet — fine on
   the Mac mini, NOT in sandboxes). It batch-queries Wikipedia for each
   player's lead image, keeps only free licences (CC BY / CC BY-SA / PD),
   downloads to img/players/ and writes photo + credit into squads.json.
   Attribution renders on the sticker's flip side — keep it, it's a CC
   requirement. Add disambiguation entries to TITLE_OVERRIDES for any
   wrong-person hits (verify each). Kane currently carries a watermarked
   SAMPLE image demonstrating layout — the harvest replaces it.
   MARKET VALUES: sticker backs link out to each player's Transfermarkt
   page (quick-search URL by name). LINK ONLY — do not scrape or store
   Transfermarkt valuations; their data is proprietary editorial content
   and their ToS prohibit it. If Adam wants richer per-player flavour,
   build "sticker rarity" tiers (gold/silver/base) from caps + goals in
   the squad data instead — that data is freely sourced from Wikipedia.
   RIGHTS NOTE: beyond Commons, do NOT add real player photos — headshots are Getty/FIFA
   licensed and Panini's designs are their IP. The drawn-bust homage is the
   point; keep it.
10. **AGGREGATION PACK (Adam-approved, all free + legal — build in this
   order):**
   a. LINE-UPS + REFEREE at KO-60: BALLDONTLIE FIFA API (free key, Adam
      creates, store as Actions secret). Show confirmed XI + formation +
      referee on the match card the hour before kick-off — pairs with
      The Window opening. Facts only, freely provided by the API.
   b. STADIUM WEATHER: Open-Meteo API (genuinely free, NO key needed).
      Action fetches forecast per venue per matchday; card shows temp +
      conditions at kick-off local time. 16 stadiums — hardcode coords.
   c. PRESS CONFERENCES: extend find_highlights.py with a second matcher
      tagging "press conference" / "media day" uploads from official
      FIFA + federation YouTube channels (same RSS feeds, embed-only,
      official channels only).
   d. PODCASTS: a Listen section reading public podcast RSS feeds (open
      syndication by design). Episode list + native <audio> player
      streaming the feed's own enclosure URLs — never download/re-host.
      Start with 2-3 feeds Adam picks.
   e. TEAM NEWS HEADLINES: per-team strip from BBC Sport / Google News
      RSS — headline + link OUT only; never reproduce article text.
   f. RADIO LINKS: static "BBC 5 Live" link on live match cards.
   All six follow the highlights principle: embed or link what is
   officially syndicated; copy nothing.
11. Nice-to-haves: kits/badges from TheSportsDB (free), stadium info sheet,
   third-place permutation explainer for Matchday 3.

## Match Intel — auto-generation (`tools/gen_intel.py`, added 15 Jun 2026)

The MATCH_INTEL geography cards + COUNTRY_MAPS in index.html are generated by
`tools/gen_intel.py` — a MANUAL one-off, never wired to the cron. Needs
ANTHROPIC_API_KEY in the env; uses claude-opus-4-8 via the Batches API, grounded
only in the curated COUNTRY_FACTS table in the script (it never invents figures;
weak fixtures are flagged thin, not padded). First run (15 Jun) did the 72
group-stage fixtures + maps for all 48 nations; the 32 knockout matches were
still placeholders. **Once the bracket fills, re-run `python tools/gen_intel.py
--full`** to generate the remaining ~32 (existing fixtures auto-skip), then
deploy per the usual fresh-origin/main-worktree procedure (bump __BUILD + sw.js
VERSION). See the operational note at the top of the script.

## Service Worker / PWA update path (RESOLVED 13 Jun 2026)

The one-launch update is solved and verified live. Every deploy now reaches
users on their next single app-open (and mid-session if the app is left open).

How it works (`sw.js` + the registration block in `index.html`):
- `sw.js` bumps `VERSION` per deploy → new shell/runtime caches.
- **install precaches with `cache:"reload"`** — this was the missing piece.
  Without it, `cache.add()` pulled `index.html` from the browser HTTP cache, so
  a new SW version cached the STALE page and "updates" silently carried old
  content even though the SW version bumped. `cache:"reload"` forces a network
  fetch so the new shell holds the FRESH page.
- install does NOT call `skipWaiting()`. Instead the page postMessages
  `{type:"SKIP_WAITING"}` once its `controllerchange` listener is wired
  (gated by an `updateTriggered` flag) — this makes the takeover race-free
  rather than letting the browser's eager on-navigation activation beat the
  page's listener.
- `activate` deletes old-version caches then `clients.claim()`.
- page registers with `updateViaCache:"none"`, applies the update on
  `updatefound→statechange==="installed"` (and on an existing `reg.waiting`),
  re-checks via `reg.update()` on visibilitychange + a 30-min interval, and
  reloads once on `controllerchange`. That single reload is BOTH the one-launch
  update and the "new SW took over mid-session → quietly re-render" behaviour.

Verified with headless Chrome (persistent profile): install on vN, deploy vN+1,
a single page relaunch lands on vN+1 within ~3s (precache → activate → reload).
The `window.__BUILD` string in index.html is a deliberate build marker (lets you
confirm a deploy actually reached a device); keep bumping it with `VERSION`.

Earlier dead-ends (don't repeat): `hadController` guard (controller null on
uncontrolled first nav), async `getRegistration()` guard (resolved after
controllerchange fired), `localStorage` sync guard (doesn't flush on abrupt
kill), and unconditional `skipWaiting` (browser activated before the page
listener attached). Root cause of all the "SW bumped but content stale" symptoms
was the stale precache, not the reload timing.

## Constraints — do not break these

- £0 hard costs. No paid APIs, no servers. Static hosting + GitHub Actions only.
- All user traffic hits static files only; APIs are touched solely by the
  15-min Action. Never call rate-limited APIs from the client.
- Keep index.html dependency-free (one Google Font is the only external asset).
- openfootball is the source of truth for fixtures/results; be defensive about
  score field shapes (`score1/score2` or nested `score.ft`).

## Known gaps / honesty notes

- Channel data is from published schedules; broadcasters occasionally reshuffle
  — the README carries a "double-check on the day" note. Keep it.
- The "worth staying up" stars are a v1 heuristic (stage + marquee team +
  final group matchday). Replace with odds-tightness once Odds API is wired in.
- Standings tiebreakers implement pts/GD/GF only; FIFA's full rules add
  head-to-head, fair play and drawing of lots — fine for v1, note in v2.
- BALLDONTLIE FIFA results are wired but UNVERIFIED: Adam hasn't created the
  key yet. `build.py:fetch_balldontlie_results` is key-gated (env
  `BALLDONTLIE_KEY`, base overridable via `BALLDONTLIE_BASE`); the exact
  endpoint path and score field mapping need confirming against a live key
  before trusting it as primary. Until then Wikipedia fallback + openfootball
  cover results.
