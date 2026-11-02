# Sociai prototype

Research the person you're reaching out to, then draft a personalized message in your own writing voice.

It is one general engine. Every use case (student to professor, job seeker to recruiter, founder to investor, sales, networking, podcast invites) is just a different goal.

## How it works

1. **Research.** Claude searches the web and reads the person's key pages (personal site, lab or company page, papers, posts). It returns a dossier: a summary, cited facts, possible hooks, and cautions such as "two people share this name".
2. **Review.** You check each cited fact, correct or exclude it, and pick the "threads" (hooks) the message should be built around.
3. **Draft.** Claude writes the message using one or two real details, matched to your writing samples (tone, length, greetings, sign-off). Anything it doesn't know becomes a `[PLACEHOLDER]` listed under "check before sending". It never sends anything.

Uses `claude-opus-5-5` with server-side web search and web fetch, plus structured JSON output for both steps.

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

## Files

- `sociai/engine.py`: the engine (`Engine.research`, `Engine.draft`, `Engine.run`). Use-case agnostic.
- `sociai/cli.py`: command line.
- `sociai/web.py`: web server, standard library only. Research and drafting run as background jobs (`/api/research`, `/api/draft`, polled at `/api/jobs/<id>`), so the page shows live progress and survives a refresh. The original `/research` and `/draft` endpoints still work.
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
