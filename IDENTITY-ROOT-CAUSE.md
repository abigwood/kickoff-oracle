# IDENTITY-ROOT-CAUSE.md — device-split identities: analysis + fix plan

**Date:** 2026-06-17 · **Status:** Approved. **Phase 1 SHIPPED (v51, client-only).** Phase 2 SCHEDULED (held).
**Guardrails:** Phase 1 = client-only, no KV/Worker write, no leak opened, nobody loses code access; £0; integrity untouched.

## ▶▶ PHASE STATUS (read this first)
- **Phase 1 — DONE (v51-2026-06-17):** A single-context steering banner · B fresh-identity intercept (+ first-pick gate) · C frictionless restore (`?restore=CODE` auto-restore + copy code/link) · cosmetic KO-lock · **`wc_code` now cached locally** from the unchanged `/me`/`/restore`. Client-only; Worker untouched.
- **Phase 2 — HELD, DO NOT DEPLOY until confirmed:** close the `/me`→recovery-code leak + ship the recovery-code-authed `/mine` + `hydratePicks`. **Trigger condition:** most active devices have persisted `wc_code` (≈ **5–7 days** of Phase-1 propagation, i.e. once regulars have each opened the app once). Worker change → back up worker + Cloudflare deployment before deploying.
  - **Why two-phase (the integrity reason):** `/me?uid` currently returns the recovery code for ANY bare uid, and uids are exposed in `/state` (member rows) + `/orphans`. So today there is a chain `/state → uid → /me → code`. Closing `/me` in one shot would strand existing devices' code access (they never persisted it); shipping code-auth `/mine` *before* closing `/me` would make `/state → uid → /me → code → /mine → hidden picks` — a pre-KO pick leak. Phase 1 makes every device persist `wc_code` while `/me` still legitimately returns it; Phase 2 then closes `/me` and adds `/mine` with everyone already holding their code.
  - **Phase-2 verification checklist (to run then):** (1) `/me?uid=<arbitrary>` returns NO `recovery`; (2) existing devices still display their code (from `wc_code`); (3) `/mine` accepts only `{code}` (no uid param) and a bare uid cannot reach picks; (4) merge / restore / kick / orphan-watchdog flows still work (Phase 2 edits only `getMe` + adds `getMine`).

---

## 1. How a device gets/stores its identity (traced in live v50)

- `index.html:923` — `function uid(){ let u=localStorage.getItem("wc_uid"); if(!u){ u="u_"+Math.random()...+Date.now()...; localStorage.setItem("wc_uid",u);} return u; }`
- Identity is a **random per-localStorage uid**, plus `wc_nick`, `wc_leagues`, `wc_picks` — all in `localStorage`.
- The uid is **minted lazily, the first time `uid()` is called, with NO check for an existing identity** (no server lookup, no prompt). A fresh context silently becomes a brand-new person.
- Recovery: `restoreIdentity()` (`:979`) — user types a recovery code → `/restore` → overwrites `wc_uid`. Worker `restore` looks up `recovery:{code}` → uid. Recovery codes are minted server-side on first sight (`ensureUser`).
- Smart-join guard: `/whois?code&nickname&uid` (`:998`) — joining a league under a name that's already a member prompts "Are you [name]? Restore instead." **Only fires on JOIN, only if they retype the same nickname.**

### THE ROOT CAUSE
On iOS, **Safari and the home-screen (standalone) PWA have completely separate `localStorage`** (separate WebKit storage partitions; cookies too). So the same person in two contexts gets **two independent `wc_uid`s**. Because `uid()` mints a fresh uid on demand with **no cross-context reconciliation**, the second context becomes a new identity. When they then pick there, the pick lands on the orphan uid → shows 😴 on their "real" row. Every Safari↔PWA oscillation can mint/strand another identity.

There is **no shared client storage between Safari and a standalone PWA on iOS**, so a new context **cannot automatically know the user's existing uid** without either (a) the user supplying their recovery code, or (b) a cross-context anchor that survives the partition (passkey via iCloud Keychain — see Option E). This is an OS-level constraint, not a bug we can simply patch away.

## 2. Why the earlier restore-hydration fix didn't stop NEW splits

- **Restore is manual + reactive:** the user must already realise they're split and type their recovery code. It repairs *after* a split, never prevents the mint.
- **`hydratePicks()` was never shipped** — it lives only in archived `a850074`. Even if shipped, it only rehydrates picks *after* a restore.
- **Nothing intercepts a fresh context before it creates orphan data.** A new uid can join/pick immediately as a new person; the only guard (`/whois`) is on join + needs the same nickname retyped. Picking has no guard at all.
- Net: splits keep *originating*; we only ever did manual merge/restore cleanup (Boat, Parks, Marcela, Choco, Cookster).

## 3. Archived `/mine` + `hydratePicks` — assessment

- `getMine(uid)` returns `{matchId:{s1,s2}}` for that uid; `hydratePicks()` calls `/mine?uid=<own uid>` after restore and writes into `myPicks`.
- **What it does:** completes a restore so locked picks don't *look* lost. Useful — it removes the incentive to re-pick (re-picking is a common way a split becomes visible). **But it REPAIRS, it does not PREVENT** the initial mint.
- ⚠️ **INTEGRITY FLAG (must fix before shipping):** `getMine` authenticates by a **bare `uid` query param**. uids are **not secret** — `computeTable` rows return `uid` (`logic.js:103`), so `/state?code=CODE` exposes every member's uid to anyone with the league code (shared in group chats), and `/orphans` exposes them to admins. So `/mine?uid=X` as drafted lets a rival **read another player's hidden picks BEFORE kick-off**, weakening the hidden-until-KO / fail-closed guarantee. **Do not ship as-is.**
  - **Integrity-correct version:** authenticate hydration by the **recovery code** (which *is* a secret), not the bare uid — e.g. `/mine {code}` → resolve `recovery:{code}` → uid → return that uid's picks. This ties hydration to the thing the user already proves at restore, and leaks nothing (only the code-holder can read their own picks). This is the extension to adopt.

