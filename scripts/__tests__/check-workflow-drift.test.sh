#!/usr/bin/env bash
#
# Scenario tests for scripts/check-workflow-drift.sh.
#
# A drift check that cannot fail is worse than no check: it reports green
# forever and everyone stops reading it. Each case below stages copies of
# the REAL workflows in a temp dir, points the check at them via
# $CI_WORKFLOW / $E2E_WORKFLOW, and asserts the exit code — including the
# cases that must NOT fail, since a check that fires on prose would get
# muted the first time someone edits a comment.
#
# The compared block gets: a real-regression case, a second field class to
# prove the whole block is covered, a comment-only case that must pass, and
# the structural cases (block gone, key renamed, block duplicated).
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-workflow-drift.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-workflow-drift.sh"
REAL_CI="$REPO_ROOT/.github/workflows/ci.yml"
REAL_E2E="$REPO_ROOT/.github/workflows/e2e.yml"

for f in "$CHECK" "$REAL_CI" "$REAL_E2E"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found." >&2
    exit 2
  fi
done

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

# A fresh pair of copies per case, so a mutation cannot leak sideways.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  cp "$REAL_CI" "$d/ci.yml"
  cp "$REAL_E2E" "$d/e2e.yml"
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  CI_WORKFLOW="$dir/ci.yml" E2E_WORKFLOW="$dir/e2e.yml" bash "$CHECK" >/dev/null 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

echo "Case: the real workflows are in sync"
assert_case 0 "in-sync workflows" "$(stage)"

echo "Case: health probe reverted to the unix socket in one file only"
# The regression this check exists for. `-h 127.0.0.1` was added to both
# files in one PR; dropping it from one leaves that job racing the
# entrypoint's init-phase temporary server.
d="$(stage)"
sed -i 's/pg_isready -h 127\.0\.0\.1 -U pm -d pm/pg_isready -U pm -d pm/' "$d/e2e.yml"
assert_case 1 "drifted health probe" "$d"

echo "Case: image major bumped in one file only"
# A different field class from the case above — proves the comparison
# covers the whole block, not just the options string. A Postgres major
# mismatch between the two jobs means one suite validates against a
# server the other never sees.
d="$(stage)"
sed -i 's/postgres:17-alpine/postgres:16-alpine/' "$d/e2e.yml"
assert_case 1 "drifted image tag" "$d"

echo "Case: comments differ, configuration does not"
# Must pass. The two files explain the block in their own terms and
# always will; a check that fires on that would be muted within a week.
d="$(stage)"
sed -i 's|^        ports:|        # An extra note that exists in only one of the two files.\n        ports:|' "$d/e2e.yml"
assert_case 0 "comment-only difference" "$d"

echo "Case: the postgres service is gone from one file"
# Structural, not drift. Without a dedicated code the extractor would
# return an empty block, string equality against a non-empty one would
# fail, and the run would exit 1 — the right code for the wrong reason,
# reported as "these drifted" when the truth is "one of them is gone".
d="$(stage)"
sed -i '/^      postgres:$/d' "$d/e2e.yml"
assert_case 2 "missing postgres service" "$d"

echo "Case: the services: key itself was renamed"
# The other structural guard, and the only case that reaches it: the
# count guard above sees `postgres:` and is satisfied, so the empty
# extraction is what has to catch this. Stands in for any future change
# to how workflows declare service containers — the check must stop and
# say so rather than compare two empty strings and report "in sync".
d="$(stage)"
sed -i 's/^    services:$/    service-containers:/' "$d/e2e.yml"
assert_case 2 "renamed services key" "$d"

echo "Case: a second postgres service makes the pair ambiguous"
# The extractor takes the first block. A second one must stop the run
# rather than let it compare a pair nobody chose.
d="$(stage)"
sed -i 's/^      postgres:$/      postgres:\n      postgres-replica:\n        image: postgres:17-alpine\n      postgres:/' "$d/e2e.yml"
assert_case 2 "two postgres services" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
