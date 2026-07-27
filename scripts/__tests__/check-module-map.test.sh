#!/usr/bin/env bash
#
# Scenario tests for scripts/check-module-map.sh (AC-350).
#
# A coverage check that cannot fail is worse than no check. Each case
# stages a fixture repository — a small source tree plus a synthetic
# ARCHITECTURE.md — and points the check at it via $MODULE_MAP_ROOT.
#
# The ratchet cases matter most. A baseline that never shrinks is a
# permanent exemption list wearing a burn-down costume, so "an entry that
# is documented now must fail" gets the same weight as "an undocumented
# file must fail".
#
# Exits 0 when every case matches its expected code; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-module-map.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-module-map.sh"

if [[ ! -f "$CHECK" ]]; then
  echo "ERROR: $CHECK not found." >&2
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

# Fixture: two source files under a gated directory, one under a
# directory with no subsection (must stay unchecked), and a doc that
# names only the first.
stage() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/src/server/services" "$d/src/ungated" "$d/scripts"
  : >"$d/src/server/services/AlphaService.ts"
  : >"$d/src/server/services/BetaService.ts"
  : >"$d/src/ungated/Whatever.ts"
  cat >"$d/ARCHITECTURE.md" <<'DOC'
## Module Map

| Directory              | Owns   | Must NOT |
| ---------------------- | ------ | -------- |
| `src/server/services/` | Things | Nothing  |
| `src/ungated/`         | Things | Nothing  |

### Directory Detail

#### `src/server/services/`

- `AlphaService.ts` — the documented one

### Configuration Files

Nothing here.
DOC
  : >"$d/scripts/module-map-baseline.txt"
  git -C "$d" init --quiet
  git -C "$d" add -A >/dev/null 2>&1
  echo "$d"
}

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3"
  local actual
  MODULE_MAP_ROOT="$dir" bash "$CHECK" >/dev/null 2>&1
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

echo "Case: the real repository passes its own check"
assert_case 0 "real repository covered" "$REPO_ROOT"

echo "Case: an undocumented file in a gated directory"
# The regression this check exists for — #306's invoices subsystem was
# exactly this, at scale.
assert_case 1 "undocumented file" "$(stage)"

echo "Case: the same file, recorded in the baseline"
# Must pass. The ratchet freezes the existing backlog so new files are
# gated from day one.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
assert_case 0 "baselined file" "$d"

echo "Case: a NEW undocumented file alongside a baselined one"
# Must fail. This is the whole point of a ratchet: the frozen set does
# not shelter files added after it.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
: >"$d/src/server/services/GammaService.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 1 "new file beside a baselined one" "$d"

echo "Case: a baseline entry that is documented now"
# Must fail. Without this the baseline never shrinks and the burn-down
# is invisible.
d="$(stage)"
echo "src/server/services/AlphaService.ts" >"$d/scripts/module-map-baseline.txt"
assert_case 1 "stale baseline — file documented" "$d"

echo "Case: a baseline entry whose file was deleted"
# Same ratchet, other direction.
d="$(stage)"
printf 'src/server/services/BetaService.ts\nsrc/server/services/Gone.ts\n' >"$d/scripts/module-map-baseline.txt"
assert_case 1 "stale baseline — file deleted" "$d"

echo "Case: a directory with no Directory Detail subsection"
# Must pass. Coverage is opt-in by subsection: `src/ungated/` is
# documented at table level only and carries no per-file obligation.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
: >"$d/src/ungated/Another.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 0 "ungated directory ignored" "$d"

echo "Case: adding a subsection opts the directory in"
# Must fail. The doc's own structure is the configuration — writing a
# `#### <dir>` heading is the act of accepting per-file coverage.
# Inserted INSIDE the Directory Detail block: the block ends at the next
# `### ` heading, so a subsection appended past it is out of scope.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
sed -i 's|^### Configuration Files$|#### `src/ungated/`\n\nNo files named here.\n\n### Configuration Files|' "$d/ARCHITECTURE.md"
assert_case 1 "new subsection gates its directory" "$d"

echo "Case: a subsection past the end of the Directory Detail block"
# Must pass — and this is a boundary, not a loophole: a `#### <dir>`
# heading under some later `### ` section is not part of the Directory
# Detail structure and gates nothing.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
printf '\n#### `src/ungated/`\n\nNo files named here.\n' >>"$d/ARCHITECTURE.md"
assert_case 0 "subsection outside the Detail block" "$d"

echo "Case: tests and nested directories are out of scope"
# Must pass. `__tests__/` is not architecture, and a nested directory
# opts in through its own subsection rather than its parent's.
d="$(stage)"
echo "src/server/services/BetaService.ts" >"$d/scripts/module-map-baseline.txt"
mkdir -p "$d/src/server/services/__tests__" "$d/src/server/services/nested"
: >"$d/src/server/services/__tests__/AlphaService.test.ts"
: >"$d/src/server/services/nested/Deep.ts"
git -C "$d" add -A >/dev/null 2>&1
assert_case 0 "tests and nested dirs out of scope" "$d"

echo "Case: --update-baseline makes a failing tree pass"
d="$(stage)"
MODULE_MAP_ROOT="$d" bash "$CHECK" --update-baseline >/dev/null 2>&1
assert_case 0 "regenerated baseline" "$d"

echo "Case: the Directory Detail block is missing"
# Structural, not drift. Without a dedicated code the run would gate
# nothing and report green over an empty scan.
d="$(stage)"
sed -i '/^### Directory Detail$/d; /^#### /d' "$d/ARCHITECTURE.md"
assert_case 2 "missing Directory Detail block" "$d"

echo "Case: ARCHITECTURE.md is missing entirely"
d="$(stage)"
rm "$d/ARCHITECTURE.md"
assert_case 2 "missing document" "$d"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
