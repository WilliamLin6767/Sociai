# Sociai prototype

Research the person you're reaching out to, then draft a personalized message in your own writing voice.

It is one general engine. Every use case (student to professor, job seeker to recruiter, founder to investor, sales, networking, podcast invites) is just a different goal.

## How it works

1. **Research.** Claude searches the web and reads the person's key pages (personal site, lab or company page, papers, posts). It returns a dossier: a summary, cited facts, possible hooks, and cautions such as "two people share this name".
2. **Review.** You check each cited fact, correct or exclude it, and pick the "threads" (hooks) the message should be built around.
3. **Draft.** Claude writes the message using one or two real details, matched to your writing samples (tone, length, greetings, sign-off). Anything it doesn't know becomes a `[PLACEHOLDER]` listed under "check before sending". It never sends anything.

Uses `claude-sonnet-5-5` by default (configurable per step, see below) with server-side web search and web fetch, plus structured JSON output for both steps. If a safety classifier declines a request, the server-side refusal fallback re-runs it on another model in the same call.

## Models and cost

| Variable | Default | What it does |
| --- | --- | --- |
| `SOCIAI_RESEARCH_MODEL` | `claude-sonnet-5-5` | Model for the research step (web search + fetch). |
| `SOCIAI_DRAFT_MODEL` | `claude-sonnet-5-5` | Model for writing and refining drafts. |
| `SOCIAI_MAX_SEARCHES` | 5 | Web searches allowed per research run. |
| `SOCIAI_MAX_FETCHES` | 8 | Pages read (web fetch) per research run. |

The search and fetch limits are the main cost lever: each search costs about $0.01 plus the tokens of what it returns, and every page read adds its text to the input. If a run is paused and continued by the server, the continuation only gets what's left of the budget (at least one of each).

For example, to research with Opus and draft with Sonnet (PowerShell):

```powershell
$env:SOCIAI_RESEARCH_MODEL="claude-opus-5-5"; $env:SOCIAI_DRAFT_MODEL="claude-sonnet-5-5"; python -m sociai.web
```

Every research and draft run records input, output and cache-read tokens, web searches and fetches, and the model that actually served it (which differs from the one you asked for if the refusal fallback stepped in). The web server prints one line per run and adds the same numbers to the job result as `usage`:

```
[run] research done 48.2s model=claude-sonnet-5-5 in=38120 out=3104 cache_read=0 searches=5 fetches=8 cost=$0.1573
```

Costs are estimates from the price table in `sociai/engine.py`: Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50 per million input / output tokens, and about $10 per 1,000 web searches. A model missing from the table shows up as `unpriced` instead of being guessed. Check the Claude Console for actual billing.

