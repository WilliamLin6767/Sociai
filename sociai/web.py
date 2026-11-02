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
  GET  /healthz            -> {"ok": true}
  GET  /privacy, /terms    the Privacy Policy and Terms (static pages)

Profile and project calls run as the user (their own token), so the database's
row-level security applies to them as well.

Research and drafting run as background jobs so the page shows live progress and can
pick a job back up after a refresh. Messages are never sent on the user's behalf.
Settings come from environment variables or a local .env file (see .env.example).
"""

import hashlib
import json
import mimetypes
import os
import re
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import anthropic
import stripe

from . import monitoring
from .billing import PLANS, Billing, BillingError
from .config import Settings, is_disposable, load_env
from .engine import Dossier, Engine, OutreachRequest, Refused, RunUsage
from .resume import KINDS, MAX_BYTES as MAX_RESUME, MAX_TEXT as MAX_RESUME_TEXT, ResumeError, detect, extract_text
from .supabase import Supabase, SupabaseError

STATIC = Path(__file__).parent / "static"
# Windows can map these from the registry (e.g. .js -> text/plain), which breaks modules.
for ext, kind in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml")):
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
PAGES = {"/": "index.html", "/index.html": "index.html", "/privacy": "privacy.html", "/terms": "terms.html"}

# Set by setup(): main() loads .env first; tests pass their own settings and engine.
settings: Settings = Settings()
supa: Supabase | None = None
engine: Engine | None = None
billing: Billing | None = None
billing_off_reason = ""


def setup(new_settings: Settings, new_engine: Engine | None = None):
    global settings, supa, engine, billing, billing_off_reason
    settings = new_settings
    supa = Supabase(settings.supabase_url, settings.supabase_anon_key, settings.supabase_service_key) \
        if not settings.missing() else None
    engine = new_engine or Engine()
    billing, billing_off_reason = Billing.from_settings(settings)


class Reject(Exception):
    """An HTTP error to send back as {"error": message}."""

    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code, self.extra = code, extra


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

_tokens: dict[str, tuple[dict, float]] = {}
_tokens_lock = threading.Lock()


def verify_token(token: str) -> dict | None:
    """The Supabase user for an access token (cached briefly), or None if it isn't valid."""
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.time()
    with _tokens_lock:
        hit = _tokens.get(key)
        if hit and hit[1] > now:
            return hit[0]
    user = supa.get_user(token)
    if user:
        with _tokens_lock:
            if len(_tokens) > 5000:
                _tokens.clear()
            _tokens[key] = (user, now + TOKEN_TTL)
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
    def __init__(self, job_id, work, kind, user_id):
        self.id, self.kind, self.user_id = job_id, kind, user_id
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


# These build the request objects up front, so a malformed body fails before any credit is spent.
def research_work(data, resume_text=""):
    req = OutreachRequest(**data["request"])
    return lambda emit, usage: engine.research(req, on_progress=emit, usage=usage).__dict__


def draft_work(data, resume_text=""):
    # The resume comes from the user's saved profile, never from the request body.
    req = OutreachRequest(**{**data["request"], "resume_text": resume_text})
    dossier = Dossier(**data["dossier"])
    revise = data.get("revise")
    if revise is not None and not (isinstance(revise, dict) and {"body", "instruction"} <= revise.keys()):
        raise ValueError("revise needs body and instruction")
    return lambda emit, usage: engine.draft(req, dossier, revise=revise, usage=usage).__dict__


JOB_ROUTES = {"/api/research": (research_work, "research"), "/api/draft": (draft_work, "draft")}


# ───────── HTTP ─────────

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/healthz":
            return self._json(200, {"ok": True})
        if url.path.startswith("/api/"):
            return self._api(self._get_api, url)
        name = PAGES.get(url.path) or url.path.lstrip("/")
        path = (STATIC / name).resolve()
        if not path.is_file() or STATIC.resolve() not in path.parents:
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)

    def do_POST(self):
        self._api(self._post_api, urlparse(self.path))

    def do_PUT(self):
        self._api(self._put_api, urlparse(self.path))

    def do_DELETE(self):
        self._api(self._delete_api, urlparse(self.path))

    def _api(self, handler, url):
        try:
            handler(url)
        except Reject as r:
            self._json(r.code, {"error": str(r), **r.extra})
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
            job = jobs.get(url.path.rsplit("/", 1)[-1])
            if not job or job.user_id != user["id"]:
                return self._json(404, {"error": "This job is no longer running. The server may have restarted."})
            try:
                after = max(0, int(parse_qs(url.query).get("after", ["0"])[0]))
            except ValueError:
                raise Reject(400, "after must be a whole number.")
            return self._json(200, job.snapshot(after))
        raise Reject(404, "Not found.")

    def _post_api(self, url):
        if url.path == "/api/check-email":
            email = str(self._read_json().get("email", "")).strip()
            if "@" not in email:
                raise Reject(400, "Enter a full email address.")
            if is_disposable(email, settings.disposable_domains):
                raise Reject(400, BLOCKED["disposable_email"])
            return self._json(200, {"ok": True})
        if url.path == "/api/stripe/webhook":
            return self._stripe_webhook()
        if url.path == "/api/profile/resume":
            return self._upload_resume(self._user(), url)
        if url.path == "/api/profile/onboarded":
            self._user()
            return self._json(200, supa.rpc_as(self._token, "sociai_finish_onboarding"))
        if url.path == "/api/checkout":
            user = self._user()
            plan = self._read_json().get("plan")
            if plan not in PLANS:
                raise Reject(400, "Choose the credit pack or the monthly plan.")
            self._billing()
            self._activate(user)  # blocked accounts can't buy credits they can't use
            customer = self._customer(user)
            if plan == "monthly" and billing.has_subscription(customer):
                raise Reject(409, "You already have the monthly plan. You can manage it from your account page.")
            return self._json(200, {"url": billing.checkout_url(user["id"], customer, plan)})
        if url.path == "/api/billing-portal":
            user = self._user()
            self._billing()
            customer = supa.rpc("sociai_get_customer", p_user=user["id"]).get("customer")
            if not customer:
                raise Reject(409, "You don't have a billing account yet. It's created with your first purchase.")
            return self._json(200, {"url": billing.portal_url(customer)})
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
        user = self._user()
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

    def _delete_api(self, url):
        user = self._user()
        if url.path == "/api/profile/resume":
            supa.remove(RESUME_BUCKET, [f"{user['id']}/resume{ext}" for _, ext in KINDS.values()], access_token=self._token)
            supa.rpc("sociai_set_resume", p_user=user["id"], p_path=None, p_filename=None, p_text="")
            return self._json(200, self._profile())
        if url.path.startswith("/api/projects/"):
            return self._json(200, supa.rpc_as(self._token, "sociai_delete_project", p_id=self._project_id(url)))
        if url.path == "/api/account":
            if self._read_json().get("confirm") != "DELETE":
                raise Reject(400, 'Send {"confirm": "DELETE"} to delete your account.')
            return self._delete_account(user)
        raise Reject(404, "Not found.")

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
        user = verify_token(token) if token else None
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
            # Behind a proxy (Render), the original client is the first X-Forwarded-For entry.
            first = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if first:
                return first
        return self.client_address[0]

    def _read_raw(self, limit, too_big="That request is too large. Try shorter writing samples."):
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

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if not self.path.startswith(("/api/jobs/", "/healthz")):  # polling and health checks would drown the log
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
