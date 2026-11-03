# Conversion audit: ad click → sign-up → first draft

Measured on 2026-11-03 against the live site (getsociai.com) and a local copy of `main` before
this branch, in Chrome at 390×700 with 4G throttling (150 ms latency, 1.5 Mbit/s) and a 4× slower
CPU, which is roughly a mid-range phone on Instagram's in-app browser. 200+ ad clicks, 0 sign-ups.

## 1. What a cold visitor saw

**Landing page (as deployed before this branch).** First contentful paint at **304 ms**; **29 KB**
before paint (the HTML; fonts load after). Above the fold at 390×700: headline "Cold emails that
actually get replies", a two-line subline, a full-width "Try 2 free drafts" button, "No credit card
needed", "Already have an account? Log in", "Built by Stanford & Berkeley students". Nothing to do
on the page itself except leave for sign-up.

**Sign-up screen (/app?mode=signup).** First paint at **1.4 s**, usable at **2.8 s** on the same
connection: the app shell loads `sociai.css` (76 KB), `app.js` and four modules, supabase-js
from jsdelivr (~100 KB) and three Google Fonts before the form appears. Four fields (email,
password, confirm password, Terms checkbox) and a submit.

**Render cold start.** Three requests to `/` from cold: TTFB 0.16–0.21 s, `/app` 0.26 s. The
service is on Render's starter plan (always on) behind Cloudflare; there is no sleep/wake delay.
Not a cause of drop-off.

**Taps to a working draft (before):** landing CTA (1) → sign-up form (5) → leave for the mail
app, open the confirmation link (2–3; in Instagram's browser the link opens in Safari, where the
sign-in code can't be exchanged, so: sign in again, 3 more) → three-step setup wizard (3 skips or
~8 taps of typing) → desk: type a name (the ask is prefilled) → Begin research (2) → wait 1–3 min
→ Review: pick a thread, Write the draft (2) → wait 30–60 s. **About 15–20 taps, one email
round-trip, two waits of a minute or more, and the first thing a new account sees is a setup
wizard, not an email.**

## 2. Sign-up → first draft, as a new user (before)

| Screen | What happens | Friction |
|---|---|---|
| Landing | One button, "Try 2 free drafts" | No proof the product works on *their* professor |
| Sign-up | Email, password, confirm, Terms | 2.8 s to usable on a phone; a second password field |
| "Check your email" | Must leave the site | In-app browser → link opens elsewhere → "sign in with your password to continue" |
| Setup wizard, 3 steps | Goal, background/resume, writing samples | Asks for effort before any value; skippable but reads as required |
| Desk | Empty target field | A blank page to fill in; the example is a hint, not a prefill |
| Research | Live map, 1–3 minutes | Fine once started; the wait is honest and visible |
| Review → Draft | Pick a thread, write, ~1 minute | Fine |
| Out of credits | Toast + link | No explanation of what a credit buys |

Nothing was broken: no console errors, no layout overflow at 375 px, every state renders. The
problem is sequencing: every path asks for an account before showing anything.

## 3. Top 5 reasons a visitor leaves, ranked by impact

1. **Nothing to try without an account.** 200 clicks and 0 sign-ups says the page never earned
   the account. Fixed: the hero is now a working demo (name a person, pick the ask) that shows the
   research steps live, then the summary, two facts and the first two sentences of a real draft,
   with the rest blurred behind "Sign up free to see the full email". The sign-up link carries the
   demo id, so the account's first screen is that full draft.
2. **Email confirmation in an in-app browser.** The confirmation link opens outside Instagram's
   browser; the PKCE code can't be exchanged there, so the user is asked to sign in a second time
   before seeing anything. Recommendation (a Supabase setting, see below): turn "Confirm email"
   off. The server and app handle both settings.
3. **The sign-up screen itself.** 2.8 s to usable and four fields. Fixed: the confirm-password
   field is gone (there's a Show toggle and a reset link); the app page preloads its modules and
   preconnects to jsdelivr (from the previous branch); the demo gives people a reason to wait.
4. **A setup wizard before any value.** Fixed: new accounts go straight to the desk with a worked
   example in the brief (one tap to a first research run); the profile is nudged from the desk
   afterwards. If they ran the demo, the full draft is already open.
5. **No visible path after the free credits.** Fixed: a short note on the desk when credits hit
   zero, saying what a credit buys and linking to pricing and billing.

## 4. What changed, and why it should raise sign-ups

- **Demo in the hero** (`POST /api/demo`, Haiku, 2 searches + 3 page reads capped at 20k tokens
  each, a 90 s timeout per call): the visitor sees Sociai work on the person they actually want
  to write to. Measured live on "Prof. Fei-Fei Li, Stanford": **32 s, $0.03**, 6 sources, two
  cited facts and a 107-word draft of which 64 words stay hidden. Cost is capped: one demo
  per IP per day (the refusal points to sign-up), `SOCIAI_DEMO_DAILY_LIMIT` across everyone, the
  public rate limit, no credits and no job rows. The result is kept (memory + `demo_runs`), so
  **sign-up is rewarded immediately** with the full draft instead of a wait.
- **Headline matches the ad**: "Cold emails professors actually reply to" (6 words).
- **Landing page**: still one request to paint (**40 KB**, first paint ~310 ms on throttled 4G);
  "Who it's for" and the two FAQ answers people ask first ("Does it sound like AI?", "Is it free?").
- **Sign-up**: three fields; `signup_started` / `signup_done` show where it fails.
- **First run**: desk prefilled with an example and the ask, unfolded, one tap to research.
- **Attribution**: `utm_*` and `fbclid` ride through every link into `/app` and are recorded once
  per new account (`signup_attribution`).
- **Funnel**: `landing_view → demo_used → signup_started → signup_done → first_draft → checkout`
  counted per day in the `events` table and in the log; `GET /api/funnel?token=…` shows the last
  14 days as a table with each step as a share of landing views.

What to watch after deploy: `landing_view → demo_used` (is the demo used?), `demo_used →
signup_done` (does seeing the result earn the account?), `signup_started → signup_done` (the form
and, if still on, email confirmation), `signup_done → first_draft`.

## 5. What you need to do

1. **Supabase → SQL Editor**: run `supabase/migrations/20261107000000_demo_and_funnel.sql`
   (three new tables and their functions; nothing existing changes). Until then the demo still
   works from memory, events are logged but not stored, and the server prints one line saying so.
2. **Supabase → Authentication → Providers → Email**: turn **Confirm email off** (reason 2 above).
3. **Render → Environment**: add `SOCIAI_ADMIN_TOKEN` (a long random string). Then
   `https://getsociai.com/api/funnel?token=<it>` is the funnel page. Optional:
   `SOCIAI_DEMO_DAILY_LIMIT` (default 100/day ≈ $3/day at most) and `SOCIAI_DEMO_MODEL`.
4. Keep the ad's destination on `/` with its `utm_*`; the page carries them on.
