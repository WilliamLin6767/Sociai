"""Web app server (python -m sociai.web -> http://localhost:8000).

The page lives in sociai/static/. Users sign in with Supabase (email and password) and
every /api/* call carries their access token as "Authorization: Bearer <token>".
Credits, limits and job records live in Postgres (supabase/migrations/); the server
changes them only through the database functions defined there.

  GET  /api/config         public: the Supabase URL and anon key for the browser
  POST /api/check-email    public: {email} -> 400 if the domain isn't accepted
  GET  /api/me             {email, credits, blocked}
  POST /api/research       {request, project_id}                     -> {job, credits}
  POST /api/draft          {request, dossier, project_id, revise?}   -> {job, credits, drafts_left}
  GET  /api/jobs/<id>?after=N  -> {status, events (from index N), result, error}
  GET  /api/profile        background, defaults, writing samples, resume text
  PUT  /api/profile        {background?, default_channel?, default_max_words?, resume_text?,
                            main_goal?, main_goal_note?}
  POST /api/profile/onboarded    onboarding is over (finished or skipped); only the first call counts
  PUT  /api/profile/samples      {samples: [text, ...]}  (replaces the list)
  POST /api/profile/resume?filename=...   raw PDF or DOCX body, up to 5 MB
  DELETE /api/profile/resume
  GET  /api/projects?q=    the user's projects, newest first (summaries only)
  GET / PUT / DELETE /api/projects/<id>   one project's full saved state
  DELETE /api/account      {confirm: "DELETE"}: the account and all its data
  GET  /api/account        balance, billing status, credit history
  GET  /api/pricing        the two plans, with prices from Stripe
  POST /api/checkout       {plan: "pack" | "monthly"} -> {url} of a Stripe Checkout page
  POST /api/billing-portal -> {url} of the Stripe customer portal
  POST /api/stripe/webhook public; Stripe-signed events add credits (once per event)
  POST /api/event          public: {name, where?, utm_source?, fbclid?}: a funnel step the browser
                           reports (landing_view, cta_click, signup_started, signup_done,
                           first_draft). Counted per day; nothing about the visitor is kept.
  POST /api/demo           public: {target, goal, purpose?} -> {id}: the landing-page demo, one
                           per IP per day, on the cheapest model; no credits involved
  GET  /api/demo/<id>?after=N   {status, events, teaser}: progress, then a teaser of the result
  POST /api/demo/claim     {id} -> the demo's full research and draft, for the account that
                           signed up after seeing it (once)
  POST /api/profile/attribution  {utm_source?, utm_medium?, utm_campaign?, fbclid?} once per user
  GET  /api/funnel         daily funnel counts; needs SOCIAI_ADMIN_TOKEN (Bearer or ?token=)
  GET  /api/contacts?today=YYYY-MM-DD      the outreach tracker: {contacts: [...]}, newest first
  POST /api/contacts                       {name, email?, role?, organization?, subject?, status?,
                                            sent_at?, replied_at?, follow_up_at?, notes?} -> {contact}
  PATCH / DELETE /api/contacts/<id>        change or delete one; tracker calls never use credits
  GET  /healthz            -> {"ok": true}
  GET  /                  the public landing page; the app itself is at /app
  GET  /privacy, /terms    the Privacy Policy and Terms (static pages)
  GET  /robots.txt, /sitemap.xml

Profile and project calls run as the user (their own token), so the database's
row-level security applies to them as well.

Research and drafting run as background jobs so the page shows live progress and can
pick a job back up after a refresh. Messages are never sent on the user's behalf.
Settings come from environment variables or a local .env file (see .env.example).
"""

import base64
import hashlib
import hmac
import json
import math
import mimetypes
import os
import re
import threading
import time
import traceback
import uuid
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import anthropic
import stripe

from . import monitoring, tracker
from .billing import PLANS, Billing, BillingError
from .config import Settings, is_disposable, load_env
from .engine import Dossier, Engine, OutreachRequest, Refused, RunUsage, clean_contact
from .resume import KINDS, MAX_BYTES as MAX_RESUME, MAX_TEXT as MAX_RESUME_TEXT, ResumeError, detect, extract_text
from .supabase import Supabase, SupabaseError, SupabaseRefused

STATIC = Path(__file__).parent / "static"
# Windows can map these from the registry (e.g. .js -> text/plain), which breaks modules.
for ext, kind in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml"),
                  (".txt", "text/plain"), (".xml", "application/xml"), (".ico", "image/x-icon")):
    mimetypes.add_type(kind, ext)
JOB_TTL = 3600     # seconds a finished job is kept for a refreshed page to collect
MAX_BODY = 200 * 1024
MAX_PROJECT_BODY = 2_100_000  # the database caps a project's saved state at 2 MB
DRAIN_LIMIT = 16 * 1024 * 1024  # oversized bodies up to this size are read so the 413 reaches the client
CHANNELS = ("email", "linkedin", "direct message")
MAIN_GOALS = ("", "research", "job", "fundraising", "sales", "networking", "other")
RESUME_BUCKET = "resumes"
MAX_WEBHOOK_BODY = 1024 * 1024
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TOKEN_TTL = 60     # seconds a verified access token is trusted before asking Supabase again
PROJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CONTACTS = "outreach_contacts"
CONTACT_PATH = re.compile(r"^/api/contacts/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$")
MAX_CONTACTS = 2000  # the database caps each account at this many
PAGES = {"/": "landing.html", "/app": "app.html", "/privacy": "privacy.html", "/terms": "terms.html"}
REDIRECTS = {"/app/": "/app", "/index.html": "/", "/landing.html": "/", "/app.html": "/app",
             "/privacy.html": "/privacy", "/terms.html": "/terms"}
# Cloudflare (in front of the site) turns static files' Cache-Control into a 4-hour browser cache, so
# after a deploy a browser could pair new HTML with an old stylesheet. Pages and modules therefore
# link their CSS and JS as /file?v=<hash of all of them>: every deploy that changes one changes all
# the URLs, and a versioned file can be cached for good. Anything else is served with no-cache.
ASSET_VERSION = hashlib.sha256(b"".join(p.read_bytes() for p in sorted(STATIC.glob("*")) if p.suffix in (".css", ".js"))).hexdigest()[:12]
PAGE_ASSET = re.compile(r'((?:href|src)="/[\w.-]+\.(?:css|js))"')  # <link href="/sociai.css">, <script src="/app.js">
MODULE_IMPORT = re.compile(r'(from\s+"\./[\w.-]+\.js)"')      # import ... from "./store.js"
IMMUTABLE = "public, max-age=31536000, immutable"
# Links that belong to the app but may still arrive at / : email links sent before the app moved
# to /app (or sent to Supabase's Site URL) and Stripe Checkout sessions started before the move.
APP_QUERY = ("auth", "code", "token_hash", "error_description", "checkout")

# ───────── Security headers ─────────
#
# Pages get a Content-Security-Policy that names every origin they load from. Inline scripts (the
# theme switch and the Meta Pixel on the public pages) are allowed by hash, computed from the files
# here, so no 'unsafe-inline' script is ever allowed. Adding a third-party script means adding its
# origin to csp() as well.
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\ssrc=)[^>]*>(.*?)</script>", re.S | re.I)


def inline_script_hashes(html: str) -> list[str]:
    return [f"'sha256-{base64.b64encode(hashlib.sha256(s.encode()).digest()).decode()}'" for s in INLINE_SCRIPT.findall(html)]


