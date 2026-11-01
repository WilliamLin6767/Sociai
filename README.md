# Sociai prototype

Research the person you're reaching out to, then draft a personalized message in your own writing voice.

It is one general engine. Every use case (student to professor, job seeker to recruiter, founder to investor, sales, networking, podcast invites) is just a different goal.

## How it works

1. **Research.** Claude searches the web and reads the person's key pages (personal site, lab or company page, papers, posts). It returns a dossier: a summary, cited facts, possible hooks, and cautions such as "two people share this name".
2. **Review.** You see the research and can correct it before anything is written.
3. **Draft.** Claude writes the message using one or two real details, matched to your writing samples (tone, length, greetings, sign-off). Anything it doesn't know becomes a `[PLACEHOLDER]` listed under "check before sending". It never sends anything.

Uses `claude-opus-5-5` with server-side web search and web fetch, plus structured JSON output for both steps.

## Run it

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...      # web search must be enabled for your org in the Claude Console

# Web UI (pick a use case from the dropdown)
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
- `sociai/web.py`: single-page web UI, standard library only.
- `examples/`: the student-to-professor demo, with two writing samples.

## Next ideas

- Save a voice profile per user so samples are only pasted once.
- Batch mode: a list of targets with the same goal (with a per-message review step).
- Track replies to learn which hooks work.
