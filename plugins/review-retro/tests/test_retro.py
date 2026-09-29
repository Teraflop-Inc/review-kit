"""Offline tests for the deterministic retro tools. Run: python3 -m unittest discover plugins/review-retro/tests"""
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RETRO = os.path.join(HERE, "..", "retro")
sys.path.insert(0, RETRO)


def load(name):
    loader = importlib.machinery.SourceFileLoader(name, os.path.join(RETRO, name))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


fetch, kb, propose = load("fetch"), load("kb"), load("propose")


class FetchTests(unittest.TestCase):
    def test_touched_old_lines(self):
        patch = "@@ -10,4 +10,4 @@\n a\n-b\n+B\n c\n d\n@@ -40,2 +40,3 @@\n x\n+new\n y"
        t = fetch.touched_old_lines(patch)
        self.assertIn(11, t)            # removed line
        self.assertIn(41, t)            # insertion between 40 and 41
        self.assertNotIn(10, t)         # context only
        self.assertNotIn(13, t)

    def test_outcome_precedence(self):
        o = fetch.thread_outcome
        self.assertEqual(o({"thumbs_down": 1}, True, True, True), "thumbs_down")
        self.assertEqual(o({}, True, True, False), "fixed")
        self.assertEqual(o({}, False, True, True), "resolved_no_change")
        self.assertEqual(o({}, False, False, True), "open_at_merge")
        self.assertEqual(o({}, False, False, False), "ignored")

    def test_clean_strips_bot_chrome_keeps_identifiers(self):
        body = ('<a href="#"><img alt="P1" src="x.svg"></a> **Token leaks**\n\n`generate_with_block` logs the key.\n'
                "<details><summary>Prompt To Fix With AI</summary>long</details>\n"
                "```suggestion\nfoo\n```\n<sub>Fix in Claude Code</sub>")
        self.assertEqual(fetch.severity(body), "P1")
        text = fetch.clean(body, 400)
        self.assertTrue(text.startswith("Token leaks:"), text)
        self.assertIn("generate_with_block", text)
        self.assertNotIn("Prompt To Fix", text)
        self.assertNotIn("Fix in Claude", text)
        self.assertIn("[suggested change]", text)

    def test_lines_changed_uses_compare(self):
        class Cmp:
            def files(self, base, head):
                return {"a.py": {"status": "modified", "patch": "@@ -5,3 +5,3 @@\n x\n-y\n+Y\n z"}}
        t = {"path": "a.py", "originalLine": 6, "originalStartLine": None, "isOutdated": False}
        self.assertTrue(fetch.lines_changed(Cmp(), t, "c1", "c2"))
        self.assertFalse(fetch.lines_changed(Cmp(), {**t, "originalLine": 20}, "c1", "c2"))
        self.assertFalse(fetch.lines_changed(Cmp(), t, "c2", "c2"))   # no commit after the comment


def digest_dir(tmp, recs, prs):
    os.makedirs(tmp, exist_ok=True)
    with open(os.path.join(tmp, "digest.jsonl"), "w") as fh:
        fh.writelines(json.dumps(r) + "\n" for r in recs)
    meta = {"repo": "o/r", "prs": [{"number": n, "merged_at": d} for n, d in prs], "records": len(recs),
            "rules": [{"id": "R1", "section": "Always check", "text": "Quote shell variables."}]}
    json.dump(meta, open(os.path.join(tmp, "meta.json"), "w"))
    return tmp


