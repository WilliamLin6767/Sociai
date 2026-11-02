"""Command line: python -m sociai --target ... --goal ... [--samples file ...]"""

import argparse
import json
import sys
from pathlib import Path

from .config import load_env
from .engine import Engine, OutreachRequest


def load_request(args) -> OutreachRequest:
    if args.example:
        data = json.loads(Path(args.example).read_text())
        base = Path(args.example).parent
        samples = [(base / p).read_text() for p in data.pop("writing_sample_files", [])]
        return OutreachRequest(writing_samples=samples, **data)
    if not (args.target and args.goal):
        sys.exit("Need --target and --goal (or --example FILE).")
    samples = [Path(p).read_text() for p in args.samples or []]
    return OutreachRequest(
        target=args.target,
        goal=args.goal,
        sender_background=args.background or "",
        writing_samples=samples,
        channel=args.channel,
        max_words=args.max_words,
    )


def print_progress(event: dict):
    line = {
        "search": lambda e: f"searched: {e['query']}",
        "found": lambda e: f"found {len(e['results'])} pages",
        "fetch": lambda e: f"reading: {e['url']}",
        "read_failed": lambda e: f"couldn't read: {e['url']}",
        "composing": lambda e: "writing the dossier",
    }.get(event["kind"])
    if line:
        print(f"  · {line(event)}", file=sys.stderr)


def main():
    load_env()
    ap = argparse.ArgumentParser(description="Research a person, then draft outreach in your voice.")
    ap.add_argument("--target", help="Name and context, or a URL (e.g. 'Prof. Jane Doe, Stanford NLP')")
    ap.add_argument("--goal", help="What you want from this message")
    ap.add_argument("--background", help="Who you are, briefly")
    ap.add_argument("--samples", nargs="*", help="Text files of your own past writing")
    ap.add_argument("--channel", default="email")
    ap.add_argument("--max-words", type=int, default=180)
    ap.add_argument("--example", help="JSON file with all fields (see examples/)")
    ap.add_argument("--json", action="store_true", help="Print raw JSON output")
    args = ap.parse_args()

    req = load_request(args)
    engine = Engine()
    print(f"Researching {req.target} ...", file=sys.stderr)
    dossier = engine.research(req, on_progress=print_progress)
    print("Drafting ...", file=sys.stderr)
    draft = engine.draft(req, dossier)

    if args.json:
        print(json.dumps({"dossier": dossier.__dict__, "draft": draft.__dict__}, indent=2))
        return

    print("\n=== RESEARCH ===\n" + dossier.as_text())
    print("\n=== DRAFT ===")
    if draft.subject:
        print(f"Subject: {draft.subject}\n")
    print(draft.body)
    print("\n=== WHY IT'S PERSONAL ===")
    print("\n".join(f"- {n}" for n in draft.personalization_notes))
    print(f"\nVoice: {draft.voice_notes}")
    if draft.open_questions:
        print("\n=== CHECK BEFORE SENDING ===")
        print("\n".join(f"- {q}" for q in draft.open_questions))
