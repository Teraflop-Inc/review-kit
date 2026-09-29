# Spec: `review-kit` repo and base PR review workflow

**Owner:** Alex Owen
**For:** an implementation agent, working autonomously
**Deadline:** before the Claude Code LA PR Review session on 2026-09-29
**Related Linear tickets:** ENG2-1655 (review retro), ENG2-1656 (AC checker), ENG2-1657 (Channels PR server). Those three ship *into* this repo. This spec creates the repo and the base workflow they sit next to.

---

## 1. Goal

Create a public central repo, `Teraflop-Inc/review-kit`, that other repos *call* rather than copy. Ship the first piece: a reusable PR review workflow built on Anthropic's `claude-code-action`. Prove it by adopting it in a separate public test repo with a caller workflow of about 10 lines.

The value is not the review itself (Anthropic already publishes that). The value is:

1. One place to manage mechanics and base prompts for every repo.
2. An opinionated `REVIEW.md` starter, since most people do not know the file exists.
3. Conventions (the `fyi` label) that make review cheaper.
4. A home for the drop-ins that do not exist off the shelf (AC checker, retro, Channels server).

## 2. Layering rule

Apply this everywhere in the repo:

| Layer | Where it lives | Examples |
|---|---|---|
| Mechanics (deterministic) | Central, always | Triggers, fetching, posting comments, dedupe |
| Judgment (prompts) | Central base, local additions | Base review prompt; the repo's `REVIEW.md` and `CLAUDE.md` add to it |
| Context | Local, always | `REVIEW.md`, `CLAUDE.md`, the code |
| Secrets | Org level | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |

## 3. Repo layout

```
review-kit/
  .github/workflows/
    review.yml               # reusable workflow (on: workflow_call)
    ci.yml                   # runs review.yml against the fixture PR on every push
    release.yml              # on tag vX.Y.Z, moves the floating vX tag
  .claude-plugin/
    marketplace.json         # plugin marketplace manifest
  plugins/                   # placeholder dirs for ENG2-1655/1656/1657; README stub each
    ac-check/
    review-retro/
    pr-channel/
  prompts/
    base-review.md           # central base review prompt
  templates/
    REVIEW.app.md            # starter: application repo
    REVIEW.infra.md          # starter: infra, scripts, install tooling
    REVIEW.docs.md           # starter: docs and content repo
    CLAUDE.fyi-snippet.md    # the fyi labeling convention, paste into CLAUDE.md
    caller-review.yml        # the ~10 line caller workflow to copy
  README.md                  # doubles as the session handout
```

## 4. The reusable review workflow

`review.yml`, triggered by `workflow_call`.

**Behavior**
- Runs `anthropics/claude-code-action@v1` on the calling repo's PR.
- Loads the central base prompt from `prompts/base-review.md` (check out `review-kit` at the same ref the caller pinned) and appends the calling repo's `REVIEW.md` if present. The calling repo's `CLAUDE.md` is picked up automatically from the checkout.
- Installs Anthropic's `pr-review-toolkit` plugin so its agents are available (pr-test-analyzer, code-simplifier, type-design-analyzer, silent-failure-hunter). Verify against the current `claude-code-action` docs how plugins or marketplaces are passed to the action; if there is no direct input, document the working alternative.
- Honors the `fyi` label: on PRs labeled `fyi`, post Important findings only and skip nits.
- Posts findings as inline comments plus a summary, using the action's progress tracking.

**Inputs** (all optional, with defaults)
- `model`
- `max_turns`
- `review_focus`: free text appended to the prompt
- `skip_paths`: glob list

