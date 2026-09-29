# review-kit

A central repo that other repos *call* for Claude PR review, instead of copying review logic into each one. It ships a reusable GitHub Actions workflow built on Anthropic's `claude-code-action`, a base review prompt, `REVIEW.md` starters for common repo types, and a labeling convention (`fyi`) that makes review cheaper. Mechanics and the base prompt live here; each repo adds its own context through `REVIEW.md` and `CLAUDE.md`. It is also the home for review drop-ins that do not exist off the shelf.

## What already exists off the shelf

Use these directly if they fit. review-kit builds on them.

- [Anthropic Code Review](https://docs.claude.com/en/docs/claude-code/code-review): managed PR review for teams and enterprise plans.
- [`/code-review`](https://github.com/anthropics/claude-code/tree/main/plugins/code-review): a Claude Code plugin you run locally on the current diff or a PR.
- [`claude-code-action`](https://github.com/anthropics/claude-code-action): the GitHub Action that runs Claude Code in a workflow. review-kit's workflow wraps it.
- [`pr-review-toolkit`](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit): Anthropic's plugin with specialist review agents (`pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`, `code-simplifier`, and more). review-kit installs it into every run.

## Prerequisites

- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed.
- [`gh`](https://cli.github.com) installed and authenticated (`gh auth status`).
- A GitHub repo where you can add a workflow and a secret.
- One Anthropic credential: an API key from the [Console](https://console.anthropic.com), or an OAuth token from `claude setup-token` (uses your Claude subscription).
- Optional, for the drop-ins: a Linear API key (AC checker), and Bun plus a Tailscale account (Channels server).

## Quickstart

1. **Add the workflow.** Copy [`templates/caller-review.yml`](templates/caller-review.yml) to `.github/workflows/review.yml` in your repo:

   ```bash
   mkdir -p .github/workflows
   curl -fsSL https://raw.githubusercontent.com/aowen14/review-kit/v1/templates/caller-review.yml \
     -o .github/workflows/review.yml
   ```

2. **Add a secret.** Pick one:

   ```bash
   claude setup-token                       # prints an OAuth token
   gh secret set CLAUDE_CODE_OAUTH_TOKEN    # paste it when prompted
   # or
   gh secret set ANTHROPIC_API_KEY
   ```

   The workflow uses the OAuth token if both are set. Org-level secrets work too.

3. **Pick a `REVIEW.md` starter** and save it as `REVIEW.md` at the repo root. Edit it for your repo.

   | Starter | Use for |
   |---|---|
   | [`REVIEW.app.md`](templates/REVIEW.app.md) | application and API repos |
   | [`REVIEW.infra.md`](templates/REVIEW.infra.md) | infra, scripts, install tooling |
   | [`REVIEW.docs.md`](templates/REVIEW.docs.md) | docs and content repos |

   ```bash
   curl -fsSL https://raw.githubusercontent.com/aowen14/review-kit/v1/templates/REVIEW.app.md -o REVIEW.md
   ```

4. **Open a PR.** Commit the two files on a branch and open a PR (`gh pr create --fill`). The review posts a progress comment, inline comments on findings, and a summary. The first PR reviews itself.

Optional: paste [`templates/CLAUDE.fyi-snippet.md`](templates/CLAUDE.fyi-snippet.md) into your `CLAUDE.md` so agents label their own PRs `needs-review` or `fyi`, and create the labels with `gh label create fyi` and `gh label create needs-review`.

### What the workflow does

- Loads [`prompts/base-review.md`](prompts/base-review.md) from review-kit at the exact ref you pinned, then appends your repo's `REVIEW.md` if present. `REVIEW.md` is read from the PR's base branch, so a PR cannot loosen its own review rules (the PR that first adds it uses its own copy). Your `CLAUDE.md` is picked up from the checkout. Change `REVIEW.md` and the next run changes with it.
- Installs `pr-review-toolkit` through the action's `plugin_marketplaces` and `plugins` inputs, so its agents are available to the reviewer through the Task tool.
- On PRs labeled `fyi`, reports Important findings only and posts no nits. The label is read when the job starts, so labeling right after opening still counts.
- Skips draft PRs (they are reviewed on "ready for review") and PRs whose files all match `skip_paths`.
- Fork PRs get no secrets, so the review is skipped and a comment explains why. That comment is posted by a job on `pull_request_target` that never checks out or runs PR code and uses no secrets. The review itself only runs on `pull_request`.
- Posts as `github-actions[bot]` with the workflow token. No GitHub App install and no `id-token: write` are needed; permissions are `contents: read` and `pull-requests: write`.
- Fails with a clear error if neither `CLAUDE_CODE_OAUTH_TOKEN` nor `ANTHROPIC_API_KEY` is available.

### Troubleshooting

- **"No Anthropic credential available"**: add the secret, then push a new commit (or close and reopen the PR). Re-running an old run can keep the secrets it started with, so a secret added afterwards may not reach it.
- **Fork PR skipped**: expected. Fork PRs never receive secrets. Push the branch to the base repo to get a review.
- **No review on a draft**: expected. Mark the PR ready for review.

### Inputs

All optional. Pass them under `with:` in your caller.

| Input | Default | Meaning |
|---|---|---|
| `model` | action default | Claude model id |
| `max_turns` | `40` | agent turn limit |
| `review_focus` | empty | free text appended to the prompt |
| `skip_paths` | empty | globs, comma or newline separated |
| `auth_method` | `auto` | `auto`, `oauth`, or `api_key` |

## Drop-ins

Plugins in this repo's marketplace, installed with `/plugin marketplace add aowen14/review-kit`.

### AC checker (`ac-check`): coming

Checks a PR against the acceptance criteria on its linked Linear ticket. Needs a Linear API key. Tracked in ENG2-1656.

### Review retro (`review-retro`): coming

After merge, summarizes what the review caught and what it missed, so you can tune `REVIEW.md`. Tracked in ENG2-1655.

### PR Channels server (`pr-channel`): coming

Streams PR review events into a running Claude Code session through Channels. Needs Bun and Tailscale. Tracked in ENG2-1657.

## How updates reach your repo

- **Tag pinning (default):** the caller uses `@v1`. Every `v1.x.y` release moves the floating `v1` tag, so you get prompt and mechanics updates automatically. Breaking changes go to `v2`.
- **SHA pinning (recommended outside Teraflop):** replace `@v1` with a full commit SHA so nothing changes until you choose. Let Dependabot or Renovate propose bumps:

  ```yaml
  # .github/dependabot.yml
  version: 2
  updates:
    - package-ecosystem: github-actions
      directory: /
      schedule:
        interval: weekly
  ```

- **Canary:** one Teraflop repo pins `@main` to get changes before they are released.

A prompt change is a release. Every push to `main` runs [`ci.yml`](.github/workflows/ci.yml), which reviews a fixture PR with a known bug and fails unless the bug is reported. Pushing a `vX.Y.Z` tag runs [`release.yml`](.github/workflows/release.yml), which moves `vX` to that commit.

## Repo layout

```
.github/workflows/review.yml        reusable workflow (workflow_call)
.github/workflows/ci.yml            reviews the fixture PR on every push to main
.github/workflows/release.yml       moves vX when vX.Y.Z is tagged
.github/workflows/credential-check.yml  manual: no secrets must fail clearly
.claude-plugin/marketplace.json     plugin marketplace for the drop-ins
plugins/                            ac-check, review-retro, pr-channel
prompts/base-review.md              central base review prompt
templates/                          caller workflow, REVIEW.md starters, fyi snippet
docs/spec.md                        the spec this repo was built from
```
