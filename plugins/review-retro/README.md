# review-retro

A background job, not a reviewer. It reads the review threads on your last N merged PRs, builds a per-repo knowledge base of recurring issue types (`retro/issues.md`), and opens a PR proposing `REVIEW.md` changes. Every proposed rule cites the PRs that justify it. It never edits `REVIEW.md` on your default branch; a human merges the proposal or doesn't.

## How it works

```
gh API ──> retro/fetch ──> digest.jsonl + meta.json ──> review-retro subagent ──> analysis.json
                (deterministic, no LLM)                     (the only model step)        │
                                                                                        v
             PR from review-retro/<timestamp>  <── retro/propose  <── retro/kb merge ──> retro/issues.md
```

1. **`retro/fetch`** pulls review data through `gh` and writes one compact JSONL record per review thread: `pr`, `pr_title`, `merged_at`, `file`, `line`, `author`, `author_kind` (bot or human), `severity`, `body` (trimmed, badges and bot chrome stripped), `outcome`, `reactions`, `replies`. Human top-level review bodies count as threads too; bot summaries do not. It pages through threads, retries on rate limits, and caps at N PRs.
2. **Outcomes are mechanical** (first match wins):
   - `thumbs_down`: the finding has a 👎 reaction.
   - `fixed`: a commit after the comment's commit changed the flagged lines (or the file, for file-level comments) before merge. Computed from `compare` patches; falls back to GitHub's `isOutdated` when a patch is too large.
   - `resolved_no_change`: resolved, but those lines never changed.
   - `open_at_merge`: unresolved, not fixed, with a reply from someone else.
   - `ignored`: unresolved, not fixed, no reply.
3. **The `review-retro` subagent** reads only the digest and sorts findings into recurring real issues, noise, human-only catches (a human flagged it, no bot did), and stale rules (rules in `REVIEW.md` that never fired). It proposes `add`, `change`, or `remove` rule edits with PR citations.
4. **`retro/kb merge`** folds the analysis into `retro/issues.md`. It is created on the first run and appended on later runs, never rewritten. Counts are distinct threads and dates are PR merge dates, both computed from the digest, so overlapping runs never double count. The machine state is a JSON block at the end of the file.
5. **`retro/propose`** checks that every change cites scanned PRs, applies it to `REVIEW.md` from the default branch, and opens a PR from a new `review-retro/<timestamp>` branch containing `REVIEW.md` and `retro/issues.md`. It refuses to write to any branch that isn't `review-retro/*`. When an older retro PR is still open, the next run carries its knowledge base forward and closes it as superseded, so runs chain without anyone merging.

**Cross-repo:** run it over two or more repos and a second pass looks for patterns that recur across repos. Those are proposed as a PR against review-kit's [`prompts/base-review.md`](../../prompts/base-review.md) instead of each repo's `REVIEW.md`, citing `owner/name#N` from at least two repos. `propose --min-repos 2` drops anything that doesn't.

## Run it locally

```bash
/plugin marketplace add aowen14/review-kit
/plugin install review-retro@review-kit
```

Then, in any directory:

```
/review-retro Teraflop-Inc/teraflop-dev-setup --prs 20 --dry-run
/review-retro Teraflop-Inc/teraflop-dev-setup                 # opens the proposal PR
/review-retro org/repo-a org/repo-b --cross-only             # cross-repo pass only
```

Options: `--prs N` (default 20), `--dry-run` (print the diff and PR body, touch nothing), `--rules-file PATH` (for a repo with no `REVIEW.md` yet, check a candidate rule set such as a review-kit starter for staleness and seed the proposal from it), `--skip-paths 'docs/**,*.lock'`. Working files go to `.retro/` in the current directory.

The scripts also run without Claude, for example to inspect a digest:

