#!/usr/bin/env bash
#
# Scenario tests for scripts/check-notify-coverage.sh.
#
# notify.yml hooks workflows by NAME. A scheduled workflow missing from
# its `workflows:` list fails red with nobody told — and a scheduled run
# has no PR to sit red on, so nothing else ever surfaces it. #637 adds
# nightly controls whose whole job is to go red; each must reach a human.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-notify-coverage.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK_SCRIPT="$REPO_ROOT/scripts/check-notify-coverage.sh"

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

# $1 = the notify.yml `workflows:` list body, e.g. "[CI, 'Security (scheduled)']"
mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/.github/workflows"
  cat > "$d/.github/workflows/notify.yml" <<EOF
name: Notify
on:
  workflow_run:
    workflows: $1
    types: [completed]
EOF
  echo "$d"
}

# $1 = dir, $2 = file name, $3 = name, $4 = trigger block (YAML under on:)
add_workflow() {
  cat > "$1/.github/workflows/$2" <<EOF
name: $3
on:
$4
jobs: {}
EOF
}

SCHEDULE="  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:"
# The comment mirrors the real tree: notify.yml and ci.yml mention
# schedules in prose without being scheduled.
PR_ONLY="  # not on a schedule: — runs when a PR closes
  pull_request:
    types: [closed]"

pass=0
fail=0
failures=()

assert_case() {
  local expected="$1" label="$2" dir="$3" expect_text="${4:-}"
  local out actual
  out=$(NOTIFY_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" 2>&1)
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

dir="$(mktmp "[CI, 'Security (scheduled)', Inventory scan]")"
add_workflow "$dir" security-scheduled.yml "'Security (scheduled)'" "$SCHEDULE"
add_workflow "$dir" inventory-scan.yaml "Inventory scan" "$SCHEDULE"
assert_case 0 "scheduled workflows listed (quoted/bare names, .yml/.yaml)" "$dir"

dir="$(mktmp "[CI]")"
add_workflow "$dir" inventory-scan.yaml "Inventory scan" "$SCHEDULE"
assert_case 1 "scheduled workflow not listed fails, naming it" "$dir" "Inventory scan"

dir="$(mktmp "[CI]")"
add_workflow "$dir" cache-cleanup.yml "Cache cleanup" "$PR_ONLY"
assert_case 0 "unscheduled workflow need not be listed" "$dir"

# A prefix is not a match: `Inventory` listed does not hook `Inventory scan`.
dir="$(mktmp "[Inventory]")"
add_workflow "$dir" inventory-scan.yml "Inventory scan" "$SCHEDULE"
assert_case 1 "name prefix is not a match" "$dir" "Inventory scan"

# If notify.yml's shape changes the check must not pass vacuously.
dir="$(mktmp "[CI]")"
sed -i '/workflows:/d' "$dir/.github/workflows/notify.yml"
add_workflow "$dir" inventory-scan.yml "Inventory scan" "$SCHEDULE"
assert_case 2 "notify.yml without a workflows: list is an error" "$dir"

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
