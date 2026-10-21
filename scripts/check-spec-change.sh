#!/usr/bin/env bash
#
# Spec-change declaration gate (#486 F).
#
# The spec changes only for a requirements defect or approved scope
# (CONTRIBUTING.md § Workflow, step 1). A PR touching `docs/spec/**` must
# say which, in its body:
#
#   Spec change: wrong | silent | scope — <one-line reason>
#
#   wrong   the spec states the requirement incorrectly
#   silent  the spec says nothing about an observable behavior
#   scope   approved scope (name the issue)
#
# An implementation defect has no label: its fix is a regression test, not
# spec text. The gate checks that the contract change is declared, not
# that it is true — that is the spec reviewer's job.
#
# Inputs: changed paths on stdin, one per line; the PR body in $PR_BODY.
# Exit 0 = no spec change or valid declaration, 1 = declaration missing,
# 2 = $PR_BODY unset (wiring error).
#
# Usage:
#   printf '%s\n' docs/spec/index.md | PR_BODY="$body" bash scripts/check-spec-change.sh

set -euo pipefail
export LC_ALL=C

if [[ -z "${PR_BODY+set}" ]]; then
  echo "ERROR: PR_BODY is not set." >&2
  exit 2
fi

spec_paths=$(grep -E '^docs/spec/' || true)

if [[ -z "$spec_paths" ]]; then
  echo "✓ No spec change."
  exit 0
fi

# Bodies edited in the GitHub web UI carry \r\n line endings. HTML
# comments are dropped: GitHub hides them, so a reviewer never sees a
# declaration inside one.
if printf '%s\n' "$PR_BODY" | tr -d '\r' | perl -0pe 's/<!--.*?-->//gs' |
  grep -qE '^Spec change: (wrong|silent|scope) (—|-) .*[^[:space:]]'; then
  echo "✓ Spec change declared."
  exit 0
fi

echo "ERROR: this PR changes the spec but declares no reason:" >&2
printf '%s\n' "$spec_paths" | sed 's/^/  /' >&2
cat >&2 <<'EOF'

Add one line to the PR body:

  Spec change: wrong | silent | scope — <one-line reason>

  wrong   the spec states the requirement incorrectly
  silent  the spec says nothing about an observable behavior
  scope   approved scope (name the issue)

An implementation defect needs no spec change — fix it with a failing
regression test (CONTRIBUTING.md § Workflow, step 1).
EOF
exit 1
