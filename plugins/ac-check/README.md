# ac-check

Checks a pull request against the acceptance criteria (ACs) on its Linear issue and posts one report comment on the PR: a table with a verdict per criterion, a one-line reason, and `file:line` evidence, plus a tally. Re-running edits the same comment. It is report only: it never changes the Linear issue's status, fields, or checkboxes.

```
Acceptance criteria check: ENG2-1655 Review retro: ...
11 met · 1 partial · 0 missing · 1 not verifiable from diff (13 criteria, from the "Acceptance criteria" section)

| # | Criterion                         | Verdict                     | Reason                                  | Evidence                   |
| 7 | The job never writes to REVIEW.md | ✅ met                       | put_file refuses the default branch ... | retro/propose:128-135      |
| 12| Caller pins a version tag (@v1)   | 🟡 partial                   | v1 has no review-retro.yml yet ...      | caller-review-retro.yml:22 |
| 10| Attach issues.md to this ticket   | ❔ not verifiable from diff  | Needs the ticket attachments ...        | n/a                        |
```

Run it two ways, with the same prompt: as `/ac-check` in Claude Code, or as a GitHub Actions workflow on every PR.

## How it works

1. **Find the issue (deterministic).** An explicit ID wins. Otherwise the first Linear identifier (`TEAM-123`, any case) in the branch name, then the PR title, then the PR body. With a Linear key, only keys of teams that key can see count, so `utf-8` or `sha-256` never match. `team_prefixes` narrows it further.
2. **Parse the ACs (deterministic).** Checkboxes (`- [ ]`, `- [x]`) under a heading named "Acceptance criteria" (markdown `#` heading or a bold line, any case, optional colon). Without that heading, every checkbox in the description counts. With no checkboxes at all, it posts a short "no acceptance criteria" comment and exits successfully, with no verdicts.
3. **Evaluate (Claude).** [`prompts/evaluate.md`](prompts/evaluate.md) is the base prompt. Claude starts from the diff and reads beyond it in a checkout of the PR head. The calling repo's `CLAUDE.md` and `REVIEW.md` tell it what "done" means there. Each criterion gets exactly one verdict:

   | Verdict | Meaning | Evidence |
   |---|---|---|
   | `met` | the PR head does it | required `file:line` |
   | `partial` | some parts done, the rest named in the reason | required `file:line` |
   | `missing` | not done | none needed |
   | `not verifiable from diff` | code cannot show it (a run, a ticket attachment, a UI setting) | none needed |

   The issue's own ticked boxes are shown but ignored. Verdicts come from the code.
4. **Post (deterministic).** [`ac/post`](ac/post) validates the verdicts before posting: one per criterion, one of the four strings, and every `met`/`partial` cites a `path:line` that exists at the PR head (or in a file this PR deletes). A `met`/`partial` without one is downgraded to `not verifiable from diff`, and the reason says so. Evidence links point at the head SHA. The comment carries a hidden `<!-- review-kit:ac-check -->` marker, so the next run edits it instead of posting another.

The only writes are that PR comment and, if you ask for it, one Linear comment mirroring the result (`--linear-comment`, or `linear_comment: true` in the Action), which is also updated in place. A unit test asserts that the code contains no Linear mutation besides `commentCreate` and `commentUpdate`.

## Run it in Claude Code

```
/plugin marketplace add aowen14/review-kit
/plugin install ac-check@review-kit
```

Then, in any directory:

```
/ac-check https://github.com/owner/repo/pull/123
/ac-check owner/repo#123 ENG2-456          # explicit issue
/ac-check 123 --dry-run                    # print the comment, post nothing
/ac-check owner/repo#123 --linear-comment  # also mirror to the Linear issue
```

Needs `gh` logged in and `LINEAR_API_KEY` exported. Without the key, the command falls back to a Linear MCP server if the session has one (it reads the issue with `get_issue`). With neither, it stops and says so. If you are not inside the PR's repo at its head commit, it makes a blob-less clone under `.ac-check/`, which is safe to delete.

The deterministic steps also work without Claude:

```bash
A=plugins/ac-check/ac
$A/prepare owner/repo#123 --out /tmp/ac     # resolve, fetch, parse; prints a JSON summary
# write /tmp/ac/verdicts.json (see ac/post --help for the shape)
$A/post /tmp/ac --dry-run
```

## Run it in GitHub Actions

