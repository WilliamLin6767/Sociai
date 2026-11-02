"""Web app server (python -m sociai.web -> http://localhost:8000).

The page lives in sociai/static/. Users sign in with Supabase (email magic link) and
every /api/* call carries their access token as "Authorization: Bearer <token>".
Credits, limits and job records live in Postgres (supabase/migrations/); the server
changes them only through the database functions defined there.

  GET  /api/config         public: the Supabase URL and anon key for the browser
  POST /api/check-email    public: {email} -> 400 if the domain isn't accepted
  GET  /api/me             {email, credits, blocked}
  POST /api/research       {request, project_id}                     -> {job, credits}
  POST /api/draft          {request, dossier, project_id, revise?}   -> {job, credits, drafts_left}
  GET  /api/jobs/<id>?after=N  -> {status, events (from index N), result, error}
  GET  /healthz            -> {"ok": true}

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

from .config import Settings, is_disposable, load_env
from .engine import Dossier, Engine, OutreachRequest, Refused, RunUsage
from .supabase import Supabase, SupabaseError

STATIC = Path(__file__).parent / "static"
# Windows can map these from the registry (e.g. .js -> text/plain), which breaks modules.
for ext, kind in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml")):
    mimetypes.add_type(kind, ext)
JOB_TTL = 3600     # seconds a finished job is kept for a refreshed page to collect
MAX_BODY = 200 * 1024
TOKEN_TTL = 60     # seconds a verified access token is trusted before asking Supabase again
PROJECT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Set by setup(): main() loads .env first; tests pass their own settings and engine.
settings: Settings = Settings()
supa: Supabase | None = None
engine: Engine | None = None


def setup(new_settings: Settings, new_engine: Engine | None = None):
    global settings, supa, engine
    settings = new_settings
    supa = Supabase(settings.supabase_url, settings.supabase_anon_key, settings.supabase_service_key) \
        if not settings.missing() else None
    engine = new_engine or Engine()


class Reject(Exception):
    """An HTTP error to send back as {"error": message}."""

    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code, self.extra = code, extra


GENERIC_ERROR = "Something went wrong on the server. Try again, and let the Sociai team know if it keeps happening."


def public_error(e: Exception) -> str:
    """What the browser may see about a failure. Details stay in the server log."""
    traceback.print_exception(e)
    if isinstance(e, Refused):
        return str(e)
    busy = isinstance(e, (anthropic.RateLimitError, anthropic.APIConnectionError)) or (
        isinstance(e, anthropic.APIStatusError) and e.status_code >= 500)
    return "The AI service is busy right now. Try again in a minute." if busy else GENERIC_ERROR


BLOCKED = {
    "disposable_email": "Sociai doesn't accept disposable email addresses. Sign in with your usual email instead.",
    "too_many_accounts": "Too many new accounts were created from your network today. Please try again tomorrow.",
}
START_ERRORS = {  # sociai_start_job error code -> (HTTP status, message)
    "no_credits": (402, "You're out of credits. Each credit covers one research run and up to 3 drafts."),
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
def research_work(data):
    req = OutreachRequest(**data["request"])
    return lambda emit, usage: engine.research(req, on_progress=emit, usage=usage).__dict__


def draft_work(data):
    req = OutreachRequest(**data["request"])
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
        name = "index.html" if url.path in ("/", "/index.html") else url.path.lstrip("/")
        path = (STATIC / name).resolve()
        if not path.is_file() or STATIC.resolve() not in path.parents:
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)

    def do_POST(self):
        self._api(self._post_api, urlparse(self.path))

    def _api(self, handler, url):
        try:
            handler(url)
        except Reject as r:
            self._json(r.code, {"error": str(r), **r.extra})
        except SupabaseError as e:
            print(f"[supabase] {e}", flush=True)
            self._json(503, {"error": "Sociai can't reach its account service right now. Try again in a minute."})

    def _get_api(self, url):
        if url.path == "/api/config":
            return self._json(200, {"configured": supa is not None, "supabase_url": settings.supabase_url,
                                    "supabase_anon_key": settings.supabase_anon_key})
        user = self._user()
        if url.path == "/api/me":
            account = self._activate(user, allow_blocked=True)
            return self._json(200, {"email": user.get("email"), "credits": account["credits"],
                                    "blocked": BLOCKED.get(account.get("blocked_reason") or "")})
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
        route = JOB_ROUTES.get(url.path)
        if not route:
            raise Reject(404, "Not found.")
        build, kind = route
        user = self._user()
        data = self._read_json()
        project = data.get("project_id")
        if not isinstance(project, str) or not PROJECT_ID.match(project):
            raise Reject(400, "The request needs a valid project_id.")
        try:
            work = build(data)
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
            raise Reject(status, message, **({"credits": started["credits"]} if "credits" in started else {}))
        keep_job(Job(started["job_id"], work, kind, user["id"]))
        self._json(200, {"job": started["job_id"], "credits": started["credits"],
                         **({"drafts_left": started["drafts_left"]} if "drafts_left" in started else {})})

    def _user(self):
        """The signed-in Supabase user. Raises 401 without a valid token, 403 without a verified email."""
        if supa is None:
            raise Reject(503, "This server isn't set up for accounts yet.")
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        user = verify_token(token) if token else None
        if not user or not user.get("id"):
            raise Reject(401, "Please sign in.")
        if not user.get("email") or not (user.get("email_confirmed_at") or user.get("confirmed_at")):
            raise Reject(403, "Confirm your email address before using Sociai.")
        return user

    def _activate(self, user, allow_blocked=False):
        """Apply the sign-up rules on an account's first call; returns {credits, blocked_reason}."""
        account = supa.rpc("sociai_activate", p_user=user["id"], p_ip=self._client_ip(),
                           p_disposable=is_disposable(user["email"], settings.disposable_domains),
                           p_max_per_ip=settings.max_accounts_per_ip)
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

    def _read_json(self):
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            raise Reject(400, "Missing or invalid Content-Length.")
        if length > MAX_BODY:
            raise Reject(413, "That request is too large. Try shorter writing samples.")
        if length < 0:
            raise Reject(400, "Missing or invalid Content-Length.")
        try:
            data = json.loads(self.rfile.read(length))
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
    server.serve_forever()


if __name__ == "__main__":
    main()
