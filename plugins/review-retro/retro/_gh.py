"""Shared GitHub helpers for the retro tools. Stdlib only; talks to GitHub through `gh`."""
import json
import subprocess
import sys
import time


class GhError(RuntimeError):
    pass


def _rate_limited(text):
    t = text.lower()
    return "rate limit" in t or "secondary rate" in t or "abuse detection" in t


def _wait_for_reset():
    """Sleep until the core/graphql rate limit resets (capped at 15 min)."""
    try:
        out = subprocess.run(["gh", "api", "rate_limit"], capture_output=True, text=True, check=True).stdout
        res = json.loads(out)["resources"]
        reset = max(res["core"]["reset"], res["graphql"]["reset"])
        delay = min(max(reset - time.time(), 5), 900)
    except Exception:
        delay = 60
    print(f"retro: rate limited, sleeping {int(delay)}s", file=sys.stderr)
    time.sleep(delay)


def gh(args, stdin=None, tries=5):
    """Run `gh` and return stdout. Retries on rate limits and transient 5xx errors."""
    for attempt in range(tries):
        p = subprocess.run(["gh", *args], input=stdin, capture_output=True, text=True)
        if p.returncode == 0:
            return p.stdout
        err = p.stderr + p.stdout
        if _rate_limited(err):
            _wait_for_reset()
            continue
        if any(code in err for code in ("HTTP 502", "HTTP 503", "HTTP 504", "timeout")) and attempt < tries - 1:
            time.sleep(2 ** attempt)
            continue
        raise GhError(f"gh {' '.join(args[:3])} failed: {err.strip()[:500]}")
    raise GhError(f"gh {' '.join(args[:3])} failed after {tries} attempts")


def graphql(query, **variables):
    """Run a GraphQL query. Returns (data, raw_bytes)."""
    args = ["api", "graphql", "-f", f"query={query}"]
    for k, v in variables.items():
        if v is None:
            continue
        args += ["-F" if isinstance(v, int) else "-f", f"{k}={v}"]
    raw = gh(args)
    body = json.loads(raw)
    if body.get("errors"):
        raise GhError(f"GraphQL error: {json.dumps(body['errors'])[:500]}")
    return body["data"], len(raw.encode())


def rest(path, method="GET", fields=None, body=None):
    """Call the REST API. Returns (parsed_json_or_None, raw_bytes)."""
    args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    for k, v in (fields or {}).items():
        args += ["-f", f"{k}={v}"]
    stdin = None
    if body is not None:
        args += ["--input", "-"]
        stdin = json.dumps(body)
    raw = gh(args, stdin=stdin)
    return (json.loads(raw) if raw.strip() else None), len(raw.encode())


def split_repo(repo):
    if repo.count("/") != 1:
        raise SystemExit(f"--repo must be owner/name, got {repo!r}")
    return repo.split("/")
