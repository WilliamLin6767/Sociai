"""Web UI (stdlib only): python -m sociai.web  ->  http://localhost:8000

The page lives in sociai/static/. Research and drafting run as background jobs so
the browser can show live progress and pick a job back up after a refresh:

  POST /api/research  {request}                      -> {"job": id}
  POST /api/draft     {request, dossier, revise?}    -> {"job": id}
  GET  /api/jobs/<id>?after=N  -> {"status", "events" (from index N), "result", "error"}
  GET  /api/session   -> {"ok": true} if the invite code is accepted
  GET  /healthz       -> {"ok": true}

Projects are saved in the browser (localStorage); nothing is ever sent anywhere
except to the Claude API, and messages are never sent on the user's behalf.

Deployment settings (environment variables):
  PORT                       listen on 0.0.0.0:PORT (otherwise 127.0.0.1:8000)
  SOCIAI_ACCESS_CODES        comma-separated invite codes; when set, /api/*, /research
                             and /draft need an X-Sociai-Code header, per-code limits
                             apply, and API errors are logged instead of shown
  SOCIAI_DAILY_LIMIT         research + draft jobs per code per UTC day (default 20)
  SOCIAI_GLOBAL_DAILY_LIMIT  jobs per UTC day across everyone (default 200)
Usage is counted in memory, so it resets when the server restarts.
"""

import hmac
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import anthropic

from .engine import Dossier, Engine, OutreachRequest, Refused

engine = Engine()

STATIC = Path(__file__).parent / "static"
# Windows can map these from the registry (e.g. .js -> text/plain), which breaks modules.
for ext, kind in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml")):
    mimetypes.add_type(kind, ext)
JOB_TTL = 3600  # seconds a finished job is kept for a refreshed page to collect
MAX_BODY = 200 * 1024


def _env_int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        print(f"Ignoring {name}={os.environ[name]!r}: not a whole number. Using {default}.", file=sys.stderr)
        return default


ACCESS_CODES = [c.strip() for c in os.environ.get("SOCIAI_ACCESS_CODES", "").split(",") if c.strip()]
GATED = bool(ACCESS_CODES)
DAILY_LIMIT = _env_int("SOCIAI_DAILY_LIMIT", 20)
GLOBAL_DAILY_LIMIT = _env_int("SOCIAI_GLOBAL_DAILY_LIMIT", 200)
MAX_RUNNING = 2  # jobs running at once per code


class Reject(Exception):
    """An HTTP error to send back as {"error": message}."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def public_error(e: Exception) -> str:
    """What the browser may see about a failure. Behind the invite gate, details stay in the log."""
    traceback.print_exception(e)
    if isinstance(e, Refused):
        return str(e)
    if not GATED:  # local dev: show everything, it helps debugging
        cause = f" (cause: {e.__cause__!r})" if e.__cause__ else ""
        return f"{type(e).__name__}: {e}{cause}"
    busy = isinstance(e, (anthropic.RateLimitError, anthropic.APIConnectionError)) or (
        isinstance(e, anthropic.APIStatusError) and e.status_code >= 500)
    if busy:
        return "The AI service is busy right now. Try again in a minute."
    return "Something went wrong on the server. Try again, and let the Sociai team know if it keeps happening."


class Quota:
    """Job limits. Only the global daily cap applies when there's no invite gate (local dev)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.daily = {}    # (code, "YYYY-MM-DD") -> jobs started
        self.total = {}    # "YYYY-MM-DD" -> jobs started by everyone
        self.running = {}  # code -> jobs running now

    def acquire(self, code):
        today = datetime.now(timezone.utc).date().isoformat()
        with self.lock:
            self.daily = {k: n for k, n in self.daily.items() if k[1] == today}
            self.total = {k: n for k, n in self.total.items() if k == today}
            if self.total.get(today, 0) >= GLOBAL_DAILY_LIMIT:
                raise Reject(429, "Sociai has reached its limit for today. Please try again tomorrow.")
            if GATED:
                if self.running.get(code, 0) >= MAX_RUNNING:
                    raise Reject(429, f"You already have {MAX_RUNNING} research or draft jobs running. Wait for one to finish.")
                if self.daily.get((code, today), 0) >= DAILY_LIMIT:
                    raise Reject(429, f"You've reached today's limit of {DAILY_LIMIT} research and draft runs. "
                                      "It resets at midnight UTC.")
                self.daily[(code, today)] = self.daily.get((code, today), 0) + 1
                self.running[code] = self.running.get(code, 0) + 1
            self.total[today] = self.total.get(today, 0) + 1

    def release(self, code):
        if not GATED:
            return
        with self.lock:
            self.running[code] = max(0, self.running.get(code, 0) - 1)


quota = Quota()


class EditedDossier(Dossier):
    """A dossier the user edited by hand: draft from their text, not the original."""

    def __init__(self, text: str):
        super().__init__(summary="", facts=[], hooks=[], cautions=[], sources=[])
        self._text = text

    def as_text(self) -> str:
        return self._text