```bash
R=~/.claude/plugins/marketplaces/review-kit/plugins/review-retro/retro   # or a review-kit checkout
$R/fetch --repo owner/name --prs 20 --out .retro/owner__name
$R/kb merge --kb retro/issues.md --digest .retro/owner__name --analysis analysis.json
$R/propose --repo owner/name --analysis analysis.json --digest .retro/owner__name --kb retro/issues.md --dry-run
```

Tests: `python3 -m unittest discover plugins/review-retro/tests` (offline, stdlib only).

## Schedule it

**GitHub Actions (recommended).** The mechanics live in review-kit's reusable workflow [`.github/workflows/review-retro.yml`](../../.github/workflows/review-retro.yml). Your repo only adds a caller that owns the schedule, because schedules must live in the calling repo:

```bash
mkdir -p .github/workflows
curl -fsSL https://raw.githubusercontent.com/aowen14/review-kit/v1/plugins/review-retro/templates/caller-review-retro.yml \
  -o .github/workflows/review-retro.yml
```

The caller pins `@v1`. The workflow checks out review-kit at that exact commit and installs the `review-retro` plugin from the kit's marketplace in that checkout, so CI and local runs use the same subagent and command. Inputs: `prs`, `skip_paths`, `rules_file`, `model`, `max_turns`, `auth_method`, `dry_run`. Output: `pr_url`.

Setup in the calling repo:

- Secret: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, as a repo or org secret, passed to the workflow by name as the caller template does. `secrets: inherit` only works when the calling repo and review-kit belong to the same account, organization, or enterprise.
- Settings → Actions → General → enable **Allow GitHub Actions to create and approve pull requests**, or `GITHUB_TOKEN` cannot open the proposal PR. A PR opened by `GITHUB_TOKEN` does not trigger other workflows, so your review workflow will not run on it; that's fine for a rules proposal.

**Local cron or a Claude Code scheduled task.** Use this for the cross-repo pass, which needs a token that can read several repos:

```bash
# crontab: Mondays 07:00
0 7 * * 1 cd ~/retro && claude -p --permission-mode acceptEdits "/review-retro org/repo-a org/repo-b"
```

Or schedule the same prompt as a Claude Code routine (`/schedule`).

## Token scopes

The job reads PRs, review threads, reactions, commit compares, and `REVIEW.md`, then pushes one branch and opens one PR. Nothing needs admin or settings scopes.

| Token | Needs |
|---|---|
| Workflow `GITHUB_TOKEN` | `contents: write` (push the `review-retro/*` branch), `pull-requests: write` (open the PR). Set in the caller. |
| Fine-grained PAT (local or cross-repo) | Per repo: **Contents** read and write, **Pull requests** read and write, **Metadata** read. For a dry run: read-only Contents and Pull requests. |
| Classic PAT | `repo` (private repos) or `public_repo`. |

Branch protection on your default branch keeps working as-is, because the job never pushes there.

## Cost

- **Fetch** costs no tokens. It uses about 2 GraphQL calls per PR plus one `compare` per commit pair where a thread predates the head. 20 PRs cost roughly 25 to 60 API calls, well under rate limits.
- **Analysis** is one subagent pass over the digest. Digests run about 0.5 to 1.5 KB per thread, so 20 PRs usually means 10 to 30 KB of input (roughly 3k to 8k tokens) plus a few thousand output tokens. That's cents per run on Sonnet, and it runs within a subscription when you use an OAuth token.
- The digest is where the savings come from. On Teraflop repos, 20 PRs produced a 10 to 24 KB digest from 78 KB to 3.7 MB of raw API responses (see the ENG2-1655 PR for exact numbers). The model never sees diff hunks or bot chrome.
- Weekly is plenty. Pair the schedule's PR count with your merge rate so consecutive runs overlap a little. The knowledge base deduplicates the overlap.

## Limits

- "Last N merged" is approximated by fetching recently updated merged PRs and sorting by merge time. A PR merged long ago but touched recently can land in the window.
- `fixed` means the flagged lines changed, not that the change addressed the finding.
- Stale rules need a `REVIEW.md` (or `--rules-file`). Without one, that category stays empty.
