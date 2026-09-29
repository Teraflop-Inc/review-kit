#!/usr/bin/env bash
# post-comment.sh — the synthetic event driver. This is the test instrument.
#
# POSTs a realistic GitHub webhook payload at the channel server's intake, so
# the whole loop can be exercised in one shot with no real GitHub ingress.
#
# Why synthetic, and why this is not a shortcut: a repository webhook needs repo
# admin, and `gh webhook forward` creates a REAL hook on the repo and is
# documented as testing-only and single-consumer. Neither belongs in an
# automated build. Real ingress is a separate, later step; the mechanism being
# proven here — normalize -> notify -> the model reacts — is identical either
# way, because the intake is the only thing that ever sees a GitHub-shaped
# payload.
#
# The comment id is derived from the body by default, so running the same
# command twice exercises the dedupe path (intake answers "duplicate") while
# distinct bodies produce distinct events. Use --event-id to override.
#
# Requests are signed with X-Hub-Signature-256 exactly as GitHub signs them
# (HMAC-SHA256 of the raw body under GITHUB_WEBHOOK_SECRET). --no-sign and
# --bad-sig exercise the 401 path; --age makes a stale event; --expect asserts
# the HTTP status. --url sends anywhere, e.g. a smee.io channel.
set -euo pipefail

INTAKE="${INTAKE:-http://127.0.0.1:8787}"
URL=""
SECRET="${GITHUB_WEBHOOK_SECRET:-}"
SIGN=1
BAD_SIG=0
AGE=0
DELIVERY=""
EXPECT=""
REPO="${REPO:-aowen14/dev-agent-workshop-starter}"
PR=1
BODY=""
KIND="review_comment"
ACTOR="${ACTOR:-aowen14}"
EVENT_ID=""
CHECK_NAME="build"
CONCLUSION="failure"

usage() {
  cat >&2 <<'EOF'
usage: post-comment.sh --pr N --body TEXT [options]

  --pr N            PR / issue number (default 1)
  --body TEXT       comment body (required unless --kind check_failed)
  --kind KIND       review_comment | review | issue_comment | check_failed
                    (default review_comment)
  --actor LOGIN     comment author (default $ACTOR or aowen14)
  --repo OWNER/NAME target repo (default aowen14/dev-agent-workshop-starter)
  --event-id ID     force the underlying object id (to test dedupe explicitly)
  --check NAME      check name, for --kind check_failed (default build)
  --conclusion C    check conclusion (default failure)
  --intake URL      intake PUBLIC base URL (default http://127.0.0.1:8787)
  --url URL         full target URL instead of $INTAKE/webhook/github (smee.io)
  --secret S        webhook secret (default $GITHUB_WEBHOOK_SECRET)
  --no-sign         send no X-Hub-Signature-256 (expect 401)
  --bad-sig         send a signature made with the wrong secret (expect 401)
  --age SECONDS     backdate the comment's created_at (stale-event test)
  --delivery ID     force X-GitHub-Delivery (default: a fresh uuid)
  --expect CODE     fail unless the HTTP status is exactly CODE

env: INTAKE, REPO, ACTOR, GITHUB_WEBHOOK_SECRET override the defaults above.
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --body) BODY="$2"; shift 2 ;;
    --kind) KIND="$2"; shift 2 ;;
    --actor) ACTOR="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --event-id) EVENT_ID="$2"; shift 2 ;;
    --check) CHECK_NAME="$2"; shift 2 ;;
    --conclusion) CONCLUSION="$2"; shift 2 ;;
    --intake) INTAKE="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --secret) SECRET="$2"; shift 2 ;;
    --no-sign) SIGN=0; shift ;;
    --bad-sig) BAD_SIG=1; shift ;;
    --age) AGE="$2"; shift 2 ;;
    --delivery) DELIVERY="$2"; shift 2 ;;
    --expect) EXPECT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

case "$KIND" in
  review_comment) GH_EVENT="pull_request_review_comment" ;;
  review)         GH_EVENT="pull_request_review" ;;
  issue_comment)  GH_EVENT="issue_comment" ;;
  check_failed)   GH_EVENT="check_run" ;;
  *) echo "unknown --kind: $KIND" >&2; usage ;;
esac

if [[ "$SIGN" == "1" && -z "$SECRET" ]]; then
  echo "no webhook secret: set GITHUB_WEBHOOK_SECRET, pass --secret, or --no-sign" >&2
  exit 2
fi

if [[ -z "$BODY" && "$KIND" != "check_failed" ]]; then
  echo "--body is required for --kind $KIND" >&2
  usage
fi

