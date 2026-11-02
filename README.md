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

## Run it

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # web search must be enabled for your org in the Claude Console

# Web UI
python -m sociai.web                     # open http://localhost:8000

# CLI demo: undergrad emailing a professor about research
python -m sociai --example examples/student_professor.json

# CLI, any use case
python -m sociai --target "Jane Doe, recruiter at Stripe" \
  --goal "Get a referral for the new-grad backend role" \
  --background "CS senior, interned at Plaid on payments infra" \
  --samples my_email_1.txt my_email_2.txt --channel linkedin --max-words 120
```

On Windows PowerShell, set the key with `$env:ANTHROPIC_API_KEY="sk-ant-..."` instead of `export`.

### Run locally with the invite gate on (Windows PowerShell)

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."; $env:SOCIAI_ACCESS_CODES="test123"; python -m sociai.web
```

Open http://localhost:8000 and enter `test123` when asked for an invite code. To turn the gate off again in the same window, run `Remove-Item Env:SOCIAI_ACCESS_CODES`.

## Deploy to Render

The repo includes a `render.yaml` blueprint (a Python web service on Python 3.13.3, health-checked at `/healthz`).

1. Push this repo to GitHub.
2. In the Render dashboard choose **New > Blueprint**, pick the repo, and Render reads `render.yaml`.
3. When Render asks, fill in the secrets:
   - `ANTHROPIC_API_KEY`: your Claude API key (web search must be enabled for your org).
   - `SOCIAI_ACCESS_CODES`: comma-separated invite codes, one per tester, e.g. `amy-7f3k,ben-q9x2`. Codes are per person, so limits apply per person.
4. Deploy, then send each tester the URL and their code.

Settings (environment variables):

| Variable | Default | What it does |
| --- | --- | --- |
| `SOCIAI_ACCESS_CODES` | unset | Invite codes. When set, every API call needs a valid code, and server errors are logged instead of shown in the browser. When unset (local dev), there is no gate. |
| `SOCIAI_DAILY_LIMIT` | 20 | Research + draft runs per code per UTC day. Each code can also run at most 2 at once. |
| `SOCIAI_GLOBAL_DAILY_LIMIT` | 200 | Runs per UTC day across all testers, as a spending backstop. Applies even without the gate. |
| `SOCIAI_RESEARCH_MODEL`, `SOCIAI_DRAFT_MODEL` | `claude-sonnet-5-5` | Model per step. See "Models and cost" above. |
| `PORT` | unset | Set by Render. The server listens on `0.0.0.0:$PORT`; without it, `127.0.0.1:8000`. |

Things to know:

- Usage counts and running jobs live in memory. A restart or redeploy resets the daily counts and drops any research in progress (the page shows it as interrupted, with a retry).
- Render's free plan sleeps after about 15 minutes without traffic, so the first visit after that takes a while to load. Change `plan` in `render.yaml` if that matters.
- Projects are stored in each tester's browser, not on the server.
- To revoke a tester, remove their code from `SOCIAI_ACCESS_CODES` and redeploy.

## Files

- `sociai/engine.py`: the engine (`Engine.research`, `Engine.draft`, `Engine.run`). Use-case agnostic.
- `sociai/cli.py`: command line.
- `sociai/compare.py`: runs one case on several models and compares cost, time and drafts.
- `sociai/web.py`: web server, standard library only. Research and drafting run as background jobs (`/api/research`, `/api/draft`, polled at `/api/jobs/<id>`), so the page shows live progress and survives a refresh. The original `/research` and `/draft` endpoints still work. Also serves `/healthz`, the optional invite gate and the usage limits.
- `render.yaml`: Render deploy blueprint.
- `sociai/static/`: the web app (plain HTML, CSS and ES modules, no build step). Projects are saved in the browser's localStorage.
- `examples/`: the student-to-professor demo, with two writing samples.

## Web app

- **Desk**: start new outreach ("Who would you like to reach out to?") and pick up anything in progress. Your background and writing samples are remembered from last time.
- **Research**: a live map of the real searches and page reads the server reports, plus a timestamped field log.
- **Review**: cited facts (each with a source card), recent work, cautions, and threads to choose. Your corrections are marked as yours and sent to the draft step.
- **Draft**: an editor where placeholders are highlighted inline. Refine tone and length (your edits are kept), regenerate, switch between versions, and copy the message. Nothing is ever sent for you.

## Next ideas

- Batch mode: a list of targets with the same goal (with a per-message review step).
- Track replies to learn which hooks work.