PAGE_HASHES = {name: inline_script_hashes((STATIC / name).read_text(encoding="utf-8")) for name in PAGES.values()}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
}
HSTS = "max-age=31536000; includeSubDomains"
NO_CONTENT_CSP = "default-src 'none'; frame-ancestors 'none'"


def csp(page: str) -> str:
    """The Content-Security-Policy for one of the HTML pages."""
    scripts = ["'self'", "https://cdn.jsdelivr.net", "https://connect.facebook.net", *PAGE_HASHES.get(page, [])]
    connect = ["'self'", settings.supabase_url, "https://www.facebook.com", "https://connect.facebook.net"]
    return "; ".join([
        "default-src 'self'",
        "script-src " + " ".join(scripts),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https://www.facebook.com",
        "connect-src " + " ".join(c for c in connect if c),
        "frame-src https://www.facebook.com",
        "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'",
    ])


# ───────── Rate limits ─────────
#
# Sliding windows per key, in this process's memory (one server instance). The budgets are per
# minute. Credits and the database's own caps bound the real cost of research and drafts; these
# limits keep one connection from hammering Supabase (token checks), Stripe or the parsers.
RATE = {
    "api": 600,      # every /api call except job polling, per IP (a campus network shares one)
    "poll": 300,     # /api/jobs/<id> polls, per user (two running jobs poll about 130 times a minute)
    "verify": 60,    # access tokens checked with Supabase, per IP (valid ones are cached for a minute)
    "public": 30,    # /api/check-email, per IP
    "job": 10,       # research and draft starts, per user
    "billing": 10,   # checkout and portal sessions, per user
    "upload": 10,    # resume uploads, per user
    "delete": 5,     # account deletion attempts, per user
}
RATE_WINDOW = 60


class Limiter:
    def __init__(self):
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()
        self._swept = 0.0

    def check(self, key: str, limit: int, window: int = RATE_WINDOW) -> float:
        """0 if this request is allowed (and counted); otherwise the seconds until one would be."""
        now = time.time()
        with self._lock:
            if now - self._swept > window:  # drop keys that went quiet
                self._swept = now
                for k in [k for k, q in self._hits.items() if not q or q[-1] < now - window]:
                    del self._hits[k]
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                return q[0] + window - now
            q.append(now)
            return 0.0

    def release(self, key: str):
        """Give back the most recent count for a key (e.g. a demo that failed)."""
        with self._lock:
            q = self._hits.get(key)
            if q:
                q.pop()

    def reset(self):
        with self._lock:
            self._hits.clear()


limiter = Limiter()

# ───────── Funnel events ─────────
#
# Each step of the funnel is counted per UTC day: in this process (for the running totals in the
# log line) and in the events table (sociai_count_event, so counts survive deploys and GET
# /api/funnel can show them). Nothing about the visitor is kept: only the step, which button, the
# utm_source and whether an fbclid was there.
FUNNEL = ("landing_view", "demo_used", "signup_started", "signup_done", "first_draft", "checkout")
CLIENT_EVENTS = ("landing_view", "cta_click", "signup_started", "signup_done", "first_draft")  # the browser may report these
SERVER_EVENTS = ("demo_used", "demo_claimed", "checkout")                                      # only the server records these
WORD = re.compile(r"[^A-Za-z0-9_.-]")
_events: dict = {"day": None}
_events_lock = threading.Lock()
_events_warned = False


def record_event(name: str, where: str = "", utm_source: str = "", fbclid: bool = False) -> dict:
    """Count an event and print one log line; returns the day's totals so far."""
    global _events_warned
    today = datetime.now(timezone.utc).date().isoformat()
    with _events_lock:
        if _events["day"] != today:
            _events.clear()
            _events["day"] = today
        _events[name] = _events.get(name, 0) + 1
        totals = {k: v for k, v in _events.items() if k != "day"}
    views, signups = totals.get("landing_view", 0), totals.get("signup_done", 0)
    rate = f"{100 * signups / views:.1f}%" if views else "-"
    keys = [k for k in FUNNEL if k in totals] + [k for k in totals if k not in FUNNEL]
    print(f"[event] {name}{' where=' + where if where else ''} utm_source={utm_source or '-'} fbclid={'yes' if fbclid else 'no'}"
          f" | today " + " ".join(f"{k}={totals[k]}" for k in keys) + f" signup_rate={rate}", flush=True)
    if supa is not None:
        def persist():
            global _events_warned
            try:
                supa.rpc("sociai_count_event", p_name=name)
            except Exception as e:  # best effort: a count is never worth an error
                if not _events_warned:  # e.g. the migration hasn't been run yet; say so once
                    _events_warned = True
                    print(f"[event] not saved to the database ({e}); run the demo_and_funnel migration", flush=True)
        threading.Thread(target=persist, daemon=True).start()
    return totals


def funnel_text(rows: list) -> str:
    """The funnel as a plain-text table, newest day first."""
    names = list(FUNNEL)
    widths = [max(len(n), 6) for n in names]
    lines = ["day         " + " ".join(n.rjust(w) for n, w in zip(names, widths))]
    for row in rows:
        counts = row.get("counts") or {}
        lines.append(f"{row.get('day', '')}  " + " ".join(str(counts.get(n, 0)).rjust(w) for n, w in zip(names, widths)))
    if len(rows) > 0:
        total = {n: sum((r.get("counts") or {}).get(n, 0) for r in rows) for n in names}
        lines.append("total       " + " ".join(str(total[n]).rjust(w) for n, w in zip(names, widths)))
        views = total["landing_view"]
        if views:
            lines.append("")
            lines.append("of landing views: " + ", ".join(f"{n} {100 * total[n] / views:.1f}%" for n in names[1:]))
    return "\n".join(lines) + "\n"


# ───────── The landing-page demo ─────────
#
# A visitor names a person and a goal; the server researches them and writes a draft on the
# cheapest model with a small search budget, then shows a teaser (the summary, two facts and the
# first lines of the email). The whole result is kept, keyed by the demo id the browser holds, so
# the account they create next can claim it and find the full draft waiting. One demo per IP per
# day, a daily cap across everyone, and no credits anywhere.
DEMO_SEARCHES, DEMO_FETCHES = 2, 3
DEMO_WORDS = 130
DEMO_CALL_TIMEOUT = 90        # seconds per API call; Haiku finishes a demo's research in about 30
DEMO_FETCH_TOKENS = 20000     # per page read: a faculty page is a few thousand tokens; three unbounded pages were 229k
DEMO_DRAFT_RETRIES = 3        # the draft is a small call right after a big one; a per-minute token limit can refuse it at first
DEMO_TTL = 24 * 3600          # seconds a demo is kept in memory (the database keeps it longer)
DEMO_PURPOSES = {
    "research": ("professor", "Ask whether their group takes undergraduate research assistants, or for a short call about open projects."),
    "job": ("recruiter", "Ask about internship or new-grad openings on their team, or for a referral."),
    "advice": ("advice", "Ask for 15 minutes of advice about their path."),
}
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
demos: dict[str, dict] = {}   # demo id -> {job, target, goal, purpose, ip_hash, created, result?, claimed_by?}
_demos_lock = threading.Lock()


