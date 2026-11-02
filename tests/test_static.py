"""Static files: pages and modules link CSS and JS with ?v=<version>, so a cache in front of the
site (Cloudflare) can never pair a new page with an old stylesheet after a deploy.

Run with: python -m unittest discover tests
"""

import re
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from sociai import web

V = web.ASSET_VERSION


class VersionedAssets(unittest.TestCase):
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

    def get(self, path):
        with urllib.request.urlopen(self.base + path) as res:
            return res.headers, res.read().decode()

    def test_pages_link_versioned_css_and_js(self):
        for page in ("/app", "/", "/privacy", "/terms"):
            with self.subTest(page=page):
                headers, html = self.get(page)
                self.assertIn(f'href="/sociai.css?v={V}"', html)
                self.assertNotIn('href="/sociai.css"', html)
                self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertIn(f'src="/app.js?v={V}"', self.get("/app")[1])

    def test_module_imports_are_versioned(self):
        js = self.get(f"/app.js?v={V}")[1]
        for name in ("store", "auth", "loom", "tracker"):
            self.assertIn(f'from "./{name}.js?v={V}"', js)
        self.assertFalse(re.search(r'from\s+"\./[\w.-]+\.js"', js), "an import without ?v= is left")
        self.assertIn("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@", self.get("/auth.js")[1])  # CDN URLs untouched

    def test_cache_headers(self):
        self.assertEqual(self.get(f"/sociai.css?v={V}")[0]["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(self.get(f"/tracker.js?v={V}")[0]["Cache-Control"], "public, max-age=31536000, immutable")
        self.assertEqual(self.get("/sociai.css")[0]["Cache-Control"], "no-cache")
        self.assertEqual(self.get("/sociai.css?v=old")[0]["Cache-Control"], "no-cache")  # a stale page's link
        self.assertEqual(self.get("/sociai.css")[0]["Content-Type"], "text/css; charset=utf-8")

    def test_version_follows_the_files(self):
        self.assertRegex(V, r"^[0-9a-f]{12}$")
        self.assertIn(".tr-due", self.get(f"/sociai.css?v={V}")[1])


if __name__ == "__main__":
    unittest.main()