Copy [`templates/caller-ac-check.yml`](templates/caller-ac-check.yml) to `.github/workflows/ac-check.yml`. That file is all a repo needs, because the logic stays in review-kit:

```yaml
name: AC check
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  ac-check:
    uses: aowen14/review-kit/.github/workflows/ac-check.yml@v1
    secrets: inherit
```

It runs when a PR opens and on every push. Draft PRs are skipped until marked ready. Fork PRs are skipped because they get no secrets. A PR with no Linear ID is skipped with a notice and no comment. The workflow installs this plugin from review-kit's marketplace at the exact commit you pinned, so CI and local runs use identical prompts.

### Inputs

All optional, under `with:`.

| Input | Default | Meaning |
|---|---|---|
| `ac_heading` | `Acceptance criteria` | heading whose checkboxes are the ACs |
| `team_prefixes` | all teams the key sees | comma-separated Linear team keys, for example `ENG2,ENG` |
| `linear_comment` | `false` | mirror the result as a Linear comment |
| `model` | action default | Claude model id |
| `max_turns` | `40` | agent turn limit |
| `auth_method` | `auto` | `auto` (OAuth token first), `oauth`, or `api_key` |

### Secrets

Set these once as **organization secrets** (Organization settings → Secrets and variables → Actions) and give the calling repos access. `secrets: inherit` passes them through, so no repo stores its own copy.

| Secret | Needed | Notes |
|---|---|---|
| `LINEAR_API_KEY` | yes | read access; see scopes below |
| `CLAUDE_CODE_OAUTH_TOKEN` | one of these two | from `claude setup-token` (Claude subscription) |
| `ANTHROPIC_API_KEY` | one of these two | from the [Console](https://console.anthropic.com) |

If both Anthropic secrets are set, the OAuth token is used unless `auth_method: api_key`. A missing secret fails the job with a message naming it.

### Token scopes

| Token | Scope |
|---|---|
| Linear API key | **Read** is enough. Add **Create comments** (or **Write**) only for `linear_comment` / `--linear-comment`. Create it under Linear → Settings → Security & access → Personal API keys. A key sees only the teams its owner can see. Use a bot or service user if the report should not depend on one person. |
| GitHub, in Actions | nothing to create. The job uses the workflow token with `contents: read` and `pull-requests: write`, and comments appear as `github-actions[bot]`. |
| GitHub, local (`gh`) | classic token: `repo` (private repos) or `public_repo`. Fine-grained: Contents read, Pull requests read and write, Metadata read. |
| Anthropic | no scopes. Either credential above. |

### Pinning

- **Org repos: pin the tag.** `@v1` moves with every `v1.x.y` release, so prompt and mechanics fixes arrive without edits. Breaking changes ship as `v2`.
- **External users: pin a full SHA**, `uses: aowen14/review-kit/.github/workflows/ac-check.yml@<40-char sha>`, and let Dependabot or Renovate propose bumps (see the root README). The plugin is loaded from that same commit.

### Using a private review-kit

review-kit is public today. If it (or an org fork) is private, callers in the same organization can only use its reusable workflow after you allow it: in the review-kit repo, go to **Settings → Actions → General → Access** and choose "Accessible from repositories in the '<org>' organization".

That setting covers the `uses:` line. The workflow also runs `actions/checkout` on review-kit to load the plugin and prompt, and the caller's workflow token cannot read another private repo. For a private kit, that step needs a token with read access to it (for example a GitHub App token), the same as `review.yml`. The private setup has not been exercised yet, because review-kit is public.

## Files

```
ac/prepare            resolve PR and issue, fetch Linear, parse ACs, save the diff, ensure a checkout
ac/post               validate verdicts, render, create or update the PR (and Linear) comment
ac/_ac.py             shared logic, stdlib only
commands/ac-check.md  /ac-check: drives prepare, the evaluation, and post
prompts/evaluate.md   base evaluation prompt
templates/            caller workflow
tests/                offline tests: python3 -m unittest discover plugins/ac-check/tests
../../.github/workflows/ac-check.yml   reusable workflow (workflow_call)
```

## Limits

- One issue per PR: the first identifier that resolves. Pass one explicitly to choose.
- Criteria about things outside the code (a run happened, a link is attached to the ticket) come back `not verifiable from diff` by design. Check those by hand.
- The Linear mirror finds its previous comment by author and header, so switching keys between runs creates a second comment.