def demo_teaser(result: dict) -> dict:
    """What the landing page may show: the research summary, two facts, and the first two
    sentences of the email. The rest stays on the server until the visitor signs up."""
    d, draft = result["dossier"], result["draft"]
    body = (draft.get("body") or "").strip()
    paragraphs = [p for p in body.split("\n") if p.strip()]
    greeting = paragraphs[0] if paragraphs and len(paragraphs[0]) < 60 else ""
    rest = "\n".join(paragraphs[1:] if greeting else paragraphs)
    sentences = SENTENCE_END.split(rest.strip())
    shown = " ".join(sentences[:2]).strip()
    hidden_words = max(0, len(rest.split()) - len(shown.split()))
    return {
        "name": d.get("name") or "", "headline": d.get("headline") or "",
        "summary": " ".join(SENTENCE_END.split((d.get("summary") or "").strip())[:2])[:320],
        "facts": [{"fact": f.get("fact", ""), "source": f.get("source", "")} for f in (d.get("facts") or [])[:2] if isinstance(f, dict)],
        "sources": len(d.get("sources") or []),
        "subject": draft.get("subject") or "", "greeting": greeting, "opening": shown,
        "hidden_words": hidden_words, "words": len(body.split()),
    }


def demo_work(demo_id: str, target: str, goal: str, purpose: str, ip: str):
    req = OutreachRequest(target=target, goal=goal, channel="email", max_words=DEMO_WORDS)
    ip_hash = hashlib.sha256(ip.encode()).hexdigest()[:32]

    def run(emit, usage):
        try:
            dossier = demo_engine.research(req, on_progress=emit, usage=usage)
            emit({"kind": "drafting"})
            for attempt in range(DEMO_DRAFT_RETRIES):
                try:
                    draft = demo_engine.draft(req, dossier, usage=usage)
                    break
                except anthropic.RateLimitError:
                    if attempt == DEMO_DRAFT_RETRIES - 1:
                        raise
                    time.sleep(20)  # per-minute limits reset quickly
        except Exception:
            limiter.release(f"demo_ip:{ip}")  # a failed demo doesn't use up the visitor's one a day
            raise
        result = {"dossier": dossier.__dict__, "draft": draft.__dict__}
        with _demos_lock:
            if demo_id in demos:
                demos[demo_id]["result"] = result
        if supa is not None:
            try:
                supa.rpc("sociai_save_demo", p_id=demo_id, p_ip_hash=ip_hash, p_target=target, p_goal=goal,
                         p_purpose=purpose, p_dossier=result["dossier"], p_draft=result["draft"])
            except SupabaseError as e:
                print(f"[demo] {demo_id} kept in memory only ({e})", flush=True)
        return result

    return run


def forget_old_demos():
    now = time.time()
    with _demos_lock:
        for key in [k for k, d in demos.items() if now - d["created"] > DEMO_TTL]:
            del demos[key]


# Caps on what a research or draft request may carry into a prompt (the profile has the same ones).
REQUEST_LIMITS = {"target": 500, "goal": 2000, "sender_background": 20000}
MAX_SAMPLES, MAX_SAMPLE = 10, 20000
MAX_DOSSIER = 100_000      # characters of JSON the browser may send back as the research
MAX_REVISE_BODY, MAX_INSTRUCTION = 20000, 2000

# Set by setup(): main() loads .env first; tests pass their own settings and engine.
settings: Settings = Settings()
supa: Supabase | None = None
engine: Engine | None = None
billing: Billing | None = None
billing_off_reason = ""


demo_engine: Engine | None = None


def setup(new_settings: Settings, new_engine: Engine | None = None):
    global settings, supa, engine, demo_engine, billing, billing_off_reason
    settings = new_settings
    supa = Supabase(settings.supabase_url, settings.supabase_anon_key, settings.supabase_service_key) \
        if not settings.missing() else None
    engine = new_engine or Engine()
    # The landing-page demo: the cheapest model and a small research budget, so a run costs cents.
    demo_engine = Engine(client=engine.client, model=settings.demo_model)
    demo_engine.max_searches, demo_engine.max_fetches = DEMO_SEARCHES, DEMO_FETCHES
    demo_engine.timeout = DEMO_CALL_TIMEOUT  # a stalled call fails the demo instead of pinning it
    demo_engine.fetch_tokens = DEMO_FETCH_TOKENS
    billing, billing_off_reason = Billing.from_settings(settings)


class Reject(Exception):
    """An HTTP error to send back as {"error": message}."""

    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code, self.extra = code, extra


def limit_or_reject(kind: str, who: str):
    """Count one request of this kind for an IP or a user; 429 when its budget for the minute is spent."""
    wait = limiter.check(f"{kind}:{who}", RATE[kind])
    if wait:
        raise Reject(429, "Too many requests from your connection. Wait a minute and try again.", retry_after=math.ceil(wait))


SUPPORT_EMAIL = "supportsociai613@gmail.com"
GENERIC_ERROR = f"Something went wrong on the server. Try again, and email {SUPPORT_EMAIL} if it keeps happening."
CANCEL_FAILED = (f"Your account wasn't deleted: we couldn't cancel your monthly plan with Stripe, and we won't delete "
                 f"an account that could still be charged. Try again in a minute, or email {SUPPORT_EMAIL}.")


def public_error(e: Exception) -> str:
    """What the browser may see about a failure. Details stay in the server log."""
    traceback.print_exception(e)
    if isinstance(e, Refused):
        return str(e)
    monitoring.capture(e)
    busy = isinstance(e, (anthropic.RateLimitError, anthropic.APIConnectionError)) or (
        isinstance(e, anthropic.APIStatusError) and e.status_code >= 500)
    return "The AI service is busy right now. Try again in a minute." if busy else GENERIC_ERROR


BLOCKED = {
    "disposable_email": "Sociai doesn't accept disposable email addresses. Sign in with your usual email instead.",
    "too_many_accounts": "Too many new accounts were created from your network today. Please try again tomorrow.",
}
START_ERRORS = {  # sociai_start_job error code -> (HTTP status, message)
    "no_credits": (402, "You're out of credits. Get more on the Pricing page: each credit covers one research run "
                        "and up to 3 drafts."),
    "draft_limit": (402, "You've used the 3 drafts included with this research. Re-running the research "
                         "(1 credit) adds 3 more."),
    "no_research": (409, "Research this person first. Drafts come with a finished research run."),
    "too_many_running": (429, "You already have 2 research or draft jobs running. Wait for one to finish."),
    "global_limit": (429, "Sociai has reached its limit for today. Please try again tomorrow."),
}


# ───────── Token checks ─────────

_tokens: dict[str, tuple[dict | None, float]] = {}
_tokens_lock = threading.Lock()
TOKEN_MISS_TTL = 10  # seconds an invalid token is remembered, so a stale session's polling doesn't ask Supabase each time


def verify_token(token: str, ip: str = "") -> dict | None:
    """The Supabase user for an access token (cached briefly), or None if it isn't valid.
    Uncached checks count against the IP's "verify" budget: made-up tokens would otherwise turn
    into one Supabase call each, all from this server's address."""
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.time()
    with _tokens_lock:
        hit = _tokens.get(key)
        if hit and hit[1] > now:
            return hit[0]
    if ip:
        limit_or_reject("verify", ip)
    user = supa.get_user(token)
    with _tokens_lock:
        if len(_tokens) > 5000:
            _tokens.clear()
        _tokens[key] = (user, now + (TOKEN_TTL if user else TOKEN_MISS_TTL))
    return user


# ───────── Jobs ─────────

