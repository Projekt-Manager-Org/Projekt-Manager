#!/usr/bin/env bash
#
# Scenario tests for scripts/generate-api-surface.ts --check (AC-352).
#
# Each case stages a copy of the real ARCHITECTURE.md in a temp file and
# points the generator at it via $API_SURFACE_DOC_PATH. The ROUTES
# themselves are always read from the real src/server/ — that's the
# source of truth the check protects, not something to fake. Exits 0 when
# every case matches its expected exit code; 1 otherwise.
#
# Sibling of check-nav-doc.test.sh, and it inherits that generator's one
# extra case: the prose BELOW the end marker must be free to change. The
# whole reason this table is generated only in part is that § Endpoint
# Notes is hand-written meaning — a check that fired on it would push the
# prose back out of the document.
#
# The two access columns get a case each. They are the ones where a
# stale cell is a claim about who can reach an endpoint, so a silent
# hand-edit there is the failure with teeth.
#
# Usage:
#   bash scripts/__tests__/check-api-surface.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REAL_DOC="$REPO_ROOT/ARCHITECTURE.md"
GENERATOR="$REPO_ROOT/scripts/generate-api-surface.ts"

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
  cp "$REAL_DOC" "$d/ARCHITECTURE.md"
  echo "$d/ARCHITECTURE.md"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" doc="$3"
  local actual
  (cd "$REPO_ROOT" && API_SURFACE_DOC_PATH="$doc" npx --no-install tsx "$GENERATOR" --check) >/dev/null 2>&1
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

echo "Case: a hand-edited Auth cell fails --check"
# The one that matters most: a public endpoint documented as
# session-protected reads as a security property the code does not have.
d="$(mktmp_doc)"
sed -i 's@^| GET .*`/api/health`.*$@| GET | `/api/health` | session | — | none |@' "$d"
assert_case 1 "hand-edited Auth cell" "$d"

echo "Case: a hand-edited Access cell fails --check"
d="$(mktmp_doc)"
sed -i 's/`project:purge`/`project:read`/' "$d"
assert_case 1 "hand-edited Access cell" "$d"

echo "Case: a deleted row inside the markers fails --check"
# Under-documenting an endpoint is the quieter half of the same failure —
# nothing in the rendered page looks wrong. It is also the failure the
# hand-maintained table actually had: 17 of 53 paths absent.
d="$(mktmp_doc)"
sed -i '\@^| GET .*`/api/invoices/years`@d' "$d"
assert_case 1 "deleted row" "$d"

echo "Case: prose below the end marker changes freely"
# Must pass. § Endpoint Notes is hand-written meaning that exists nowhere
# in a route declaration; a check that fired on it would push the prose
# out of the document, which is the outcome this design exists to avoid.
d="$(mktmp_doc)"
sed -i 's|^- `GET /api/health` — probes|- `GET /api/health` — reworded by hand; probes|' "$d"
assert_case 0 "prose edit below markers" "$d"

echo "Case: missing markers fails with a toolchain error, not a false pass"
d="$(mktmp_doc)"
sed -i '/GENERATED:api-surface/d' "$d"
assert_case 2 "missing markers" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
