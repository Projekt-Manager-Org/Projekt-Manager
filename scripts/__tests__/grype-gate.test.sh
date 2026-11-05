#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/grype-gate.sh (#724).
#
# The gate reads a Grype JSON report and fails on every match not rated
# Negligible, Low or Medium: HIGH, CRITICAL and unrated alike. Unrated
# comes two ways, `"severity": "Unknown"` and no `severity` field at all
# (Grype's model marks it `omitempty`), so each has its own case.
#
# Reports follow Grype's JSON document shape (grype/presenter/models,
# v0.121.0): `matches[]`, and `ignoredMatches[]` for what .grype.yaml
# suppressed.
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/grype-gate.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/ci/grype-gate.sh"

if ! command -v jq > /dev/null 2>&1; then
  echo "ERROR: jq is required." >&2
  exit 2
fi
if [[ ! -f "$GATE" ]]; then
  echo "ERROR: $GATE not found." >&2
  exit 2
fi

TMP_ROOT="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# One match; $1 is its severity, `-` for no severity field.
match() {
  jq -n --arg sev "$1" '{
    vulnerability: ({id: "GHSA-test-\($sev)"} + (if $sev == "-" then {} else {severity: $sev} end)),
    artifact: {name: "golang.org/x/net", version: "v0.60.0", locations: [{path: "/usr/bin/caddy"}]}
  }'
}

# report <matches-json-array> [<ignoredMatches-json-array>]
report() {
  local f="$TMP_ROOT/report-$RANDOM.json"
  jq -n --argjson m "$1" --argjson i "${2:-[]}" '{matches: $m, ignoredMatches: $i}' > "$f"
  echo "$f"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" file="$3"
  local actual
  bash "$GATE" "$file" > "$TMP_ROOT/out" 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
    sed 's/^/    /' "$TMP_ROOT/out"
  fi
}

echo "Case: no matches"
assert_case 0 "empty report" "$(report '[]')"

echo "Case: Negligible, Low and Medium pass"
assert_case 0 "below the floor" "$(report "[$(match Negligible),$(match Low),$(match Medium)]")"

for sev in High Critical Unknown -; do
  echo "Case: severity '$sev' fails"
  assert_case 1 "severity $sev" "$(report "[$(match Low),$(match "$sev")]")"
done

echo "Case: a failing match is named"
bash "$GATE" "$(report "[$(match -)]")" > "$TMP_ROOT/out" 2>&1
if grep -q 'GHSA-test--' "$TMP_ROOT/out" && grep -q '/usr/bin/caddy' "$TMP_ROOT/out"; then
  pass=$((pass + 1))
  echo "  PASS — id and location in output"
else
  fail=$((fail + 1))
  failures+=("failing match not named in output")
  echo "  FAIL — id and location missing from output"
  sed 's/^/    /' "$TMP_ROOT/out"
fi

echo "Case: an allowlisted High (ignoredMatches) passes"
assert_case 0 "ignored High" "$(report '[]' "[$(match High)]")"

echo "Case: unreadable report fails closed"
echo 'not json' > "$TMP_ROOT/garbage.json"
assert_case 2 "not JSON" "$TMP_ROOT/garbage.json"
echo '{}' > "$TMP_ROOT/nomatches.json"
assert_case 2 "no matches array" "$TMP_ROOT/nomatches.json"
assert_case 2 "missing file" "$TMP_ROOT/absent.json"

echo
echo "Result: $pass passed, $fail failed"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