def log_run(kind, usage: RunUsage, seconds, status):
    """One line per research or draft run, so spend shows up in the server log."""
    u = usage.summary()
    models = "+".join(u["models"]) or "-"
    print(f"[run] {kind} {status} {seconds:.1f}s model={models}{' (fallback)' if u['fell_back'] else ''} "
          f"in={u['input_tokens']} out={u['output_tokens']} cache_read={u['cache_read_tokens']} "
          f"searches={u['web_searches']} fetches={u['web_fetches']} cost=${u['cost_usd']:.4f}"
          + (f" unpriced={','.join(u['unpriced_models'])}" if u["unpriced_models"] else ""), flush=True)


class Job:
    def __init__(self, job_id, work, kind, user_id, record=True):
        """record: the job has a row in the database to close (demos don't)."""
        self.id, self.kind, self.user_id, self.record = job_id, kind, user_id, record
        self.events, self.result, self.error = [], None, None
        self.status = "running"
        self.usage = RunUsage()
        self.created = time.time()
        self.lock = threading.Lock()
        threading.Thread(target=self._run, args=(work,), daemon=True).start()

    def _run(self, work):
        try:
            result = {**work(self.emit, self.usage), "usage": self.usage.summary()}
            with self.lock:
                self.result, self.status = result, "done"
        except Exception as e:
            message = public_error(e)
            with self.lock:
                self.error, self.status = message, "error"
        finally:
            log_run(self.kind, self.usage, time.time() - self.created, self.status)
            if not self.record:
                return
            try:  # records the outcome; a failed research run gets its credit back here
                supa.rpc("sociai_finish_job", p_job=self.id, p_status=self.status, p_usage=self.usage.summary())
            except SupabaseError as e:
                print(f"[run] couldn't record job {self.id} as {self.status}: {e}", flush=True)

    def emit(self, event):
        with self.lock:
            self.events.append({**event, "t": time.time() - self.created})

    def snapshot(self, after):
        with self.lock:
            return {"status": self.status, "events": self.events[after:], "total": len(self.events),
                    "result": self.result, "error": self.error}


jobs: dict[str, Job] = {}


def keep_job(job: Job):
    now = time.time()
    for key in [k for k, j in jobs.items() if now - j.created > JOB_TTL]:
        del jobs[key]
    jobs[job.id] = job


# These check the body and build the request objects up front, so a malformed or oversized
# request fails with a 400 before any credit is spent or a job thread starts.
def clean_request(raw) -> dict:
    """The fields of OutreachRequest the browser may set, within the same caps as the profile."""
    if not isinstance(raw, dict):
        raise Reject(400, "The request needs a request object.")
    out = {}
    for field, limit in REQUEST_LIMITS.items():
        value = raw.get(field) or ""
        if not isinstance(value, str):
            raise Reject(400, f"{field} must be text.")
        if len(value) > limit:
            raise Reject(400, f"{field} can be up to {limit:,} characters.")
        out[field] = value
    if not out["target"].strip() or not out["goal"].strip():
        raise Reject(400, "Say who this is for and what you're asking for.")
    samples = raw.get("writing_samples") or []
    if not isinstance(samples, list) or not all(isinstance(s, str) for s in samples):
        raise Reject(400, "writing_samples must be a list of texts.")
    samples = [s.strip() for s in samples if s.strip()]
    if len(samples) > MAX_SAMPLES:
        raise Reject(400, f"You can use up to {MAX_SAMPLES} writing samples.")
    if any(len(s) > MAX_SAMPLE for s in samples):
        raise Reject(400, f"Each writing sample can be up to {MAX_SAMPLE:,} characters.")
    channel = raw.get("channel") or "email"
    if channel not in CHANNELS:
        raise Reject(400, "Choose email, LinkedIn or direct message as the channel.")
    words = raw.get("max_words", 160)
    if isinstance(words, bool) or not isinstance(words, (int, float)) or words != int(words) or not 40 <= words <= 600:
        raise Reject(400, "The word limit must be between 40 and 600.")
    return {**out, "writing_samples": samples, "channel": channel, "max_words": int(words)}


def clean_dossier(raw) -> Dossier:
    """The research as the browser sends it back (with the sender's corrections), checked."""
    if not isinstance(raw, dict):
        raise Reject(400, "The request needs the research to draft from.")
    if len(json.dumps(raw)) > MAX_DOSSIER:
        raise Reject(400, "The research sent back is too large.")
    try:
        dossier = Dossier(**raw)
        dossier.contact = clean_contact(dossier.contact)
        dossier.as_text()  # every list has the shape the prompt builder expects
    except (TypeError, KeyError, AttributeError, ValueError):
        raise Reject(400, "The research is missing fields or has the wrong shape.")
    return dossier


def research_work(data, resume_text=""):
    req = OutreachRequest(**clean_request(data.get("request")))
    return lambda emit, usage: engine.research(req, on_progress=emit, usage=usage).__dict__


def draft_work(data, resume_text=""):
    # The resume comes from the user's saved profile, never from the request body.
    req = OutreachRequest(**clean_request(data.get("request")), resume_text=resume_text)
    dossier = clean_dossier(data.get("dossier"))
    revise = data.get("revise")
    if revise is not None:
        if not (isinstance(revise, dict) and {"body", "instruction"} <= revise.keys()):
            raise Reject(400, "A revision needs the current draft and an instruction.")
        if not all(isinstance(revise.get(k, ""), str) for k in ("subject", "body", "instruction")):
            raise Reject(400, "A revision's fields must be text.")
        if len(revise["body"]) > MAX_REVISE_BODY or len(revise.get("subject", "")) > 500:
            raise Reject(400, f"The draft to revise can be up to {MAX_REVISE_BODY:,} characters.")
        if len(revise["instruction"]) > MAX_INSTRUCTION:
            raise Reject(400, f"A revision request can be up to {MAX_INSTRUCTION:,} characters.")
    return lambda emit, usage: engine.draft(req, dossier, revise=revise, usage=usage).__dict__


JOB_ROUTES = {"/api/research": (research_work, "research"), "/api/draft": (draft_work, "draft")}


# ───────── HTTP ─────────

