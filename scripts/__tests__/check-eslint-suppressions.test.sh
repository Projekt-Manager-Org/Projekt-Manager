#!/usr/bin/env bash
#
# Scenario tests for scripts/check-eslint-suppressions.sh (#939).
#
# Each way of growing the baseline (see the script's header) gets a case.
#
# Each case builds a throwaway project root (SUPPRESSIONS_PROJECT_ROOT)
# holding the suppressions file, the files its entries name, and
# optionally a base copy in a separate --base-dir.
#
# Usage:
#   bash scripts/__tests__/check-eslint-suppressions.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-eslint-suppressions.sh"
RULE='local/no-direct-db-access'

if [[ ! -f "$CHECK" ]]; then
  echo "ERROR: $CHECK not found." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
failures=()

# A fresh project root with two source files the entries can name.
new_root() {
  local root="$TMP/$1"
  mkdir -p "$root/src/server/services" "$root/base"
  : >"$root/src/server/services/A.ts"
  : >"$root/src/server/services/B.ts"
  echo "$root"
}

# suppressions <file> <path>=<count>[:<rule>] ...
suppressions() {
  local out="$1"
  shift
  node -e '
    const [out, rule, ...entries] = process.argv.slice(1);
    const data = {};
    for (const e of entries) {
      const [path, rest] = e.split("=");
      const [count, r] = rest.split(":");
      data[path] ??= {};
      data[path][r || rule] = { count: Number(count) };
    }
    require("fs").writeFileSync(out, JSON.stringify(data, null, 2));
  ' "$out" "$RULE" "$@"
}

assert_case() {
  local label="$1" expected="$2" root="$3"
  shift 3
  local actual
  SUPPRESSIONS_PROJECT_ROOT="$root" bash "$CHECK" "$@" >"$TMP/out.log" 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual")
    echo "  FAIL — $label (expected exit $expected, got $actual)"
    sed 's/^/    | /' "$TMP/out.log"
  fi
}

echo "Case: no suppressions file at the head or the base"
R="$(new_root none)"
assert_case "no file, no base" 0 "$R" --base-dir "$R/base"

echo "Case: unchanged against the base"
R="$(new_root same)"
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=3 src/server/services/B.ts=1
cp "$R/eslint-suppressions.json" "$R/base/"
assert_case "same entries and counts" 0 "$R" --base-dir "$R/base"

echo "Case: paid down against the base"
R="$(new_root shrunk)"
suppressions "$R/base/eslint-suppressions.json" src/server/services/A.ts=3 src/server/services/B.ts=1
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=2
assert_case "lower count, entry removed" 0 "$R" --base-dir "$R/base"

echo "Case: a count goes up"
R="$(new_root raised)"
suppressions "$R/base/eslint-suppressions.json" src/server/services/A.ts=3
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=4
assert_case "higher count" 1 "$R" --base-dir "$R/base"

echo "Case: a new path appears"
R="$(new_root added)"
suppressions "$R/base/eslint-suppressions.json" src/server/services/A.ts=3
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=3 src/server/services/B.ts=1
assert_case "new entry" 1 "$R" --base-dir "$R/base"

echo "Case: a rename moves an entry to a new path"
# The total stays the same, but the entry under the new path is new: the
# policy is to move the file's queries out before renaming it.
R="$(new_root renamed)"
suppressions "$R/base/eslint-suppressions.json" src/server/services/A.ts=3
suppressions "$R/eslint-suppressions.json" src/server/services/B.ts=3
assert_case "same total under a new path" 1 "$R" --base-dir "$R/base"

echo "Case: an entry for another rule"
# `--suppress-all` freezes every rule's violations, not only the
# burn-down's. Fails even when the base already carries it.
R="$(new_root other-rule)"
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=1:no-restricted-imports
cp "$R/eslint-suppressions.json" "$R/base/"
assert_case "other rule, present at the base too" 1 "$R" --base-dir "$R/base"

echo "Case: an entry for a file that no longer exists"
# ESLint checks suppressions only for files it lints, so this entry would
# never be reported as unused — and would hand its allowance to any later
# file at that path.
R="$(new_root deleted)"
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=1 src/server/services/Gone.ts=2
cp "$R/eslint-suppressions.json" "$R/base/"
assert_case "stale path, present at the base too" 1 "$R" --base-dir "$R/base"

