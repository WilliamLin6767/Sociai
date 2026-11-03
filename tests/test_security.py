"""Launch hardening: security headers and the Content-Security-Policy, HTTPS and HSTS behind the
proxy, rate limits, request size caps, the client IP behind Cloudflare, lost jobs after a restart,
and the pages' SEO and icon basics.

Run with: python -m unittest discover tests
"""

import json
import os
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from unittest import mock

from sociai import web
from sociai.config import Settings
from sociai.engine import Dossier
from tests.test_tracker import FakeSupabase

SUPABASE_URL = "https://example.supabase.co"
USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
DOSSIER = {"summary": "s", "facts": [{"fact": "f", "source": "https://x.edu"}], "hooks": ["h"], "cautions": [], "sources": ["https://x.edu"]}
REQUEST = {"target": "Prof. Lena Ortiz, UC Berkeley", "goal": "Join the field season", "channel": "email", "max_words": 160}


class SecFake(FakeSupabase):
    """The tracker fake plus what these tests touch: token checks (counted), activation (records
    the IP), job rows and finishing a job."""

    def __init__(self):
        super().__init__()
        self.jobs, self.ips, self.get_user_calls = {}, [], 0

    def get_user(self, token):
        self.get_user_calls += 1
        return super().get_user(token)

    def rpc(self, fn, **a):
        self.rpc_calls.append(fn)
        if fn == "sociai_activate":
            self.ips.append(a["p_ip"])
            return {"credits": 2, "blocked_reason": None}
        if fn == "sociai_finish_job":
            if a["p_job"] in self.jobs:
                self.jobs[a["p_job"]]["status"] = a["p_status"]
            return {"credits": 3}
        if fn == "sociai_start_job":
            return {"job_id": str(uuid.uuid4()), "credits": 1}
        raise AssertionError(fn)

    def rpc_as(self, token, fn, **a):
        if fn == "sociai_get_profile":
            return {"resume_text": ""}
        raise AssertionError(fn)

    def rows_as(self, token, method, table, query="", body=None):
        if table != "jobs":
            return super().rows_as(token, method, table, query, body)
        want = dict(part.split("=eq.") for part in query.split("&") if "=eq." in part)
        return [dict(j) for j in self.jobs.values() if j["id"] == want.get("id") and j["user_id"] == want.get("user_id")]


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
        cls.server.RequestHandlerClass.log_message = lambda *a: None
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.fake = web.supa = SecFake()
        web.settings = Settings(supabase_url=SUPABASE_URL, supabase_anon_key="anon", supabase_service_key="service")
        web._tokens.clear()
        web.limiter.reset()

    def call(self, method, path, body=None, token="token-a", headers=None):
        h = dict(headers or {})
        if token:
            h["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, res.headers, res.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def get(self, path, **headers):
        return self.call("GET", path, token=None, headers=headers)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


opener = urllib.request.build_opener(NoRedirect)


class Headers(Server):
    def test_every_response_carries_the_security_headers(self):
        for path in ("/", "/app", "/privacy", "/api/config", "/no-such-page", "/sociai.css", "/robots.txt"):
            with self.subTest(path=path):
                _, h, _ = self.get(path)
                self.assertEqual(h["X-Content-Type-Options"], "nosniff")
                self.assertEqual(h["X-Frame-Options"], "DENY")
                self.assertEqual(h["Referrer-Policy"], "strict-origin-when-cross-origin")
                self.assertIn("camera=()", h["Permissions-Policy"])
                self.assertIn("frame-ancestors 'none'", h["Content-Security-Policy"])
                self.assertIsNotNone(h["Content-Length"])
        _, h, _ = self.call("POST", "/api/check-email", {"email": "a@b.co"}, token=None)
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertEqual(h["Content-Security-Policy"], web.NO_CONTENT_CSP)

    def test_pages_get_a_policy_that_names_their_origins_and_hashes_inline_scripts(self):
        for path, name in (("/", "landing.html"), ("/app", "app.html"), ("/privacy", "privacy.html"), ("/terms", "terms.html")):
            with self.subTest(path=path):
                _, h, body = self.get(path)
                csp = h["Content-Security-Policy"]
                directives = dict(d.strip().split(" ", 1) for d in csp.split(";"))
                self.assertNotIn("unsafe-inline", directives["script-src"])
                self.assertNotIn("unsafe-eval", csp)
                self.assertIn("https://cdn.jsdelivr.net", directives["script-src"])
                self.assertIn(SUPABASE_URL, directives["connect-src"])
                self.assertEqual(directives["frame-ancestors"], "'none'")
                self.assertEqual(directives["object-src"], "'none'")
                self.assertEqual(directives["base-uri"], "'none'")
                scripts = web.INLINE_SCRIPT.findall(body.decode())
                self.assertTrue(scripts, "every page has at least the theme script inline")
                for hashed in web.inline_script_hashes(body.decode()):
                    self.assertIn(hashed, directives["script-src"])
                self.assertEqual(len(web.PAGE_HASHES[name]), len(scripts))
        self.assertNotIn("fbevents.js", self.get("/app")[2].decode(), "the app loads the pixel from app.js, after the URL is cleaned")
        self.assertIn("fbevents.js", self.get("/")[2].decode())

    def test_hsts_and_the_https_redirect_only_behind_the_proxy(self):
        self.assertIsNone(self.get("/")[1]["Strict-Transport-Security"])
        web.settings.trust_proxy = True
        self.assertEqual(self.get("/", **{"X-Forwarded-Proto": "https"})[1]["Strict-Transport-Security"], web.HSTS)
        req = urllib.request.Request(self.base + "/app?mode=login", headers={"X-Forwarded-Proto": "http", "Host": "getsociai.com"})
        with self.assertRaises(urllib.error.HTTPError) as cm:
            opener.open(req)
        self.assertEqual(cm.exception.code, 301)
        self.assertEqual(cm.exception.headers["Location"], "https://getsociai.com/app?mode=login")
        self.assertIsNone(cm.exception.headers["Strict-Transport-Security"])
        self.assertEqual(self.get("/healthz", **{"X-Forwarded-Proto": "http"})[0], 200, "Render's health check isn't redirected")

    def test_head_requests_and_content_length(self):
        status, h, body = self.get("/")
        req = urllib.request.Request(self.base + "/", method="HEAD")
        with urllib.request.urlopen(req) as res:
            self.assertEqual(res.status, 200)
            self.assertEqual(res.headers["Content-Length"], str(len(body)))
            self.assertEqual(res.read(), b"")
        self.assertEqual(h["Content-Length"], str(len(body)))

    def test_raw_html_file_names_redirect_to_their_pages(self):
        for raw, page in (("/app.html", "/app"), ("/landing.html", "/"), ("/privacy.html", "/privacy"), ("/terms.html", "/terms")):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                opener.open(self.base + raw)
            self.assertEqual((cm.exception.code, cm.exception.headers["Location"]), (302, page))

    def test_seo_and_icons(self):
        app = self.get("/app")[2].decode()
        self.assertIn('<meta name="robots" content="noindex">', app)
        landing = self.get("/")[2].decode()
        self.assertNotIn("noindex", landing)
        self.assertIn('property="og:image" content="https://getsociai.com/og.png"', landing)
        self.assertIn('name="twitter:card" content="summary_large_image"', landing)
        for page in (app, landing, self.get("/privacy")[2].decode()):
            self.assertIn('rel="icon" href="/favicon.ico"', page)
            self.assertIn('rel="apple-touch-icon" href="/apple-touch-icon.png"', page)
        for path, ctype in (("/favicon.ico", "image/x-icon"), ("/apple-touch-icon.png", "image/png"), ("/og.png", "image/png")):
            status, h, body = self.get(path)
            self.assertEqual((status, h["Content-Type"]), (200, ctype), path)
            self.assertGreater(len(body), 500)
        self.assertIn("Meta Pixel", self.get("/privacy")[2].decode())


class RateLimits(Server):
    def test_the_public_email_check_is_limited_per_ip(self):
        for _ in range(web.RATE["public"]):
            self.assertEqual(self.call("POST", "/api/check-email", {"email": "a@b.co"}, token=None)[0], 200)
        status, h, body = self.call("POST", "/api/check-email", {"email": "a@b.co"}, token=None)
        self.assertEqual(status, 429)
        self.assertTrue(1 <= int(h["Retry-After"]) <= 60)
        self.assertIn("Wait a minute", json.loads(body)["error"])

    def test_invalid_tokens_are_remembered_and_checks_are_limited(self):
        for _ in range(5):
            self.assertEqual(self.call("GET", "/api/me", token="nope")[0], 401)
        self.assertEqual(self.fake.get_user_calls, 1, "the same bad token is checked with Supabase once, not per request")
        for _ in range(3):
            self.assertEqual(self.call("GET", "/api/me")[0], 200)
        self.assertEqual(self.fake.get_user_calls, 2, "a valid token is cached too")
        for i in range(web.RATE["verify"] - 2):
            self.assertEqual(self.call("GET", "/api/me", token=f"made-up-{i}")[0], 401)
        self.assertEqual(self.call("GET", "/api/me", token="one-more")[0], 429)
        self.assertEqual(self.call("GET", "/api/me")[0], 200, "cached valid sessions keep working")

    def test_limits_are_per_user_for_the_expensive_calls(self):
        web.engine = type("E", (), {"research": lambda self, req, on_progress=None, usage=None: Dossier(summary="s", facts=[], hooks=[], cautions=[], sources=[])})()
        for _ in range(web.RATE["job"]):
            self.assertEqual(self.call("POST", "/api/research", {"request": REQUEST, "project_id": "p1"})[0], 200)
        self.assertEqual(self.call("POST", "/api/research", {"request": REQUEST, "project_id": "p1"})[0], 429)
        self.assertEqual(self.call("POST", "/api/research", {"request": "bad", "project_id": "p1"})[0], 400, "malformed requests are refused as such, not counted")
        self.assertEqual(self.call("POST", "/api/research", {"request": REQUEST, "project_id": "p1"}, token="token-b")[0], 200)
        for _ in range(web.RATE["delete"]):
            self.assertEqual(self.call("DELETE", "/api/account", {"confirm": "nope"})[0], 400)
        self.assertEqual(self.call("DELETE", "/api/account", {"confirm": "nope"})[0], 429)

    def test_polling_is_not_counted_against_the_ip_budget(self):
        with mock.patch.dict(web.RATE, {"api": 3}):
            jid = str(uuid.uuid4())
            for _ in range(5):
                self.assertEqual(self.call("GET", f"/api/jobs/{jid}")[0], 404)
            for _ in range(3):
                self.assertEqual(self.call("GET", "/api/me")[0], 200)
            self.assertEqual(self.call("GET", "/api/me")[0], 429)


class RequestCaps(Server):
    def start(self, path, body):
        status, _, raw = self.call("POST", path, body)
        return status, json.loads(raw).get("error", "")

    def test_oversized_or_malformed_research_requests_are_refused_before_a_job_starts(self):
        bad = [
            ({**REQUEST, "target": "x" * 501}, "target can be up to 500"),
            ({**REQUEST, "goal": "x" * 2001}, "goal can be up to 2,000"),
            ({**REQUEST, "sender_background": "x" * 20001}, "sender_background can be up to 20,000"),
            ({**REQUEST, "writing_samples": ["s"] * 11}, "up to 10 writing samples"),
            ({**REQUEST, "writing_samples": ["x" * 20001]}, "up to 20,000 characters"),
            ({**REQUEST, "writing_samples": "not a list"}, "list of texts"),
            ({**REQUEST, "channel": "fax"}, "Choose email"),
            ({**REQUEST, "max_words": 1000}, "between 40 and 600"),
            ({**REQUEST, "max_words": "160"}, "between 40 and 600"),
            ({**REQUEST, "target": "   "}, "Say who this is for"),
            ("not an object", "needs a request object"),
        ]
        for request, message in bad:
            with self.subTest(message=message):
                status, error = self.start("/api/research", {"request": request, "project_id": "p1"})
                self.assertEqual(status, 400)
                self.assertIn(message, error)
        self.assertNotIn("sociai_start_job", self.fake.rpc_calls)

    def test_draft_requests_check_the_dossier_and_revision(self):
        base = {"request": REQUEST, "project_id": "p1"}
        bad = [
            ({**base, "dossier": "nope"}, "needs the research"),
            ({**base, "dossier": {**DOSSIER, "facts": ["just a string"]}}, "wrong shape"),
            ({**base, "dossier": {**DOSSIER, "extra": 1}}, "wrong shape"),
            ({**base, "dossier": {**DOSSIER, "summary": "x" * 100_001}}, "too large"),
            ({**base, "dossier": DOSSIER, "revise": {"body": "b"}}, "needs the current draft and an instruction"),
            ({**base, "dossier": DOSSIER, "revise": {"body": "b", "instruction": "x" * 2001}}, "up to 2,000"),
            ({**base, "dossier": DOSSIER, "revise": {"body": "x" * 20001, "instruction": "i"}}, "up to 20,000"),
            ({**base, "dossier": DOSSIER, "revise": {"body": 5, "instruction": "i"}}, "must be text"),
        ]
        for body, message in bad:
            with self.subTest(message=message):
                status, error = self.start("/api/draft", body)
                self.assertEqual(status, 400, error)
                self.assertIn(message, error)
        self.assertNotIn("sociai_start_job", self.fake.rpc_calls)

    def test_a_good_request_is_cleaned_and_accepted(self):
        req = web.clean_request({**REQUEST, "writing_samples": ["  a  ", "", "b"], "max_words": 160.0, "resume_text": "ignored"})
        self.assertEqual(req["writing_samples"], ["a", "b"])
        self.assertEqual(req["max_words"], 160)
        self.assertNotIn("resume_text", req)


class LostJobs(Server):
    def test_a_job_lost_to_a_restart_is_closed_and_the_research_credit_refunded(self):
        jid = str(uuid.uuid4())
        self.fake.jobs[jid] = {"id": jid, "kind": "research", "status": "running", "user_id": USER_A}
        status, _, raw = self.call("GET", f"/api/jobs/{jid}")
        self.assertEqual(status, 404)
        self.assertIn("Your credit was refunded", json.loads(raw)["error"])
        self.assertEqual(self.fake.jobs[jid]["status"], "error")
        self.assertEqual(self.fake.rpc_calls.count("sociai_finish_job"), 1)
        status, _, raw = self.call("GET", f"/api/jobs/{jid}")  # already closed: nothing more happens
        self.assertEqual(self.fake.rpc_calls.count("sociai_finish_job"), 1)
        self.assertIn("no longer running", json.loads(raw)["error"])

    def test_a_lost_draft_says_no_credit_was_used(self):
        jid = str(uuid.uuid4())
        self.fake.jobs[jid] = {"id": jid, "kind": "draft", "status": "running", "user_id": USER_A}
        self.assertIn("didn't use a credit", json.loads(self.call("GET", f"/api/jobs/{jid}")[2])["error"])

    def test_someone_elses_job_is_left_alone(self):
        jid = str(uuid.uuid4())
        self.fake.jobs[jid] = {"id": jid, "kind": "research", "status": "running", "user_id": USER_B}
        status, _, raw = self.call("GET", f"/api/jobs/{jid}")
        self.assertEqual(status, 404)
        self.assertEqual(self.fake.jobs[jid]["status"], "running")
        self.assertNotIn("sociai_finish_job", self.fake.rpc_calls)
        self.assertEqual(self.call("GET", "/api/jobs/not-a-uuid")[0], 404)


class ClientIP(Server):
    def test_cloudflares_header_beats_a_forged_x_forwarded_for(self):
        web.settings.trust_proxy = True
        self.call("GET", "/api/me", headers={"CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "1.1.1.1, 10.0.0.1"})
        self.call("GET", "/api/me", headers={"X-Forwarded-For": "198.51.100.7, 10.0.0.1"})
        web.settings.trust_proxy = False
        self.call("GET", "/api/me", headers={"CF-Connecting-IP": "203.0.113.9", "X-Forwarded-For": "1.1.1.1"})
        self.assertEqual(self.fake.ips, ["203.0.113.9", "198.51.100.7", "127.0.0.1"])

    def test_accounts_per_ip_can_be_raised_from_the_environment(self):
        with mock.patch.dict(os.environ, {"SOCIAI_MAX_ACCOUNTS_PER_IP": "25"}):
            self.assertEqual(Settings.from_env().max_accounts_per_ip, 25)
        self.assertEqual(Settings().max_accounts_per_ip, 3)


class LimiterUnit(unittest.TestCase):
    def test_sliding_window(self):
        lim = web.Limiter()
        now = [1000.0]
        with mock.patch("sociai.web.time.time", lambda: now[0]):
            self.assertEqual([lim.check("k", 2, 60) for _ in range(3)], [0.0, 0.0, 60.0])
            now[0] += 30
            self.assertEqual(lim.check("k", 2, 60), 30.0)
            now[0] += 31
            self.assertEqual(lim.check("k", 2, 60), 0.0)
            self.assertEqual(lim.check("other", 2, 60), 0.0)

    def test_pixel_loads_after_the_url_is_cleaned(self):
        js = (web.STATIC / "app.js").read_text(encoding="utf-8")
        cleaned = js.index('history.replaceState(null, "", location.pathname + (query.toString()')
        self.assertLess(cleaned, js.index("loadPixel();"))
        self.assertIn("fbevents.js", js)
        self.assertEqual(web.Handler.timeout, 30)


if __name__ == "__main__":
    unittest.main()
