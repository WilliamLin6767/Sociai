"""Run one outreach case on several models and compare cost, time and drafts.

  python -m sociai.compare
  python -m sociai.compare --models claude-opus-5-5 claude-sonnet-5-5 --save compare.json

Each model does its own research and draft, the same way the web app does before
review. This spends real API credits: roughly one research and one draft per model.
"""

import argparse
import json
import shutil
import sys
import textwrap
import time
from pathlib import Path

from .cli import load_request
from .engine import Engine, RunUsage

EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "student_professor.json"


def run_model(model, req):
    engine = Engine(model=model)
    out = {"model": model}
    for step in ("research", "draft"):
        out[step] = {"usage": RunUsage(), "seconds": 0.0}
    try:
        print(f"[{model}] researching...", file=sys.stderr, flush=True)
        started = time.time()
        dossier = engine.research(req, usage=out["research"]["usage"])
        out["research"]["seconds"] = time.time() - started
        print(f"[{model}] drafting...", file=sys.stderr, flush=True)
        started = time.time()
        draft = engine.draft(req, dossier, usage=out["draft"]["usage"])
        out["draft"]["seconds"] = time.time() - started
        out["draft_text"] = (f"Subject: {draft.subject}\n\n" if draft.subject else "") + draft.body
        out["open_questions"] = draft.open_questions
    except Exception as e:  # keep going so the other model's result still prints
        out["error"] = f"{type(e).__name__}: {e}"
        print(f"[{model}] failed: {out['error']}", file=sys.stderr, flush=True)
    return out


def print_costs(results):
    rows = [("model", "step", "time", "input", "output", "cache rd", "search", "fetch", "cost")]
    for r in results:
        for step in ("research", "draft"):
            u, secs = r[step]["usage"], r[step]["seconds"]
            served = "+".join(u.models) if u.models and u.models != [r["model"]] else ""
            rows.append((r["model"] + (f" (served by {served})" if served else ""), step, f"{secs:.0f}s",
                         f"{u.input_tokens:,}", f"{u.output_tokens:,}", f"{u.cache_read_tokens:,}",
                         str(u.web_searches), str(u.web_fetches), f"${u.cost:.4f}"))
        total = r["research"]["usage"].cost + r["draft"]["usage"].cost
        secs = r["research"]["seconds"] + r["draft"]["seconds"]
        rows.append(("", "total", f"{secs:.0f}s", "", "", "", "", "", f"${total:.4f}"))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for i, row in enumerate(rows):
        print("  ".join(cell.ljust(w) if j < 2 else cell.rjust(w) for j, (cell, w) in enumerate(zip(row, widths))))
        if i == 0:
            print("  ".join("-" * w for w in widths))
    unpriced = {m for r in results for s in ("research", "draft") for m in r[s]["usage"].unpriced_models}
    if unpriced:
        print(f"\nNot priced (missing from PRICES, so their cost is left out): {', '.join(sorted(unpriced))}")
    print("Costs are estimates from the price table in sociai/engine.py.")


def print_side_by_side(results):
    width = max(30, (shutil.get_terminal_size((120, 40)).columns - 3) // len(results))
    columns = []
    for r in results:
        text = r.get("draft_text") or f"(no draft: {r.get('error', 'unknown error')})"
        lines = [r["model"], "=" * min(width, len(r["model"]))]
        for para in text.split("\n"):
            lines += textwrap.wrap(para, width) or [""]
        if r.get("open_questions"):
            lines += ["", "Check before sending:"]
            for q in r["open_questions"]:
                lines += textwrap.wrap(q, width, initial_indent="- ", subsequent_indent="  ")
        columns.append(lines)
    for i in range(max(len(c) for c in columns)):
        print(" | ".join((c[i] if i < len(c) else "").ljust(width) for c in columns).rstrip())


def main():
    ap = argparse.ArgumentParser(description="Compare cost, time and drafts across models. Spends real API credits.")
    ap.add_argument("--example", default=str(EXAMPLE), help="JSON case file (default: examples/student_professor.json)")
    ap.add_argument("--models", nargs="+", default=["claude-opus-5-5", "claude-sonnet-5-5"])
    ap.add_argument("--save", help="Also write the full results to this JSON file")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    req = load_request(args)
    results = [run_model(m, req) for m in args.models]

    print("\n=== COST AND TIME ===\n")
    print_costs(results)
    print("\n=== DRAFTS ===\n")
    print_side_by_side(results)

    if args.save:
        data = [{**r, **{s: {"seconds": round(r[s]["seconds"], 1), "usage": r[s]["usage"].summary()}
                         for s in ("research", "draft")}} for r in results]
        Path(args.save).write_text(json.dumps(data, indent=2), encoding="utf-8")
        print(f"\nSaved to {args.save}")


if __name__ == "__main__":
    main()
