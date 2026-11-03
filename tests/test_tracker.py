"""Outreach tracker: follow-up rules (sociai/tracker.py) and the /api/contacts endpoints.

Run with: python -m unittest discover tests

The API tests run the real request handler against an in-memory stand-in for Supabase. The
stand-in does NOT apply row-level security, so the cross-account tests show the server's own
user_id filter keeps people out of each other's rows; in production RLS is a second wall.
"""

import json
import threading
import unittest
import urllib.error
import urllib.request
import uuid
from datetime import date
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qsl

from sociai import tracker, web
from sociai.supabase import SupabaseRefused
from sociai.tracker import Invalid, apply_rules, clean, client_today, present

TODAY = date(2026, 11, 2)


class FollowUpRules(unittest.TestCase):
    def test_marking_sent_sets_follow_up_by_role(self):
        for role, days, expected in (("professor", 30, "2026-12-02"), ("recruiter", 7, "2026-11-09"),
                                     ("alum", 10, "2026-11-12"), ("other", 10, "2026-11-12")):
            with self.subTest(role=role):
                self.assertEqual(tracker.FOLLOW_UP_DAYS[role], days)
                out = apply_rules(None, {"name": "A", "role": role, "status": "sent"}, TODAY)
                self.assertEqual(out["sent_at"], "2026-11-02")
                self.assertEqual(out["follow_up_at"], expected)

    def test_follow_up_counts_from_the_sent_date(self):
        out = apply_rules(None, {"role": "recruiter", "status": "sent", "sent_at": "2026-10-20"}, TODAY)
        self.assertEqual(out["follow_up_at"], "2026-10-27")

    def test_a_follow_up_given_in_the_request_wins(self):
        out = apply_rules(None, {"role": "professor", "status": "sent", "follow_up_at": "2026-11-05"}, TODAY)
        self.assertEqual(out["follow_up_at"], "2026-11-05")
        out = apply_rules(None, {"role": "professor", "status": "sent", "follow_up_at": None}, TODAY)
        self.assertIsNone(out["follow_up_at"])

    def test_marking_sent_from_drafted_on_an_existing_row(self):
        old = {"status": "drafted", "role": "alum", "sent_at": None, "follow_up_at": None}
        self.assertEqual(apply_rules(old, {"status": "sent"}, TODAY),
                         {"status": "sent", "sent_at": "2026-11-02", "follow_up_at": "2026-11-12"})

    def test_an_existing_follow_up_is_kept(self):
        old = {"status": "follow_up_due", "role": "professor", "sent_at": "2026-09-01", "follow_up_at": "2026-10-01"}
        self.assertNotIn("follow_up_at", apply_rules(old, {"status": "sent"}, TODAY))

    def test_other_edits_leave_the_dates_alone(self):
        old = {"status": "sent", "role": "professor", "sent_at": "2026-10-01", "follow_up_at": "2026-10-31"}
        self.assertEqual(apply_rules(old, {"notes": "Met at office hours"}, TODAY), {"notes": "Met at office hours"})

    def test_marking_replied_clears_the_follow_up(self):
        old = {"status": "sent", "role": "professor", "sent_at": "2026-10-01", "follow_up_at": "2026-10-31"}
        out = apply_rules(old, {"status": "replied"}, TODAY)
        self.assertIsNone(out["follow_up_at"])
        self.assertEqual(out["replied_at"], "2026-11-02")

    def test_marking_replied_keeps_a_given_reply_date(self):
        out = apply_rules({"status": "sent"}, {"status": "replied", "replied_at": "2026-10-30"}, TODAY)
        self.assertEqual(out["replied_at"], "2026-10-30")

    def test_sent_again_after_a_reply_gets_a_new_follow_up(self):
        old = {"status": "replied", "role": "recruiter", "sent_at": "2026-10-01", "follow_up_at": None}
        self.assertEqual(apply_rules(old, {"status": "sent"}, TODAY)["follow_up_at"], "2026-10-08")