class Handler(BaseHTTPRequestHandler):
    body_read = False  # set once this request's body has been read (one request per connection)
    timeout = 30       # seconds of silence before a connection is dropped, so idle sockets can't pin threads

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/healthz":
            return self._json(200, {"ok": True})
        # Render and Cloudflare redirect plain HTTP themselves; this is the backstop behind them.
        if settings.trust_proxy and self.headers.get("X-Forwarded-Proto") == "http" and self.headers.get("Host"):
            return self._redirect(f"https://{self.headers['Host']}{self.path}", code=301)
        if url.path.startswith("/api/"):
            return self._api(self._get_api, url)
        if url.path in REDIRECTS or (url.path == "/" and any(k in parse_qs(url.query) for k in APP_QUERY)):
            target = REDIRECTS.get(url.path, "/app")
            return self._redirect(target + (f"?{url.query}" if url.query else ""))
        name = PAGES.get(url.path) or url.path.lstrip("/")
        path = (STATIC / name).resolve()
        if not path.is_file() or STATIC.resolve() not in path.parents:
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        body = path.read_bytes()
        if path.suffix in (".html", ".js"):
            body = (PAGE_ASSET if path.suffix == ".html" else MODULE_IMPORT).sub(
                rf'\1?v={ASSET_VERSION}"', body.decode()).encode()
        versioned = path.suffix in (".css", ".js") and parse_qs(url.query).get("v") == [ASSET_VERSION]
        self._send(200, body, ctype, cache=IMMUTABLE if versioned else "no-cache", page=name if path.suffix == ".html" else None)

    def do_HEAD(self):
        self.do_GET()  # _send leaves the body out

    def do_POST(self):
        self._api(self._post_api, urlparse(self.path))

    def do_PUT(self):
        self._api(self._put_api, urlparse(self.path))

    def do_DELETE(self):
        self._api(self._delete_api, urlparse(self.path))

    def do_PATCH(self):
        self._api(self._patch_api, urlparse(self.path))

    def _api(self, handler, url):
        try:
            if not url.path.startswith("/api/jobs/") and url.path != "/api/stripe/webhook":
                limit_or_reject("api", self._client_ip())  # polls have a per-user budget; Stripe retries on 429
            handler(url)
        except Reject as r:
            headers = {"Retry-After": str(r.extra["retry_after"])} if "retry_after" in r.extra else None
            self._json(r.code, {"error": str(r), **r.extra}, headers=headers)
        except SupabaseRefused as e:
            self._json(409, {"error": str(e)})
        except SupabaseError as e:
            print(f"[supabase] {e}", flush=True)
            monitoring.capture(e)
            self._json(503, {"error": "Sociai can't reach its account service right now. Try again in a minute."})
        except BillingError as e:
            self._json(e.status, {"error": str(e)})
        except stripe.StripeError as e:
            print(f"[stripe] {type(e).__name__}: {e}", flush=True)
            monitoring.capture(e)
            self._json(502, {"error": "Payments aren't available right now. Try again in a minute."})
        except Exception as e:  # a bug: log it, report it, and answer instead of dropping the connection
            traceback.print_exception(e)
            monitoring.capture(e)
            self._json(500, {"error": GENERIC_ERROR})

    def _get_api(self, url):
        if url.path == "/api/config":
            return self._json(200, {"configured": supa is not None, "supabase_url": settings.supabase_url,
                                    "supabase_anon_key": settings.supabase_anon_key})
        if url.path == "/api/contacts":
            return self._contacts("GET", url)
        if url.path.startswith("/api/demo/"):
            return self._demo_snapshot(url)
        if url.path == "/api/funnel":
            return self._funnel(url)
        user = self._user()
        if url.path == "/api/me":
            account = self._activate(user, allow_blocked=True)
            return self._json(200, {"email": user.get("email"), "credits": account["credits"],
                                    "blocked": BLOCKED.get(account.get("blocked_reason") or "")})
        if url.path == "/api/profile":
            return self._json(200, self._profile())
        if url.path == "/api/account":
            return self._json(200, {**supa.rpc_as(self._token, "sociai_account"), "payments": billing is not None})
        if url.path == "/api/pricing":
            if not billing:
                return self._json(200, {"enabled": False})
            return self._json(200, {"enabled": True, "test_mode": not billing.live, "plans": billing.plans()})
        if url.path == "/api/projects":
            query = parse_qs(url.query).get("q", [""])[0][:200]
            return self._json(200, {"projects": supa.rpc_as(self._token, "sociai_list_projects", p_query=query)})
        if url.path.startswith("/api/projects/"):
            data = supa.rpc_as(self._token, "sociai_get_project", p_id=self._project_id(url))
            if data is None:
                raise Reject(404, "That project isn't in your account.")
            return self._json(200, {"project": data})
        if url.path.startswith("/api/jobs/"):
            limit_or_reject("poll", user["id"])
            job_id = url.path.rsplit("/", 1)[-1]
            job = jobs.get(job_id)
            if not job or job.user_id != user["id"]:
                return self._json(404, {"error": self._lost_job(job_id, user)})
            try:
                after = max(0, int(parse_qs(url.query).get("after", ["0"])[0]))
            except ValueError:
                raise Reject(400, "after must be a whole number.")
            return self._json(200, job.snapshot(after))
        raise Reject(404, "Not found.")

    def _post_api(self, url):
        if url.path == "/api/check-email":
            limit_or_reject("public", self._client_ip())
            email = str(self._read_json().get("email", "")).strip()
            if "@" not in email:
                raise Reject(400, "Enter a full email address.")
            if is_disposable(email, settings.disposable_domains):
                raise Reject(400, BLOCKED["disposable_email"])
            return self._json(200, {"ok": True})
        if url.path == "/api/stripe/webhook":
            return self._stripe_webhook()
        if url.path == "/api/event":
            limit_or_reject("public", self._client_ip())
            data = self._read_json(limit=4096)
            if data.get("name") not in CLIENT_EVENTS:
                raise Reject(400, "Unknown event.")
            record_event(data["name"], WORD.sub("", str(data.get("where") or ""))[:24],
                         WORD.sub("", str(data.get("utm_source") or ""))[:32], bool(data.get("fbclid")))
            return self._json(200, {"ok": True})
        if url.path == "/api/demo":
            return self._start_demo()
        if url.path == "/api/demo/claim":
            return self._claim_demo(self._user())
        if url.path == "/api/profile/attribution":
            user = self._user()
            data = self._read_json(limit=4096)
            clean = {k: WORD.sub("", str(data.get(k) or ""))[:64] for k in ("utm_source", "utm_medium", "utm_campaign")}
            supa.rpc("sociai_set_attribution", p_user=user["id"], p_source=clean["utm_source"], p_medium=clean["utm_medium"],
                     p_campaign=clean["utm_campaign"], p_fbclid=bool(data.get("fbclid")))
            return self._json(200, {"ok": True})
        if url.path == "/api/profile/resume":
            user = self._user()
            limit_or_reject("upload", user["id"])
            return self._upload_resume(user, url)
        if url.path == "/api/profile/onboarded":
            self._user()
            return self._json(200, supa.rpc_as(self._token, "sociai_finish_onboarding"))
        if url.path == "/api/checkout":
            user = self._user()
            limit_or_reject("billing", user["id"])
            plan = self._read_json().get("plan")
            if plan not in PLANS:
                raise Reject(400, "Choose the credit pack or the monthly plan.")
            self._billing()
            self._activate(user)  # blocked accounts can't buy credits they can't use
            customer = self._customer(user)
            if plan == "monthly" and billing.has_subscription(customer):
                raise Reject(409, "You already have the monthly plan. You can manage it from your account page.")
            checkout = billing.checkout_url(user["id"], customer, plan)
            record_event("checkout", plan)
            return self._json(200, {"url": checkout})
        if url.path == "/api/billing-portal":
            user = self._user()
            limit_or_reject("billing", user["id"])
            self._billing()
            customer = supa.rpc("sociai_get_customer", p_user=user["id"]).get("customer")
            if not customer:
                raise Reject(409, "You don't have a billing account yet. It's created with your first purchase.")
            return self._json(200, {"url": billing.portal_url(customer)})
        if url.path == "/api/contacts":
            return self._contacts("POST", url)
        route = JOB_ROUTES.get(url.path)
        if not route:
            raise Reject(404, "Not found.")
        build, kind = route
        user = self._user()
        data = self._read_json()
        project = data.get("project_id")
        if not isinstance(project, str) or not PROJECT_ID.match(project):
            raise Reject(400, "The request needs a valid project_id.")
        resume = self._profile().get("resume_text", "") if kind == "draft" else ""
        try:
            work = build(data, resume)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise Reject(400, "The request is missing fields or has the wrong shape.")
        limit_or_reject("job", user["id"])  # well-formed starts only; a malformed one costs nothing
        self._activate(user)
        started = supa.rpc("sociai_start_job", p_user=user["id"], p_project=project, p_kind=kind,
                           p_max_running=settings.max_running, p_global_daily=settings.global_daily_limit)
        code = started.get("error")
        if code == "blocked":
            raise Reject(403, BLOCKED.get(started.get("reason"), "This account can't start new jobs."))
        if code:
            status, message = START_ERRORS.get(code, (500, GENERIC_ERROR))
            extra = {"credits": started["credits"]} if "credits" in started else {}
            if code == "no_credits":
                extra["action"] = "pricing"  # the page links to the Pricing page
            raise Reject(status, message, **extra)
        keep_job(Job(started["job_id"], work, kind, user["id"]))
        self._json(200, {"job": started["job_id"], "credits": started["credits"],
                         **({"drafts_left": started["drafts_left"]} if "drafts_left" in started else {})})

    def _put_api(self, url):
        self._user()
        if url.path == "/api/profile":
            data = self._read_json()
            fields = {
                "p_background": self._text(data, "background", 20000),
                "p_channel": data.get("default_channel"),
                "p_max_words": data.get("default_max_words"),
                "p_resume_text": self._text(data, "resume_text", MAX_RESUME_TEXT),
                "p_main_goal": data.get("main_goal"),
                "p_main_goal_note": self._text(data, "main_goal_note", 500),
            }
            if fields["p_channel"] is not None and fields["p_channel"] not in CHANNELS:
                raise Reject(400, "Choose email, LinkedIn or direct message as your default channel.")
            if fields["p_main_goal"] is not None and fields["p_main_goal"] not in MAIN_GOALS:
                raise Reject(400, "Choose one of the listed goals.")
            words = fields["p_max_words"]
            if words is not None and (not isinstance(words, int) or isinstance(words, bool) or not 40 <= words <= 600):
                raise Reject(400, "The default word limit must be between 40 and 600.")
            return self._json(200, supa.rpc_as(self._token, "sociai_save_profile", **fields))
        if url.path == "/api/profile/samples":
            samples = self._read_json().get("samples")
            if not isinstance(samples, list) or not all(isinstance(x, str) for x in samples):
                raise Reject(400, "samples must be a list of texts.")
            samples = [x.strip() for x in samples if x.strip()]
            if len(samples) > 10:
                raise Reject(400, "You can keep up to 10 writing samples.")
            if any(len(x) > 20000 for x in samples):
                raise Reject(400, "Each writing sample can be up to 20,000 characters.")
            return self._json(200, supa.rpc_as(self._token, "sociai_replace_samples", p_bodies=samples))
        if url.path.startswith("/api/projects/"):
            project_id = self._project_id(url)
            data = self._read_json(limit=MAX_PROJECT_BODY)
            if not isinstance(data.get("data"), dict) or not isinstance(data.get("summary", {}), dict):
                raise Reject(400, "A project needs its data as an object.")
            name = str(data.get("name") or "")[:300]
            saved = supa.rpc_as(self._token, "sociai_save_project", p_id=project_id, p_name=name,
                                p_summary=data.get("summary") or {}, p_data=data["data"])
            return self._json(200, saved)
        raise Reject(404, "Not found.")

    def _patch_api(self, url):
        if url.path.startswith("/api/contacts/"):
            return self._contacts("PATCH", url)
        raise Reject(404, "Not found.")

    def _delete_api(self, url):
        if url.path.startswith("/api/contacts/"):
            return self._contacts("DELETE", url)
        user = self._user()
        if url.path == "/api/profile/resume":
            supa.remove(RESUME_BUCKET, [f"{user['id']}/resume{ext}" for _, ext in KINDS.values()], access_token=self._token)
            supa.rpc("sociai_set_resume", p_user=user["id"], p_path=None, p_filename=None, p_text="")
            return self._json(200, self._profile())
        if url.path.startswith("/api/projects/"):
            return self._json(200, supa.rpc_as(self._token, "sociai_delete_project", p_id=self._project_id(url)))
        if url.path == "/api/account":
            limit_or_reject("delete", user["id"])
            if self._read_json().get("confirm") != "DELETE":
                raise Reject(400, 'Send {"confirm": "DELETE"} to delete your account.')
            return self._delete_account(user)
        raise Reject(404, "Not found.")

    # ── Outreach tracker: the caller's own contacts (row-level security, plus a user_id filter) ──

    def _contacts(self, method, url):
        user = self._user()
        today = tracker.client_today(parse_qs(url.query).get("today", [None])[0], datetime.now(timezone.utc).date())
        mine = f"user_id=eq.{user['id']}"
        try:
            if method == "GET":
                rows = supa.rows_as(self._token, "GET", CONTACTS, f"select=*&{mine}&order=created_at.desc&limit={MAX_CONTACTS}")
                return self._json(200, {"contacts": [tracker.present(r, today) for r in rows]})
            if method == "POST":
                fields = tracker.apply_rules(None, tracker.clean(self._read_json(), partial=False), today)
                rows = supa.rows_as(self._token, "POST", CONTACTS, body={**fields, "user_id": user["id"]})
                return self._json(200, {"contact": tracker.present(rows[0], today)})
            match = CONTACT_PATH.match(url.path)
            if not match:
                raise Reject(404, "Not found.")
            this = f"id=eq.{match[1]}&{mine}"
            if method == "DELETE":
                if not supa.rows_as(self._token, "DELETE", CONTACTS, this):
                    raise Reject(404, "That contact isn't in your tracker.")
                return self._json(200, {"deleted": True})
            changes = tracker.clean(self._read_json(), partial=True)
            if not changes:
                raise Reject(400, "Nothing to change.")
            old = supa.rows_as(self._token, "GET", CONTACTS, f"select=*&{this}")
            if not old:
                raise Reject(404, "That contact isn't in your tracker.")
            rows = supa.rows_as(self._token, "PATCH", CONTACTS, this, body=tracker.apply_rules(old[0], changes, today))
            if not rows:
                raise Reject(404, "That contact isn't in your tracker.")
            return self._json(200, {"contact": tracker.present(rows[0], today)})
        except tracker.Invalid as e:
            raise Reject(400, str(e))

    # ── The landing-page demo ──

    def _start_demo(self):
        ip = self._client_ip()
        limit_or_reject("public", ip)
        data = self._read_json(limit=4096)
        target = str(data.get("target") or "").strip()[:200]
        purpose = data.get("purpose") if data.get("purpose") in DEMO_PURPOSES else "research"
        goal = str(data.get("goal") or "").strip()[:300] or DEMO_PURPOSES[purpose][1]
        if len(target) < 3:
            raise Reject(400, "Name the person you'd write to, with a little context: e.g. Prof. Fei-Fei Li, Stanford.")
        if demo_engine is None:
            raise Reject(503, "The demo isn't available right now. Sign up free to run the full version.", action="signup")
        if limiter.check(f"demo_ip:{ip}", 1, 86400):
            raise Reject(429, "Today's demo on this network has been used. Sign up free for 2 full runs with no waiting.", action="signup")
        if limiter.check("demo:all", settings.demo_daily_limit, 86400):
            raise Reject(429, "The demo is fully booked for today. Sign up free: new accounts get 2 full runs.", action="signup")
        forget_old_demos()
        demo_id = str(uuid.uuid4())
        job = Job(demo_id, demo_work(demo_id, target, goal, purpose, ip), "demo", f"demo:{demo_id}", record=False)
        with _demos_lock:
            demos[demo_id] = {"job": job, "target": target, "goal": goal, "purpose": purpose, "created": time.time()}
        record_event("demo_used", purpose)
        self._json(200, {"id": demo_id})

    def _demo_snapshot(self, url):
        demo_id = url.path.rsplit("/", 1)[-1]
        with _demos_lock:
            demo = demos.get(demo_id) if UUID.match(demo_id) else None
        if not demo:
            raise Reject(404, "That demo has expired. Start another, or sign up free.")
        limit_or_reject("poll", demo_id)
        try:
            after = max(0, int(parse_qs(url.query).get("after", ["0"])[0]))
        except ValueError:
            raise Reject(400, "after must be a whole number.")
        snap = demo["job"].snapshot(after)
        teaser = demo_teaser(snap["result"]) if snap["status"] == "done" else None
        self._json(200, {"status": snap["status"], "events": snap["events"], "total": snap["total"], "error": snap["error"], "teaser": teaser})

    def _claim_demo(self, user):
        demo_id = str(self._read_json(limit=4096).get("id") or "")
        if not UUID.match(demo_id):
            raise Reject(400, "That isn't a demo id.")
        with _demos_lock:
            demo = demos.get(demo_id)
            if demo and demo.get("result") and demo.get("claimed_by") in (None, user["id"]):
                demo["claimed_by"] = user["id"]
                found = {"target": demo["target"], "goal": demo["goal"], "purpose": demo["purpose"], **demo["result"]}
            else:
                found = None
        if found is None and demo is None:  # not in this process (a deploy in between): the database has it
            row = supa.rpc("sociai_claim_demo", p_id=demo_id, p_user=user["id"])
            if row:
                found = {"target": row["target"], "goal": row["goal"], "purpose": row.get("purpose") or "research",
                         "dossier": row["dossier"], "draft": row["draft"]}
        if found is None:
            raise Reject(404, "That demo isn't available any more.")
        record_event("demo_claimed", found["purpose"])
        self._json(200, {"demo": {**found, "category": DEMO_PURPOSES.get(found["purpose"], DEMO_PURPOSES["research"])[0]}})

    def _funnel(self, url):
        if not settings.admin_token:
            raise Reject(404, "Not found.")
        auth = self.headers.get("Authorization", "")
        given = auth[7:].strip() if auth.lower().startswith("bearer ") else parse_qs(url.query).get("token", [""])[0]
        if not given or not hmac.compare_digest(given, settings.admin_token):
            raise Reject(401, "Wrong token.")
        rows = supa.rpc("sociai_funnel", p_days=14) if supa else []
        if parse_qs(url.query).get("format", [""])[0] == "json":
            return self._json(200, {"days": rows, "today_in_memory": {k: v for k, v in _events.items() if k != "day"}})
        self._send(200, funnel_text(rows).encode(), "text/plain; charset=utf-8")

    def _billing(self):
        if not billing:
            print(f"[stripe] payments are off: {billing_off_reason}", flush=True)
            raise Reject(503, "Payments aren't set up on this server yet.")

    def _customer(self, user):
        """The user's Stripe customer, created on first purchase. One per user."""
        info = supa.rpc("sociai_get_customer", p_user=user["id"])
        if info.get("customer"):
            return info["customer"]
        created = billing.create_customer(user.get("email"), user["id"])
        stored = supa.rpc("sociai_set_customer", p_user=user["id"], p_customer=created)["customer"]
        if stored != created:  # another checkout got there first; keep that one
            print(f"[stripe] unused customer {created} for {user['id']}", flush=True)
        return stored

    def _stripe_webhook(self):
        if not billing:
            raise Reject(503, "Payments aren't set up on this server yet.")
        payload = self._read_raw(MAX_WEBHOOK_BODY)
        event = billing.verify(payload, self.headers.get("Stripe-Signature"))
        grant = billing.grant_for(event)
        if not grant:
            return self._json(200, {"received": True})
        user_id = grant.user_id
        if not user_id and grant.customer:
            user_id = (supa.rpc("sociai_user_for_customer", p_customer=grant.customer) or {}).get("user_id")
        if not user_id or not UUID.match(str(user_id)):
            print(f"[stripe] {event.get('id')} {event.get('type')}: no Sociai user for it; ignored", flush=True)
            return self._json(200, {"received": True})
        result = supa.rpc("sociai_grant_credits", p_user=user_id, p_delta=grant.credits, p_reason=grant.reason,
                          p_event=event["id"])
        if result.get("error"):
            print(f"[stripe] {event['id']}: {result['error']} for {user_id}; ignored", flush=True)
            return self._json(200, {"received": True})
        if grant.customer:
            supa.rpc("sociai_set_customer", p_user=user_id, p_customer=grant.customer)
        word = "granted" if result["granted"] else "already credited"
        print(f"[stripe] {event['id']} {event['type']}: {grant.credits} credits {word} for {user_id} "
              f"(balance {result['credits']})", flush=True)
        self._json(200, {"received": True, "granted": result["granted"]})

    def _lost_job(self, job_id, user):
        """A polled job this server doesn't have. If the database still shows it running for this
        user, the server restarted while it ran: close it now (a research run gets its credit back)
        instead of leaving it to the 15-minute cleanup, which could also block new jobs meanwhile."""
        message = "This job is no longer running. The server may have restarted."
        if not UUID.match(job_id):
            return message
        try:
            rows = supa.rows_as(self._token, "GET", "jobs", f"select=id,kind,status&id=eq.{job_id}&user_id=eq.{user['id']}")
            if not rows or rows[0].get("status") != "running":
                return message
            supa.rpc("sociai_finish_job", p_job=job_id, p_status="error", p_usage={"lost": "server restarted"})
        except SupabaseError as e:
            print(f"[run] couldn't close lost job {job_id}: {e}", flush=True)
            return message
        print(f"[run] closed lost job {job_id} for {user['id']}", flush=True)
        return ("The server restarted while this was running, so it stopped. "
                + ("Your credit was refunded. " if rows[0].get("kind") == "research" else "It didn't use a credit. ") + "Try again.")

    def _profile(self):
        profile = supa.rpc_as(self._token, "sociai_get_profile")
        if not profile:  # no profile row yet: create it with the sign-up rules, then read it
            supa.rpc("sociai_ensure_profile", p_user=self._uid, p_email=self._email)
            profile = supa.rpc_as(self._token, "sociai_get_profile")
            if not profile:
                raise SupabaseError(f"profile still missing for {self._uid}")
        return profile

    def _upload_resume(self, user, url):
        filename = os.path.basename(parse_qs(url.query).get("filename", [""])[0])[:200]
        content = self._read_raw(MAX_RESUME, "Resumes can be up to 5 MB.")
        try:
            kind = detect(content, filename)
            text = extract_text(content, kind)
        except ResumeError as e:
            raise Reject(e.status, str(e))
        mime, ext = KINDS[kind]
        path = f"{user['id']}/resume{ext}"
        supa.upload(self._token, RESUME_BUCKET, path, content, mime)
        others = [f"{user['id']}/resume{e}" for _, e in KINDS.values() if e != ext]
        supa.remove(RESUME_BUCKET, others, access_token=self._token)
        supa.rpc("sociai_set_resume", p_user=user["id"], p_path=path, p_filename=filename or f"resume{ext}", p_text=text)
        self._json(200, self._profile())

    def _delete_account(self, user):
        """Cancel any subscription, remove the user's files, then the account; every table row goes
        with it (on delete cascade). If the subscription can't be cancelled, nothing is deleted."""
        uid = user["id"]
        customer = supa.rpc("sociai_get_customer", p_user=uid).get("customer")
        if customer:
            if not billing:
                print(f"[account] not deleting {uid}: has Stripe customer {customer} but payments are off "
                      f"({billing_off_reason})", flush=True)
                raise Reject(503, CANCEL_FAILED)
            try:
                cancelled = billing.cancel_subscriptions(customer)
            except stripe.StripeError as e:
                print(f"[stripe] couldn't cancel subscriptions of {customer} for {uid}: {type(e).__name__}: {e}", flush=True)
                monitoring.capture(e)
                raise Reject(502, CANCEL_FAILED)
            if cancelled:
                print(f"[stripe] cancelled {', '.join(cancelled)} for {uid} before deleting the account", flush=True)
        names = supa.list_files(RESUME_BUCKET, uid)
        supa.remove(RESUME_BUCKET, [f"{uid}/{n}" for n in names])
        supa.rpc("sociai_forget_user", p_user=uid)
        supa.delete_user(uid)
        with _tokens_lock:
            for key in [k for k, (u, _) in _tokens.items() if u.get("id") == uid]:
                del _tokens[key]
        print(f"[account] deleted {uid}", flush=True)
        self._json(200, {"deleted": True})

    def _project_id(self, url):
        project_id = url.path.rsplit("/", 1)[-1]
        if not PROJECT_ID.match(project_id):
            raise Reject(400, "That isn't a valid project id.")
        return project_id

    @staticmethod
    def _text(data, field, limit):
        value = data.get(field)
        if value is None:
            return None
        if not isinstance(value, str):
            raise Reject(400, f"{field} must be text.")
        if len(value) > limit:
            raise Reject(400, f"{field} can be up to {limit:,} characters.")
        return value

    def _user(self):
        """The signed-in Supabase user. Raises 401 without a valid token, 403 without a verified email."""
        if supa is None:
            raise Reject(503, "This server isn't set up for accounts yet.")
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        user = verify_token(token, self._client_ip()) if token else None
        if not user or not user.get("id"):
            raise Reject(401, "Please sign in.")
        self._token, self._uid, self._email = token, user["id"], user.get("email")
        if not user.get("email") or not (user.get("email_confirmed_at") or user.get("confirmed_at")):
            raise Reject(403, "Confirm your email address before using Sociai.")
        return user

    def _activate(self, user, allow_blocked=False):
        """Apply the sign-up rules on an account's first call; returns {credits, blocked_reason}."""
        account = supa.rpc("sociai_activate", p_user=user["id"], p_ip=self._client_ip(),
                           p_disposable=is_disposable(user["email"], settings.disposable_domains),
                           p_max_per_ip=settings.max_accounts_per_ip)
        if account.get("error") == "no_user":  # the account was deleted while this token was still cached
            raise Reject(401, "Please sign in.")
        if account.get("error"):
            raise SupabaseError(f"activate {user['id']}: {account}")
        if account.get("blocked_reason") and not allow_blocked:
            raise Reject(403, BLOCKED.get(account["blocked_reason"], "This account can't start new jobs."))
        return account

    def _client_ip(self):
        if settings.trust_proxy:
            # Behind Cloudflare and Render. Cloudflare sets CF-Connecting-IP itself on every request
            # it proxies, while the first X-Forwarded-For entry is whatever the client sent, so the
            # Cloudflare header wins when it's there. (Requests straight to the Render origin could
            # still forge it; they bypass Cloudflare's own protections anyway.)
            for name in ("CF-Connecting-IP", "True-Client-IP"):
                if self.headers.get(name, "").strip():
                    return self.headers[name].strip()
            first = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if first:
                return first
        return self.client_address[0]

    def _read_raw(self, limit, too_big="That request is too large. Try shorter writing samples."):
        self.body_read = True
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            raise Reject(400, "Missing or invalid Content-Length.")
        if length > limit:
            # Read and discard the body (within reason) so the client gets this answer instead of
            # a reset connection; anything bigger than that just gets the connection closed.
            left = length if length <= DRAIN_LIMIT else 0
            while left > 0:
                chunk = self.rfile.read(min(left, 65536))
                if not chunk:
                    break
                left -= len(chunk)
            self.close_connection = True
            raise Reject(413, too_big)
        if length < 0:
            raise Reject(400, "Missing or invalid Content-Length.")
        return self.rfile.read(length)

    def _read_json(self, limit=MAX_BODY):
        raw = self._read_raw(limit)
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise Reject(400, "The request body isn't valid JSON.")
        if not isinstance(data, dict):
            raise Reject(400, "The request body must be a JSON object.")
        return data

    def _json(self, code, obj, headers=None):
        self._send(code, json.dumps(obj).encode(), "application/json", headers=headers)

    def _drain(self):
        """Read a body no one read (e.g. a request refused with 401 before it was parsed). Closing the
        connection with it unread can reset it, and the client would lose the reply."""
        if self.body_read:
            return
        self.body_read = True
        try:
            left = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if left > DRAIN_LIMIT:
            return
        while left > 0:
            chunk = self.rfile.read(min(left, 65536))
            if not chunk:
                break
            left -= len(chunk)

    def _redirect(self, location, code=302):
        self._drain()
        self.send_response(code)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self._security_headers()
        self.end_headers()

    def _send(self, code, body, ctype, cache="no-cache", page=None, headers=None):
        """page names the HTML page being served (for its Content-Security-Policy)."""
        self._drain()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self._security_headers(page, headers)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _security_headers(self, page=None, headers=None):
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        if settings.trust_proxy and self.headers.get("X-Forwarded-Proto", "https") != "http":  # only over HTTPS
            self.send_header("Strict-Transport-Security", HSTS)
        self.send_header("Content-Security-Policy", csp(page) if page else NO_CONTENT_CSP)
        for name, value in (headers or {}).items():
            self.send_header(name, value)

    def log_message(self, fmt, *args):
        # Polling and health checks would drown the log; the funnel URL may carry the admin token.
        if not self.path.startswith(("/api/jobs/", "/api/demo/", "/healthz", "/api/funnel")):
            super().log_message(fmt, *args)


