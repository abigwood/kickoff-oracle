# REPO-STATE.md — KickOff Oracle source consolidation audit

**Date:** 2026-06-17 · **Status:** ✅ EXECUTED — consolidation complete (approved & run 2026-06-17).
**Scope guardrails honoured:** git/source only (NO Cloudflare KV / user data touched), £0, integrity logic untouched.

## ▶ NEXT-TASK HANDOFF — `/mine` + `hydratePicks` is the STARTING POINT for the identity root-cause fix
The pick-hydration-after-restore feature in commit `a850074` was **archived, not revived** (this task), but it is **part of the upcoming identity root-cause fix and must be picked up there, integrity-reviewed, not lost.** Restore it from any of:
- tag **`preserve/mine-hydration`** · branch **`archive/local-main-pre-reset`** · patch **`~/kickoff-oracle-backups/0001-Add-match-highlight-embed.patch`**
Why it matters: after a restore/reinstall a device's locked picks look gone until KO; `GET /mine?uid=` (caller proves its own uid → reveals only its own picks, leaks nothing) lets the client `hydratePicks()` rehydrate immediately. Integrity note for that task: it is **read-only of the caller's own picks** — confirm it does not weaken the KO lock / fail-closed window / anti-backfill gate before shipping.

---

## 1. Inventory

| Ref / worktree | Path | HEAD | `__BUILD` / `sw` | Last commit | vs `origin/main` |
|---|---|---|---|---|---|
| **origin/main** | remote (GitHub) | `1e75181` | **v49** / **v49** | `data refresh 2026-06-17 13:02` | **source of truth** |
| local **main** | `~/Projects/wc26` | `a850074` | v14 / v16 | `Add match highlight embed` | **ahead 1, behind 1361** |
| `match-intel-v31` | `/private/tmp/kickoff-oracle-match-intel` | `2c9a1f9` | v34 / v34 | `Add Intel WhatsApp share` | ancestor (captured) |
| (detached) | `/private/tmp/kickoff-oracle-live` | `79454c2` | v23 / v23 | `Restore Qatar Switzerland highlights` | ancestor (captured) |
| (detached) | `/private/tmp/wc26-intel` | `b94f6ad` | v45 / v45 | `data refresh 2026-06-15 12:18` | ancestor (captured) |
| **LIVE Pages** | abigwood.github.io/kickoff-oracle | — | **v49** | — | **== origin/main** |
| **LIVE Worker** | kickoff-oracle-window…workers.dev | — | — | — | **deployed from origin/main** |

Local main diverged from origin at merge-base `cbb952a`; origin has since advanced **1361** commits.

## 2. Source-of-truth confirmation (re-confirmed)

- **GitHub Pages == `origin/main`.** Live `index.html`/`sw.js` both report `__BUILD/VERSION = v49-2026-06-16`, byte-identical to `origin/main`. Pages serves `main` root.
- **Cloudflare Worker == `origin/main`.** Deployed from fresh `origin/main` worktrees this week; live behaviour matches `origin/main` source exactly: tiered scoring with **exact = 5** (commit `1afe58d`), ESPN result auto-fill (France v Senegal 16 Jun, no manual override), `joinedAt` anti-backfill gating, recovery-code identity. `/health` → `{ok:true}`. **No KV read/write performed for this audit.**

## 3. Feature presence on `origin/main` (v49) — all ✅ captured

| Feature | Present on origin/main |
|---|---|
| Live ESPN scores (client overlay) | ✅ index.html |
| ESPN result fallback (build pipeline) | ✅ build.py `fetch_espn_results` |
| Two-column live scorers | ✅ index.html |
| Match Intel + COUNTRY_MAPS (48 maps, direct URLs) | ✅ index.html |
| Tiered scoring (exact 5 / draw 2 / winner+GD 2 / winner 1 / 0) | ✅ worker/src/logic.js |
| Identity / recovery-code system | ✅ worker/src/worker.js |
| `joinedAt` anti-backfill gating | ✅ worker/src/worker.js |
| Match highlight embed (youtube-nocookie) | ✅ index.html |
| PWA one-launch SW (`cache:"reload"`) | ✅ sw.js |

## 4. ⚠️ AT-RISK — the one thing NOT in origin/main

**Local commit `a850074` contains a `/mine` worker endpoint (`getMine`) + client `hydratePicks()` — unique to local main, never pushed, never deployed.**

