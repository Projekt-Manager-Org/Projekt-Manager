#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-nav-doc.ts --check (AC-349).
#
# Each case stages a copy of the real docs/spec/ui/index.md in a temp file
# and points the generator at it via $NAV_DOC_PATH. `ROUTE_DEFINITIONS`
# itself is always read from the real src/config/routes.ts — that's the
# source of truth the check protects, not something to fake. Exits 0 when
# every case matches its expected exit code; 1 otherwise.
#
# Sibling of check-permissions-doc.test.sh, with one case that generator
# does not need: the prose BELOW the end marker must be free to change.
# The whole reason this table is generated only in part is that the
# per-view notes are hand-written spec intent — a check that fired on
# them would force the prose back out of the document.
#
# Usage:
#   bash scripts/__tests__/check-nav-doc.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_DOC="$REPO_ROOT/docs/spec/ui/index.md"
GENERATOR="$REPO_ROOT/scripts/generate-nav-doc.ts"

for f in "$GENERATOR" "$REAL_DOC"; do
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

mktmp_doc() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  cp "$REAL_DOC" "$d/index.md"
  echo "$d/index.md"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" doc="$3"
  local actual
  (cd "$REPO_ROOT" && NAV_DOC_PATH="$doc" npx --no-install tsx "$GENERATOR" --check) >/dev/null 2>&1
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
assert_case 0 "in-sync doc" "$(mktmp_doc)"

echo "Case: a hand-edited access rule inside the markers fails --check"
# The regression this check exists for: #289 found the bookkeeper landing
# view documented as Projekte while the code said Rechnungen.
d="$(mktmp_doc)"
sed -i 's/`invoice:read`/`project:read`/' "$d"
assert_case 1 "hand-edited access rule" "$d"

echo "Case: a deleted row inside the markers fails --check"
# Under-documenting a view is the quieter half of the same failure —
# nothing in the rendered page looks wrong.
d="$(mktmp_doc)"
sed -i '/^| `benachrichtigungen` /d' "$d"
assert_case 1 "deleted row" "$d"

echo "Case: a hand-edited landing column fails --check"
d="$(mktmp_doc)"
sed -i 's/| bookkeeper *|$/| — |/' "$d"
assert_case 1 "hand-edited landing column" "$d"

echo "Case: prose below the end marker changes freely"
# Must pass. The per-view notes are hand-written spec intent that exists
# nowhere in the code; a check that fired on them would push the prose
# out of the document, which is the outcome this design exists to avoid.
d="$(mktmp_doc)"
sed -i 's|^- \*\*"Meine Projekte"\*\* —|- **"Meine Projekte"** — reworded by hand;|' "$d"
assert_case 0 "prose edit below markers" "$d"

echo "Case: missing markers fails with a toolchain error, not a false pass"
d="$(mktmp_doc)"
sed -i '/GENERATED:nav-matrix/d' "$d"
assert_case 2 "missing markers" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
