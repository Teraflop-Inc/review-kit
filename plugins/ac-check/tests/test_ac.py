"""Offline tests for the deterministic ac-check tools. Run: python3 -m unittest discover plugins/ac-check/tests"""
import json
import os
import re
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
AC = os.path.join(HERE, "..", "ac")
sys.path.insert(0, AC)

import _ac  # noqa: E402

TICKET = """## Why

Some context with a stray box:

- [ ] not an AC, sits above the heading

## Acceptance criteria

- [ ] Given a PR whose branch name contains a Linear ID, the checker finds the issue
- [x] Parses ACs; falls back to all checkboxes
  when the heading is absent
* [X] Validated on <issue id="b07f" href="https://linear.app/x/issue/ENG2-1653/y">ENG2-1653</issue>'s PR

### Notes inside the section
- [ ] nested heading keeps the section open

## Out of scope

- [ ] never counted
"""


class ResolveTests(unittest.TestCase):
    def test_branch_first_and_lowercase(self):
        c = _ac.resolve_issue_candidates("aowen14/eng2-1656-ac-checker-verify", "Fix ENG-9 thing", "Closes ENG2-1")
        self.assertEqual(c[0], ("ENG2-1656", "branch"))
        self.assertEqual([i for i, _ in c], ["ENG2-1656", "ENG-9", "ENG2-1"])

    def test_title_then_body_when_branch_has_none(self):
        c = _ac.resolve_issue_candidates("feature/cleanup", "no id here", "Part of ENG2-77")
        self.assertEqual(c, [("ENG2-77", "body")])

    def test_team_filter_drops_false_positives(self):
        text = "utf-8 sha-256 python-3 ENG2-5 gpt-4"
        self.assertEqual(_ac.id_candidates(text, {"ENG2"}), ["ENG2-5"])
        self.assertIn("UTF-8", _ac.id_candidates(text))   # without team keys, prepare tries each in order

    def test_pr_refs(self):
        self.assertEqual(_ac.parse_pr_ref("https://github.com/aowen14/review-kit/pull/5/files"), ("aowen14/review-kit", 5))
        self.assertEqual(_ac.parse_pr_ref("Teraflop-Inc/teraflop-dev-setup#59"), ("Teraflop-Inc/teraflop-dev-setup", 59))
        self.assertEqual(_ac.parse_pr_ref("#12", default_repo="o/r"), ("o/r", 12))
        with self.assertRaises(_ac.AcError):
            _ac.parse_pr_ref("not a pr")


class ParseTests(unittest.TestCase):
    def test_heading_section(self):
        crit, src = _ac.parse_criteria(TICKET)
        self.assertEqual(src, "heading")
        self.assertEqual(len(crit), 4)
        self.assertEqual(crit[1]["text"], "Parses ACs; falls back to all checkboxes when the heading is absent")
        self.assertTrue(crit[1]["checked"])
        self.assertEqual(crit[2]["text"], "Validated on ENG2-1653's PR")
        self.assertEqual([c["id"] for c in crit], [1, 2, 3, 4])

    def test_bold_heading(self):
        desc = "**Acceptance criteria**\n\n- [X] one\n- [ ] two\n\n**Out of scope**\n- [ ] nope\n"
        crit, src = _ac.parse_criteria(desc)
        self.assertEqual((src, [c["text"] for c in crit]), ("heading", ["one", "two"]))

    def test_heading_is_case_and_colon_insensitive(self):
        crit, src = _ac.parse_criteria("### ACCEPTANCE CRITERIA:\n- [ ] a\n")
        self.assertEqual((src, len(crit)), ("heading", 1))

    def test_custom_heading(self):
        crit, src = _ac.parse_criteria("## Definition of done\n- [ ] a\n- [ ] b\n", heading="Definition of done")
        self.assertEqual((src, len(crit)), ("heading", 2))

    def test_fallback_to_all_checkboxes(self):
        crit, src = _ac.parse_criteria("Intro\n- [ ] a\n\n## Later\n- [x] b\n")
        self.assertEqual((src, [c["text"] for c in crit]), ("all-checkboxes", ["a", "b"]))

    def test_none(self):
        self.assertEqual(_ac.parse_criteria("Just prose.\n- a plain bullet\n"), ([], "none"))
        self.assertEqual(_ac.parse_criteria(None), ([], "none"))


