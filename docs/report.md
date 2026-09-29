# Final report: base PR review workflow (docs/spec.md)

Date: 2026-09-29. Release: [`v1.0.0`](https://github.com/aowen14/review-kit/tree/v1.0.0), with floating `v1` at the same commit (`811e73d`).

## Links

| Item | Link |
|---|---|
| Repo | https://github.com/aowen14/review-kit |
| Deliberate-bug PR (CI fixture, left open) | https://github.com/aowen14/dev-agent-workshop-starter/pull/2 |
| `fyi`-labeled PR | https://github.com/aowen14/dev-agent-workshop-starter/pull/3 |
| Fork PR | https://github.com/aowen14/dev-agent-workshop-starter/pull/4 |
| Fresh-repo Quickstart PR | https://github.com/aowen14/review-kit-quickstart/pull/1 |
| CI on `main` (push run, waits on the dispatched review) | https://github.com/aowen14/review-kit/actions/runs/36520614134 |
| CI dispatched review run (green) | https://github.com/aowen14/review-kit/actions/runs/36520619485 |
| Release run that moved `v1` | https://github.com/aowen14/review-kit/actions/runs/36520736376 |
| Test repo run pinned to `@v1` | https://github.com/aowen14/dev-agent-workshop-starter/actions/runs/36520828501 |

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| Repo exists, public, section 3 layout | Pass | Lives at `aowen14/review-kit` (see deviation 1) |
| Reusable workflow; test repo adopts it with a short caller | Pass | 14-line caller, identical to `templates/caller-review.yml` |
| Works with `CLAUDE_CODE_OAUTH_TOKEN` | Pass | All review runs above |
| Works with `ANTHROPIC_API_KEY` | Not tested live | See deviation 7 |
| Errors clearly with neither | Pass | [test repo run](https://github.com/aowen14/dev-agent-workshop-starter/actions/runs/36516850497), [credential-check](https://github.com/aowen14/review-kit/actions/runs/36520702686) |
| Base prompt loaded, `REVIEW.md` appended, a change is visible | Pass | Adding a "frontend types must track API changes" rule to the test repo's `REVIEW.md` produced a new, fourth Important finding on #2 that cites the rule |
| `pr-review-toolkit` agents available | Pass | Installed through the action's `plugins` / `plugin_marketplaces` inputs. The CI dry run reports all six agents in the Task tool |
| Deliberate-bug PR gets an inline finding on the bug | Pass | Inline Important on `src/database.py:64`: off-by-one, fix `(page - 1) * page_size` |
| `fyi` PR gets no nit comments | Pass | Zero nit comments across four runs. The only finding is a real Important one (the change breaks `tests/test_health.py`) |
| Fork PR skips cleanly with a comment | Pass | Both runs succeed; #4 has the explanatory comment |
| `v1.0.0` tagged, `release.yml` moved `v1` | Pass | `v1` and `v1.0.0` both resolve to `811e73d` |
| `ci.yml` green against the fixture PR | Pass | Asserts an Important finding on `src/database.py` |
| `templates/` complete | Pass | Three `REVIEW.md` starters, `fyi` snippet, caller workflow |
| `marketplace.json` with three placeholders | Pass | Not installed for real (see deviation 10) |
| README follows section 6; Quickstart works on a fresh repo | Pass | Followed word for word on `aowen14/review-kit-quickstart`; the review caught a planted `median` bug |

## Deviations from the spec, and why

1. **Repo owner is `aowen14`, not `Teraflop-Inc`.** Alex asked to move it after creation. It was transferred, not recreated, so history is intact and GitHub redirects the old URL. Agents that cloned the old URL should run `git remote set-url origin https://github.com/aowen14/review-kit.git`.
2. **The caller also listens on `pull_request_target`**, for fork-PR notices only. Under `pull_request`, fork PRs get a read-only token, so the review job cannot comment. The `fork-notice` job never checks out or runs PR code and uses no secrets. The review itself only runs on `pull_request`. This makes the caller 14 lines instead of about 10.
3. **`ci.yml` is a dry run and re-dispatches itself.** review-kit's `GITHUB_TOKEN` cannot write to the test repo, so CI returns findings as structured output and asserts on them instead of posting. `claude-code-action` rejects `push` events, so a push to `main` dispatches the workflow as `workflow_dispatch` on the same commit and waits for it. The dispatched run is started by `github-actions[bot]`, which the action blocks by default, so that bot is allowlisted, but only when `dry_run` is true.
4. **Extra workflow `credential-check.yml`.** The "no secrets must fail" check is manual and separate, because a failing called workflow cannot be marked continue-on-error and would turn every CI run red.
5. **No Claude GitHub App, no `id-token: write`.** The action runs with the workflow's `GITHUB_TOKEN`, so comments post as `github-actions[bot]`. Permissions are `contents: read` and `pull-requests: write`.
6. **`REVIEW.md` is read from the base branch**, so a PR cannot loosen its own review rules. The PR that first adds `REVIEW.md` uses its own copy.
7. **`ANTHROPIC_API_KEY` not tested live.** Alex chose not to spend API credits. The code path differs only in which secret is passed to the action; selection is covered by the `auth_method` input (`auto`, `oauth`, `api_key`).
8. **Re-running an old run does not pick up newly added secrets.** A fresh push does. Documented in the README's troubleshooting section.
9. **Direct commits to `main`:** the spec commit and the skeleton (requested early so other agents could branch), plus one CI fix (`2e3261d`) that should have gone through a branch. Everything else went through PRs [#1](https://github.com/aowen14/review-kit/pull/1) and [#2](https://github.com/aowen14/review-kit/pull/2).
10. **Marketplace not installed for real.** The placeholder plugin dirs contain only a README, so `/plugin marketplace add` has not been verified. Alex decided this is fine for the workshop.
11. **`fyi` mode is enforced by the prompt, not mechanically.** The workflow tells Claude to post Important findings only. It does not filter comments after the fact. This held on every `fyi` run.
12. **Secrets were placeholders in the task.** Alex set them with `gh secret set`. No keys were read from shell profiles.

## Left behind, for cleanup

- Test repo PRs #2 (fixture, keep open), #3 and #4 (open, usable as session demos).
- The test repo's `REVIEW.md` keeps the extra frontend-types rule used for the before/after test.
- `aowen14/review-kit-quickstart` (public) and a fork of the workshop repo on the second GitHub account.