To compare models on the student-to-professor example (this spends real API credits, roughly one research and one draft per model):

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
python -m sociai.compare                      # claude-opus-5-5 vs claude-sonnet-5-5
python -m sociai.compare --save compare.json  # also keep the full results
python -m sociai.compare --models claude-sonnet-5-5 claude-haiku-5-5
```

It prints cost, time and token counts per model and step, then the two drafts side by side. Haiku is supported (with basic web tools and no refusal fallback), but untested.

## Accounts and credits

People sign in with **email and password** (Supabase Auth). Magic links are gone: the server no longer offers them and the sign-in screen doesn't send them.

- **Sign up** asks for an email, a password of at least 10 characters (with a strength hint and a show/hide toggle) and the password again. Supabase emails a confirmation link; the account can't be used until it's confirmed. The "Check your email" screen can resend it.
- **Sign in** says "That email and password don't match" for a wrong password or an unknown address alike, so the form can't be used to find out who has an account. Signing in before confirming offers to resend the confirmation.
- **Forgot password** emails a reset link that opens a **Set a new password** screen. Like sign-in, it answers the same way whether or not the address has an account.
- The browser uses Supabase's **PKCE** flow: an email link carries a one-time code that only the browser that asked for it can turn into a session. Opened in another browser, a confirmation link still confirms the email and the page asks you to sign in; a reset link asks you to open it where you requested it, or to send a new one.
- The server still checks every access token with Supabase and refuses accounts whose email isn't confirmed (403 "Confirm your email address").

Each new account gets **2 free credits**. **1 credit = one research run plus up to 3 drafts or revisions for that person.** A research run that fails is refunded automatically. The balance shows in the header.

Abuse limits are enforced in the database:

- Disposable email domains (`sociai/disposable_domains.txt`) can't use the app.
- At most 3 new accounts per IP address per day (`SOCIAI_MAX_ACCOUNTS_PER_IP`; raise it for campus or office networks that share one IP).
- At most 2 research or draft jobs running at once per user.
- A global cap on jobs per UTC day (`SOCIAI_GLOBAL_DAILY_LIMIT`, default 100).
- Per-minute rate limits (`RATE` in `sociai/web.py`): per IP for the API as a whole, the public email check and token checks against Supabase; per user for job starts, checkout and portal sessions, resume uploads and account deletion. Over the budget, the API answers 429 with `Retry-After`.
- Research and draft requests cap every field (target 500, goal 2,000, background 20,000 characters, 10 samples of 20,000) and are checked before a credit is taken.

The browser never sees raw API errors; details go to the server log.

**Security headers.** Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`; behind the proxy (`SOCIAI_TRUST_PROXY=1`) HTTPS responses also carry HSTS, and plain-HTTP requests are redirected. Pages get a `Content-Security-Policy` that names every origin they load from (Supabase, jsdelivr for supabase-js, Google Fonts, Meta's pixel) and allows the inline scripts in the HTML files by hash, computed from the files at startup, so there is no `unsafe-inline` for scripts. Adding a third-party script means adding its origin to `csp()` in `sociai/web.py`; adding an inline script to a page needs nothing, its hash is picked up. In the app the Meta Pixel is loaded by `app.js` only after the one-time codes from sign-in email links have been taken out of the URL, so they never reach Meta.

## Profiles and saved projects

Each account has a **Profile** page (account menu > Your profile):

- **Main goal**, **about you**, a default **channel** and **word limit**, and **writing samples** (up to 10; at least 2 recommended). New outreach starts from these. Changing them for one message doesn't touch the profile unless you choose **Save these details to your profile**.
- **Resume**: upload a PDF or Word (.docx) file, up to 5 MB. The server checks the file's contents (not just its name), extracts the text with pypdf / python-docx, and stores the file in a private Supabase Storage bucket. The extracted text is shown so you can correct it. Files are never executed, rendered or served back. Drafts get an excerpt of the resume text (about 6,000 characters) with an instruction to use only details that help that particular message.
- **Delete my account and data** removes the profile, writing samples, resume file, projects and credit history. A hash of the email address is kept so a new sign-up with the same address doesn't get the free credits again.

**Onboarding.** After the first sign-in, a three-step setup comes before the Desk: your **main goal** with Sociai (reach professors or researchers, find a job or internship, raise money or find investors, sales or partnerships, networking, or something else, plus your own words), **about you** (a few lines and/or a resume, read the same way as on the Profile page), and **writing samples** (one to three). Each step saves when you continue, and any step can be skipped, as can the whole setup. It shows once per account (`profiles.onboarded_at`); while something was skipped, the Desk shows a "Finish setting up your profile" note. Everything stays editable on the Profile page, main goal included.

**New outreach starts from the profile:** the main goal picks the purpose and fills in the ask (your own words if you gave them, otherwise the purpose's suggested ask), along with your background, writing samples and default format. Drafts use your saved resume text, as before.

**Projects are saved to the account**, not the browser: the request, research, your corrections, chosen threads and every draft version. They save as you work (unsaved edits wait in the browser until the server has them), the Desk lists them newest first with search, and opening one in any browser restores it exactly. Projects created before this change are offered for import on first sign-in.

**Outreach tracker** (Tracker in the top bar, or account menu > Outreach tracker): people you've written to, entered by hand, with a sortable, filterable table, a month calendar of sent dates, replies and follow-ups, and a **Due soon** panel (follow-ups in the next 7 days or overdue). Marking a contact **sent** sets its follow-up date (professor +30 days, recruiter +7, alum and other +10), which you can change; marking it **replied** clears it. A sent contact whose follow-up date has arrived shows as **Follow-up due**. Under a draft, **Track this** fills in a new contact from the person and the subject. Nothing reads your inbox or sends anything, and tracker actions never use credits. The rules live in `sociai/tracker.py`.

**Privacy:** profiles, writing samples, resume files and their text, projects and tracker contacts are stored in your Supabase project. Row-level security lets each user read and change only their own rows and files.

## Payments (Stripe)

People buy credits on the **Pricing** page (account menu > Buy credits, or the link in any "out of credits" message):

- **Credit pack**: 20 credits, one-time (`STRIPE_PRICE_PACK`).
- **Monthly plan**: 30 credits each month (`STRIPE_PRICE_MONTHLY`), added every time an invoice is paid. Users manage or cancel it in the Stripe customer portal from the **Account** page, which also lists their purchases and recent credit activity.

Checkout and the portal are Stripe-hosted pages; Sociai never sees card details. Credits are added only by **signed webhooks** (`checkout.session.completed` for the pack, `invoice.paid` for the plan), never by the browser coming back from Checkout. Each Stripe event id is stored in `credit_ledger.stripe_event_id` (unique), so an event delivered twice adds credits once. Each user gets one Stripe customer, stored on their profile.

**Test or live, never mixed.** `SOCIAI_STRIPE_MODE` is `test` (the default) or `live`:

| Mode | Accepted keys | Events that add credits | Pricing page |
| --- | --- | --- | --- |
| `test` | `sk_test_...`, `rk_test_...` | test events only | shows "Test mode" and the 4242 test card |
| `live` | `sk_live_...`, `rk_live_...` | live events only | no test notice; real charges |

A key from the other mode (or an unknown mode) turns payments off, and the startup log says why, e.g. `Payments are OFF: SOCIAI_STRIPE_MODE is test but STRIPE_SECRET_KEY is a live-mode key...`. When payments are on it prints `Payments: Stripe LIVE mode (real charges)` or `Stripe TEST mode`.

**Legal pages.** `/privacy` and `/terms` are static pages (`sociai/static/privacy.html`, `terms.html`) with highlighted `[PLACEHOLDERS]` to fill in: your name or company, contact email, data region, refund window and jurisdiction. They're linked from the sign-in screens, the Pricing page and the footer. Creating an account requires ticking "I agree to the Terms and Privacy Policy"; accounts made earlier are asked once after signing in. The agreement and its version are saved on the Supabase user (`user_metadata.terms_version`, `terms_accepted_at`); bump `TERMS_VERSION` in `app.js` to ask everyone again after a significant change.

**Error monitoring.** Set `SENTRY_DSN` to send server errors to Sentry; without it nothing is loaded or sent. Events carry the error and stack trace only: no request bodies, cookies, auth headers or local variables, and any field that could hold resume text, writing samples or user input is removed, and anything that looks like a key or token is masked (`sociai/monitoring.py`).

## Supabase setup

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard) (**New project**).
2. **Email and password sign-in**: **Authentication > Sign In / Providers > Email** (click **Email** to open its settings):
   - **Enable Email provider**: on. This is what allows email + password sign-in.
   - **Confirm email**: on.
   - **Minimum password length**: `10`.
   - **Password requirements**: leave at "No required characters" (the sign-up screen shows a strength hint instead), or tighten it if you like.
   - **Save**. Under **User Signups** on the same page, **Allow new users to sign up** must be on.
3. **Redirect URLs**: **Authentication > URL Configuration**.
   - Site URL: your Render URL (e.g. `https://sociai.onrender.com`), or `http://localhost:8000` while you only run locally.
   - Redirect URLs: add `http://localhost:8000/**` and `https://<your-app>.onrender.com/**`. Those wildcards cover the two pages email links return to; you can also add them exactly: `http://localhost:8000/app?auth=confirmed` (email confirmation) and `http://localhost:8000/app?auth=reset` (password reset), plus the same two with your Render URL. A link whose address isn't allowed is sent to the Site URL instead; the server forwards a sign-in link that lands on `/` to `/app`, and the page still recognises a reset link there.
   - Optional, for links that work in any browser: in **Authentication > Emails > Templates**, change the link in **Confirm signup** to `{{ .SiteURL }}/app?token_hash={{ .TokenHash }}&type=email` and in **Reset Password** to `{{ .SiteURL }}/app?token_hash={{ .TokenHash }}&type=recovery`. The page accepts both kinds of link.
4. **Email delivery**: Supabase's built-in email service only sends to your project's team members, at a very low rate. For testers, set up your own SMTP provider (Resend, Postmark, SendGrid...) under **Authentication > Emails > SMTP Settings**, then raise the email limit under **Authentication > Rate Limits**.
5. **Run the migrations, in order** (oldest first). Either:
   - **SQL Editor > New query**: paste and **Run** each file in `supabase/migrations/`, in the order of the table below; or
   - with the Supabase CLI: `npx supabase login`, `npx supabase link --project-ref <your-project-ref>`, then `npx supabase db push` (it runs whichever haven't run yet).

   | Migration | Creates |
   | --- | --- |
   | `20261101000000_accounts_and_credits.sql` | `profiles` (credits), `credit_ledger`, `jobs`, the free-credit trigger and the credit functions |
   | `20261102000000_profiles_and_history.sql` | profile fields on `profiles` (background, default channel and word limit, resume text), `writing_samples`, `projects`, `deleted_accounts`, the private **`resumes`** Storage bucket (5 MB, PDF/DOCX only) and its per-user-folder policies |
   | `20261103000000_payments.sql` | `stripe_customer_id` on `profiles`, and the functions that grant credits once per Stripe event and show the Account page |
   | `20261104000000_onboarding.sql` | `main_goal`, `main_goal_note` and `onboarded_at` on `profiles` (users may change only their own), and the onboarding functions. People who already used Sociai are marked as onboarded, so they don't see the setup |
   | `20261105000000_profile_repair.sql` | repairs accounts whose profile row is missing (with the sign-up rules for free credits) |
   | `20261106000000_outreach_contacts.sql` | `outreach_contacts` for the outreach tracker, with row-level security (each user sees and changes only their own), an `updated_at` trigger and a cap of 2,000 contacts per account |

   Then check **Storage**: a bucket named `resumes` should be listed as private. If your project doesn't let SQL create buckets, create it by hand (**Storage > New bucket**, name `resumes`, public off, 5 MB limit, allowed types `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document`) then run just the storage section at the end of that migration (from the `insert into storage.buckets` line down) so the per-user policies exist.
6. **Keys**: **Project Settings > API Keys** gives the publishable (anon) key and the secret (service_role) key; the project URL is under **Project Settings > Data API**. Put them in `.env` locally and in Render's environment.

Handy SQL (SQL Editor) for running the test:

```sql
-- give a tester 5 more credits
update public.profiles set credits = credits + 5 where email = 'tester@example.com';
insert into public.credit_ledger (user_id, delta, reason)
  select id, 5, 'manual_grant' from public.profiles where email = 'tester@example.com';

-- unblock an account flagged as disposable or over the per-IP limit
update public.profiles set blocked_reason = null where email = 'tester@example.com';
```

## Stripe setup (test mode)

1. In the [Stripe dashboard](https://dashboard.stripe.com), switch on **Test mode** (top right). Everything below happens in test mode. (For real payments, see **Going live** below.)
2. **Products > Add product**:
   - "Sociai credit pack": one-off price **$14.99**. Copy its price id (`price_...`) into `STRIPE_PRICE_PACK`.
   - "Sociai monthly": recurring monthly price **$11.99**. Copy its price id into `STRIPE_PRICE_MONTHLY`.

   The Pricing page reads the amounts from these prices in Stripe, so changing a price in Stripe changes the page (within 10 minutes); nothing in the code holds a price.
3. **Developers > API keys**: copy the secret key (`sk_test_...`) into `STRIPE_SECRET_KEY`.
4. **Settings > Billing > Customer portal**: click **Activate test link** (or **Save**) once, and allow customers to cancel subscriptions. Without this, "Manage subscription" fails.
5. **Webhooks**
   - **On Render**: **Developers > Webhooks > Add endpoint**, URL `https://<your-app>.onrender.com/api/stripe/webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `invoice.paid`. Copy its signing secret (`whsec_...`) into Render's `STRIPE_WEBHOOK_SECRET`.
   - **Locally**: install the [Stripe CLI](https://docs.stripe.com/stripe-cli) (on Windows: `scoop bucket add stripe https://github.com/stripe/scoop-stripe-cli.git; scoop install stripe`, or unzip the Windows release from GitHub), then in a second PowerShell window:

     ```powershell
     stripe login
     stripe listen --forward-to localhost:8000/api/stripe/webhook
     ```

     It prints a signing secret (`whsec_...`). Put it in `.env` as `STRIPE_WEBHOOK_SECRET` and restart `python -m sociai.web`. Keep `stripe listen` running while you test.
6. `PUBLIC_URL` is where Stripe sends people back to: `http://localhost:8000` locally. On Render it defaults to your Render URL.

## Run it locally (Windows PowerShell)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
notepad .env          # fill in ANTHROPIC_API_KEY and the three SUPABASE_ values
python -m sociai.web  # open http://localhost:8000
```

On startup the server prints which settings it loaded from `.env` (names only, never values). Values in `.env` win over variables already set in Windows, so an old `setx ANTHROPIC_API_KEY` can't shadow the file.

Tests (standard library only, no Supabase or Claude key needed):

```powershell
python -m unittest discover tests
```

The command line tools don't need Supabase, only the Claude key:

```powershell
python -m sociai --example examples/student_professor.json
python -m sociai --target "Jane Doe, recruiter at Stripe" --goal "Get a referral for the new-grad backend role" --channel linkedin --max-words 120
```

## Settings

All settings are environment variables, or lines in `.env` (see `.env.example`).

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (required) | Claude API key. Web search must be enabled for your org. |
| `SUPABASE_URL` | (required) | Your Supabase project URL. |
| `SUPABASE_ANON_KEY` | (required) | Publishable (anon) key. Sent to the browser for sign-in. |
| `SUPABASE_SERVICE_ROLE_KEY` | (required) | Secret (service_role) key. Server only: it changes credits through the database functions. |
| `SOCIAI_GLOBAL_DAILY_LIMIT` | 100 | Research + draft jobs per UTC day across all users. |
| `SOCIAI_MAX_ACCOUNTS_PER_IP` | 3 | New accounts per IP per day before the next is blocked. Campus networks share one IP. |
| `SOCIAI_RESEARCH_MODEL`, `SOCIAI_DRAFT_MODEL` | `claude-sonnet-5-5` | Model per step. See "Models and cost" above. |
| `SOCIAI_STRIPE_MODE` | `test` | `test` or `live`. The secret key and webhook events must be from this mode. |
| `STRIPE_SECRET_KEY` | unset | Stripe secret key for that mode (`sk_test_...` or `sk_live_...`). Payments are off without it, or if it doesn't match the mode. |
| `STRIPE_WEBHOOK_SECRET` | unset | Signing secret of the webhook endpoint (`whsec_...`), or the one `stripe listen` prints locally. |
| `STRIPE_PRICE_PACK` | unset | Price id of the 20-credit pack. |
| `STRIPE_PRICE_MONTHLY` | unset | Price id of the monthly plan (30 credits a month). |
| `PUBLIC_URL` | Render URL, else `http://localhost:8000` | Base of Checkout's success and cancel URLs and the portal's return URL. |
| `SENTRY_DSN` | unset | Optional. Sends server errors to Sentry, without user content or keys. |
| `SOCIAI_MAX_SEARCHES`, `SOCIAI_MAX_FETCHES` | 5, 8 | Research budget per run. See "Models and cost". |
| `SOCIAI_TRUST_PROXY` | off | Set to `1` behind a proxy (Render) so the per-IP limit sees the real client IP from `X-Forwarded-For`. |
| `PORT` | unset | Set by Render. The server listens on `0.0.0.0:$PORT`; without it, `127.0.0.1:8000`. |

## Deploy to Render

The repo includes a `render.yaml` blueprint (a Python web service on Render's **Starter** plan and Python 3.13.3, health-checked at `/healthz`).

1. Do the Supabase setup above, including the migration.
2. Push this repo to GitHub, then in Render choose **New > Blueprint** and pick the repo.
3. Fill in the secrets Render asks for: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_URL` (your site's address, e.g. `https://sociai.app`), optionally `SENTRY_DSN`, and for payments `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PACK`, `STRIPE_PRICE_MONTHLY` (see Stripe setup; the webhook endpoint needs your Render URL, so you can add its secret after the first deploy).
4. After the first deploy, add the Render URL to Supabase's Site URL and Redirect URLs (step 3 above).

Things to know:

- Credits, limits and job records live in Supabase. The live progress of a running job lives in server memory, so a restart or redeploy drops research in progress; jobs stuck as running for 15 minutes are closed and research is refunded the next time that user starts a job.
- The Starter plan stays on. (The free plan sleeps after about 15 minutes without traffic, which also drops running research jobs.)
- Projects, profiles and resumes are stored in Supabase, so they survive restarts and follow users across browsers.
- The per-IP limit trusts the first `X-Forwarded-For` address, which a determined user can fake. It slows down casual abuse; it isn't a wall.

## Going live

Do these in order, and test one real purchase with your own card before announcing anything.

1. **Legal pages**: fill in every highlighted `[PLACEHOLDER]` in `sociai/static/privacy.html` and `terms.html` (name or company, contact email, data region, refund window, minimum age, jurisdiction), and check the Anthropic data-use sentence against Anthropic's current commercial terms.
2. **Stripe account**: finish activating it (business details, bank account for payouts) so live mode is available.
3. **Live products and prices**: in **live mode** (test mode toggle off), **Products > Add product**: the credit pack, one-off **$14.99**, and the monthly plan, recurring **$11.99**. Test-mode products don't carry over. Copy the two live `price_...` ids into Render's `STRIPE_PRICE_PACK` and `STRIPE_PRICE_MONTHLY`.
4. **Live key**: **Developers > API keys** (live mode): copy the secret key (`sk_live_...`, or a restricted `rk_live_...` key) into Render's `STRIPE_SECRET_KEY`, and set `SOCIAI_STRIPE_MODE` to `live`.
5. **Live webhook**: **Developers > Webhooks > Add endpoint** in live mode, URL `https://<your-domain>/api/stripe/webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`. Copy its signing secret (`whsec_...`, different from the test one) into Render's `STRIPE_WEBHOOK_SECRET`.
6. **Customer portal (live)**: **Settings > Billing > Customer portal**, save it once in live mode and allow cancelling subscriptions.
7. **`PUBLIC_URL`**: set it to the address customers use (custom domain or the `onrender.com` URL), and add that address to Supabase's Site URL and Redirect URLs.
8. **Email sending**: Supabase's built-in email only sends to your team, a few an hour, so confirmation and password-reset emails would fail for customers. Set up your own SMTP sender (Resend, Postmark, SendGrid...) in **Authentication > Emails > SMTP Settings**, with a sender address on your domain (and its SPF/DKIM records), then raise **Authentication > Rate Limits** for emails.
9. **Claude spend limit**: in the [Claude Console](https://console.anthropic.com), **Settings > Limits**, set a monthly spend limit (and an email alert below it) for the organization behind `ANTHROPIC_API_KEY`. Keep `SOCIAI_GLOBAL_DAILY_LIMIT` as a second backstop.
10. **Monitoring**: optionally create a Sentry project and set `SENTRY_DSN`.
11. **Deploy and check the log**: it should say `Payments: Stripe LIVE mode (real charges)`. If it says `Payments are OFF`, the reason is on the same line. The Pricing page should show $14.99 and $11.99 and no "Test mode" note.
12. **One real purchase**: buy the pack with your own card, confirm +20 credits and a `[stripe] ... granted` log line, then refund yourself in the Stripe dashboard.

## Files

- `sociai/engine.py`: the engine (`Engine.research`, `Engine.draft`, `Engine.run`). Use-case agnostic.
- `sociai/cli.py`: command line.
- `sociai/compare.py`: runs one case on several models and compares cost, time and drafts.
- `sociai/web.py`: web server. Checks the Supabase access token on every `/api/*` call, starts research and drafting as background jobs (`/api/research`, `/api/draft`, polled at `/api/jobs/<id>`) after the database has approved and charged them, and serves `/healthz`.
- `sociai/config.py`: settings and the `.env` loader. `sociai/supabase.py`: the small Supabase client the server uses.
- `sociai/disposable_domains.txt`: email domains that can't use the app.
- `sociai/resume.py`: checks uploaded resumes and extracts their text (PDF, DOCX).
- `sociai/tracker.py`: the outreach tracker's validation and follow-up rules (tested in `tests/test_tracker.py`).
- `sociai/billing.py`: Stripe Checkout, the customer portal, webhook verification, and the test/live mode rules.
- `sociai/monitoring.py`: optional Sentry setup and the scrubbing of events.
- `supabase/migrations/`: database tables, row-level security, credit functions, and the resumes Storage bucket.
- `.env.example`: every setting, with comments.
- `render.yaml`: Render deploy blueprint.
- `sociai/static/`: the web app (plain HTML, CSS and ES modules, no build step; supabase-js comes from a pinned CDN URL). `auth.js` holds the Supabase sign-in calls.
- `examples/`: the student-to-professor demo, with two writing samples.

## Web app

- **Sign in / Create account / Forgot password**: email and password, with email confirmation and reset links.
- **Welcome** (first sign-in only): main goal, background and resume, writing samples. Every step can be skipped.
- **Desk**: start new outreach ("Who would you like to reach out to?") and pick up anything saved in your account. New outreach starts from your profile and main goal.
- **Profile**: your main goal, background, default format, writing samples and resume, plus account deletion.
- **Pricing** and **Account**: buy credits or the monthly plan, see purchases and credit activity, manage the subscription.
- **Research**: a live map of the real searches and page reads the server reports, plus a timestamped field log.
- **Review**: cited facts (each with a source card), recent work, cautions, and threads to choose. Your corrections are marked as yours and sent to the draft step.
- **Draft**: an editor where placeholders are highlighted inline. Refine tone and length (your edits are kept), regenerate, switch between versions, and copy the message. Nothing is ever sent for you. **Track this** adds the person to the tracker.
- **Tracker**: the outreach tracker (see Profiles and saved projects): table, calendar and Due soon.

## Next ideas

- Batch mode: a list of targets with the same goal (with a per-message review step).
- Track replies to learn which hooks work.
