# pr-channel

Streams GitHub PR review events into a **running** Claude Code session, so the
session that wrote the code is the one that answers the feedback on it.

A review comment lands on a PR, GitHub sends a signed webhook, the intake checks
it and routes it to exactly one session subscribed to that PR, and the session
replies on the PR with `post_reply`. How it responds (ask for specifics, fix,
push back) comes from the checked-out repo's `CLAUDE.md` and `REVIEW.md`, not
from this plugin.

```
GitHub ──signed webhook──▶ intake :8787 (public)   verify signature, normalize,
                                │                  drop self / stale / duplicate,
                                │                  pick ONE subscribed session
                                ▼
                           intake :8788 (loopback) ──SSE──▶ server.ts (MCP, one per session)
                                ▲                               │  notifications/claude/channel
                                └────── post_reply ◀────────────┘  subscribe / unsubscribe / list
```

Two processes on purpose. `server.ts` is the MCP server: claude spawns it and it
dies with the session. The **intake** has to outlive every session to receive a
webhook at all, and it is the only process holding the GitHub token.

## Requirements

- Claude Code with Channels (research preview) and [Bun](https://bun.sh).
  No npm dependencies.
- A webhook secret, and a GitHub token that can comment on the PRs.
- A way for GitHub to reach the intake: Tailscale Funnel, or smee.io /
  cloudflared (see [Network](#network)).

## Quickstart

**1. Install the plugin** (once per machine):

```bash
claude plugin marketplace add Teraflop-Inc/review-kit
claude plugin install pr-channel@review-kit
```

**2. Run the intake** (one long-lived process; leave it running):

```bash
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 24)   # also goes in the GitHub webhook
export GH_TOKEN=...                                    # posts the replies
PUBLISH_REPLIES=1 bun run ~/.claude/plugins/marketplaces/review-kit/plugins/pr-channel/server/intake.ts
```

It refuses to start without `GITHUB_WEBHOOK_SECRET`. It listens on two ports:

| port | bind | serves | expose it? |
|---|---|---|---|
| `8787` | `PUBLIC_HOST` (127.0.0.1) | `POST /webhook/github`, `GET /healthz` | **yes**, this is what Funnel / smee / cloudflared point at |
| `8788` | `CONTROL_HOST` (127.0.0.1) | SSE to sessions, subscriptions, replies, `/ingest`, `/state` | **never** |

The split matters: a funnel forwards from localhost, so "loopback only" cannot
protect a funneled port. Were the control routes on it, anyone could post
replies with your token. (Anthropic's `fakechat` plugin also defaults to 8787;
set `PUBLIC_PORT` if you run both.)

**3. Start a session in the repo** with the channel loaded. Custom channels are
not on the research-preview allowlist, so they need the development flag:

```bash
cd your-repo
PR_CHANNEL_SUBSCRIBE="owner/repo#12" \
  claude --dangerously-load-development-channels plugin:pr-channel@review-kit
```

Accept the development-channels prompt. Leave out `PR_CHANNEL_SUBSCRIBE` and
ask the session to subscribe instead ("subscribe to owner/repo#12").

**4. Register the webhook** (see [Webhooks](#webhooks)), comment on the PR, and
watch the comment arrive in the session.

## Tools

| tool | does |
|---|---|
| `subscribe` `{pr}` | start receiving events for `owner/repo#N` |
| `unsubscribe` `{pr}` | stop |
| `list_subscriptions` | your PRs, and whether you are **owner** or **standby** on each |
| `post_reply` `{correlation_key, in_reply_to, body}` | answer an event on its PR |

Each event arrives as a `<channel source="pr-channel">` block with `event_id`,
`correlation_key` (`owner/repo#N`), `kind` (`review_comment`, `review`,
`issue_comment`, `check_failed`), `actor`, `actor_is_bot` and `permalink`.

## Delivery rules

- **Only subscribed PRs.** Events for any other PR are dropped at the intake and
  never reach a session.
- **Exactly one session per event.** If several sessions subscribe to one PR,
  the longest-standing connected one owns its events; the rest are standbys and
  take over if it goes away. This is the fix for two open shells both replying.
- **One reply per event**, only from the owning session, only on that event's
  PR. The reply quotes the originating comment's permalink; inline review
  comments get a threaded reply next to the code.
- **Signed only.** Missing or wrong `X-Hub-Signature-256` gets a 401.
- **Deduped** on the comment/review id (stable across GitHub retries) and the
  delivery id.
- **Stale events rejected** with 422 when older than `MAX_EVENT_AGE_SECONDS`
  (default 3600; `0` turns it off, e.g. to use "Redeliver" on an old event).
- **No loops.** The intake adds a hidden `<!-- agent-reply -->` marker to every
  reply and drops anything carrying it. If the token is a bot or GitHub App
  identity (or `BOT_LOGIN` is set), events by that login are dropped too. A
  personal token is not filtered by login, because that would also drop your own
  review comments. Other bots (review bots) are delivered, flagged
  `actor_is_bot`.

## Network

GitHub needs an HTTPS URL for port 8787.

### Tailscale Funnel (preferred)

A stable public `https://<machine>.<tailnet>.ts.net` hostname.

1. In the tailnet policy file, grant the `funnel` node attribute, e.g.
   `"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`.
   MagicDNS and HTTPS certificates must be enabled for the tailnet.
2. Funnel serves only on ports **443, 8443 or 10000**. Map 443 to the public
   listener: `tailscale funnel --bg 8787`.
3. Webhook URL: `https://<machine>.<tailnet>.ts.net/webhook/github`.
4. Check it: `curl https://<machine>.<tailnet>.ts.net/healthz` returns `{"ok":true}`.

Funnel only port 8787. Never funnel 8788.

### smee.io (no Tailscale)

```bash
npx smee-client --url https://smee.io/<channel> --target http://127.0.0.1:8787/webhook/github
```

Webhook URL: `https://smee.io/<channel>`. smee-client re-serializes the JSON
before forwarding, so the signature only survives if GitHub's bytes equal
`JSON.stringify(JSON.parse(body))`. That held for every body tested (ASCII,
emoji, `<b>&`), but if deliveries 401 through smee and not directly, this is why.
Anyone who knows the channel URL can send to it; the signature check is what
keeps them out.

### cloudflared (no Tailscale)

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Forwards raw bytes. Quick tunnels get a new hostname each run, so update the
webhook each time or use a named tunnel.

## Webhooks

Content type must be **`application/json`**; the intake verifies and parses the
raw JSON body. Events: **Pull request reviews**, **Pull request review
comments**, **Issue comments** (only comments on PRs are kept). Add **Check
runs** to also hear failed CI.

### One org webhook (every repo in the org)

One webhook covers every repo, with no per-repo setup; subscriptions still
decide which PRs reach which session. Needs an org owner (`admin:org_hook`).

```bash
gh api orgs/ORG/hooks --method POST \
  -f name=web -F active=true \
  -f 'config[url]=https://<machine>.<tailnet>.ts.net/webhook/github' \
  -f 'config[content_type]=json' -f "config[secret]=$GITHUB_WEBHOOK_SECRET" \
  -f 'events[]=pull_request_review' -f 'events[]=pull_request_review_comment' \
  -f 'events[]=issue_comment'
```

### One repo (outside the org)

Needs repo admin. Same payload against the repo:

```bash
gh api repos/OWNER/REPO/hooks --method POST \
  -f name=web -F active=true \
  -f 'config[url]=https://smee.io/<channel>' \
  -f 'config[content_type]=json' -f "config[secret]=$GITHUB_WEBHOOK_SECRET" \
  -f 'events[]=pull_request_review' -f 'events[]=pull_request_review_comment' \
  -f 'events[]=issue_comment'
```

Or in the UI: repo **Settings → Webhooks → Add webhook**. GitHub sends a `ping`
first; the intake answers `pong` once the signature checks out.

## Testing without GitHub

`scripts/post-comment.sh` sends a webhook signed exactly as GitHub signs it:

```bash
export GITHUB_WEBHOOK_SECRET=...     # same as the intake's
scripts/post-comment.sh --repo owner/repo --pr 12 --kind issue_comment --body "this all needs to be changed"
scripts/post-comment.sh ... --no-sign --expect 401       # unsigned
scripts/post-comment.sh ... --bad-sig --expect 401       # wrong secret
scripts/post-comment.sh ... --age 7200 --expect 422      # stale
scripts/post-comment.sh --url https://smee.io/<channel> ...   # through smee
```

The intake's control port shows what it decided: `curl 127.0.0.1:8788/state`.

```bash
bun run test    # unit: signature (GitHub's published vector), routing, normalization
bun run e2e     # real intake + two real MCP sessions over stdio, signed webhooks
```

The e2e runs under a hard time limit (`tests/run-e2e.sh`): after some failing
runs bun spins after teardown instead of exiting, not yet root-caused.

## Configuration

| intake env | default | |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | (required) | webhook secret |
| `GH_TOKEN` | | token replies post with |
| `PUBLISH_REPLIES` | `0` | `1` to post to GitHub; otherwise replies are only written to `REPLY_DIR` |
| `PUBLIC_HOST` / `PUBLIC_PORT` | `127.0.0.1` / `8787` | webhook listener |
| `CONTROL_HOST` / `CONTROL_PORT` | `127.0.0.1` / `8788` | session listener; keep loopback |
| `MAX_EVENT_AGE_SECONDS` | `3600` | `0` disables |
| `BOT_LOGIN` | from the token, if it is a bot | login whose events are ours |
| `REPLY_DIR` | `./.out/replies` | audit copy of every reply |
| `SESSION_GRACE_MS` | `60000` | how long a disconnected session keeps its subscriptions |

| session env | default | |
|---|---|---|
| `PR_CHANNEL_SUBSCRIBE` | | `owner/repo#1,owner/repo#2` to subscribe at startup |
| `PR_CHANNEL_INTAKE_URL` | `http://127.0.0.1:8788` | the intake's control port |

## Security

Channel content is **untrusted input** from anyone who can comment on a
subscribed PR, delivered into a session that has tools. The signature check and
subscriptions decide who can reach a session; they do not make a hostile comment
safe. Keep the session's permissions to what the repo needs, and treat review
text the way `REVIEW.md` says to.

Today the intake and the sessions it serves share one machine, because the
control port is loopback. Serving remote sessions from one always-on instance
is a follow-on.

## Troubleshooting

- **"no MCP server configured with that name"** at startup means the channel was
  loaded as `server:pr-channel` against a server passed with `--mcp-config`.
  Claude checks `server:` entries only against servers in its scopes, and only
  shows a notice; the channel still loads. Use
  `plugin:pr-channel@review-kit` and it goes away.
- **Nothing arrives.** There is no delivery acknowledgement in the Channels
  protocol. Check in order: `curl 127.0.0.1:8788/state` (did the intake accept
  it, and route it to which session?), `list_subscriptions` in the session, the
  GitHub webhook's Recent Deliveries (401 means a secret mismatch).
- **Two sessions, one answer, by design.** The standby shows `(standby)` in
  `list_subscriptions`.

History: this started as the 9/23 Claude Code LA meetup demo
(`Teraflop-Inc/claude-github-channel`) and was productionized under ENG2-1657.