class ShownStatus(unittest.TestCase):
    def row(self, **kw):
        return {"id": "x", "user_id": "u", "name": "A", "status": "sent", "follow_up_at": None, **kw}

    def test_sent_becomes_follow_up_due_once_the_date_arrives(self):
        self.assertEqual(present(self.row(follow_up_at="2026-11-01"), TODAY)["shown_status"], "follow_up_due")
        self.assertEqual(present(self.row(follow_up_at="2026-11-02"), TODAY)["shown_status"], "follow_up_due")
        self.assertEqual(present(self.row(follow_up_at="2026-11-03"), TODAY)["shown_status"], "sent")
        self.assertEqual(present(self.row(), TODAY)["shown_status"], "sent")

    def test_other_statuses_are_shown_as_saved(self):
        for status in ("drafted", "replied", "no_reply", "closed"):
            self.assertEqual(present(self.row(status=status, follow_up_at="2026-10-01"), TODAY)["shown_status"], status)

    def test_due_in_covers_overdue_and_the_next_7_days(self):
        self.assertEqual(present(self.row(follow_up_at="2026-10-30"), TODAY)["due_in"], -3)
        self.assertEqual(present(self.row(follow_up_at="2026-11-02"), TODAY)["due_in"], 0)
        self.assertEqual(present(self.row(follow_up_at="2026-11-09"), TODAY)["due_in"], 7)
        self.assertIsNone(present(self.row(follow_up_at="2026-11-10"), TODAY)["due_in"])
        self.assertEqual(present(self.row(status="no_reply", follow_up_at="2026-11-04"), TODAY)["due_in"], 2)

    def test_nothing_is_due_once_replied_closed_or_drafted(self):
        for status in ("drafted", "replied", "closed"):
            self.assertIsNone(present(self.row(status=status, follow_up_at="2026-11-01"), TODAY)["due_in"])

    def test_user_id_is_not_sent_to_the_browser(self):
        self.assertNotIn("user_id", present(self.row(), TODAY))


class Validation(unittest.TestCase):
    def test_a_new_contact_needs_a_name(self):
        for data in ({}, {"name": ""}, {"name": "   "}, {"name": None}):
            with self.assertRaises(Invalid):
                clean(data, partial=False)
        self.assertEqual(clean({"name": "  Lena Ortiz "}, partial=False), {"name": "Lena Ortiz"})

    def test_an_edit_needs_a_name_only_if_it_changes_it(self):
        self.assertEqual(clean({"notes": "hi"}, partial=True), {"notes": "hi"})
        with self.assertRaises(Invalid):
            clean({"name": ""}, partial=True)

    def test_length_limits(self):
        for field, limit in tracker.TEXT_LIMITS.items():
            value = "a@b.co" + "x" * (limit - 6) if field == "email" else "x" * limit
            clean({"name": "A", field: value}, partial=False)
            with self.subTest(field=field), self.assertRaises(Invalid):
                clean({"name": "A", field: value + "x"}, partial=False)

    def test_rejects_bad_values(self):
        for data in ({"email": "not-an-email"}, {"role": "dean"}, {"status": "ghosted"}, {"sent_at": "11/02/2026"},
                     {"sent_at": "2026-02-30"}, {"follow_up_at": "1999-01-01"}, {"notes": 5}, {"role": None},
                     {"user_id": "someone-else"}, {"id": "x"}):
            with self.subTest(data=data), self.assertRaises(Invalid):
                clean({"name": "A", **data}, partial=False)

    def test_empty_dates_clear_them(self):
        self.assertEqual(clean({"follow_up_at": "", "sent_at": None}, partial=True), {"follow_up_at": None, "sent_at": None})

    def test_client_today_must_be_within_a_day(self):
        self.assertEqual(client_today("2026-11-03", TODAY), date(2026, 11, 3))
        self.assertEqual(client_today("2026-11-01", TODAY), date(2026, 11, 1))
        self.assertEqual(client_today("2026-11-05", TODAY), TODAY)
        self.assertEqual(client_today("soon", TODAY), TODAY)
        self.assertEqual(client_today(None, TODAY), TODAY)


