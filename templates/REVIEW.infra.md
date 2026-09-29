# Review rules: infra, scripts, and install tooling

## What Important means here
- A script that can destroy data or state without an explicit guard (`rm -rf` on a variable, force pushes, dropping resources).
- Install and setup scripts that are not idempotent, or that assume a previously configured machine (existing dirs, env vars, logged-in CLIs, prior runs).
- Secrets written to logs, committed files, or world-readable paths.
- Permissions, IAM, or network rules broader than the change needs.
- A failure that is swallowed so the script reports success anyway.

## Nits
- At most five. Skip them if there is any Important finding.

## Skip
- Lockfiles, vendored code, and generated manifests.
- Style that `shellcheck`, formatters, or CI already enforce.

## Always check
- Shell scripts use `set -euo pipefail` (or equivalent) and quote variables.
- Running the script twice in a row is safe, and running it on a fresh machine works.
- Version pins: new tools and actions are pinned, not floating on `latest`.