echo "Case: no base file (the change that creates the baseline)"
R="$(new_root bootstrap)"
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=3
assert_case "file created" 0 "$R" --base-dir "$R/base"

echo "Case: the file is removed while the base has it"
# Without this, the bootstrap allowance above would recur: delete the file
# in one change, recreate it with fresh entries in the next. The burn-down
# ends with the file holding {}, never with the file gone.
R="$(new_root removed)"
suppressions "$R/base/eslint-suppressions.json" src/server/services/A.ts=3
assert_case "file deleted" 1 "$R" --base-dir "$R/base"
R="$(new_root removed-empty)"
echo '{}' >"$R/base/eslint-suppressions.json"
assert_case "empty file deleted" 1 "$R" --base-dir "$R/base"

echo "Case: the burn-down's end state"
R="$(new_root end-state)"
suppressions "$R/base/eslint-suppressions.json" src/server/services/A.ts=1
echo '{}' >"$R/eslint-suppressions.json"
assert_case "last entry paid down to {}" 0 "$R" --base-dir "$R/base"
R="$(new_root regrow)"
echo '{}' >"$R/base/eslint-suppressions.json"
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=1
assert_case "an entry after {}" 1 "$R" --base-dir "$R/base"

echo "Case: without --base-dir only the file itself is checked"
R="$(new_root local-ok)"
suppressions "$R/eslint-suppressions.json" src/server/services/A.ts=3
assert_case "valid file" 0 "$R"
R="$(new_root local-bad)"
suppressions "$R/eslint-suppressions.json" src/server/services/Gone.ts=1
assert_case "stale path" 1 "$R"

echo "Case: inline disables of the rule or its guard"
# Lint refuses a comment disabling the rule, but one that also disables the
# guard silences the refusal; this check is the layer outside ESLint.
R="$(new_root disable-both)"
echo '/* eslint-disable @eslint-community/eslint-comments/no-restricted-disable, local/no-direct-db-access */' \
  >"$R/src/server/services/A.ts"
assert_case "rule and guard disabled together" 1 "$R"
R="$(new_root disable-next-line)"
echo '// eslint-disable-next-line local/no-direct-db-access' >"$R/src/server/services/A.ts"
assert_case "rule disabled for one line" 1 "$R"
R="$(new_root config-off)"
echo '/* eslint local/no-direct-db-access: off */' >"$R/src/server/services/A.ts"
assert_case "rule turned off by a config comment" 1 "$R"
R="$(new_root guard-off)"
printf '%s\n' \
  '/* eslint @eslint-community/eslint-comments/no-unlimited-disable: off */' \
  '/* eslint-disable */' >"$R/src/server/services/A.ts"
assert_case "guard turned off, then everything disabled" 1 "$R"
R="$(new_root multi-line)"
printf '%s\n' \
  '/* eslint-disable' \
  '   @eslint-community/eslint-comments/no-restricted-disable,' \
  '   local/no-direct-db-access */' >"$R/src/server/services/A.ts"
assert_case "rule and guard disabled over several lines" 1 "$R"
R="$(new_root audit-gate-off)"
mkdir -p "$R/src/server/repositories"
echo '/* eslint local/audit-write-gate: off */' >"$R/src/server/repositories/A.ts"
assert_case "the audit write gate turned off by a config comment" 1 "$R"
R="$(new_root disable-other)"
echo '// eslint-disable-next-line no-restricted-syntax' >"$R/src/server/services/A.ts"
assert_case "an unrelated rule disabled" 0 "$R"
R="$(new_root disable-in-tests)"
mkdir -p "$R/src/server/services/__tests__"
echo '/* eslint-disable local/no-direct-db-access */' >"$R/src/server/services/__tests__/A.test.ts"
assert_case "a disable inside tests" 0 "$R"

echo "Case: unreadable input fails closed"
R="$(new_root malformed)"
echo '{ not json' >"$R/eslint-suppressions.json"
assert_case "malformed JSON" 1 "$R" --base-dir "$R/base"
R="$(new_root no-base-dir)"
assert_case "--base-dir does not exist" 2 "$R" --base-dir "$R/missing"
assert_case "--base-dir without a value" 2 "$R" --base-dir

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
