"""Shared logic for the ac-check tools. Stdlib only; GitHub through `gh`, Linear through its GraphQL API.

Everything here is deterministic. The only judgment step (deciding each verdict) happens in
Claude, driven by commands/ac-check.md and prompts/evaluate.md.

Report only: the Linear calls in this file read issues and, when mirroring is on, create or
update a single comment. Nothing here changes issue state, fields, or description checkboxes.
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

MARKER = "<!-- review-kit:ac-check -->"
VERDICTS = ("met", "partial", "missing", "not verifiable from diff")
NEEDS_EVIDENCE = ("met", "partial")
DEFAULT_HEADING = "Acceptance criteria"
LINEAR_URL = "https://api.linear.app/graphql"

# Linear identifiers are TEAMKEY-NUMBER. Branch names lowercase them (eng2-1656-...).
ID_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,7})(?![0-9])")
EVIDENCE_RE = re.compile(r"^(?P<path>[^\s:][^:]*?):(?P<start>\d+)(?:-(?P<end>\d+))?$")
CHECKBOX_RE = re.compile(r"^(?P<indent>\s*)[-*+]\s+\[(?P<mark>[ xX])\]\s+(?P<text>.*\S)?\s*$")
HEADING_RE = re.compile(r"^\s{0,3}(?P<hashes>#{1,6})\s+(?P<text>.+?)\s*#*\s*$")
BOLD_HEADING_RE = re.compile(r"^\s{0,3}(?:\*\*|__)(?P<text>[^*_]+?)(?:\*\*|__)\s*:?\s*$")


class AcError(RuntimeError):
    pass


# ---------------------------------------------------------------- GitHub (gh)

def gh(args, stdin=None, tries=4):
    for attempt in range(tries):
        p = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout
        err = (p.stderr + p.stdout).strip()
        transient = any(s in err for s in ("HTTP 502", "HTTP 503", "HTTP 504", "timeout", "rate limit"))
        if transient and attempt < tries - 1:
            time.sleep(2 ** attempt * 3)
            continue
        raise AcError(f"gh {' '.join(args[:3])} failed: {err[:500]}")
    raise AcError("unreachable")


def gh_json(args, stdin=None):
    out = gh(args, stdin=stdin)
    return json.loads(out) if out.strip() else None


def parse_pr_ref(ref, default_repo=None):
    """Accept a PR URL, owner/repo#N, #N, or N. Returns (owner/repo, number)."""
    ref = ref.strip()
    m = re.match(r"^https?://github\.com/([^/]+/[^/]+)/pull/(\d+)", ref)
    if m:
        return m.group(1), int(m.group(2))
    m = re.match(r"^([\w.-]+/[\w.-]+)#(\d+)$", ref)
    if m:
        return m.group(1), int(m.group(2))
    m = re.match(r"^#?(\d+)$", ref)
    if m:
        repo = default_repo or current_repo()
        if not repo:
            raise AcError(f"PR {ref!r} has no repo; pass a URL or owner/repo#N")
        return repo, int(m.group(1))
    raise AcError(f"Cannot parse PR reference {ref!r}; use a URL, owner/repo#N, or a number")


def current_repo():
    try:
        return gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).strip() or None
    except AcError:
        return None


# ---------------------------------------------------------------- Linear

def linear_key():
    return os.environ.get("LINEAR_API_KEY", "").strip()


