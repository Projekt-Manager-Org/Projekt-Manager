#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-permissions-doc.ts --check (AC-343).
#
# Each case stages a copy of the real docs/spec/api.md in a temp file and
# points the generator at it via $PERMISSIONS_DOC_PATH. ROLE_PERMISSIONS
# itself is always read from the real src/config/permissions.ts — that's
# the source of truth the check protects, not something to fake. Exits 0
# when every case matches its expected exit code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-permissions-doc.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_DOC="$REPO_ROOT/docs/spec/api.md"
GENERATOR="$REPO_ROOT/scripts/generate-permissions-doc.ts"

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

assert_case() {
  local expected="$1" label="$2" doc="$3"
  local actual
  (cd "$REPO_ROOT" && PERMISSIONS_DOC_PATH="$doc" npx --no-install tsx "$GENERATOR" --check) >/dev/null 2>&1
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

echo "Case: in-sync doc (real, already-generated content) passes --check"
in_sync="$(mktmp_doc)"
assert_case 0 "in-sync doc" "$in_sync"

echo "Case: hand-edited row inside markers fails --check"
drifted="$(mktmp_doc)"
# Delete the owner row entirely — a hand-edit that would silently
# under-document a role's grants. Robust to permission-ordering choices
# inside the generator (doesn't depend on which permission is listed
# where), only on the table's row-per-role shape.
sed -i '/^| owner /d' "$drifted"
assert_case 1 "drifted table" "$drifted"

echo "Case: missing markers fails with a toolchain error, not a false pass"
no_markers="$(mktmp_doc)"
sed -i '/GENERATED:permissions-table/d' "$no_markers"
assert_case 2 "missing markers" "$no_markers"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
