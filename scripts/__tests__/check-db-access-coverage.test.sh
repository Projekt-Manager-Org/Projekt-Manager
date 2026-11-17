#!/usr/bin/env bash
#
# Scenario tests for scripts/check-db-access-coverage.mjs (#939).
#
# Each case writes a changed copy of eslint.config.js next to the original
# (so its relative imports resolve), runs the check against it with
# --config, and removes it on exit. A case whose edit does not apply fails
# instead of passing on an unchanged config.
#
# Usage:
#   bash scripts/__tests__/check-db-access-coverage.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-db-access-coverage.mjs"
CONFIG="$REPO_ROOT/eslint.config.js"
PROBE="$REPO_ROOT/eslint.config.__coverage_probe__.js"
MTS_FIXTURE="$REPO_ROOT/src/server/services/__coverage_fixture__.mts"

for f in "$CHECK" "$CONFIG"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found." >&2
    exit 1
  fi
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$PROBE" "$MTS_FIXTURE"' EXIT

pass=0
fail=0
failures=()

# assert_exit <label> <exit> [args...]; with EXPECT set, the output must
# also name it, so a case fails for the reason it tests.
assert_exit() {
  local label="$1" expected="$2"
  shift 2
  local actual
  node "$CHECK" "$@" >"$TMP/out.log" 2>&1
  actual=$?
  if [[ "$actual" == "$expected" ]] && { [[ -z "${EXPECT:-}" ]] || grep -qF -- "$EXPECT" "$TMP/out.log"; }; then
    pass=$((pass + 1))
    echo "  PASS — $label (exit $actual)"
  else
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected${EXPECT:+ naming '$EXPECT'}, got $actual")
    echo "  FAIL — $label (expected exit $expected${EXPECT:+ naming '$EXPECT'}, got $actual)"
    sed 's/^/    | /' "$TMP/out.log"
  fi
}

# probe <label> <node expression on `s`, the config source>: writes the
# changed config, or records a failure if the expression changed nothing.
probe() {
  local label="$1" edit="$2"
  node -e '
    const fs = require("fs");
    const [src, out, edit] = process.argv.slice(1);
    const before = fs.readFileSync(src, "utf8");
    const after = new Function("s", `return (${edit});`)(before);
    if (after === before) process.exit(3);
    fs.writeFileSync(out, after);
  ' "$CONFIG" "$PROBE" "$edit"
  if [[ $? -ne 0 ]]; then
    fail=$((fail + 1))
    failures+=("$label: the config edit did not apply")
    echo "  FAIL — $label (the config edit did not apply)"
    return 1
  fi
}

echo "Case: the repository's config"
assert_exit "real config" 0

echo "Case: a service added to the rule's ignores"
probe "extra ignore" "s.replace(\"'src/server/services/ephemeralPg.ts',\", \"'src/server/services/ephemeralPg.ts',\n      'src/server/services/ImportService.ts',\")" &&
  EXPECT='src/server/services/ImportService.ts:' assert_exit "extra ignore" 1 --config "$PROBE"

echo "Case: a service ignored globally"
probe "global ignore" "s.replace('export default tseslint.config(', \"export default tseslint.config(\n  { ignores: ['src/server/services/ImportService.ts'] },\")" &&
  EXPECT='src/server/services/ImportService.ts:' assert_exit "global ignore" 1 --config "$PROBE"

echo "Case: services get the repositories' options"
probe "queries: false" "s.replace(\"files: ['src/server/repositories/**/*.ts'],\", \"files: ['src/server/{repositories,services}/**/*.ts'],\")" &&
  EXPECT='src/server/services/ImportService.ts:' assert_exit "queries: false" 1 --config "$PROBE"

echo "Case: a table added to the allowed constants"
probe "allow a table" "s.replace(\"const SCHEMA_CONSTANTS = ['AUDIT_ENTITY_TYPES',\", \"const SCHEMA_CONSTANTS = ['customers', 'AUDIT_ENTITY_TYPES',\")" &&
  EXPECT='src/server/services/ImportService.ts:' assert_exit "allow a table" 1 --config "$PROBE"

echo "Case: the rule downgraded to a warning"
probe "warn" "s.replace(\"'local/no-direct-db-access': ['error', { allow: SCHEMA_CONSTANTS }]\", \"'local/no-direct-db-access': ['warn', { allow: SCHEMA_CONSTANTS }]\")" &&
  EXPECT='src/server/services/ImportService.ts:' assert_exit "warn" 1 --config "$PROBE"

echo "Case: a named exemption that no longer applies"
probe "stale exemption" "s.replace(\"      'src/server/health.ts',\n\", '')" &&
  EXPECT='src/server/health.ts:' assert_exit "stale exemption" 1 --config "$PROBE"

echo "Case: a source file the rule's glob misses"
: >"$MTS_FIXTURE"
EXPECT='__coverage_fixture__.mts:' assert_exit "a .mts service" 1
rm -f "$MTS_FIXTURE"

echo "Case: usage errors"
EXPECT='does not exist' assert_exit "missing --config file" 2 --config "$TMP/nope.js"
EXPECT='Usage:' assert_exit "unknown argument" 2 --frobnicate

echo
echo "Results: $pass passed, $fail failed"
if [[ $fail -gt 0 ]]; then
  printf '  - %s\n' "${failures[@]}"
  exit 1
fi
