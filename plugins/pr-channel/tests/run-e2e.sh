#!/usr/bin/env bash
# run-e2e.sh: tests/e2e.test.ts under a hard wall-clock limit.
#
# A PASSING run takes ~3s and exits cleanly. After some FAILING runs, bun sits at
# 100% CPU after teardown and never exits (reproduced by breaking signature
# verification; every test still reports, then the process spins). Not yet
# root-caused: it is not a live child process, and an unref'd exit timer never
# fires, so the event loop itself is blocked. Until it is fixed, a failure must
# still fail fast rather than wedge CI, so this caps the run.
set -uo pipefail
cd "$(dirname "$0")/.."
LIMIT="${E2E_TIMEOUT:-60}"
perl -e "alarm $LIMIT; exec @ARGV" bun test tests/e2e.test.ts
code=$?
if [[ $code -eq 142 ]]; then
  echo "run-e2e: killed after ${LIMIT}s. Treat as a FAILURE; read the (fail) lines above." >&2
  exit 1
fi
exit $code
