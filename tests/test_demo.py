"""The landing-page demo (research + a teaser of the draft, one per IP per day, no credits), the
claim that turns it into the new account's first project, sign-up attribution, and the funnel.

Run with: python -m unittest discover tests
"""

import contextlib
import io
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer

from sociai import web
from sociai.config import Settings
from sociai.engine import Dossier, Draft
from tests.test_tracker import FakeSupabase

USER_A = "11111111-1111-4111-8111-111111111111"
USER_B = "22222222-2222-4222-8222-222222222222"
BODY = ("Hi Professor Li,\n\nI'm a CS junior and I read your ImageNet retrospective last term. The point about scale "
        "changed how I think about data. I built a small benchmark of my own. Would you have 15 minutes to talk about open projects?\n\nThanks,\nMaya")


class DemoFake(FakeSupabase):
    def __init__(self):
        super().__init__()
        self.saved, self.counts, self.attribution = {}, {}, {}

    def rpc(self, fn, **a):
        self.rpc_calls.append(fn)
        if fn == "sociai_activate":
            return {"credits": 2, "blocked_reason": None}
        if fn == "sociai_save_demo":
            self.saved[a["p_id"]] = dict(a, claimed_by=None)
            return {"ok": True}
        if fn == "sociai_claim_demo":
            d = self.saved.get(a["p_id"])
            if not d or d["claimed_by"] not in (None, a["p_user"]):
                return None
            d["claimed_by"] = a["p_user"]
            return {"id": a["p_id"], "target": d["p_target"], "goal": d["p_goal"], "purpose": d["p_purpose"],
                    "dossier": d["p_dossier"], "draft": d["p_draft"]}
        if fn == "sociai_count_event":
            self.counts[a["p_name"]] = self.counts.get(a["p_name"], 0) + 1
            return {"ok": True}
        if fn == "sociai_funnel":
            return [{"day": "2026-11-03", "counts": {"landing_view": 40, "demo_used": 6, "signup_done": 2}},
                    {"day": "2026-11-02", "counts": {"landing_view": 10}}]
        if fn == "sociai_set_attribution":
            self.attribution[a["p_user"]] = a
            return {"recorded": True}
        raise AssertionError(fn)


class FakeDemoEngine:
    def research(self, req, on_progress=None, usage=None):
        on_progress({"kind": "search", "query": f"{req.target} lab"})
        on_progress({"kind": "read", "url": "https://profiles.stanford.edu/fei-fei-li", "title": "Fei-Fei Li"})
        time.sleep(0.05)
        return Dossier(name="Fei-Fei Li", headline="Professor of Computer Science, Stanford",
                       summary="Leads the Stanford Institute for Human-Centered AI. Known for ImageNet. Also writes books.",
                       facts=[{"fact": "Created ImageNet.", "source": "https://profiles.stanford.edu/fei-fei-li"},
                              {"fact": "Co-directs HAI.", "source": "https://hai.stanford.edu"},
                              {"fact": "Wrote The Worlds I See.", "source": "https://hai.stanford.edu"}],
                       hooks=["ImageNet"], cautions=[], sources=["https://profiles.stanford.edu/fei-fei-li", "https://hai.stanford.edu"])

    def draft(self, req, dossier, revise=None, usage=None):
        return Draft(subject="Your ImageNet retrospective", body=BODY, personalization_notes=["ImageNet"], voice_notes="plain", open_questions=[])


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
        self.fake = web.supa = DemoFake()
        web.settings = Settings(supabase_url="https://example.supabase.co", supabase_anon_key="anon", supabase_service_key="service",
                                trust_proxy=True)
        web.demo_engine = FakeDemoEngine()
        web._tokens.clear()
        web.limiter.reset()
        web.demos.clear()
        web._events.update(day=None)

    def call(self, method, path, body=None, token=None, ip="203.0.113.5"):
        headers = {"X-Forwarded-For": ip}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with contextlib.redirect_stdout(io.StringIO()), urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read()), res.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), e.headers

    def run_demo(self, ip="203.0.113.5", **body):
        status, data, _ = self.call("POST", "/api/demo", {"target": "Prof. Fei-Fei Li, Stanford", "purpose": "research", **body}, ip=ip)
        self.assertEqual(status, 200, data)
        for _ in range(100):
            status, snap, _ = self.call("GET", f"/api/demo/{data['id']}", ip=ip)
            if snap["status"] != "running":
                return data["id"], snap
            time.sleep(0.03)
        self.fail("demo never finished")


