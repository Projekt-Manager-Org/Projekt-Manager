#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-error-codes.ts --check (AC-354).
#
# Each case stages a copy of the real docs/spec/api.md in a temp file and
# points the generator at it via $ERROR_CODES_DOC_PATH. ERROR_CODES
# itself is always read from the real src/server/errors.ts — that is the
# source of truth the check protects, not something to fake. Exits 0 when
# every case matches its expectation; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-error-codes.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_DOC="$REPO_ROOT/docs/spec/api.md"
GENERATOR="$REPO_ROOT/scripts/generate-error-codes.ts"

if [[ ! -f "$GENERATOR" ]]; then
  echo "ERROR: $GENERATOR not found." >&2
  exit 2
fi

if [[ ! -f "$REAL_DOC" ]]; then
  echo "ERROR: $REAL_DOC not found." >&2
  exit 2
fi

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

mktmp_doc() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  cp "$REAL_DOC" "$d/api.md"
  echo "$d/api.md"
}

pass=0
fail=0
failures=()

# assert_case <expected-exit> <label> <doc-path> [expected-output-substring]
#
# Two distinct failures exit 2 here — an unreadable target and missing
# markers — so the exit code alone cannot say which one fired, and a case
# could pass because tsx never got as far as reading the document. The
# fourth argument, grepped against the generator's combined output, is
# what makes each case falsifiable — the same pinning
# check-openapi-doc.test.sh and check-api-surface.test.sh apply.
assert_case() {
  local expected="$1" label="$2" doc="$3" pattern="${4:-}"
  local actual output
  output="$(
    cd "$REPO_ROOT" || exit 2
    ERROR_CODES_DOC_PATH="$doc" npx --no-install tsx "$GENERATOR" --check 2>&1
  )"
  actual=$?
  if [[ "$actual" != "$expected" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual")
    echo "  FAIL — $label (expected exit $expected, got $actual)"
    return
  fi
  if [[ -n "$pattern" ]] && ! grep -qF -- "$pattern" <<<"$output"; then
    fail=$((fail + 1))
    failures+=("$label: exit $actual is right, but output does not mention '$pattern'")
    echo "  FAIL — $label (exit $actual, but output does not mention '$pattern')"
    return
  fi
  pass=$((pass + 1))
  echo "  PASS — $label (exit $actual)"
}

echo "Case: in-sync doc (real, already-generated content) passes --check"
assert_case 0 "in-sync doc" "$(mktmp_doc)" "is in sync with ERROR_CODES"

echo "Case: a code deleted from the catalogue fails --check"
# Under-declaring is the failure this AC was written for: METHOD_NOT_ALLOWED
# was on the wire at four route sites and absent from the catalogue, so a
# client had no contract entry for a response it could actually receive.
d="$(mktmp_doc)"
sed -i 's/`METHOD_NOT_ALLOWED`, //' "$d"
assert_case 1 "deleted code" "$d" "is stale"

echo "Case: a code invented inside the markers fails --check"
# The other direction: a catalogue entry no factory can produce promises
# clients a code that never arrives.
d="$(mktmp_doc)"
sed -i 's/`SERVER_ERROR`\./`SERVER_ERROR`, `TELEPORT_FAILED`./' "$d"
assert_case 1 "invented code" "$d" "is stale"

echo "Case: missing markers fails with a toolchain error, not a false pass"
d="$(mktmp_doc)"
sed -i '/GENERATED:error-codes/d' "$d"
assert_case 2 "missing markers" "$d" "markers not found"

echo "Case: prose below the end marker is not overwritten"
# The generated block sits inside §14.4.1, which continues with
# hand-authored per-code prose. Splicing that away would silently delete
# spec content on every regeneration.
d="$(mktmp_doc)"
sed -i 's/^`METHOD_NOT_ALLOWED` (405) is returned by/`METHOD_NOT_ALLOWED` (405) is HAND-EDITED and returned by/' "$d"
assert_case 0 "prose below end marker untouched" "$d" "is in sync with ERROR_CODES"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
