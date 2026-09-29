---
description: Check a PR against its Linear issue's acceptance criteria and post (or update) one report comment
argument-hint: <pr-url | owner/repo#N | N> [LINEAR-ID] [--linear-comment] [--dry-run] | --evaluate-only <work-dir>
allowed-tools: Bash, Read, Write, Grep, Glob
---

Run the acceptance criteria check for: $ARGUMENTS

`A=${CLAUDE_PLUGIN_ROOT}/ac` holds the deterministic tools. Your only judgment step is step 3. This is report only: never change the Linear issue's status, fields, description, or checkboxes, and never use Linear tools to write anything. `ac/post` makes the only writes (the PR comment, plus a Linear comment with `--linear-comment`).

If the arguments are `--evaluate-only <dir>` (CI mode), `ac/prepare` has already run: do only step 3 on that dir, then stop.

1. Prepare: `"$A/prepare" <pr> [--issue <LINEAR-ID>] --out .ac-check/<owner>__<name>-<N>`. Pass the Linear ID only if the user gave one. It prints a JSON summary.
   - Exit 3 means `LINEAR_API_KEY` is unset. If you have a Linear tool that reads issues (for example the Linear MCP `get_issue`), read the `need_issue` identifier with it, write `{"identifier", "title", "url", "description"}` (description verbatim) to `<out>/issue.json`, and rerun prepare with `--issue-json <out>/issue.json` (and the same `--issue` if one was given). Otherwise stop and tell the user to set `LINEAR_API_KEY`.
   - Exit 4 means no Linear issue was found. Report the message and stop.
2. If the summary shows `"criteria": 0`, skip to step 4. The issue has no ACs and `ac/post` says so.
3. Evaluate: read `${CLAUDE_PLUGIN_ROOT}/prompts/evaluate.md` and follow it for the work dir. Read the code in the summary's `repo_dir` and write `<out>/verdicts.json`.
4. Post: `"$A/post" <out> [--linear-comment] [--dry-run]`. If it reports downgrades or dropped evidence, fix `verdicts.json` only when you cited a wrong path or line, then rerun post. Rerunning edits the same comment.

Finish with the tally, the comment URL (or the dry-run body), and the criteria that are not met.
