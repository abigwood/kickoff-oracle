# THE WINDOW — backend Worker

Cloudflare Worker + Workers KV powering the mates' score-prediction league.
Free tier (100k requests/day). The Worker is the **only** writer to KV, and it
does the **server-side window check** — the client clock is never trusted.

## What's here

- `src/logic.js` — pure scoring/window logic (no runtime deps). The integrity core.
- `src/worker.js` — request routing, KV access, CORS, server-side window enforcement.
- `test/` — `node --test` suite. Runs with zero install, no Cloudflare account:
  ```
  cd worker && node --test
  ```
  Covers the window edges (KO−61 reject, KO−59 accept, KO+1 reject, no post-shut
  swap), scoring (3 exact / 1 result / 0), multi-league standings, reveal gating.

## Endpoints (JSON; CORS pinned to the Pages origin)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/league` | `{uid, nickname, name?}` | create; returns `{code}` |
| POST | `/join` | `{uid, nickname, code}` | adds uid↔league |
| POST | `/pick` | `{uid, nickname?, matchId, s1, s2}` | **server-side window check**; rejects outside [KO−60m, KO) |
| GET | `/picks` | `?code&matchId` | 403 while window open, full reveal once shut |
| GET | `/table` | `?code` | standings (cached ≤60s) |
| GET | `/state` | `?code` | aggregate for the UI: `{name, table, reveals}` |
| POST | `/settle` | `{secret}` | secret-gated; recomputes every league's table cache |

Scoring (final, per Adam): 🎯 exact = 3, correct result = 1, miss = 0. No bankers.

## Deploy (needs a free Cloudflare account)

```bash
cd worker
npx wrangler login                               # opens browser; Adam authorises
npx wrangler kv namespace create WINDOW          # prints an id …
npx wrangler kv namespace create WINDOW --preview #   … and a preview id
#   → paste both ids into wrangler.toml (id / preview_id)
npx wrangler secret put SETTLE_SECRET            # paste a long random string; reuse it as the GitHub Actions secret
npx wrangler deploy                              # prints the live Worker URL
```

Then, to go live on the site:
1. Set `window.WC_API = "<worker url>"` in `index.html` (a `<script>` before the main script). With it unset the app stays in self-contained DEMO mode.
2. Add the same secret as GitHub Actions secret `SETTLE_SECRET`; the refresh Action pings `POST /settle` after each data build so tables update when matches finish.

`MATCHES_URL` and `ALLOWED_ORIGIN` in `wrangler.toml` are already set to this
repo's Pages site — change them if the repo/owner changes.