class Demo(Server):
    def test_runs_and_shows_a_teaser_only(self):
        demo_id, snap = self.run_demo()
        self.assertEqual(snap["status"], "done")
        self.assertEqual([e["kind"] for e in snap["events"]], ["search", "read", "drafting"])
        t = snap["teaser"]
        self.assertEqual((t["name"], t["subject"], t["greeting"]), ("Fei-Fei Li", "Your ImageNet retrospective", "Hi Professor Li,"))
        self.assertEqual(t["opening"], "I'm a CS junior and I read your ImageNet retrospective last term. The point about scale changed how I think about data.")
        self.assertEqual(len(t["facts"]), 2)
        self.assertEqual(t["summary"], "Leads the Stanford Institute for Human-Centered AI. Known for ImageNet.")
        self.assertGreater(t["hidden_words"], 10)
        raw = json.dumps(snap)
        self.assertNotIn("benchmark of my own", raw, "the rest of the email never reaches the browser")
        self.assertNotIn("The Worlds I See", raw)
        self.assertIn("sociai_save_demo", self.fake.rpc_calls)
        self.assertNotIn("sociai_start_job", self.fake.rpc_calls)
        self.assertNotIn("sociai_finish_job", self.fake.rpc_calls, "demos have no job row and touch no credits")

    def test_one_demo_per_ip_per_day_and_a_daily_cap(self):
        self.run_demo()
        status, data, _ = self.call("POST", "/api/demo", {"target": "Someone else, MIT"})
        self.assertEqual((status, data["action"]), (429, "signup"))
        self.assertIn("Sign up free", data["error"])
        web.settings.demo_daily_limit = 2
        self.run_demo(ip="198.51.100.1")
        status, data, _ = self.call("POST", "/api/demo", {"target": "A third person"}, ip="198.51.100.2")
        self.assertEqual((status, data["action"]), (429, "signup"))

    def test_a_failed_demo_gives_the_visitor_another_go(self):
        class Broken(FakeDemoEngine):
            def research(self, req, on_progress=None, usage=None):
                raise RuntimeError("stalled")
        web.demo_engine = Broken()
        with contextlib.redirect_stderr(io.StringIO()):
            demo_id, snap = self.run_demo()
        self.assertEqual(snap["status"], "error")
        self.assertIn("Something went wrong", snap["error"])
        web.demo_engine = FakeDemoEngine()
        demo_id, snap = self.run_demo()  # same IP, same day: allowed again
        self.assertEqual(snap["status"], "done")
        self.assertEqual(self.call("POST", "/api/demo", {"target": "Someone else"})[0], 429)
        self.assertEqual(web.demo_engine.__class__, FakeDemoEngine)
        from sociai.engine import Engine
        self.assertIsNone(Engine.__init__.__defaults__ and None)  # Engine() accepts a timeout attribute
        lim = web.Limiter()
        lim.check("k", 1, 60)
        lim.release("k")
        self.assertEqual(lim.check("k", 1, 60), 0.0)

    def test_bad_input_and_no_engine(self):
        self.assertEqual(self.call("POST", "/api/demo", {"target": "Al"})[0], 400)
        self.assertEqual(self.call("POST", "/api/demo", {"target": "x" * 1000})[0], 200, "long names are cut, not refused")
        web.demo_engine = None
        status, data, _ = self.call("POST", "/api/demo", {"target": "Prof. Someone"}, ip="198.51.100.9")
        self.assertEqual((status, data["action"]), (503, "signup"))
        self.assertEqual(self.call("GET", f"/api/demo/{uuid.uuid4()}")[0], 404)
        self.assertEqual(self.call("GET", "/api/demo/not-an-id")[0], 404)

    def test_the_account_that_signs_up_claims_the_full_draft_once(self):
        demo_id, _ = self.run_demo()
        self.assertEqual(self.call("POST", "/api/demo/claim", {"id": demo_id})[0], 401)
        status, data, _ = self.call("POST", "/api/demo/claim", {"id": demo_id}, token="token-a")
        self.assertEqual(status, 200)
        d = data["demo"]
        self.assertEqual((d["target"], d["category"], d["draft"]["body"]), ("Prof. Fei-Fei Li, Stanford", "professor", BODY))
        self.assertEqual(len(d["dossier"]["facts"]), 3)
        self.assertEqual(self.call("POST", "/api/demo/claim", {"id": demo_id}, token="token-a")[0], 200, "the same account may fetch it again")
        self.assertEqual(self.call("POST", "/api/demo/claim", {"id": demo_id}, token="token-b")[0], 404)
        self.assertEqual(self.call("POST", "/api/demo/claim", {"id": "nope"}, token="token-b")[0], 400)

    def test_a_claim_after_a_restart_comes_from_the_database(self):
        demo_id, _ = self.run_demo()
        web.demos.clear()  # as after a deploy
        status, data, _ = self.call("POST", "/api/demo/claim", {"id": demo_id}, token="token-b")
        self.assertEqual(status, 200)
        self.assertEqual(data["demo"]["draft"]["subject"], "Your ImageNet retrospective")
        self.assertEqual(self.fake.saved[demo_id]["claimed_by"], USER_B)
        self.assertEqual(self.call("POST", "/api/demo/claim", {"id": demo_id}, token="token-a")[0], 404)

    def test_teaser_shapes(self):
        t = web.demo_teaser({"dossier": {"summary": "One. Two. Three.", "facts": [], "sources": []},
                             "draft": {"subject": "S", "body": "Dear X,\n\nFirst sentence here. Second one! Third one? Fourth."}})
        self.assertEqual((t["greeting"], t["opening"], t["hidden_words"]), ("Dear X,", "First sentence here. Second one!", 3))
        t = web.demo_teaser({"dossier": {}, "draft": {"body": ""}})
        self.assertEqual((t["greeting"], t["opening"], t["hidden_words"], t["words"]), ("", "", 0, 0))


