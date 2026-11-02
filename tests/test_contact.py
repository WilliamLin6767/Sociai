"""Contact details in the research: only published (or clearly marked likely) professional details,
each with a source, and never from people-search sites. See clean_contact in sociai/engine.py.

Run with: python -m unittest discover tests
"""

import unittest

from sociai import web
from sociai.engine import DOSSIER_SCHEMA, Dossier, clean_contact, finish_contact, likely_email

LAB = "https://ortizlab.berkeley.edu/people"
DIR = "https://ce.berkeley.edu/directory"


class CleanContact(unittest.TestCase):
    def test_keeps_published_details_with_sources(self):
        c = clean_contact({
            "emails": [{"address": "lortiz@berkeley.edu", "kind": "published", "source": LAB, "note": ""}],
            "phones": [{"number": "(510) 642-1234", "label": "Office", "source": DIR}],
            "best_way": "Prospective students should put [PhD applicant] in the subject.", "best_way_source": LAB,
        })
        self.assertEqual(c["emails"], [{"address": "lortiz@berkeley.edu", "kind": "published", "source": LAB, "note": ""}])
        self.assertEqual(c["phones"], [{"number": "(510) 642-1234", "label": "Office", "source": DIR}])
        self.assertEqual(c["best_way_source"], LAB)

    def test_drops_entries_without_a_real_source(self):
        c = clean_contact({"emails": [{"address": "a@b.edu", "kind": "published", "source": "", "note": ""},
                                      {"address": "c@d.edu", "kind": "published", "source": "their homepage", "note": ""}],
                           "phones": [{"number": "510 642 1234", "label": "", "source": "n/a"}],
                           "best_way": "Email works.", "best_way_source": "memory"})
        self.assertEqual((c["emails"], c["phones"]), ([], []))
        self.assertEqual((c["best_way"], c["best_way_source"]), ("Email works.", ""))  # advice stays, without a cite

    def test_never_uses_people_search_sites(self):
        for source in ("https://rocketreach.co/lena-ortiz", "https://www.zoominfo.com/p/Lena-Ortiz",
                       "https://www.spokeo.com/Lena-Ortiz", "https://www.whitepages.com/name/Lena-Ortiz"):
            with self.subTest(source=source):
                c = clean_contact({"emails": [{"address": "lena@gmail.com", "kind": "published", "source": source, "note": ""}],
                                   "phones": [{"number": "415 555 0100", "label": "Mobile", "source": source}]})
                self.assertEqual((c["emails"], c["phones"]), ([], []))

    def test_rejects_malformed_values(self):
        c = clean_contact({"emails": [{"address": "lortiz at berkeley dot edu", "kind": "published", "source": LAB, "note": ""},
                                      {"address": "x@y.edu", "kind": "guessed", "source": LAB, "note": ""}],
                           "phones": [{"number": "call the front desk", "label": "", "source": DIR},
                                      {"number": "12", "label": "", "source": DIR}]})
        self.assertEqual((c["emails"], c["phones"]), ([], []))

    def test_tidies_and_orders_emails(self):
        c = clean_contact({"emails": [
            {"address": "l.ortiz@berkeley.edu", "kind": "likely", "source": DIR, "note": "Format first.last, seen on the directory"},
            {"address": "mailto:lortiz@berkeley.edu", "kind": "published", "source": LAB, "note": ""},
            {"address": "LORTIZ@berkeley.edu", "kind": "published", "source": DIR, "note": ""},  # same address
        ]})
        self.assertEqual([(e["address"], e["kind"]) for e in c["emails"]],
                         [("lortiz@berkeley.edu", "published"), ("l.ortiz@berkeley.edu", "likely")])

    def test_caps_and_bad_shapes(self):
        many = [{"address": f"p{i}@uni.edu", "kind": "published", "source": LAB, "note": ""} for i in range(6)]
        self.assertEqual(len(clean_contact({"emails": many})["emails"]), 3)
        for raw in (None, "x", [], {"emails": "nope", "phones": [None, 3]}):
            self.assertEqual(clean_contact(raw), {"emails": [], "phones": [], "best_way": "", "best_way_source": ""})