# ───────── API ─────────

class FakeSupabase:
    """Just enough of sociai.supabase.Supabase for the contacts API. No row-level security."""

    CAP = 5

    def __init__(self):
        self.users = {"token-a": {"id": "11111111-1111-4111-8111-111111111111", "email": "a@example.com",
                                  "email_confirmed_at": "2026-11-01T00:00:00Z"},
                      "token-b": {"id": "22222222-2222-4222-8222-222222222222", "email": "b@example.com",
                                  "email_confirmed_at": "2026-11-01T00:00:00Z"}}
        self.rows, self.rpc_calls, self.clock = [], [], 0

    def get_user(self, token):
        return self.users.get(token)

    def rpc(self, fn, **args):
        self.rpc_calls.append(fn)
        raise AssertionError(f"the tracker shouldn't call {fn}")

    rpc_as = rpc

    def rows_as(self, token, method, table, query="", body=None):
        assert table == "outreach_contacts" and token in self.users
        filters = {k: v[3:] for k, v in parse_qsl(query) if v.startswith("eq.")}
        match = [r for r in self.rows if all(str(r.get(k)) == v for k, v in filters.items())]
        if method == "GET":
            return [dict(r) for r in sorted(match, key=lambda r: r["created_at"], reverse=True)]
        if method == "POST":
            if sum(r["user_id"] == body["user_id"] for r in self.rows) >= self.CAP:
                raise SupabaseRefused("You can keep up to 2,000 contacts in your tracker. Delete some old ones first.")
            self.clock += 1
            row = {"id": str(uuid.uuid4()), "email": "", "role": "other", "organization": "", "subject": "",
                   "sent_at": None, "status": "drafted", "replied_at": None, "follow_up_at": None, "notes": "",
                   "created_at": f"2026-11-02T00:00:{self.clock:02d}Z", **body}
            self.rows.append(row)
            return [dict(row)]
        if method == "PATCH":
            for r in match:
                r.update(body)
            return [dict(r) for r in match]
        if method == "DELETE":
            self.rows = [r for r in self.rows if r not in match]
            return match
        raise AssertionError(method)


