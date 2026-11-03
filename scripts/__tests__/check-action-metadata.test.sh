#!/usr/bin/env bash
#
# Scenario tests for scripts/check-action-metadata.sh.
#
# The runner evaluates `${{ }}` in a composite action's metadata strings
# too: upload-findings quoted `if: ${{ !cancelled() }}` in its description
# and every step using it failed to load (#736). actionlint reads an
# action.yml only for its inputs, so nothing else catches it before a run.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-action-metadata.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK_SCRIPT="$REPO_ROOT/scripts/check-action-metadata.sh"

if [[ ! -f "$CHECK_SCRIPT" ]]; then
  echo "ERROR: $CHECK_SCRIPT not found." >&2
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

mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/.github/actions"
  echo "$d"
}

# $1 = dir, $2 = action name, $3 = action.yml body
add_action() {
  mkdir -p "$1/.github/actions/$2"
  printf '%s\n' "$3" > "$1/.github/actions/$2/action.yml"
}

# Expressions where the runner evaluates them: an input's default, an
# output's value, a step.
CLEAN="name: Clean
description: >
  Uploads findings. Call it with !cancelled() as its condition.
inputs:
  label:
    description: Names the artifact.
    required: true
  token:
    description: Token for the upload.
    default: \${{ github.token }}
outputs:
  digest:
    description: The pushed digest.
    value: \${{ steps.push.outputs.digest }}
runs:
  using: composite
  steps:
    - id: push
      if: \${{ !cancelled() }}
      shell: bash
      run: echo \"\${{ inputs.label }}\""

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3" expect_text="${4:-}"
  local out actual
  out=$(ACTION_METADATA_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" 2>&1)
  actual=$?
  if [[ "$actual" != "$expected" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual; output:"$'\n'"$out")
    echo "  FAIL — $label"
    return
  fi
  if [[ -n "$expect_text" ]] && ! grep -qF "$expect_text" <<<"$out"; then
    fail=$((fail + 1))
    failures+=("$label: expected '$expect_text' in output; got:"$'\n'"$out")
    echo "  FAIL — $label"
    return
  fi
  pass=$((pass + 1))
  echo "  PASS — $label"
}

dir="$(mktmp)"
add_action "$dir" clean "$CLEAN"
assert_case 0 "expressions only in output values and steps" "$dir"

# The #736 shape: a folded description quoting a step condition.
dir="$(mktmp)"
add_action "$dir" upload-findings "name: Upload findings
description: >
  Run this last, with
  \`if: \${{ !cancelled() }}\`, as a step.
runs:
  using: composite
  steps: []"
assert_case 1 "expression in the description fails, naming file and field" "$dir" \
  "upload-findings/action.yml: description"

dir="$(mktmp)"
add_action "$dir" a "name: Build \${{ inputs.x }}
description: Builds.
runs:
  using: composite
  steps: []"
assert_case 1 "expression in the name fails" "$dir" "a/action.yml: name"

dir="$(mktmp)"
add_action "$dir" a "name: A
description: A.
author: \${{ github.actor }}
runs:
  using: composite
  steps: []"
assert_case 1 "expression in the author fails" "$dir" "a/action.yml: author"

dir="$(mktmp)"
add_action "$dir" a "name: A
description: A.
inputs:
  dir:
    description: Defaults to \${{ runner.temp }}.
runs:
  using: composite
  steps: []"
assert_case 1 "expression in an input description fails" "$dir" "a/action.yml: inputs.dir.description"

dir="$(mktmp)"
add_action "$dir" a "name: A
description: A.
outputs:
  digest:
    description: \${{ steps.push.outputs.digest }}
    value: x
runs:
  using: composite
  steps: []"
assert_case 1 "expression in an output description fails" "$dir" "a/action.yml: outputs.digest.description"

# Every offending action is reported, not only the first.
dir="$(mktmp)"
add_action "$dir" clean "$CLEAN"
add_action "$dir" one "name: \${{ x }}
runs: {using: composite, steps: []}"
add_action "$dir" two "name: Two
description: \${{ y }}
runs: {using: composite, steps: []}"
assert_case 1 "reports the first offending action" "$dir" "one/action.yml: name"
assert_case 1 "reports the second offending action" "$dir" "two/action.yml: description"

# No action.yml found means the glob or the layout moved: not a pass.
dir="$(mktmp)"
assert_case 2 "no action.yml at all is an error" "$dir"

dir="$(mktmp)"
add_action "$dir" a "name: [unclosed"
assert_case 2 "unparseable action.yml is an error" "$dir"

echo ""
echo "-------------------------------------------------------------"
echo "  Passed: $pass"
echo "  Failed: $fail"
if [[ "$fail" -gt 0 ]]; then
  for f in "${failures[@]}"; do
    echo "    - $f"
  done
  exit 1
fi
echo "All cases passed."
exit 0