def main():
    load_env()
    setup(Settings.from_env())
    monitoring_on = monitoring.init(settings.sentry_dsn, environment=f"stripe-{settings.stripe_mode}")
    port = os.environ.get("PORT")
    host, port = ("0.0.0.0", int(port)) if port else ("127.0.0.1", 8000)
    server = ThreadingHTTPServer((host, port), Handler)
    url = os.environ.get("RENDER_EXTERNAL_URL") or f"http://localhost:{port}"
    print(f"Sociai running at {url} (listening on {host}:{port})", flush=True)
    if supa:
        print(f"Accounts: Supabase at {settings.supabase_url}. Daily cap: {settings.global_daily_limit} jobs.", flush=True)
    else:
        print(f"Accounts are OFF: set {', '.join(settings.missing())} (see .env.example). "
              "Sign-in and the API won't work until then.", flush=True)
    if billing:
        print(f"Payments: Stripe {billing.mode.upper()} mode{' (real charges)' if billing.live else ''}. "
              f"Customers return to {settings.public_url}."
              + ("" if settings.stripe_webhook_secret else " STRIPE_WEBHOOK_SECRET is missing, so purchases won't add credits."), flush=True)
    else:
        print(f"Payments are OFF: {billing_off_reason}.", flush=True)
    print("Error monitoring: Sentry is on (no request bodies, resumes, samples or keys are sent)." if monitoring_on
          else "Error monitoring: off (set SENTRY_DSN to turn on Sentry).", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