class ContactsAPI(unittest.TestCase):
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
        self.fake = web.supa = FakeSupabase()
        web._tokens.clear()
        web.limiter.reset()

    def call(self, method, path, body=None, token="token-a", today="2026-11-02"):
        if today:
            path += ("&" if "?" in path else "?") + f"today={today}"
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def add(self, token="token-a", **fields):
        status, data = self.call("POST", "/api/contacts", {"name": "Lena Ortiz", **fields}, token=token)
        self.assertEqual(status, 200, data)
        return data["contact"]

    def test_requires_sign_in(self):
        for method, path in (("GET", "/api/contacts"), ("POST", "/api/contacts"),
                             ("PATCH", f"/api/contacts/{uuid.uuid4()}"), ("DELETE", f"/api/contacts/{uuid.uuid4()}")):
            with self.subTest(method=method):
                self.assertEqual(self.call(method, path, {} if method in ("POST", "PATCH") else None, token=None)[0], 401)
                self.assertEqual(self.call(method, path, {} if method in ("POST", "PATCH") else None, token="bad")[0], 401)

    def test_create_applies_the_follow_up_rule(self):
        c = self.add(role="professor", status="sent", email="lortiz@example.edu", subject="Your marsh paper")
        self.assertEqual((c["sent_at"], c["follow_up_at"], c["shown_status"], c["due_in"]),
                         ("2026-11-02", "2026-12-02", "sent", None))
        self.assertNotIn("user_id", c)
        self.assertEqual(self.fake.rows[0]["user_id"], self.fake.users["token-a"]["id"])

    def test_uses_the_browsers_date(self):
        status, data = self.call("POST", "/api/contacts", {"name": "Sam", "role": "recruiter", "status": "sent"},
                                 today="2026-11-03")
        self.assertEqual(data["contact"]["follow_up_at"], "2026-11-10")

    def test_list_shows_only_your_own_contacts(self):
        self.add(name="Mine")
        self.add(name="Theirs", token="token-b")
        status, data = self.call("GET", "/api/contacts")
        self.assertEqual(status, 200)
        self.assertEqual([c["name"] for c in data["contacts"]], ["Mine"])

    def test_list_shows_follow_ups_that_are_due(self):
        self.add(status="sent", role="recruiter", sent_at="2026-10-20")  # follow-up 2026-10-27
        contact = self.call("GET", "/api/contacts")[1]["contacts"][0]
        self.assertEqual((contact["status"], contact["shown_status"], contact["due_in"]), ("sent", "follow_up_due", -6))

    def test_patch_replied_clears_the_follow_up(self):
        c = self.add(status="sent", role="professor")
        status, data = self.call("PATCH", f"/api/contacts/{c['id']}", {"status": "replied"})
        self.assertEqual(status, 200, data)
        self.assertEqual((data["contact"]["follow_up_at"], data["contact"]["replied_at"]), (None, "2026-11-02"))

    def test_patch_can_change_the_follow_up_date(self):
        c = self.add(status="sent", role="professor")
        data = self.call("PATCH", f"/api/contacts/{c['id']}", {"follow_up_at": "2026-11-20"})[1]
        self.assertEqual(data["contact"]["follow_up_at"], "2026-11-20")

    def test_cannot_touch_someone_elses_contact(self):
        c = self.add()
        self.assertEqual(self.call("PATCH", f"/api/contacts/{c['id']}", {"notes": "x"}, token="token-b")[0], 404)
        self.assertEqual(self.call("DELETE", f"/api/contacts/{c['id']}", token="token-b")[0], 404)
        self.assertEqual(self.fake.rows[0]["notes"], "")

    def test_delete(self):
        c = self.add()
        self.assertEqual(self.call("DELETE", f"/api/contacts/{c['id']}"), (200, {"deleted": True}))
        self.assertEqual(self.call("GET", "/api/contacts")[1]["contacts"], [])
        self.assertEqual(self.call("DELETE", f"/api/contacts/{c['id']}")[0], 404)

    def test_rejects_bad_input(self):
        c = self.add()
        for method, path, body in (("POST", "/api/contacts", {}),
                                   ("POST", "/api/contacts", {"name": "A", "notes": "x" * 5001}),
                                   ("POST", "/api/contacts", {"name": "A", "status": "ghosted"}),
                                   ("POST", "/api/contacts", {"name": "A", "user_id": "22222222-2222-4222-8222-222222222222"}),
                                   ("PATCH", f"/api/contacts/{c['id']}", {}),
                                   ("PATCH", f"/api/contacts/{c['id']}", {"follow_up_at": "next week"})):
            with self.subTest(body=body):
                status, data = self.call(method, path, body)
                self.assertEqual(status, 400, data)
                self.assertTrue(data["error"])
        self.assertEqual(self.call("PATCH", "/api/contacts/not-an-id", {"notes": "x"})[0], 404)

    def test_the_database_cap_reaches_the_user(self):
        for i in range(FakeSupabase.CAP):
            self.add(name=f"P{i}")
        status, data = self.call("POST", "/api/contacts", {"name": "One more"})
        self.assertEqual(status, 409)
        self.assertIn("2,000", data["error"])

    def test_no_credits_are_used(self):
        c = self.add(status="sent")
        self.call("PATCH", f"/api/contacts/{c['id']}", {"status": "replied"})
        self.call("GET", "/api/contacts")
        self.call("DELETE", f"/api/contacts/{c['id']}")
        self.assertEqual(self.fake.rpc_calls, [])


if __name__ == "__main__":
    unittest.main()