def linear(query, key=None, **variables):
    key = key or linear_key()
    if not key:
        raise AcError("LINEAR_API_KEY is not set")
    # Personal API keys are sent bare; OAuth access tokens need the Bearer scheme.
    auth = key if key.startswith("lin_api_") else f"Bearer {key}"
    req = urllib.request.Request(
        LINEAR_URL,
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Content-Type": "application/json", "Authorization": auth, "User-Agent": "review-kit-ac-check"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            if e.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt * 3)
                continue
            if e.code in (400, 401, 403):
                raise AcError(f"Linear API returned {e.code}: {text[:300]}")
            raise AcError(f"Linear API returned {e.code}")
    errors = body.get("errors") or []
    if errors:
        # A missing issue is a normal outcome for a false-positive ID candidate.
        if any("not found" in (e.get("message") or "").lower() or
               (e.get("extensions") or {}).get("type") == "invalid input" for e in errors):
            return None
        raise AcError(f"Linear GraphQL error: {json.dumps(errors)[:300]}")
    return body.get("data")


ISSUE_Q = """query($id:String!){issue(id:$id){identifier title url description team{key}}}"""
TEAMS_Q = """query{teams(first:250){nodes{key}}}"""


def linear_issue(identifier, key=None):
    data = linear(ISSUE_Q, key=key, id=identifier)
    return (data or {}).get("issue")


def linear_team_keys(key=None):
    data = linear(TEAMS_Q, key=key) or {}
    return {n["key"].upper() for n in data.get("teams", {}).get("nodes", [])}


def linear_upsert_comment(issue_identifier, header, body, key=None):
    """Create or update this checker's comment on the issue. The only Linear write ac-check makes."""
    q = """query($id:String!){viewer{id} issue(id:$id){id comments(first:100){nodes{id body user{id}}}}}"""
    data = linear(q, key=key, id=issue_identifier)
    if not data or not data.get("issue"):
        raise AcError(f"Linear issue {issue_identifier} not found for mirroring")
    viewer = data["viewer"]["id"]
    existing = [c for c in data["issue"]["comments"]["nodes"]
                if (c.get("user") or {}).get("id") == viewer and (c.get("body") or "").startswith(header)]
    if existing:
        m = """mutation($id:String!,$body:String!){commentUpdate(id:$id,input:{body:$body}){success comment{url}}}"""
        res = linear(m, key=key, id=existing[0]["id"], body=body)["commentUpdate"]
        return "updated", res["comment"]["url"]
    m = """mutation($issueId:String!,$body:String!){commentCreate(input:{issueId:$issueId,body:$body}){success comment{url}}}"""
    res = linear(m, key=key, issueId=data["issue"]["id"], body=body)["commentCreate"]
    return "created", res["comment"]["url"]


# ---------------------------------------------------------------- Issue ID resolution

def id_candidates(text, team_keys=None):
    """Linear identifiers in text, in order, uppercased and de-duplicated."""
    seen, out = set(), []
    for m in ID_RE.finditer(text or ""):
        key, num = m.group(1).upper(), m.group(2)
        if not any(c.isalpha() for c in key):
            continue
        if team_keys is not None and key not in team_keys:
            continue
        ident = f"{key}-{num}"
        if ident not in seen:
            seen.add(ident)
            out.append(ident)
    return out


def resolve_issue_candidates(branch, title, body, team_keys=None):
    """Branch name first, then PR title, then PR body. Returns [(identifier, source)]."""
    out, seen = [], set()
    for source, text in (("branch", branch), ("title", title), ("body", body)):
        for ident in id_candidates(text, team_keys):
            if ident not in seen:
                seen.add(ident)
                out.append((ident, source))
    return out


# ---------------------------------------------------------------- Acceptance criteria parsing

_LINEAR_TAG_RE = re.compile(r"<(issue|user|project|document)\b[^>]*>(.*?)</\1>", re.S)


def clean_text(s):
    """Strip Linear's inline mention markup down to its label, and collapse whitespace."""
    s = _LINEAR_TAG_RE.sub(lambda m: m.group(2), s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("\\[", "[").replace("\\]", "]").replace("\\_", "_")
    return re.sub(r"\s+", " ", s).strip()


def _heading(line):
    """(level, text) if the line is a markdown heading or a bold-only line (level 7), else None."""
    m = HEADING_RE.match(line)
    if m:
        return len(m.group("hashes")), m.group("text").strip()
    m = BOLD_HEADING_RE.match(line)
    if m:
        return 7, m.group("text").strip()
    return None


def _norm(s):
    return re.sub(r"[^a-z0-9 ]", "", clean_text(s).lower()).strip()


def _checkboxes(lines):
    items, cur = [], None
    for line in lines:
        m = CHECKBOX_RE.match(line)
        if m:
            cur = {"text": m.group("text") or "", "checked": m.group("mark") in "xX"}
            items.append(cur)
            continue
        if cur is not None and line.strip() and line[:1].isspace() and not re.match(r"^\s*[-*+]\s", line):
            cur["text"] += " " + line.strip()   # wrapped continuation of the previous checkbox
        else:
            cur = None
    return [{"text": clean_text(i["text"]), "checked": i["checked"]} for i in items if clean_text(i["text"])]


def parse_criteria(description, heading=DEFAULT_HEADING):
    """Checkboxes under the AC heading; falls back to every checkbox in the description.

    Returns (criteria, source) where source is "heading", "all-checkboxes", or "none".
    """
    lines = (description or "").splitlines()
    want = _norm(heading)
    start = level = None
    for i, line in enumerate(lines):
        h = _heading(line)
        if h and _norm(h[1]).rstrip(":") == want:
            start, level = i + 1, h[0]
            break
    if start is not None:
        end = len(lines)
        for j in range(start, len(lines)):
            h = _heading(lines[j])
            # A deeper heading stays inside the section; a same-or-higher one ends it.
            # Bold-only lines (level 7) end a bold-headed section, and any section.
            if h and (h[0] <= level or h[0] == 7):
                end = j
                break
        found = _checkboxes(lines[start:end])
        if found:
            return _number(found), "heading"
    found = _checkboxes(lines)
    return (_number(found), "all-checkboxes") if found else ([], "none")


def _number(items):
    return [{"id": i + 1, **c} for i, c in enumerate(items)]


# ---------------------------------------------------------------- Verdicts

def _line_count(path):
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return None


def check_evidence(ref, repo_dir=None, changed=None):
    """Return (normalized_ref, ok, note). ok means well formed and resolvable."""
    ref = str(ref).strip().strip("`")
    while ref.startswith("./"):
        ref = ref[2:]
    m = EVIDENCE_RE.match(ref)
    if not m:
        return ref, False, "not file:line"
    path, start = m.group("path"), int(m.group("start"))
    end = int(m.group("end")) if m.group("end") else None
    if start < 1 or (end is not None and end < start):
        return ref, False, "bad line range"
    if repo_dir:
        n = _line_count(os.path.join(repo_dir, path))
        if n is None:
            # Deleted files are legitimate evidence for removal criteria.
            if changed and path in changed:
                return ref, True, "removed in this PR"
            return ref, False, "file not found at head"
        if start > max(n, 1):
            return ref, False, f"line {start} past end of file ({n} lines)"
    return ref, True, ""


def normalize_verdicts(criteria, raw, repo_dir=None, changed=None):
    """Validate model output against the criteria. Returns (rows, problems).

    Guarantees: exactly one row per criterion, a verdict from VERDICTS, and at least one
    resolvable file:line on every met/partial. A met/partial without one is downgraded to
    "not verifiable from diff" with the reason saying so, rather than shipped uncited.
    """
    problems = []
    items = raw.get("criteria") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        raise AcError("verdicts must be a list or an object with a 'criteria' list")
    by_id = {}
    for it in items:
        try:
            cid = int(it.get("id"))
        except (TypeError, ValueError, AttributeError):
            problems.append(f"entry without a numeric id: {str(it)[:80]}")
            continue
        if cid in by_id:
            problems.append(f"criterion {cid} has more than one verdict; kept the first")
            continue
        by_id[cid] = it
    rows = []
    for c in criteria:
        it = by_id.pop(c["id"], None)
        if it is None:
            problems.append(f"criterion {c['id']} had no verdict")
            rows.append({**c, "verdict": "not verifiable from diff", "reason": "No verdict was produced for this criterion.", "evidence": []})
            continue
        verdict = str(it.get("verdict", "")).strip().lower().replace("_", " ")
        if verdict == "not verifiable":
            verdict = "not verifiable from diff"
        reason = clean_text(str(it.get("reason") or ""))
        if verdict not in VERDICTS:
            problems.append(f"criterion {c['id']}: unknown verdict {it.get('verdict')!r}")
            verdict, reason = "not verifiable from diff", f"Checker returned an unknown verdict. {reason}".strip()
        ev = it.get("evidence") or []
        if isinstance(ev, str):
            ev = [ev]
        good, bad = [], []
        for e in ev:
            ref, ok, note = check_evidence(e, repo_dir, changed)
            (good if ok else bad).append((ref, note))
        for ref, note in bad:
            problems.append(f"criterion {c['id']}: dropped evidence {ref!r} ({note})")
        if verdict in NEEDS_EVIDENCE and not good:
            problems.append(f"criterion {c['id']}: {verdict} without resolvable file:line, downgraded")
            reason = f"Downgraded from {verdict}: no resolvable file:line was cited. {reason}".strip()
            verdict = "not verifiable from diff"
        rows.append({**c, "verdict": verdict, "reason": reason or "(no reason given)",
                     "evidence": [{"ref": r, "note": n} for r, n in good]})
    for cid in by_id:
        problems.append(f"verdict for unknown criterion id {cid} ignored")
    return rows, problems


def tally(rows):
    return {v: sum(1 for r in rows if r["verdict"] == v) for v in VERDICTS}


# ---------------------------------------------------------------- Rendering

ICON = {"met": "✅", "partial": "🟡", "missing": "❌", "not verifiable from diff": "❔"}


def _cell(s):
    return str(s).replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ").strip()


def _ev_link(ctx, ev):
    m = EVIDENCE_RE.match(ev["ref"])
    path, start, end = m.group("path"), m.group("start"), m.group("end")
    sha = ctx["base_sha"] if ev.get("note") == "removed in this PR" and ctx.get("base_sha") else ctx["head_sha"]
    anchor = f"#L{start}" + (f"-L{end}" if end else "")
    return f"[`{ev['ref']}`](https://github.com/{ctx['repo']}/blob/{sha}/{path}{anchor})"


def tally_line(t):
    return " · ".join(f"{t[v]} {v}" for v in VERDICTS)


def render_github(ctx, rows=None, summary=None, problems=None):
    issue = ctx.get("issue") or {}
    head = f"### Acceptance criteria check: [{issue.get('identifier')}]({issue.get('url')}) {_cell(issue.get('title', ''))}"
    foot = (f"<sub>review-kit ac-check at `{ctx['head_sha'][:7]}`. Report only: it never changes the Linear "
            f"issue's status or checkboxes. Re-runs edit this comment.</sub>")
    if not ctx.get("criteria"):
        return "\n".join([MARKER, head, "",
                          f"No acceptance criteria found on {issue.get('identifier')}: no checkbox items under an "
                          f"\"{ctx.get('heading', DEFAULT_HEADING)}\" heading and none elsewhere in the description. "
                          "Nothing to check.", "", foot])
    t = tally(rows)
    src = (f"from the \"{ctx.get('heading', DEFAULT_HEADING)}\" section" if ctx.get("criteria_source") == "heading"
           else "from every checkbox in the description (no AC heading found)")
    out = [MARKER, head, "", f"**{tally_line(t)}** ({len(rows)} criteria, {src})", "",
           "| # | Criterion | Verdict | Reason | Evidence |", "|---|---|---|---|---|"]
    for r in rows:
        ev = "<br>".join(_ev_link(ctx, e) for e in r["evidence"]) or "n/a"
        out.append(f"| {r['id']} | {_cell(r['text'])} | {ICON[r['verdict']]} {r['verdict']} | {_cell(r['reason'])} | {ev} |")
    if summary:
        out += ["", _cell(summary)]
    ticked = [r["id"] for r in rows if r.get("checked")]
    if ticked:
        out += ["", f"Ticked on the issue: {', '.join(map(str, ticked))}. Verdicts above come from the code, not the ticks."]
    if problems:
        out += ["", "<details><summary>Checker notes</summary>", ""] + [f"- {_cell(p)}" for p in problems] + ["", "</details>"]
    out += ["", foot]
    return "\n".join(out)


def linear_header(ctx):
    return f"**AC check** for {ctx['repo']}#{ctx['pr']}"


def render_linear(ctx, rows=None, summary=None, comment_url=None):
    head = linear_header(ctx)
    link = f" ([PR comment]({comment_url}))" if comment_url else ""
    if not ctx.get("criteria"):
        return f"{head}{link}\n\nNo acceptance criteria found on this issue. Nothing to check."
    t = tally(rows)
    out = [f"{head}{link} at `{ctx['head_sha'][:7]}`", "", tally_line(t), "",
           "| # | Verdict | Criterion |", "|---|---|---|"]
    for r in rows:
        out.append(f"| {r['id']} | {ICON[r['verdict']]} {r['verdict']} | {_cell(r['text'])} |")
    if summary:
        out += ["", _cell(summary)]
    out += ["", "_Report only: this comment is the only thing ac-check writes to Linear._"]
    return "\n".join(out)


# ---------------------------------------------------------------- PR comment upsert

def upsert_pr_comment(repo, pr, body):
    """Edit the existing ac-check comment (found by MARKER) or create one. Returns (action, url)."""
    pages = gh_json(["api", "--paginate", "--slurp", f"repos/{repo}/issues/{pr}/comments?per_page=100"]) or []
    comments = [c for page in pages for c in page]
    mine = [c for c in comments if MARKER in (c.get("body") or "")]
    payload = json.dumps({"body": body})
    for c in reversed(mine):   # newest marked comment first
        try:
            res = gh_json(["api", "-X", "PATCH", f"repos/{repo}/issues/comments/{c['id']}", "--input", "-"], stdin=payload)
            return "updated", res["html_url"]
        except AcError as e:
            print(f"ac-check: could not edit comment {c['id']} ({e}); trying the next or creating one", file=sys.stderr)
    res = gh_json(["api", "-X", "POST", f"repos/{repo}/issues/{pr}/comments", "--input", "-"], stdin=payload)
    return "created", res["html_url"]