- What it does: after a restore/reinstall, the device fetches **its own** locked picks (`GET /mine?uid=…`, gated by the caller's own uid — reveals nothing about rivals) to rehydrate its local cache, so locked picks don't look gone until KO. Directly relevant to the identity/restore churn handled all week.
- Confirmed unique: `getMine` = 0 on origin/main and on all three other worktrees; `git branch --contains a850074` → `main` only; **not** an ancestor of origin/main (1 unique commit).
- The **highlight-embed UI** that `a850074` also bundled **IS** independently present on origin/main — only the `/mine`/`hydratePicks` code is unique.
- **It is NOT live** (live worker is from origin/main, which lacks it). So this is a never-shipped local improvement, not a live feature being lost — but it must be **preserved before any cleanup**, per the no-data-loss / preserve-features rule.

Everything else (the 3 other worktrees + match-intel-v31) is an **ancestor of origin/main** → fully captured; removing them loses **zero** commits.

---

## 5. CONSOLIDATION PLAN (proposed — do NOT run until approved)

> Principle: `origin/main` is the single source of truth. Preserve the one unique commit, make local `main` a clean fast-follow of origin, retire everything stale, and add a guard so no session can ever push from a behind copy.

**Step 0 — Preserve the at-risk commit (do this FIRST, before anything else).**
```
git tag preserve/mine-hydration a850074
git format-patch -1 a850074 -o ~/kickoff-oracle-backups/   # standalone patch as belt-and-braces
git branch archive/local-main-pre-reset a850074            # full branch backup of old local main
```
→ `/mine`+`hydratePicks` now survives in a tag, a patch file, and an archive branch. (Whether to *revive* it later is a separate, integrity-reviewed decision — it's read-only-own-picks, so low risk, but out of scope here.)

**Step 1 — Make local `main` track origin/main cleanly.**
```
git checkout main
git fetch origin
git reset --hard origin/main      # safe: unique commit already preserved in Step 0
```
→ local main == origin/main == live (v49). `REPO-STATE.md` is untracked, so `reset --hard` keeps it.

**Step 2 — Retire the stale branch.**
```
git worktree remove --force /private/tmp/kickoff-oracle-match-intel
git branch -D match-intel-v31     # ancestor of origin/main → no loss
```

**Step 3 — Remove leftover worktrees (working dirs only; commits are all ancestors → no loss).**
```
git worktree remove --force /private/tmp/kickoff-oracle-live
git worktree remove --force /private/tmp/wc26-intel
git worktree prune
```
→ `git worktree list` should then show only `~/Projects/wc26 [main]`.

**Step 4 — Pre-deploy safety guard (refuses to push when behind origin).** Install a `pre-push` hook:
```sh
# .git/hooks/pre-push  (chmod +x)
#!/bin/sh
git fetch -q origin main
behind=$(git rev-list --count HEAD..origin/main)
if [ "$behind" -gt 0 ]; then
  echo "✋ push blocked: local is $behind commit(s) BEHIND origin/main."
  echo "   Deploy from a fresh origin/main worktree, or 'git pull --ff-only' first."
  exit 1
fi
```
Plus the standing rule (already in memory `deploy-source-of-truth`): **all deploys run from a fresh `git worktree add --detach /tmp/x origin/main`**, never the working repo. (Hook is per-clone/not committed; pairs with the worktree habit as the real safeguard.)

**Step 5 — Going-forward hygiene.**
- Local main is read-mostly: refresh with `git pull --ff-only` (the data-refresh bot pushes every ~5 min, so main moves constantly).
- **Never commit data files locally** (`data/matches.*`, `highlights.json`, `wiki_pending.json`) — the bot owns them; local edits cause the exact drift seen here.
- Commit this `REPO-STATE.md` to origin/main as the canonical record (optional, on approval).
- Update memory `deploy-source-of-truth` to note consolidation done + the pre-push guard.

### Risk / non-negotiable check
- **No data loss:** the only unique work (`/mine`) is triple-preserved (tag + patch + archive branch) before any reset/delete; all other refs are ancestors of origin/main. **Zero KV / user-data access** in this whole task.
- **£0:** all local git operations.
- **Integrity:** untouched — `origin/main` retains the KO lock, fail-closed window, `joinedAt` gate, and scoring rules verbatim; nothing in this plan modifies worker logic or live data.

---

## 6. EXECUTION RESULTS (2026-06-17)

- **Step 0 — preserved `/mine`:** tag `preserve/mine-hydration` → `a850074`, branch `archive/local-main-pre-reset` → `a850074`, patch `~/kickoff-oracle-backups/0001-Add-match-highlight-embed.patch` (all verified to contain `getMine`/`hydratePicks`). **Archived only — not revived** (see handoff note up top).
- **Step 1 — local main reset:** `main` now `28ca39b` == `origin/main` (ahead 0, behind 0). `REPO-STATE.md` survived (untracked).
- **Step 2/3 — pruned:** removed worktrees `kickoff-oracle-match-intel`, `kickoff-oracle-live`, `wc26-intel`; deleted branch `match-intel-v31` (all were ancestors of origin/main → zero commit loss). **Only one worktree remains:** `~/Projects/wc26 [main]`.
- **Step 4 — guard:** `.git/hooks/pre-push` installed (executable) — fetches origin/main and blocks the push if local is behind; pairs with the fresh-worktree deploy rule. Verified: blocks when behind, allows at parity.
- **Refs now:** `main`, `archive/local-main-pre-reset` (preserves `/mine`), tag `preserve/mine-hydration`.

### Non-negotiables — held
- **No data loss:** only unique work (`/mine`) triple-preserved before any reset/delete; all other refs were ancestors of origin/main. **Zero Cloudflare KV / user-data access** in the entire task (git-local + this doc + the deploy memory only).
- **£0:** local git operations only.
- **Integrity:** untouched — no worker logic, scoring, window, or KV change. `origin/main`/live KO lock, fail-closed window, `joinedAt` anti-backfill gate and scoring rules are byte-unchanged.

> `REPO-STATE.md` is kept as an untracked local doc (survives the session on disk). Not committed to origin/main — say the word and I'll commit it as the canonical record (it would push to live `main`, which only adds this doc file).