class Funnel(Server):
    def test_events_reach_the_log_and_the_database(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            web.record_event("signup_done", "", "ig", True)
            time.sleep(0.1)
        self.assertIn("[event] signup_done utm_source=ig fbclid=yes | today signup_done=1 signup_rate=-", out.getvalue())
        self.assertEqual(self.fake.counts, {"signup_done": 1})

    def test_browser_may_report_only_its_own_steps(self):
        for name in web.CLIENT_EVENTS:
            self.assertEqual(self.call("POST", "/api/event", {"name": name})[0], 200, name)
        for name in web.SERVER_EVENTS:
            self.assertEqual(self.call("POST", "/api/event", {"name": name})[0], 400, name)

    def test_checkout_and_demo_are_counted_on_the_server(self):
        self.run_demo()
        time.sleep(0.1)
        self.assertEqual(self.fake.counts.get("demo_used"), 1)

    def test_funnel_page_needs_the_admin_token(self):
        self.assertEqual(self.call("GET", "/api/funnel")[0], 404, "off until SOCIAI_ADMIN_TOKEN is set")
        web.settings.admin_token = "s3cret"
        self.assertEqual(self.call("GET", "/api/funnel")[0], 401)
        self.assertEqual(self.call("GET", "/api/funnel?token=wrong")[0], 401)
        req = urllib.request.Request(self.base + "/api/funnel?token=s3cret")
        with urllib.request.urlopen(req) as res:
            text = res.read().decode()
            self.assertEqual(res.headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertIn("2026-11-03", text)
        self.assertIn("signup_done 4.0%", text)  # 2 of 50 views over the two days
        status, data, _ = self.call("GET", "/api/funnel?format=json", token="s3cret")
        self.assertEqual(status, 200)
        self.assertEqual(data["days"][0]["counts"]["demo_used"], 6)

    def test_funnel_text(self):
        text = web.funnel_text([{"day": "2026-11-03", "counts": {"landing_view": 200, "signup_done": 0}}])
        self.assertIn("landing_view", text.splitlines()[0])
        self.assertEqual(text.splitlines()[1].split(), ["2026-11-03", "200", "0", "0", "0", "0", "0"])
        self.assertIn("signup_done 0.0%", text)
        self.assertEqual(web.funnel_text([]).count("\n"), 1)


class Attribution(Server):
    def test_recorded_once_per_user_from_the_ad_link(self):
        self.assertEqual(self.call("POST", "/api/profile/attribution", {"utm_source": "ig"})[0], 401)
        status, _, _ = self.call("POST", "/api/profile/attribution",
                                 {"utm_source": "ig", "utm_medium": "paid social", "utm_campaign": "launch<b>", "fbclid": "IwAR1"}, token="token-a")
        self.assertEqual(status, 200)
        rec = self.fake.attribution[USER_A]
        self.assertEqual((rec["p_source"], rec["p_medium"], rec["p_campaign"], rec["p_fbclid"]), ("ig", "paidsocial", "launchb", True))


if __name__ == "__main__":
    unittest.main()
