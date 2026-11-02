"""Web UI (stdlib only): python -m sociai.web  ->  http://localhost:8000

The page lives in sociai/static/. Research and drafting run as background jobs so
the browser can show live progress and pick a job back up after a refresh:

  POST /api/research  {request}                      -> {"job": id}
  POST /api/draft     {request, dossier, revise?}    -> {"job": id}
  GET  /api/jobs/<id>?after=N  -> {"status", "events" (from index N), "result", "error"}

Projects are saved in the browser (localStorage); nothing is ever sent anywhere
except to the Claude API, and messages are never sent on the user's behalf.
"""

import json
import mimetypes
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .engine import Dossier, Engine, OutreachRequest

engine = Engine()

STATIC = Path(__file__).parent / "static"
# Windows can map these from the registry (e.g. .js -> text/plain), which breaks modules.
for ext, kind in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml")):
    mimetypes.add_type(kind, ext)
JOB_TTL = 3600  # seconds a finished job is kept for a refreshed page to collect


class EditedDossier(Dossier):
    """A dossier the user edited by hand: draft from their text, not the original."""

    def __init__(self, text: str):
        super().__init__(summary="", facts=[], hooks=[], cautions=[], sources=[])
        self._text = text

    def as_text(self) -> str:
        return self._text


class Job:
    def __init__(self, work):
        self.events, self.result, self.error = [], None, None
        self.status = "running"
        self.created = time.time()
        self.lock = threading.Lock()
        threading.Thread(target=self._run, args=(work,), daemon=True).start()

    def _run(self, work):
        try:
            result = work(self.emit)
            with self.lock:
                self.result, self.status = result, "done"
        except Exception as e:  # surfaced in the UI as a readable error
            cause = f" (cause: {e.__cause__!r})" if e.__cause__ else ""
            with self.lock:
                self.error, self.status = f"{type(e).__name__}: {e}{cause}", "error"

    def emit(self, event):
        with self.lock:
            self.events.append({**event, "t": time.time() - self.created})

    def snapshot(self, after):
        with self.lock:
            return {"status": self.status, "events": self.events[after:], "total": len(self.events),
                    "result": self.result, "error": self.error}


jobs: dict[str, Job] = {}


def start_job(work) -> str:
    now = time.time()
    for key in [k for k, j in jobs.items() if now - j.created > JOB_TTL]:
        del jobs[key]
    key = uuid.uuid4().hex
    jobs[key] = Job(work)
    return key


def research_work(data):
    req = OutreachRequest(**data["request"])
    return lambda emit: engine.research(req, on_progress=emit).__dict__


def draft_work(data):
    req = OutreachRequest(**data["request"])
    dossier = Dossier(**data["dossier"])
    return lambda emit: engine.draft(req, dossier, revise=data.get("revise")).__dict__


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/jobs/"):
            job = jobs.get(url.path.rsplit("/", 1)[-1])
            if not job:
                return self._json(404, {"error": "This job is no longer running. The server may have restarted."})
            after = int(parse_qs(url.query).get("after", ["0"])[0])
            return self._json(200, job.snapshot(after))
        name = "index.html" if url.path in ("/", "/index.html") else url.path.lstrip("/")
        path = (STATIC / name).resolve()
        if not path.is_file() or STATIC.resolve() not in path.parents:
            return self._send(404, b"Not found", "text/plain")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        try:
            if self.path == "/api/research":
                out = {"job": start_job(research_work(data))}
            elif self.path == "/api/draft":
                out = {"job": start_job(draft_work(data))}
            # The original synchronous endpoints, kept for scripts that call them.
            elif self.path == "/research":
                dossier = engine.research(OutreachRequest(**data))
                out = {"dossier": dossier.__dict__, "text": dossier.as_text()}
            elif self.path == "/draft":
                req = OutreachRequest(**data["request"])
                original = Dossier(**data["dossier"])
                dossier = original if data["edited"] == original.as_text() else EditedDossier(data["edited"])
                out = engine.draft(req, dossier).__dict__
            else:
                return self._json(404, {})
        except Exception as e:  # surface API errors in the UI during prototyping
            cause = f" (cause: {e.__cause__!r})" if e.__cause__ else ""
            out = {"error": f"{type(e).__name__}: {e}{cause}"}
        self._json(200, out)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/jobs/"):  # polling would drown the log
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print("Sociai running at http://localhost:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
