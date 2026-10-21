#!/usr/bin/env bash
#
# Scenario tests for scripts/check-traceability.sh.
#
# Each case builds a throwaway git repository — a spec, an exceptions
# file, a test, an e2e spec, a source file — points the check at it via
# $TRACEABILITY_ROOT, mutates one thing, and asserts the exit code.
#
# The must-FAIL cases carry the weight: a reference that resolves to a
# retired or unknown AC is exactly the drift the hand-kept matrix let
# through (AC-255–258 cited by tests long after the spec dropped them).
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-traceability.test.sh

set -u

CHECK="$(cd "$(dirname "$0")/.." && pwd)/check-traceability.sh"

if [[ ! -f "$CHECK" ]]; then
  echo "ERROR: $CHECK not found." >&2
  exit 2
fi

# stage() runs in a `$(…)` subshell, so fixture dirs are recorded in a
# file — an array appended there would never reach the trap.
TMP_LIST="$(mktemp)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  while IFS= read -r d; do
    [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
  done <"$TMP_LIST"
  rm -f "$TMP_LIST"
}
trap cleanup EXIT

# A consistent fixture: every defined AC is covered by a test or listed
# as an exception, and every reference resolves.
#   AC-1 [crit]  — unit test
#   AC-2 [vis]   — e2e spec
#   AC-3 [infra] — exception: infra
#   AC-4 [vis]   — exception: gap
#   AC-5         — retired
stage() {
  local d
  d="$(mktemp -d)"
  echo "$d" >>"$TMP_LIST"
  mkdir -p "$d/docs/spec" "$d/docs/testing" "$d/src/__tests__" "$d/e2e"
  cat >"$d/docs/spec/verification.md" <<'EOF'
# Verification

- **AC-1** `[crit]`: The system persists a project.
- **AC-2** `[vis]`: The board shows nine columns. See [AC-1](#x).
- **AC-3** `[infra]`: The image builds in CI.
- **AC-4** `[vis]`: The card shows its age.
EOF
  cat >"$d/docs/testing/verification-exceptions.md" <<'EOF'
| AC | Status | Verified by / missing |
| --- | --- | --- |
| AC-3 | infra | CI `docker` job |
| AC-4 | gap | needs an e2e with an aged card |
| AC-5 | retired | — |
EOF
  printf "describe('AC-1: persists', () => {});\n" >"$d/src/__tests__/project.test.ts"
  printf "test('AC-2: nine columns', () => {});\n" >"$d/e2e/kanban.spec.ts"
  printf '// Persistence path (AC-1).\n' >"$d/src/project.ts"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}

# Appends a line to a fixture file and stages it.
add_line() {
  local dir="$1" file="$2" line="$3"
  mkdir -p "$(dirname "$dir/$file")"
  printf '%s\n' "$line" >>"$dir/$file"
  git -C "$dir" add "$file" >/dev/null 2>&1
}

pass=0
fail=0
failures=()

# A must-FAIL case also names the finding it expects, so a failure for an
# unrelated reason does not pass it.
assert_case() {
  local expected="$1" label="$2" dir="$3" finding="${4:-}"
  local actual out
  out="$(TRACEABILITY_ROOT="$dir" bash "$CHECK" 2>&1)"
  actual=$?
  if [[ -n "$finding" && "$out" != *"$finding"* ]]; then
    fail=$((fail + 1))
    failures+=("$label: finding '$finding' not reported")
    echo "  FAIL — $label (finding '$finding' not reported)"
  elif [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected, got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

SPEC=docs/spec/verification.md
EXC=docs/testing/verification-exceptions.md

echo "Case: a consistent fixture"
assert_case 0 "baseline fixture" "$(stage)"

echo "Case: a reference that does not resolve"
d="$(stage)"
add_line "$d" src/__tests__/project.test.ts "it('AC-9: unknown', () => {});"
assert_case 1 "test cites an unknown AC" "$d" "project.test.ts: cites unknown AC-9"
d="$(stage)"
add_line "$d" src/project.ts "// see AC-9"
assert_case 1 "code comment cites an unknown AC" "$d" "project.ts: cites unknown AC-9"
d="$(stage)"
add_line "$d" ARCHITECTURE.md "Upload rules: AC-9."
assert_case 1 "doc cites an unknown AC" "$d" "ARCHITECTURE.md: cites unknown AC-9"
d="$(stage)"
add_line "$d" src/project.ts "// superseded behavior, AC-5"
assert_case 1 "code cites a retired AC" "$d" "project.ts: cites retired AC-5"
d="$(stage)"
add_line "$d" src/project.ts "// AC-1a carve-out"
assert_case 1 "suffix reference does not resolve to its base" "$d" "cites unknown AC-1a"
d="$(stage)"
add_line "$d" src/__tests__/project.test.ts "it('AC-5: old behavior', () => {});"
assert_case 1 "test cites a retired AC" "$d" "project.test.ts: cites retired AC-5"
d="$(stage)"
add_line "$d" src/project.ts "// covered by AC-4..AC-6"
assert_case 1 "range spanning a retired AC" "$d" "AC range 'AC-4..AC-6'"
d="$(stage)"
add_line "$d" src/project.ts "// AC-1–3"
assert_case 1 "range with a bare upper bound" "$d" "AC range 'AC-1–3'"

echo "Case: lookalike tokens are not references"
d="$(stage)"
add_line "$d" src/project.ts "// MAC-99 and PAC-12 are not AC IDs"
assert_case 0 "AC- inside a longer word" "$d"
d="$(stage)"
printf '// AC-9\n' >"$d/src/untracked.ts"
assert_case 0 "untracked file is ignored" "$d"

echo "Case: definitions"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-6a** `[crit]`: A suffixed ID.'
assert_case 1 "suffix ID defined" "$d" "malformed definition"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-1** `[crit]`: Defined twice.'
assert_case 1 "duplicate definition" "$d" "AC-1 defined twice"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-6**: No tier marker.'
add_line "$d" src/__tests__/project.test.ts "it('AC-6', () => {});"
assert_case 1 "definition without a tier marker" "$d" "malformed definition"

echo "Case: coverage"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-6** `[crit]`: Nobody tests this.'
assert_case 1 "AC neither tested nor excepted" "$d" "AC-6: cited by no test"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-6** `[crit]`: Only code mentions this.'
add_line "$d" src/project.ts "// AC-6"
assert_case 1 "a code comment is not coverage" "$d" "AC-6: cited by no test"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-6** `[infra]`: A repo scan.'
mkdir -p "$d/scripts/__tests__"
add_line "$d" scripts/__tests__/scan.test.sh "# AC-6"
assert_case 0 "a scripts/__tests__ self-test is coverage" "$d"

echo "Case: exceptions"
d="$(stage)"
git -C "$d" rm --quiet --force "$EXC"
assert_case 1 "exceptions file missing" "$d" "verification-exceptions.md: missing"
d="$(stage)"
mkdir -p "$d/scripts/__tests__"
add_line "$d" scripts/__tests__/image.test.sh "# AC-3"
assert_case 1 "infra row for an AC a test now covers" "$d" "AC-3 is 'infra' but a test cites it"
d="$(stage)"
add_line "$d" e2e/kanban.spec.ts "test('AC-4: age', () => {});"
assert_case 1 "gap row for an AC a test now covers" "$d" "AC-4 is 'gap' but a test cites it"
d="$(stage)"
add_line "$d" "$EXC" "| AC-1 | infra | not really |"
assert_case 1 "infra row for a non-infra AC" "$d" "AC-1 is 'infra' but not a defined [infra] AC"
d="$(stage)"
add_line "$d" "$EXC" "| AC-1 | retired | — |"
assert_case 1 "retired row for a defined AC" "$d" "AC-1 is 'retired' but still defined"
d="$(stage)"
add_line "$d" "$EXC" "| AC-9 | gap | needs a test |"
assert_case 1 "gap row for an undefined AC" "$d" "AC-9 is 'gap' but not defined"
d="$(stage)"
add_line "$d" "$EXC" "| AC-4 | gap | listed twice |"
assert_case 1 "duplicate exception row" "$d" "AC-4 listed twice"
d="$(stage)"
add_line "$d" "$EXC" "| AC-6 | later | unknown status |"
assert_case 1 "unknown exception status" "$d" "unknown status 'later'"

echo "Case: numbering"
d="$(stage)"
add_line "$d" "$SPEC" '- **AC-7** `[crit]`: Skips AC-6.'
add_line "$d" src/__tests__/project.test.ts "it('AC-7', () => {});"
assert_case 1 "a free number below the highest ID" "$d" "AC-6: neither defined nor retired"
d="$(stage)"
add_line "$d" "$EXC" "| AC-6 | retired | — |"
add_line "$d" "$SPEC" '- **AC-7** `[crit]`: Follows a retired number.'
add_line "$d" src/__tests__/project.test.ts "it('AC-7', () => {});"
assert_case 0 "a retired number below the highest ID" "$d"

echo
echo "Passed: $pass, failed: $fail"
if ((fail > 0)); then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