## 4. Fix plan — ranked by reliability / risk

> Reality check: without a login or a passkey (Option E), iOS will always *let* a brand-new context start fresh. A–D below drive new-split *frequency* toward zero and make any residual split self-heal in one tap; E is the only truly automatic structural fix.

**A. Single-context steering (highest value, lowest risk, UX-only).**
Detect `window.matchMedia('(display-mode: standalone)')`. When running in **Safari (not standalone)**, show a persistent prominent banner: *"Open from your home-screen icon to keep your identity & picks — Add to Home Screen."* Splits happen on Safari↔PWA oscillation; funnelling everyone to the single PWA context means one `localStorage` → one identity. No data/integrity/KV touch.

**B. Intercept a fresh identity BEFORE it creates orphan data (low risk, client-only).**
On load, if `wc_uid` was just minted / there are no leagues + no picks (a likely "second context"), present a first-run choice instead of silently continuing: *"New here, or returning? [I'm new] · [Restore my picks]"*. Crucially, **gate the first pick on a fresh identity** behind this prompt so an orphan pick can't be created silently. Catches the exact 😴 scenario at source.

**C. Frictionless / near-automatic restore (low risk).**
- In the context that *has* an identity: surface the recovery code prominently with one-tap copy, plus a **personal restore link** `…?restore=<code>` the user can open in the PWA.
- In any context: **auto-restore from `?restore=<code>`** URL param (no typing), and accept paste. Makes "restore" a tap, not a chore.

**D. Adopt `/mine` + `hydratePicks` — HARDENED (low risk once auth-fixed).**
Ship the archived pick-rehydration, but authenticated by **recovery code, not bare uid** (per §3). After any restore (manual, link, or smart-join), the device pulls its own locked picks so nothing looks lost — removing the re-pick behaviour that surfaces splits. Read-only of the *code-holder's own* picks; integrity preserved.

**E. (Structural, higher effort — separate phase) WebAuthn passkey identity.**
A passkey created in Safari is shared with the standalone PWA via **iCloud Keychain** — the only cross-context anchor that survives iOS's storage partition, and it's £0. This is the "never splits again" fix, but it's a substantial feature needing its own integrity/UX review (fallback for non-passkey devices, recovery-code coexistence). Propose as a follow-up, not this pass.

**Recommended sequencing:** **A + B + C + D (hardened)** first — together they cut new splits sharply and make residual ones one-tap self-healing, all low-risk client/worker-read changes. Evaluate **E** afterwards as the structural endgame.

## 5. Separate cosmetic fix — picker shows "PICK OPEN" after KO

- `windowState(m)` (`:1014`) is time-based and evaluated at **render time**; the widget isn't re-rendered when KO passes, and on stale data (status still `UPCOMING`, no score yet) it stays `"open"` between refreshes. The countdown ticker flips its own text to `"SHUT"` (`:1317`) but **the stepper + "Lock it in" button stay live** and the header still reads open. The server already **fails closed** (rejects `/pick` at/after KO: *"Too late — picks shut at kick-off"*), so this is **purely cosmetic** but confusing.
- **Fix (client-only, no integrity change):** in the per-window ticker, when `KO − now ≤ 0`, put that `.window[data-wid]` into a visibly **locked** state — disable the steppers + lock button and swap the header to *"🔒 PICKS SHUT"*. The server lock is unchanged and remains authoritative.

## 6. Non-negotiables — how the plan holds them
- **No data loss:** A/B/C/E are client/UX; D is read-only of the caller's own picks. The only KV *writes* in the whole plan would be future restores/merges the USER initiates (existing, reversible) — no new bulk writes. Any KV op in implementation backs up first.
- **£0:** all static/client + existing Worker/Action; passkeys (E) are free.
- **Integrity:** A/B/C/cosmetic don't touch the Worker. D **must** be the recovery-code-authenticated version — the bare-uid draft is rejected precisely because it would weaken hidden-until-KO. KO lock / fail-closed window / anti-backfill / scoring untouched throughout.

## 7. Phase 1 — shipped (v51-2026-06-17)
Client-only (`index.html` + `sw.js`); **no Worker/KV change**.
- **A** persistent steering banner when not running standalone (Safari) → "open from your home-screen icon."
- **B** fresh-context intercept: a first-run Restore prompt, and a **gate on the first pick** of a fresh identity steering to Restore before an orphan pick is created.
- **C** `?restore=CODE` auto-restore (personal link, no typing) + "Copy code" / "Copy restore link" on the recovery card.
- **cosmetic** KO-lock: at kick-off the picker visibly disables (steppers + lock button) and relabels "🔒 PICKS SHUT". Server lock remains authoritative.
- **`wc_code` persistence:** the device caches its recovery code locally from the unchanged `/me`/`/restore` (groundwork for Phase 2). Existing users still see their code exactly as before (now also cached); new join/create/restore persists it.

**Phase 2 stays HELD until the trigger above is confirmed.**