class KbTests(unittest.TestCase):
    def test_created_then_updated_not_overwritten(self):
        with tempfile.TemporaryDirectory() as t:
            kbp = os.path.join(t, "retro", "issues.md")
            d1 = digest_dir(os.path.join(t, "d1"), [
                {"id": "1-t1", "pr": 1, "merged_at": "2026-01-01"},
                {"id": "2-t1", "pr": 2, "merged_at": "2026-01-05"}], [(1, "2026-01-01"), (2, "2026-01-05")])
            a1 = os.path.join(t, "a1.json")
            json.dump({"clusters": [
                {"key": "secrets-in-logs", "category": "recurring", "title": "Secrets in logs", "records": ["1-t1", "2-t1"]},
                {"key": "nits", "category": "noise", "title": "Nits", "records": ["2-t1", "bogus"]},
                {"key": "quote-vars", "category": "stale_rule", "title": "Quote vars", "rule_ids": ["R1"]},
                {"key": "empty", "category": "recurring", "records": []}]}, open(a1, "w"))
            kb.main(["merge", "--kb", kbp, "--digest", d1, "--analysis", a1, "--today", "2026-01-10"])
            s1 = kb.read_state(kbp)
            self.assertNotIn("empty", s1["issues"])                       # no PR cited: dropped
            self.assertEqual(s1["issues"]["secrets-in-logs"]["count"], 2)
            self.assertEqual(s1["issues"]["quote-vars"]["prs"], [1, 2])   # stale rule cites scanned PRs
            self.assertIn("## Recurring real issues", open(kbp).read())

            d2 = digest_dir(os.path.join(t, "d2"), [
                {"id": "2-t1", "pr": 2, "merged_at": "2026-01-05"},       # overlap: must not double count
                {"id": "3-t1", "pr": 3, "merged_at": "2026-02-01"}], [(2, "2026-01-05"), (3, "2026-02-01")])
            a2 = os.path.join(t, "a2.json")
            json.dump({"clusters": [{"key": "secrets-in-logs", "category": "recurring", "title": "Secrets in logs",
                                     "records": ["2-t1", "3-t1"]}]}, open(a2, "w"))
            kb.main(["merge", "--kb", kbp, "--digest", d2, "--analysis", a2, "--today", "2026-02-10"])
            s2 = kb.read_state(kbp)
            i = s2["issues"]["secrets-in-logs"]
            self.assertEqual((i["count"], i["first_seen"], i["last_seen"], i["prs"]), (3, "2026-01-01", "2026-02-01", [1, 2, 3]))
            self.assertIn("nits", s2["issues"])                           # untouched issues survive
            self.assertEqual(len(s2["runs"]), 2)


class ProposeTests(unittest.TestCase):
    RULES = "# Rules\n\n## Always check\n- Quote shell variables.\n- Pin versions. (retro: #1)\n\n## Skip\n- Lockfiles.\n"

    def test_validate_requires_citations(self):
        ok, dropped = propose.validate([
            {"op": "add", "text": "x", "prs": [5]},
            {"op": "add", "text": "y", "prs": []},
            {"op": "add", "text": "z", "prs": [99]},
            {"op": "remove", "prs": [5]}], "o/r", {5}, 0)
        self.assertEqual(len(ok), 1)
        self.assertEqual({w for _, w in dropped}, {"cites no PR", "cites a PR outside the scanned set",
                                                   "missing the existing rule text (old)"})

    def test_validate_min_repos(self):
        ok, dropped = propose.validate([
            {"op": "add", "text": "x", "prs": ["a/b#1", "c/d#2"]},
            {"op": "add", "text": "y", "prs": ["a/b#1", "a/b#3"]}], "kit/kit", None, 2)
        self.assertEqual([c["text"] for c in ok], ["x"])
        self.assertIn("fewer than 2 repos", dropped[0][1])

    def test_apply_cites_every_rule(self):
        ch, _ = propose.validate([
            {"op": "add", "section": "Always check", "text": "Never log tokens.", "prs": [3, 4]},
            {"op": "change", "old": "Pin versions.", "text": "Pin actions to a SHA.", "prs": [4]},
            {"op": "remove", "old": "Lockfiles.", "prs": [3]},
            {"op": "add", "section": "Nowhere", "text": "New section rule.", "prs": [5]},
            {"op": "remove", "old": "Not a rule.", "prs": [5]}], "o/r", None, 0)
        new, applied, missing = propose.apply(self.RULES, ch, "o/r")
        self.assertIn("- Never log tokens. (retro: #3, #4)", new)
        self.assertIn("- Pin actions to a SHA. (retro: #4)", new)
        self.assertNotIn("Lockfiles", new)
        self.assertIn("## Proposed by review-retro\n\n- New section rule. (retro: #5)", new)
        self.assertLess(new.index("Never log tokens"), new.index("## Skip"))
        self.assertEqual(len(applied), 4)
        self.assertEqual(missing[0][1], "existing rule text not found")

    def test_never_writes_default_branch(self):
        with self.assertRaises(SystemExit):
            propose.put_file("o", "r", "REVIEW.md", "main", "main", "x", "m")
        with self.assertRaises(SystemExit):
            propose.put_file("o", "r", "REVIEW.md", "feature", "main", "x", "m")


if __name__ == "__main__":
    unittest.main()