class VerdictTests(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.repo, "src"))
        with open(os.path.join(self.repo, "src", "a.py"), "w") as f:
            f.write("\n".join(f"line {i}" for i in range(1, 21)))
        self.crit = [{"id": i, "text": f"c{i}", "checked": False} for i in (1, 2, 3, 4, 5)]

    def test_all_four_verdicts_and_evidence_rules(self):
        raw = {"criteria": [
            {"id": 1, "verdict": "met", "reason": "ok", "evidence": ["src/a.py:3"]},
            {"id": 2, "verdict": "partial", "reason": "half", "evidence": ["./src/a.py:5-9"]},
            {"id": 3, "verdict": "met", "reason": "claims", "evidence": []},              # uncited
            {"id": 4, "verdict": "met", "reason": "bad path", "evidence": ["src/nope.py:1"]},
            {"id": 5, "verdict": "not_verifiable", "reason": "needs a run"},
        ]}
        rows, problems = _ac.normalize_verdicts(self.crit, raw, self.repo, {"old/gone.py"})
        v = {r["id"]: r["verdict"] for r in rows}
        self.assertEqual(v, {1: "met", 2: "partial", 3: "not verifiable from diff",
                             4: "not verifiable from diff", 5: "not verifiable from diff"})
        self.assertEqual(rows[1]["evidence"][0]["ref"], "src/a.py:5-9")
        self.assertTrue(rows[2]["reason"].startswith("Downgraded from met"))
        for r in rows:
            self.assertIn(r["verdict"], _ac.VERDICTS)
            if r["verdict"] in _ac.NEEDS_EVIDENCE:
                self.assertTrue(r["evidence"])
                for e in r["evidence"]:
                    self.assertRegex(e["ref"], r"^[^:]+:\d+(-\d+)?$")
        self.assertTrue(any("src/nope.py" in p for p in problems))

    def test_missing_duplicate_and_unknown(self):
        raw = [{"id": 1, "verdict": "missing", "reason": "x"}, {"id": 1, "verdict": "met"},
               {"id": 9, "verdict": "met"}, {"id": 2, "verdict": "great", "reason": "?"}]
        rows, problems = _ac.normalize_verdicts(self.crit[:3], raw, self.repo)
        self.assertEqual([r["verdict"] for r in rows], ["missing", "not verifiable from diff", "not verifiable from diff"])
        joined = " ".join(problems)
        for s in ("more than one", "unknown criterion id 9", "unknown verdict", "criterion 3 had no verdict"):
            self.assertIn(s, joined)

    def test_dotfile_paths_keep_their_dot(self):
        os.makedirs(os.path.join(self.repo, ".github"))
        with open(os.path.join(self.repo, ".github", "w.yml"), "w") as f:
            f.write("a\nb\n")
        self.assertEqual(_ac.check_evidence("./.github/w.yml:2", self.repo)[:2], (".github/w.yml:2", True))

    def test_line_past_end_and_deleted_file(self):
        ok = _ac.check_evidence("src/a.py:99", self.repo)
        self.assertFalse(ok[1])
        self.assertTrue(_ac.check_evidence("old/gone.py:4", self.repo, {"old/gone.py"})[1])


CTX = {"repo": "o/r", "pr": 7, "head_sha": "a" * 40, "base_sha": "b" * 40, "heading": "Acceptance criteria",
       "criteria_source": "heading", "issue": {"identifier": "ENG2-1", "title": "T", "url": "https://linear.app/x"}}


class RenderTests(unittest.TestCase):
    def test_no_criteria_comment(self):
        body = _ac.render_github({**CTX, "criteria": []})
        self.assertTrue(body.startswith(_ac.MARKER))
        self.assertIn("No acceptance criteria found on ENG2-1", body)
        self.assertNotIn("| # |", body)

    def test_table_and_tally(self):
        crit = [{"id": 1, "text": "a | b", "checked": True}, {"id": 2, "text": "c", "checked": False}]
        rows = [{**crit[0], "verdict": "met", "reason": "r", "evidence": [{"ref": "x.py:3-4", "note": ""}]},
                {**crit[1], "verdict": "missing", "reason": "gone", "evidence": []}]
        body = _ac.render_github({**CTX, "criteria": crit}, rows, "summary")
        self.assertIn("**1 met · 0 partial · 1 missing · 0 not verifiable from diff**", body)
        self.assertIn("a \\| b", body)
        self.assertIn(f"https://github.com/o/r/blob/{'a' * 40}/x.py#L3-L4", body)
        self.assertIn("Ticked on the issue: 1.", body)


class UpsertTests(unittest.TestCase):
    def _run(self, existing):
        calls = []

        def fake_gh(args, stdin=None):
            calls.append((args, stdin))
            if args[:2] == ["api", "--paginate"]:
                return json.dumps([existing])
            if "PATCH" in args:
                return json.dumps({"html_url": "https://github.com/o/r/pull/7#issuecomment-1"})
            return json.dumps({"html_url": "https://github.com/o/r/pull/7#issuecomment-2"})
        with mock.patch.object(_ac, "gh", side_effect=fake_gh):
            return _ac.upsert_pr_comment("o/r", 7, _ac.MARKER + "\nbody"), calls

    def test_edits_existing(self):
        (action, _), calls = self._run([{"id": 11, "body": "unrelated"}, {"id": 12, "body": _ac.MARKER + "\nold"}])
        self.assertEqual(action, "updated")
        self.assertIn("repos/o/r/issues/comments/12", calls[1][0])
        self.assertEqual(len(calls), 2)   # list + patch, no create

    def test_creates_when_absent(self):
        (action, _), calls = self._run([{"id": 11, "body": "unrelated"}])
        self.assertEqual(action, "created")
        self.assertIn("POST", calls[1][0])


class EvaluateOnlyGuardTests(unittest.TestCase):
    def test_post_refuses_during_evaluation(self):
        import subprocess
        env = {**os.environ, "AC_CHECK_EVALUATE_ONLY": "1"}
        p = subprocess.run([sys.executable, os.path.join(AC, "post"), tempfile.mkdtemp()],
                           capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 1)
        self.assertIn("disabled during evaluation", p.stderr)


class ReportOnlyTests(unittest.TestCase):
    def test_only_linear_writes_are_comments(self):
        src = ""
        for name in ("_ac.py", "prepare", "post"):
            with open(os.path.join(AC, name)) as f:
                src += f.read()
        mutations = set(re.findall(r"mutation\([^)]*\)\{(\w+)", src))
        self.assertEqual(mutations, {"commentCreate", "commentUpdate"})
        for forbidden in ("issueUpdate", "stateId", "issueArchive"):
            self.assertNotIn(forbidden, src)


if __name__ == "__main__":
    unittest.main()
