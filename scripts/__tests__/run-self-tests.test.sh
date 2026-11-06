#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/run-self-tests.sh, the one CI step behind every
# script self-test. If it fails open, none of them protects anything.
#
# Exits 0 when every case holds; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/run-self-tests.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$REPO_ROOT/scripts/ci/run-self-tests.sh"

if [[ ! -f "$RUNNER" ]]; then
  echo "ERROR: $RUNNER not found." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  echo "  PASS — $1"
}
ko() {
  fail=$((fail + 1))
  echo "  FAIL — $1"
  sed 's/^/    /' "$TMP_ROOT/out"
}

# fixture <dir> <name> <body>: a self-test that also records that it ran.
fixture() {
  mkdir -p "$1"
  printf 'touch "%s/%s.ran"\n%s\n' "$1" "$2" "$3" > "$1/$2.test.sh"
}

# run <dir>: the runner's exit code; its output lands in $TMP_ROOT/out.
run() {
  bash "$RUNNER" "$1" > "$TMP_ROOT/out" 2>&1
  echo $?
}

echo "Case: every test passing is green"
d="$TMP_ROOT/green"
fixture "$d" a 'exit 0'
fixture "$d" b 'exit 0'
[[ "$(run "$d")" == 0 ]] && ok "exit 0" || ko "exit 0"
[[ -f "$d/a.ran" && -f "$d/b.ran" ]] && ok "both ran" || ko "both ran"

echo "Case: a failure is red, named, and stops nothing"
d="$TMP_ROOT/red"
fixture "$d" a 'exit 1'
fixture "$d" b 'exit 0'
fixture "$d" c 'exit 2'
[[ "$(run "$d")" == 1 ]] && ok "exit 1" || ko "exit 1"
[[ -f "$d/b.ran" && -f "$d/c.ran" ]] && ok "later tests still ran" || ko "later tests still ran"
grep -qxF '::error::a.test.sh failed (exit 1)' "$TMP_ROOT/out" && ok "names the first failure" || ko "names the first failure"
grep -qxF '::error::c.test.sh failed (exit 2)' "$TMP_ROOT/out" && ok "names the second failure" || ko "names the second failure"
grep -q '^::error::b.test.sh' "$TMP_ROOT/out" && ko "does not name a pass" || ok "does not name a pass"

echo "Case: nothing to run is not a pass"
mkdir -p "$TMP_ROOT/empty"
[[ "$(run "$TMP_ROOT/empty")" == 2 ]] && ok "empty directory" || ko "empty directory"
[[ "$(run "$TMP_ROOT/absent")" == 2 ]] && ok "missing directory" || ko "missing directory"

echo
echo "Result: $pass passed, $fail failed"
((fail == 0))
