#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-openapi.ts --check (AC-351).
#
# Unlike the permissions-doc check (markers inside a hand-authored file),
# docs/spec/openapi.json is entirely generated, so "drift" means the whole
# file differs from a fresh generation. Each case points the generator at
# a fixture path via $OPENAPI_DOC_PATH; the route schemas themselves are
# always read from the real src/server/routes/ — that's the source of
# truth the check protects, not something to fake. Exits 0 when every
# case matches its expected exit code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-openapi-doc.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GENERATOR="$REPO_ROOT/scripts/generate-openapi.ts"

if [[ ! -f "$GENERATOR" ]]; then
  echo "ERROR: $GENERATOR not found." >&2
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

mktmp_dir() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" doc="$3"
  local actual
  (cd "$REPO_ROOT" && OPENAPI_DOC_PATH="$doc" npx --no-install tsx "$GENERATOR" --check) >/dev/null 2>&1
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

echo "Case: freshly generated doc passes --check"
in_sync_dir="$(mktmp_dir)"
in_sync="$in_sync_dir/openapi.json"
(cd "$REPO_ROOT" && OPENAPI_DOC_PATH="$in_sync" npx --no-install tsx "$GENERATOR") >/dev/null 2>&1
if [[ ! -f "$in_sync" ]]; then
  echo "ERROR: generator did not produce $in_sync — cannot continue." >&2
  exit 2
fi
assert_case 0 "in-sync doc" "$in_sync"

echo "Case: hand-edited doc fails --check"
drifted_dir="$(mktmp_dir)"
drifted="$drifted_dir/openapi.json"
cp "$in_sync" "$drifted"
# Mutate a value that only exists because it came out of the generator
# (the published title) — a hand-edit that would silently misrepresent
# the API surface.
sed -i 's/"Projekt-Manager API"/"Hand-Edited API"/' "$drifted"
assert_case 1 "drifted doc" "$drifted"

echo "Case: missing target fails with a toolchain error, not a false pass"
missing_dir="$(mktmp_dir)"
missing="$missing_dir/does-not-exist.json"
assert_case 2 "missing target" "$missing"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
