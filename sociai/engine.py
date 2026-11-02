"""Core engine: research a person, then draft outreach in the sender's voice.

The engine is deliberately use-case agnostic. Every scenario (student -> professor,
job seeker -> recruiter, founder -> investor, sales, networking, ...) is just a
different `goal` string. Two steps:

  1. research(target, goal)  -> Dossier   (Claude + web search / web fetch)
  2. draft(dossier, request) -> Draft     (Claude, structured JSON output)

Keeping them separate lets the user review (and correct) the research before
anything is written, which is the core trust feature of the product.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import anthropic

MODEL = "claude-opus-5-5"

# Server-side refusal fallback: if a request is declined by a safety classifier,
# the API re-runs it on Anthropic's recommended fallback model in the same call.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

WEB_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 10},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 15},
]


@dataclass
class OutreachRequest:
    target: str                      # a name ("Prof. Jane Doe, MIT CSAIL") and/or a URL
    goal: str                        # what the sender wants out of this message
    sender_background: str = ""      # who the sender is, relevant experience
    writing_samples: list[str] = field(default_factory=list)  # sender's own past writing
    channel: str = "email"           # email | linkedin | cold dm | intro request ...
    max_words: int = 180


@dataclass
class Dossier:
    summary: str                     # who this person is, in a paragraph
    facts: list[dict]                # [{"fact": ..., "source": url, "corrected": bool?}]
    hooks: list[str]                 # specific, genuine angles to connect on
    cautions: list[str]              # things to avoid / uncertainty (e.g. same-name confusion)
    sources: list[str]
    name: str = ""                   # their name as written on a primary source
    headline: str = ""               # current role and affiliation, in a few words
    recent_work: list[dict] = field(default_factory=list)  # [{"title", "detail", "source"}]
    notes: str = ""                  # anything the sender added during review
    reviewed: bool = False           # True once the sender has checked facts and picked hooks

    def as_text(self) -> str:
        who = ", ".join(x for x in (self.name, self.headline) if x)
        lines = [f"WHO: {who}"] if who else []
        lines += [f"SUMMARY: {self.summary}", ""]
        if self.reviewed:
            lines.append("FACTS (checked by the sender; trust [corrected by sender] over any source):")
        else:
            lines.append("FACTS:")
        for f in self.facts:
            mark = " [corrected by sender]" if f.get("corrected") else ""
            lines.append(f"- {f['fact']} [{f.get('source', '')}]{mark}")
        if self.recent_work:
            lines += ["", "RECENT WORK:"]
            lines += [f"- {w['title']}: {w.get('detail', '')} [{w.get('source', '')}]" for w in self.recent_work]
        if self.reviewed:
            lines += ["", "HOOKS THE SENDER CHOSE (build the message around these):"]
        else:
            lines += ["", "POSSIBLE HOOKS:"]
        lines += [f"- {h}" for h in self.hooks]
        if self.cautions:
            lines += ["", "CAUTIONS:"] + [f"- {c}" for c in self.cautions]
        if self.notes:
            lines += ["", f"NOTES FROM THE SENDER: {self.notes}"]
        return "\n".join(lines)


@dataclass
class Draft:
    subject: str
    body: str
    personalization_notes: list[str]  # which researched facts were used and why
    voice_notes: str                  # how the draft mirrors the sender's style
    open_questions: list[str]         # things the sender should verify or fill in


DOSSIER_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"fact": {"type": "string"}, "source": {"type": "string"}},
                "required": ["fact", "source"],
                "additionalProperties": False,
            },
        },
        "recent_work": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "source": {"type": "string"},
                },
                "required": ["title", "detail", "source"],
                "additionalProperties": False,
            },
        },
        "hooks": {"type": "array", "items": {"type": "string"}},
        "cautions": {"type": "array", "items": {"type": "string"}},
        "sources": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "headline", "summary", "facts", "recent_work", "hooks", "cautions", "sources"],
    "additionalProperties": False,
}

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string"},
        "body": {"type": "string"},
        "personalization_notes": {"type": "array", "items": {"type": "string"}},
        "voice_notes": {"type": "string"},
        "open_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["subject", "body", "personalization_notes", "voice_notes", "open_questions"],
    "additionalProperties": False,
}

RESEARCH_SYSTEM = """You research a person before someone reaches out to them.
Focus on what is relevant to the sender's goal, and prefer recent, specific,
verifiable facts over generic bio lines.

How to spend your tools (search is for finding pages, fetch is for reading them):
1. If a URL was given, fetch it first. Otherwise use 1-3 searches to identify the
   person and find their official pages.
2. Fetch primary sources before anything else: personal homepage, lab/team/company
   page, and any "join us", "prospective students", "careers" or contact page.
3. Then fetch the 2-4 most relevant recent items (papers, posts, talks, projects).
4. Don't spend fetches on aggregator or SEO sites (Muck Rack, ZoomInfo, RocketReach,
   etc.) when a primary source exists, and don't re-search for things you can get
   by fetching a page you already found.

Rules:
- Every fact must come from a page you actually saw; cite its URL.
- name is the person's name as written on their own page.
- headline is their current role and affiliation in a few words, as stated on
  a primary source (e.g. "Associate Professor of CS, Stanford").
- recent_work lists 0-4 specific recent papers, projects, posts or talks
  (title, one line on what it is, URL). Leave it empty rather than guess.
- If several people share the name, say so in cautions and pick the one that
  best matches the given context, explaining why.
- Hooks are concrete angles the sender could genuinely connect on (a specific
  paper, project, post, decision), not flattery.