# Build the payload with python3 so the body is JSON-escaped correctly
# (bodies contain quotes, newlines and backticks in practice).
PAYLOAD=$(
  REPO="$REPO" PR="$PR" BODY="$BODY" KIND="$KIND" ACTOR="$ACTOR" AGE="$AGE" \
  EVENT_ID="$EVENT_ID" CHECK_NAME="$CHECK_NAME" CONCLUSION="$CONCLUSION" \
  python3 - <<'PY'
import datetime, hashlib, json, os

repo = os.environ["REPO"]
owner, name = repo.split("/", 1)
pr = int(os.environ["PR"])
body = os.environ["BODY"]
kind = os.environ["KIND"]
actor = os.environ["ACTOR"]
forced = os.environ["EVENT_ID"]
check_name = os.environ["CHECK_NAME"]
conclusion = os.environ["CONCLUSION"]
# "Now", minus --age. A fixed date here would read as stale to the intake.
created = (datetime.datetime.now(datetime.timezone.utc)
           - datetime.timedelta(seconds=int(os.environ["AGE"]))).strftime("%Y-%m-%dT%H:%M:%SZ")

# Stable-by-content id: same body -> same id -> intake dedupes it.
oid = int(forced) if forced.isdigit() else int(
    hashlib.sha256(f"{repo}#{pr}:{kind}:{body}:{check_name}".encode()).hexdigest()[:12], 16
)

repository = {
    "full_name": repo,
    "name": name,
    "owner": {"login": owner, "type": "Organization"},
    "private": True,
    "html_url": f"https://github.com/{repo}",
}
sender = {"login": actor, "id": 22056542, "type": "Bot" if actor.endswith("[bot]") else "User"}

if kind == "review_comment":
    payload = {
        "action": "created",
        "comment": {
            "id": oid,
            "body": body,
            "user": sender,
            "path": "channel-server/server.ts",
            "line": 42,
            "commit_id": "0" * 40,
            "html_url": f"https://github.com/{repo}/pull/{pr}#discussion_r{oid}",
            "created_at": created,
        },
        "pull_request": {
            "number": pr,
            "title": "Add a GitHub-comment channel",
            "html_url": f"https://github.com/{repo}/pull/{pr}",
            "head": {"ref": "channel", "sha": "0" * 40},
            "base": {"ref": "main"},
        },
        "repository": repository,
        "sender": sender,
    }
elif kind == "review":
    payload = {
        "action": "submitted",
        "review": {
            "id": oid,
            "body": body,
            "state": "changes_requested",
            "user": sender,
            "html_url": f"https://github.com/{repo}/pull/{pr}#pullrequestreview-{oid}",
            "submitted_at": created,
        },
        "pull_request": {"number": pr, "html_url": f"https://github.com/{repo}/pull/{pr}"},
        "repository": repository,
        "sender": sender,
    }
elif kind == "issue_comment":
    payload = {
        "action": "created",
        "comment": {
            "id": oid,
            "body": body,
            "user": sender,
            "html_url": f"https://github.com/{repo}/pull/{pr}#issuecomment-{oid}",
            "created_at": created,
        },
        "issue": {
            "number": pr,
            "title": "Add a GitHub-comment channel",
            "html_url": f"https://github.com/{repo}/pull/{pr}",
            "pull_request": {"url": f"https://api.github.com/repos/{repo}/pulls/{pr}"},
        },
        "repository": repository,
        "sender": sender,
    }
else:  # check_failed
    payload = {
        "action": "completed",
        "check_run": {
            "id": oid,
            "name": check_name,
            "status": "completed",
            "conclusion": conclusion,
            "html_url": f"https://github.com/{repo}/runs/{oid}",
            "output": {
                "title": f"{check_name} failed",
                "summary": body or f"{check_name} exited non-zero.",
            },
            "pull_requests": [{"number": pr}],
            "completed_at": created,
        },
        "repository": repository,
        "sender": sender,
    }

# Compact, like GitHub's own serialization. The signature covers these exact
# bytes, so nothing after this point may reformat them.
print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
PY
)

TARGET="${URL:-$INTAKE/webhook/github}"
[[ -n "$DELIVERY" ]] || DELIVERY=$(python3 -c 'import uuid;print(uuid.uuid4())')

# printf '%s' so the signed bytes are exactly the bytes sent: no trailing newline.
sign() { printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$1" | sed 's/^.*= *//'; }
SIG_HEADER=()
if [[ "$SIGN" == "1" ]]; then
  KEY="$SECRET"; [[ "$BAD_SIG" == "1" ]] && KEY="not-the-secret"
  SIG_HEADER=(-H "X-Hub-Signature-256: sha256=$(sign "$KEY")")
fi

SIGNED="no"; [[ "$SIGN" == "1" ]] && SIGNED="yes"; [[ "$BAD_SIG" == "1" ]] && SIGNED="wrong secret"
echo "==> POST $TARGET  (X-GitHub-Event: $GH_EVENT, signed: $SIGNED)" >&2

HTTP_BODY=$(mktemp)
trap 'rm -f "$HTTP_BODY"' EXIT
CODE=$(printf '%s' "$PAYLOAD" | curl -sS -o "$HTTP_BODY" -w '%{http_code}' \
  -X POST "$TARGET" \
  -H "content-type: application/json" \
  -H "X-GitHub-Event: $GH_EVENT" \
  -H "X-GitHub-Delivery: $DELIVERY" \
  ${SIG_HEADER[@]+"${SIG_HEADER[@]}"} \
  --data-binary @-)

cat "$HTTP_BODY" >&2
echo >&2

if [[ -n "$EXPECT" ]]; then
  [[ "$CODE" == "$EXPECT" ]] || { echo "FAIL: expected HTTP $EXPECT, got $CODE" >&2; exit 1; }
  echo "ok (HTTP $CODE, as expected)" >&2
  exit 0
fi
if [[ "$CODE" != "200" && "$CODE" != "202" ]]; then
  echo "FAIL: intake returned HTTP $CODE" >&2
  exit 1
fi

# NOTE: a 200 here means the INTAKE accepted the event. It does NOT mean the
# model received it: there is no delivery acknowledgement anywhere in this
# protocol. Check the session itself.
echo "ok (HTTP $CODE). The intake accepted it; that alone does not prove the session saw it." >&2
