#!/usr/bin/env bash
#
# Scenario tests for scripts/check-spec-change.sh.
#
# Each case feeds a changed-path list on stdin and a PR body via $PR_BODY,
# then asserts the exit code. The must-FAIL cases carry the weight: a gate
# that waves an undeclared spec change through is the defect #486 exists
# to stop.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-spec-change.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-spec-change.sh"

if [[ ! -f "$CHECK" ]]; then
  echo "ERROR: $CHECK not found." >&2
  exit 2
fi

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" paths="$3" body="$4"
  local actual
  printf '%s' "$paths" | PR_BODY="$body" bash "$CHECK" >/dev/null 2>&1
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

SPEC=$'src/server/app.ts\ndocs/spec/verification.md\n'
NO_SPEC=$'src/server/app.ts\ndocs/adr/0001-x.md\nARCHITECTURE.md\n'

echo "Case: no spec file touched"
assert_case 0 "no spec change, empty body" "$NO_SPEC" ""
assert_case 0 "no changed paths at all" "" ""

echo "Case: a path that only resembles the spec"
# A sibling `docs/spec-old/` and a `spec/` dir elsewhere are not the spec.
assert_case 0 "docs/spec-old/ is not docs/spec/" $'docs/spec-old/x.md\n' ""
assert_case 0 "src/spec/ is not docs/spec/" $'src/spec/x.ts\n' ""

echo "Case: spec touched, valid declaration"
for label in wrong silent scope; do
  assert_case 0 "label '$label' with em dash" "$SPEC" "Spec change: $label — the upload AC contradicts ADR-0024"
done
assert_case 0 "hyphen separator" "$SPEC" "Spec change: scope - #486"
assert_case 0 "declaration amid other body text" "$SPEC" $'## Summary\n\nDoes things.\n\nSpec change: silent — export never stated the order\n\nCloses #1'
assert_case 0 "nested spec file" $'docs/spec/ui/index.md\n' "Spec change: scope — #486"

echo "Case: CRLF line endings"
# Bodies edited in the GitHub web UI arrive with \r\n. A trailing \r must
# not turn a valid declaration into a failure.
assert_case 0 "valid declaration with CRLF" "$SPEC" $'Intro\r\nSpec change: wrong — typo in an AC\r\nmore\r\n'

echo "Case: spec touched, declaration missing or malformed"
assert_case 1 "empty body" "$SPEC" ""
assert_case 1 "body without declaration" "$SPEC" "Fixes the attachment upload."
assert_case 1 "retired label 'cleanup'" "$SPEC" "Spec change: cleanup — dedupe two ACs"
assert_case 1 "unknown label" "$SPEC" "Spec change: minor — small tweak"
assert_case 1 "label without reason" "$SPEC" "Spec change: scope"
assert_case 1 "label with empty reason" "$SPEC" "Spec change: scope — "
assert_case 1 "label case differs" "$SPEC" "Spec change: Scope — #486"
assert_case 1 "declaration not at line start" "$SPEC" "See: Spec change: scope — #486"
assert_case 1 "label glued to more text" "$SPEC" "Spec change: scoped — #486"

echo "Case: declaration inside an HTML comment"
# GitHub hides comments when rendering the body; a reviewer never sees it.
assert_case 1 "inside a multi-line comment" "$SPEC" $'Intro\n<!--\nSpec change: scope — #486\n-->\n'
assert_case 0 "visible after a comment" "$SPEC" $'<!-- template hint -->\nSpec change: scope — #486\n'

echo "Case: PR_BODY unset is a wiring error, not a pass"
printf '%s' "$SPEC" | env -u PR_BODY bash "$CHECK" >/dev/null 2>&1
actual=$?
if [[ "$actual" == 2 ]]; then
  pass=$((pass + 1))
  echo "  PASS — PR_BODY unset (exit 2)"
else
  fail=$((fail + 1))
  failures+=("PR_BODY unset: expected 2, got $actual")
  echo "  FAIL — PR_BODY unset (expected 2, got $actual)"
fi

echo
echo "Passed: $pass, failed: $fail"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
