---
description: Mine past PR review threads into retro/issues.md and open a PR proposing REVIEW.md changes
argument-hint: <owner/repo> [owner/repo ...] [--prs N] [--dry-run] [--cross-only] [--rules-file PATH] [--skip-paths GLOBS] | --analyze-only <digest-dir>
allowed-tools: Bash, Read, Write, Task
---

Run the review retro for: $ARGUMENTS

`R=${CLAUDE_PLUGIN_ROOT}/retro` holds the deterministic tools. The only judgment step is the `review-retro` subagent. Do not edit `REVIEW.md` yourself and never push to a default branch; `retro/propose` opens the PR.

If the arguments are `--analyze-only <dir>` (CI mode), the digest and knowledge base (`<dir>/issues.md`, if any) are already in place: only run the subagent from step 2 on that dir, writing `<dir>/analysis.json`, then stop.

For each repo (default `--prs 20`):

1. Fetch: `"$R/fetch" --repo <repo> --prs <N> --out .retro/<owner>__<name> [--rules-file ...] [--skip-paths ...]`. If it reports 0 records, say so and skip the repo.
2. Analyze: pull the existing knowledge base first with `"$R/kb" pull --repo <repo> --out .retro/<owner>__<name>/issues.md`. Then use the Task tool with `subagent_type: review-retro` and a prompt naming the digest dir, the knowledge base path if it exists, and the output path `.retro/<owner>__<name>/analysis.json`. Do not paste the digest into the prompt.
3. Merge: `"$R/kb" merge --kb .retro/<owner>__<name>/issues.md --digest .retro/<owner>__<name> --analysis .retro/<owner>__<name>/analysis.json`.
4. Propose: `"$R/propose" --repo <repo> --analysis .retro/<owner>__<name>/analysis.json --digest .retro/<owner>__<name> --kb .retro/<owner>__<name>/issues.md [--base-file <rules-file>] [--dry-run]`.

With `--cross-only`, skip step 4 (no per-repo PRs) and go straight to the cross-repo pass.

If two or more repos were run, do a cross-repo pass: use the Task tool with `subagent_type: review-retro` in cross-repo mode over all the `.retro/*` dirs and their `issues.md`, writing `.retro/cross-analysis.json` with PRs cited as `owner/name#N`. Then run `"$R/propose" --repo aowen14/review-kit --file prompts/base-review.md --analysis .retro/cross-analysis.json --min-repos 2 [--dry-run]`.

Finish with a short report: records and outcomes per repo, clusters per category, the PR links (or the dry-run diffs), and any clusters or changes the tools dropped.