- Don't collect private or sensitive personal information (home address,
  family, health, etc.). Professional/public work only."""

DRAFT_SYSTEM = """You write outreach messages that the sender will review and send
themselves. The message must sound like the sender wrote it, not like an AI.

Rules:
- Match the sender's voice from their writing samples: sentence length,
  formality, greetings/sign-offs, punctuation habits, vocabulary. If no samples
  are given, write plainly and warmly, like a thoughtful person, not a template.
- Use one or two researched details, specifically and accurately. Never invent
  facts about the recipient or the sender. If something is needed but unknown,
  put a [BRACKETED PLACEHOLDER] and list it in open_questions.
- Lead with why this person specifically, make the ask clear and easy to say
  yes to, and respect their time. No buzzwords, no excessive praise.
- Stay within the word limit. For channels without subjects, leave subject empty.
- When asked to revise an existing draft, treat it as the sender's text: they
  may have edited it by hand. Change only what the revision request needs and
  keep their wording everywhere else."""


class Engine:
    def __init__(self, client: anthropic.Anthropic | None = None, model: str = MODEL):
        self.client = client or anthropic.Anthropic()
        self.model = model

    def _create(self, on_block=None, **kwargs):
        """One API call. With on_block, stream it and report each content block as it completes."""
        params = dict(model=self.model, betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
        if on_block is None:
            response = self.client.beta.messages.create(**params)
        else:
            with self.client.beta.messages.stream(**params) as stream:
                for event in stream:
                    if event.type == "content_block_start" and event.content_block.type == "text":
                        on_block(event.content_block, started=True)
                    elif event.type == "content_block_stop":
                        on_block(event.content_block, started=False)
                response = stream.get_final_message()
        if response.stop_reason == "refusal":
            raise RuntimeError("The request was declined. Try rephrasing the goal.")
        return response

    def research(self, req: OutreachRequest, on_progress=None) -> Dossier:
        """on_progress, if given, receives live events as dicts with a "kind" key:
        search {query}, found {results: [{url, title}]}, fetch {url},
        read {url, title}, read_failed {url}, composing {}."""
        prompt = (
            f"Person to research: {req.target}\n"
            f"Sender's goal: {req.goal}\n"
            f"Sender's background: {req.sender_background or '(not given)'}\n\n"
            "Research this person, then give the dossier."
        )
        messages = [{"role": "user", "content": prompt}]
        on_block = _progress_reporter(on_progress) if on_progress else None
        # Server tools can pause a long turn; send it back so the server continues.
        for _ in range(6):
            response = self._create(
                on_block=on_block,
                max_tokens=16000,
                system=RESEARCH_SYSTEM,
                tools=WEB_TOOLS,
                output_config={"effort": "medium", "format": {"type": "json_schema", "schema": DOSSIER_SCHEMA}},
                messages=messages,
            )
            if response.stop_reason != "pause_turn":
                break
            messages.append({"role": "assistant", "content": response.content})
        text = next(b.text for b in response.content if b.type == "text")
        return Dossier(**json.loads(text))

    def draft(self, req: OutreachRequest, dossier: Dossier, revise: dict | None = None) -> Draft:
        """revise, if given, is {"subject", "body", "instruction"}: rework that draft instead of starting over."""
        samples = "\n\n---\n\n".join(req.writing_samples) or "(none given)"
        prompt = (
            f"Channel: {req.channel}\nWord limit: {req.max_words}\n\n"
            f"Sender's goal: {req.goal}\n"
            f"Sender's background: {req.sender_background or '(not given)'}\n\n"
            f"Sender's writing samples:\n{samples}\n\n"
            f"Research on the recipient:\n{dossier.as_text()}\n\n"
        )
        if revise:
            prompt += (
                "Current draft (the sender may have edited it by hand):\n"
                f"Subject: {revise.get('subject', '')}\n\n{revise['body']}\n\n"
                f"Revision request: {revise['instruction']}\n\n"
                "Write the revised draft."
            )
        else:
            prompt += "Write the draft."
        response = self._create(
            max_tokens=8000,
            system=DRAFT_SYSTEM,
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": DRAFT_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        )
        text = next(b.text for b in response.content if b.type == "text")
        return Draft(**json.loads(text))

    def run(self, req: OutreachRequest, on_progress=None) -> tuple[Dossier, Draft]:
        dossier = self.research(req, on_progress)
        return dossier, self.draft(req, dossier)


def _progress_reporter(on_progress):
    """Turn streamed content blocks into the progress events research() documents."""
    fetch_urls = {}  # tool_use_id -> url, so a failed fetch can say which page

    def on_block(block, started):
        if started:
            on_progress({"kind": "composing"})
        elif block.type == "server_tool_use" and block.name == "web_search":
            on_progress({"kind": "search", "query": block.input.get("query", "")})
        elif block.type == "server_tool_use" and block.name == "web_fetch":
            fetch_urls[block.id] = block.input.get("url", "")
            on_progress({"kind": "fetch", "url": fetch_urls[block.id]})
        elif block.type == "web_search_tool_result" and isinstance(block.content, list):
            results = [{"url": r.url, "title": r.title} for r in block.content]
            on_progress({"kind": "found", "results": results})
        elif block.type == "web_fetch_tool_result":
            content = block.content
            if content.type == "web_fetch_result":
                title = getattr(content.content, "title", None) or ""
                on_progress({"kind": "read", "url": content.url, "title": title})
            else:
                on_progress({"kind": "read_failed", "url": fetch_urls.get(block.tool_use_id, "")})

    return on_block
