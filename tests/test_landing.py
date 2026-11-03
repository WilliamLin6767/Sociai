"""The landing page: one request to render (its CSS inline, no stylesheet or font link in the
HTML), the first screen's parts in order, links that carry the ad's query on into the app, and
the /api/event counter behind the click-through rate in the log.

Run with: python -m unittest discover tests
"""

import contextlib
import io
import json
import re
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from sociai import web
from sociai.config import Settings
from tests.test_tracker import FakeSupabase

LANDING = web.STATIC / "landing.html"


class Page(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
        cls.server.RequestHandlerClass.log_message = lambda *a: None
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        with urllib.request.urlopen(cls.base + "/") as res:
            cls.html = res.read().decode()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_renders_from_one_request(self):
        self.assertLess(LANDING.stat().st_size, 60 * 1024)
        self.assertNotIn('rel="stylesheet"', self.html, "no render-blocking stylesheet; the CSS is inline")
        self.assertNotIn("fonts.googleapis.com/css", self.html.split("<script>", 3)[0], "no font link in the head")
        self.assertIn("<style>", self.html)
        # Same-origin assets referenced from the markup: the icon only.
        refs = set(re.findall(r'(?:href|src)="(/[^"]+)"', self.html.split("<body", 1)[0]))
        self.assertEqual(refs, {"/favicon.ico", "/mark.svg", "/apple-touch-icon.png"})
        self.assertNotIn("<img", self.html.split("<noscript>")[0].split("<!-- Meta Pixel")[0])

    def test_first_screen_in_order(self):
        body = self.html.split("<main", 1)[1]
        order = [body.index(s) for s in (
            'id="hero-title"', 'class="hero-sub"', 'href="/app?mode=signup" data-app data-cta="hero">Try 2 free drafts',
            "No credit card needed", "Already have an account?", 'href="/app?mode=login" data-app>Log in',
            "Built by Stanford &amp; Berkeley students", 'id="sample"', 'id="how"', 'id="faq"', 'id="pricing"')]
        self.assertEqual(order, sorted(order))
        title = re.search(r'<h1 class="display" id="hero-title">(.*?)</h1>', body).group(1)
        self.assertLessEqual(len(re.sub(r"<[^>]+>", "", title).split()), 8)
        self.assertIn('id="sticky"', body)
        self.assertIn("shaped by real cold emails that got replies", body)
        for banned in ("fine-tuned", "fine tuned", "trained on"):
            self.assertNotIn(banned, self.html.lower())

    def test_prices_are_unchanged(self):
        for price in ("$0", "$14.99", "$11.99", "20 credits", "30 credits every month", "2 credits"):
            self.assertIn(price, self.html)

    def test_inline_scripts_survive_the_asset_rewrite(self):
        # The server rewrites href="/x.css" / src="/x.js" in HTML; an inline script containing that
        # pattern would be changed on the way out and no longer match its CSP hash.
        for script in web.INLINE_SCRIPT.findall(LANDING.read_text(encoding="utf-8")):
            self.assertIsNone(web.PAGE_ASSET.search(script))
        with urllib.request.urlopen(self.base + "/") as res:
            csp = res.headers["Content-Security-Policy"]
        for hashed in web.inline_script_hashes(self.html):
            self.assertIn(hashed, csp)

    def test_links_into_the_app_carry_the_query(self):
        script = self.html.split('<script>\n(() => {', 1)[1]
        self.assertIn('document.querySelectorAll("a[data-app]")', script)
        self.assertIn('"mode"', script, "the page's own ?mode= never overrides a link's")
        self.assertIn('"/api/event"', script)
        self.assertIn('"landing_view"', script)


class Events(unittest.TestCase):
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
        web.supa = FakeSupabase()
        web.settings = Settings()
        web.limiter.reset()
        web._events.update(day=None, landing_view=0, cta_click=0)

    def post(self, body):
        req = urllib.request.Request(self.base + "/api/event", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out), urllib.request.urlopen(req) as res:
                status, data = res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            status, data = e.code, json.loads(e.read())
        return status, data, out.getvalue()

    def test_counts_views_and_clicks_with_a_running_ctr(self):
        self.assertEqual(self.post({"name": "landing_view", "utm_source": "ig", "fbclid": True})[0], 200)
        self.post({"name": "landing_view", "where": "", "utm_source": "", "fbclid": False})
        with contextlib.redirect_stdout(io.StringIO()) as out:
            web.record_event("cta_click", "hero", "ig", True)
        line = out.getvalue()
        self.assertIn("[event] cta_click where=hero utm_source=ig fbclid=yes | today views=2 clicks=1 ctr=50.0%", line)

    def test_no_sign_in_needed_and_values_are_cleaned_before_logging(self):
        status, _, printed = self.post({"name": "cta_click", "where": "hero<script>", "utm_source": "someone@example.com ref", "fbclid": "yes"})
        self.assertEqual(status, 200)
        self.assertIn("[event] cta_click where=heroscript utm_source=someoneexample.comref fbclid=yes", printed)
        status, _, printed = self.post({"name": "cta_click", "where": "x" * 100, "utm_source": 5})
        self.assertEqual(status, 200)
        self.assertIn("where=" + "x" * 24 + " ", printed)

    def test_rejects_unknown_events_and_rate_limits(self):
        self.assertEqual(self.post({"name": "signed_up"})[0], 400)
        self.assertEqual(self.post({})[0], 400)
        for _ in range(web.RATE["public"]):
            self.post({"name": "landing_view"})
        self.assertEqual(self.post({"name": "landing_view"})[0], 429)


if __name__ == "__main__":
    unittest.main()
