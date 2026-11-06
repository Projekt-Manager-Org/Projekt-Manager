#!/usr/bin/env bash
#
# deploy.sh's check that CI passed the target commit (#740): its push run on
# main is green, which means its images were scanned at that exact commit. A
# read-only look at the public API: no token, 60 requests an hour.
#
# Batch-intermediate, evicted and feature-branch commits have no push run of
# their own, so they need the override. A commit whose push run is red, or an
# API that does not answer, is refused too: the override is the way past it.
#
# Open ci-red issues only warn: a red nightly flags an advisory against what
# main already runs, and blocking would stop the fix without reducing exposure.
#
# Usage: deploy-ci-gate.sh <sha> [<override reason>]
#
# EXIT CODES
#   0  green, or overridden and logged
#   1  refused
#   2  bad usage

set -euo pipefail

if (($# < 1 || $# > 2)) || [[ -z "$1" ]]; then
  echo "usage: deploy-ci-gate.sh <sha> [<override reason>]" >&2
  exit 2
fi
sha="$1"
reason="${2:-}"
api='https://api.github.com/repos/Projekt-Manager-Org/Projekt-Manager'

get() { curl -fsS --max-time 20 --retry 2 --retry-all-errors "$api/$1"; }

# The filter is repeated on the answer: a query the API ignored must not pass.
# shellcheck disable=SC2016  # jq program, not a shell expansion
if ! verdict=$(get "actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=1" \
  | jq -re --arg sha "$sha" '
      .workflow_runs
      | map(select(.head_sha == $sha and .head_branch == "main" and .event == "push"))
      | if length == 0 then "no push run on main for this commit"
        elif .[0].status != "completed" then "its push run has not finished: \(.[0].html_url)"
        elif .[0].conclusion == "success" then "green"
        else "its push run concluded \(.[0].conclusion): \(.[0].html_url)" end'); then
  verdict='could not read its push run from the GitHub API'
fi

# shellcheck disable=SC2016  # jq program, not a shell expansion
if red=$(get 'issues?state=open&labels=ci-red&per_page=100' | jq -r '.[] | "  \(.title): \(.html_url)"'); then
  if [[ -n "$red" ]]; then
    printf 'WARNING: open ci-red issues, check they do not concern this deploy:\n%s\n' "$red" >&2
  fi
else
  echo 'WARNING: could not read the open ci-red issues.' >&2
fi

if [[ "$verdict" == green ]]; then
  echo "CI: the push run of $sha is green."
  exit 0
fi

if [[ -z "$reason" ]]; then
  echo "ERROR: deploy of $sha refused: $verdict." >&2
  echo "An emergency, or a commit with no push run of its own: --accept-red-ci <reason>." >&2
  exit 1
fi

who="${SUDO_USER:-$(id -un)}"
if ! logger -t projekt-manager-deploy "OVERRIDE by $who of $sha ($verdict): $reason"; then
  echo "ERROR: deploy of $sha refused: could not log the override." >&2
  exit 1
fi
echo "OVERRIDE: deploying $sha although $verdict. Logged: $reason" >&2
