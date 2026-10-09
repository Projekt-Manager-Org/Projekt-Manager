#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-baseline.ts --check (#488).
#
# The check exists so that a baseline missing its hand-written parts, or
# with a hand edit in the drizzle-generated part, fails CI instead of
# reaching a database. A string comparison fails open in ways the CI step
# alone cannot see (wrong target read, expected built from the target),
# so each drift case below must turn the check red.
#
# Every case points the generator at a fixture via $BASELINE_PATH; the
# schema and the hand-written parts are always the real ones. Exits 0
# when every case matches its expected exit code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-baseline.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GENERATOR="$REPO_ROOT/scripts/generate-baseline.ts"

if [[ ! -f "$GENERATOR" ]]; then
  echo "ERROR: $GENERATOR not found." >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass=0
fail=0
failures=()

run_generator() {
  (cd "$REPO_ROOT" && BASELINE_PATH="$1" npx --no-install tsx "$GENERATOR" "${@:2}" 2>&1)
}

# assert_check <expected-exit> <label> <baseline-path>
assert_check() {
  local expected="$1" label="$2" baseline="$3"
  local actual
  run_generator "$baseline" --check >/dev/null
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual")
  fi
}

# mutate <sed-script> <out> — a fixture identical to the in-sync one would
# make its drift case pass vacuously, so a stale sed pattern is an error.
mutate() {
  sed "$1" "$in_sync" >"$2"
  if cmp -s "$in_sync" "$2"; then
    echo "ERROR: sed '$1' no longer changes the baseline — update the fixture." >&2
    exit 1
  fi
}

in_sync="$TMP_DIR/in-sync.sql"
if ! run_generator "$in_sync" >/dev/null || [[ ! -s "$in_sync" ]]; then
  echo "ERROR: generator failed to write the in-sync fixture." >&2
  exit 1
fi

echo "Case: a freshly written baseline passes"
assert_check 0 "in sync" "$in_sync"

echo "Case: a baseline missing a hand-written tail part fails"
# The issue's failure mode: a regen that forgets to re-splice the tail.
missed_tail="$TMP_DIR/missed-tail.sql"
mutate '/CREATE OR REPLACE FUNCTION company_profile_block_delete_fn/,$d' "$missed_tail"
assert_check 1 "missed tail" "$missed_tail"

echo "Case: a hand edit of the generated part fails"
hand_edit="$TMP_DIR/hand-edit.sql"
mutate 's/"label" text NOT NULL/"label" varchar NOT NULL/' "$hand_edit"
assert_check 1 "hand-edited generated part" "$hand_edit"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
