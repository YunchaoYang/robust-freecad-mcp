"""Catalog integrity: unique ids, valid kinds, every example file exists and is listed."""

import json
import os
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.path.join(ROOT, "packages", "cad-api")


class CatalogIntegrity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(os.path.join(API, "catalog.json"), encoding="utf-8") as f:
            cls.cat = json.load(f)

    def test_entries_well_formed(self):
        ids = [e["id"] for e in self.cat["entries"]]
        self.assertEqual(len(ids), len(set(ids)), "duplicate ids")
        for e in self.cat["entries"]:
            with self.subTest(id=e["id"]):
                for key in ("id", "kind", "title", "module", "tags", "freecadVersions", "summary"):
                    self.assertIn(key, e)
                self.assertIn(e["kind"], self.cat["kinds"])
                self.assertTrue(e["id"].startswith(e["kind"] + "."))
                self.assertIsInstance(e["tags"], list)
                self.assertTrue(e["tags"])
                self.assertIn("1.1", e["freecadVersions"])
                self.assertLess(len(e["summary"]), 1200, "keep summaries concise")

    def test_examples_exist_and_are_listed(self):
        ex_dir = os.path.join(API, "examples")
        referenced = {e["example"] for e in self.cat["entries"] if "example" in e}
        on_disk = {f for f in os.listdir(ex_dir) if f.endswith(".py")}
        self.assertEqual(referenced, on_disk)

    def test_contract_doc_present(self):
        self.assertTrue(os.path.getsize(os.path.join(API, "contract.md")) > 500)


if __name__ == "__main__":
    unittest.main()