class LikelyEmail(unittest.TestCase):
    def test_from_their_own_academic_homepage(self):
        g = likely_email("Percy Liang", ["https://arxiv.org/abs/1", "https://cs.stanford.edu/~pliang/"])
        self.assertEqual((g["address"], g["kind"], g["source"]), ("pliang@cs.stanford.edu", "likely", "https://cs.stanford.edu/~pliang/"))
        self.assertIn("not published", g["note"])
        self.assertEqual(likely_email("Ana Ruiz", ["https://www.cs.ox.ac.uk/~aruiz"])["address"], "aruiz@www.cs.ox.ac.uk")

    def test_not_from_someone_elses_page_or_other_sites(self):
        for sources in (["https://cs.stanford.edu/~jdoe/"],              # a student linked from their page
                        ["https://percyliang.com/"],                      # no ~username
                        ["https://example.com/~pliang"],                  # not an academic domain
                        ["https://cs.stanford.edu/people/pliang"]):
            with self.subTest(sources=sources):
                self.assertIsNone(likely_email("Percy Liang", sources))
        self.assertIsNone(likely_email("Li", ["https://cs.uni.edu/~li"]))  # surname too short to tell

    def test_only_when_nothing_was_published(self):
        published = {"name": "Percy Liang", "sources": ["https://cs.stanford.edu/~pliang/"], "facts": [],
                     "contact": {"emails": [{"address": "pliang@stanford.edu", "kind": "published", "source": "https://cs.stanford.edu/~pliang/", "note": ""}],
                                 "phones": [], "best_way": "", "best_way_source": ""}}
        self.assertEqual([e["address"] for e in finish_contact(published)["emails"]], ["pliang@stanford.edu"])
        none = {**published, "contact": {}}
        self.assertEqual([e["kind"] for e in finish_contact(none)["emails"]], ["likely"])
        self.assertEqual(finish_contact({"name": "Percy Liang", "sources": [], "facts": []})["emails"], [])


class DossierContact(unittest.TestCase):
    def test_the_research_schema_asks_for_contact(self):
        self.assertIn("contact", DOSSIER_SCHEMA["required"])
        email = DOSSIER_SCHEMA["properties"]["contact"]["properties"]["emails"]["items"]
        self.assertEqual(email["properties"]["kind"]["enum"], ["published", "likely"])

    def test_older_research_without_contact_still_loads(self):
        d = Dossier(summary="s", facts=[], hooks=[], cautions=[], sources=[])
        self.assertEqual(d.contact, {})
        self.assertNotIn("HOW THEY ASK", d.as_text())

    def test_the_draft_sees_how_they_ask_to_be_contacted_but_not_the_details(self):
        d = Dossier(summary="s", facts=[], hooks=[], cautions=[], sources=[], contact=clean_contact({
            "emails": [{"address": "lortiz@berkeley.edu", "kind": "published", "source": LAB, "note": ""}],
            "best_way": "Put [PhD applicant] in the subject.", "best_way_source": LAB}))
        text = d.as_text()
        self.assertIn("HOW THEY ASK TO BE CONTACTED: Put [PhD applicant] in the subject.", text)
        self.assertNotIn("lortiz@berkeley.edu", text)

    def test_contact_sent_back_by_the_browser_is_cleaned(self):
        data = {"request": {"target": "Lena Ortiz", "goal": "Join the lab"},
                "dossier": {"summary": "s", "facts": [], "hooks": [], "cautions": [], "sources": [],
                            "contact": {"emails": [{"address": "x@y.com", "kind": "published", "source": "https://spokeo.com/x", "note": ""}],
                                        "best_way": "Email.", "best_way_source": LAB}}}
        captured = {}
        web.engine = type("E", (), {"draft": lambda self, req, dossier, **kw: captured.setdefault("d", dossier)})()
        web.draft_work(data)(lambda e: None, None)
        self.assertEqual(captured["d"].contact["emails"], [])
        self.assertEqual(captured["d"].contact["best_way"], "Email.")


if __name__ == "__main__":
    unittest.main()