class Job:
    def __init__(self, work, code=None):
        self.events, self.result, self.error = [], None, None
        self.status = "running"
        self.code = code
        self.created = time.time()
        self.lock = threading.Lock()
        threading.Thread(target=self._run, args=(work,), daemon=True).start()

    def _run(self, work):
        try:
            result = work(self.emit)
            with self.lock:
                self.result, self.status = result, "done"
        except Exception as e:
            message = public_error(e)
            with self.lock:
                self.error, self.status = message, "error"
        finally:
            quota.release(self.code)

    def emit(self, event):
        with self.lock:
            self.events.append({**event, "t": time.time() - self.created})

    def snapshot(self, after):
        with self.lock:
            return {"status": self.status, "events": self.events[after:], "total": len(self.events),
                    "result": self.result, "error": self.error}


jobs: dict[str, Job] = {}


def start_job(work, code) -> str:
    now = time.time()
    for key in [k for k, j in jobs.items() if now - j.created > JOB_TTL]:
        del jobs[key]
    key = uuid.uuid4().hex
    jobs[key] = Job(work, code)
    return key


# These build the request objects up front, so a malformed body fails before any quota is spent.
def research_work(data):
    req = OutreachRequest(**data["request"])
    return lambda emit: engine.research(req, on_progress=emit).__dict__


def draft_work(data):
    req = OutreachRequest(**data["request"])
    dossier = Dossier(**data["dossier"])
    revise = data.get("revise")
    if revise is not None and not (isinstance(revise, dict) and {"body", "instruction"} <= revise.keys()):
        raise ValueError("revise needs body and instruction")
    return lambda emit: engine.draft(req, dossier, revise=revise).__dict__


def legacy_research_work(data):
    req = OutreachRequest(**data)

    def work():
        dossier = engine.research(req)
        return {"dossier": dossier.__dict__, "text": dossier.as_text()}
    return work


def legacy_draft_work(data):
    req = OutreachRequest(**data["request"])
    original = Dossier(**data["dossier"])
    dossier = original if data["edited"] == original.as_text() else EditedDossier(data["edited"])
    return lambda: engine.draft(req, dossier).__dict__


POST_ROUTES = {
    "/api/research": research_work, "/api/draft": draft_work,
    # The original synchronous endpoints, kept for scripts that call them.
    "/research": legacy_research_work, "/draft": legacy_draft_work,
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/healthz":
                return self._json(200, {"ok": True})
            if url.path.startswith("/api/"):
                return self._get_api(url)
        except Reject as r:
            return self._json(r.code, {"error": str(r)})
        name = "index.html" if url.path in ("/", "/index.html") else url.path.lstrip("/")
        path = (STATIC / name).resolve()
        if not path.is_file() or STATIC.resolve() not in path.parents:
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)

    def _get_api(self, url):
        code = self._check_code()
        if url.path == "/api/session":
            return self._json(200, {"ok": True})
        if url.path.startswith("/api/jobs/"):
            job = jobs.get(url.path.rsplit("/", 1)[-1])
            if not job or job.code != code:
                return self._json(404, {"error": "This job is no longer running. The server may have restarted."})
            try:
                after = max(0, int(parse_qs(url.query).get("after", ["0"])[0]))
            except ValueError:
                raise Reject(400, "after must be a whole number.")
            return self._json(200, job.snapshot(after))
        self._json(404, {"error": "Not found."})

    def do_POST(self):
        path = urlparse(self.path).path
        route = POST_ROUTES.get(path)
        if not route:
            return self._json(404, {"error": "Not found."})
        try:
            code = self._check_code()
            data = self._read_json()
            try:
                work = route(data)
            except (KeyError, TypeError, ValueError, AttributeError):
                raise Reject(400, "The request is missing fields or has the wrong shape.")
            quota.acquire(code)
        except Reject as r:
            return self._json(r.code, {"error": str(r)})
        if path.startswith("/api/"):
            return self._json(200, {"job": start_job(work, code)})
        try:
            out = work()
        except Exception as e:
            out = {"error": public_error(e)}
        finally:
            quota.release(code)
        self._json(200, out)

    def _check_code(self):
        """The caller's invite code (None when there's no gate). Raises 401 if it's missing or wrong."""
        if not GATED:
            return None
        given = self.headers.get("X-Sociai-Code", "").strip().encode()
        for c in ACCESS_CODES:
            if hmac.compare_digest(c.encode(), given):
                return c
        raise Reject(401, "Enter a valid invite code to use Sociai.")

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
    port = os.environ.get("PORT")
    host, port = ("0.0.0.0", int(port)) if port else ("127.0.0.1", 8000)
    server = ThreadingHTTPServer((host, port), Handler)
    url = os.environ.get("RENDER_EXTERNAL_URL") or f"http://localhost:{port}"
    print(f"Sociai running at {url} (listening on {host}:{port})", flush=True)
    if GATED:
        print(f"Invite gate on: {len(ACCESS_CODES)} code(s), {DAILY_LIMIT} jobs per code per day, "
              f"{MAX_RUNNING} at once, {GLOBAL_DAILY_LIMIT} per day in total.", flush=True)
    else:
        print(f"Invite gate off (SOCIAI_ACCESS_CODES is not set). Daily cap: {GLOBAL_DAILY_LIMIT} jobs.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