**Secrets**
- Accepts either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`; fails with a clear message if neither is set.
- Callers pass secrets with `secrets: inherit`.

**Safety**
- Trigger on `pull_request` in the caller, not `pull_request_target`.
- Fork PRs will not have secrets; the workflow should skip cleanly with a comment explaining why, not error.
- Minimal permissions: `contents: read`, `pull-requests: write`, `id-token: write` only if the action requires it.

## 5. Versioning and release

- `release.yml`: when a `vX.Y.Z` tag is pushed, move the floating `vX` tag to that commit.
- Callers pin `@v1`. External users are told to pin a full commit SHA and use Dependabot or Renovate to bump.
- `ci.yml`: on every push to `main`, run the reusable workflow against a known fixture PR in the test repo (see section 7) and fail if the run errors. A prompt change is a release, so it gets tested before `v1` moves.
- Document a canary path: one Teraflop repo may pin `@main`.

## 6. Session-prep content in this repo

These are part of this spec because they live in `review-kit`:

- **Three `REVIEW.md` starters** in `templates/`. Each is short (under 40 lines), following Anthropic's guidance: redefine what Important means for that repo type, cap nits (e.g. at most five), list skip rules (generated files, lockfiles, anything CI already enforces), and add two or three "always check" rules. The infra variant should include "install and setup scripts must be idempotent and must not assume a previously configured machine."
- **`CLAUDE.fyi-snippet.md`**: a few lines telling implementation agents to label their own PRs `needs-review` or `fyi` when opening them, with a one-line reason in the PR body.
- **`README.md` as the handout**, in this order:
  1. What this is (one paragraph)
  2. What already exists off the shelf, with links: Anthropic Code Review, `/code-review`, `claude-code-action`, `pr-review-toolkit`
  3. Prerequisites: Claude Code installed, `gh` authenticated, a repo where you can add a GitHub Action, an Anthropic API key or `claude setup-token` OAuth token. Optional: Linear API key (AC checker), Bun and a Tailscale account (Channels server).
  4. Quickstart: copy `templates/caller-review.yml`, add a secret, pick a `REVIEW.md` starter, open a PR
  5. Drop-ins: one short section per plugin, marked "coming" until ENG2-1655/1656/1657 land
  6. How updates reach your repo (tag pinning, SHA pinning, Dependabot)

## 7. Test on the public repo

- Test repo: `aowen14/dev-agent-workshop-starter` (public, used in the 9/23 talk). Swap if Alex names another.
- Add `templates/caller-review.yml` as `.github/workflows/review.yml` in the test repo, pinned to `@v1`.
- Add the infra or app `REVIEW.md` starter, whichever fits the repo.
- Open two test PRs:
  1. A normal PR with at least one real, deliberate bug (e.g. an off-by-one or unhandled error) to confirm the review catches it.
  2. A small PR labeled `fyi` to confirm nits are suppressed.
- Leave one of these open as the fixture PR that `ci.yml` targets.

## 8. Acceptance criteria

- [ ] `Teraflop-Inc/review-kit` exists, is public, and has the layout in section 3
- [ ] `review.yml` is a reusable workflow; the test repo adopts it with a caller of about 10 lines and no copied logic
- [ ] Works with `CLAUDE_CODE_OAUTH_TOKEN`; works with `ANTHROPIC_API_KEY`; errors clearly with neither
- [ ] Central base prompt is loaded and the calling repo's `REVIEW.md` is appended; changing the test repo's `REVIEW.md` visibly changes review behavior on the next run
- [ ] `pr-review-toolkit` agents are available inside the action run, or the README documents why not and the working alternative
- [ ] The deliberate-bug PR receives an inline finding on the bug
- [ ] The `fyi`-labeled PR receives no nit-level comments
- [ ] A fork PR skips cleanly with an explanatory comment
- [ ] `v1.0.0` is tagged and `release.yml` moved `v1` to it
- [ ] `ci.yml` runs green against the fixture PR
- [ ] `templates/` contains the three `REVIEW.md` starters, the `fyi` snippet, and the caller workflow
- [ ] `.claude-plugin/marketplace.json` exists with placeholder entries for `ac-check`, `review-retro`, and `pr-channel`
- [ ] README follows section 6 and a person following only the Quickstart gets a review on a fresh repo
- [ ] Final report lists: links to both test PRs, the CI run, the release tag, and anything that deviated from this spec and why

## 9. Constraints

- Work in a branch or worktree. Scoped GitHub token: create repo in `Teraflop-Inc`, push, open PRs, manage Actions secrets on the test repo. No org admin or settings scopes beyond that.
- Do not add org-level required workflows or rulesets.
- All prose (README, templates, comments) follows the house style: no em dashes or en dashes used as punctuation, American English. Rewrite with periods, commas, colons, or parentheses.

## 10. Out of scope

- The AC checker, retro job, and Channels server themselves (ENG2-1656, ENG2-1655, ENG2-1657)
- Anthropic's managed Code Review setup
- Sandboxed or adversarial review
- Org-wide enforcement via rulesets
