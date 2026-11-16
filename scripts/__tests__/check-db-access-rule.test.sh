#!/usr/bin/env bash
#
# Scenario tests for the wiring of `local/no-direct-db-access` in
# eslint.config.js (#939): which files the rule covers, that its named
# exemptions are load-bearing, and that inline disables fail lint.
#
# The rule's own logic is unit-tested in
# eslint-rules/__tests__/no-direct-db-access.test.mjs. What a unit test
# cannot see is the config: a widened `ignores:` or a mistyped `files:`
# glob fails open — lint stays green and direct queries land unnoticed.
#
# ESLint reads the repo's eslint-suppressions.json on its own, which would
# hide a violation that sits in the baseline. Every run here points it at an
# empty suppressions file instead, so only the config decides.
#
# Fixtures are written under src/server/ (the rule is scoped by path, so a
# fixture elsewhere would prove nothing) and removed on exit. Assertions
# count this rule's messages only.
#
# Usage:
#   bash scripts/__tests__/check-db-access-rule.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RULE='local/no-direct-db-access'
# The rule, or the guard that refuses inline comments disabling it.
GUARDED='^(local/no-direct-db-access|@eslint-community/eslint-comments/.+)$'
SERVICE_FIXTURE="$REPO_ROOT/src/server/services/__db_access_fixture__.ts"
SERVICE_COPY="$REPO_ROOT/src/server/services/__db_access_fixture_ephemeral__.ts"
ROOT_COPY="$REPO_ROOT/src/server/__db_access_fixture_health__.ts"
REPO_FIXTURE="$REPO_ROOT/src/server/repositories/__db_access_fixture__.ts"
DB_FIXTURE="$REPO_ROOT/src/server/db/__db_access_fixture__.ts"
TEST_FIXTURE="$REPO_ROOT/src/server/services/__tests__/__db_access_fixture__.ts"
HEALTH="$REPO_ROOT/src/server/health.ts"
EPHEMERAL="$REPO_ROOT/src/server/services/ephemeralPg.ts"

if [[ ! -f "$REPO_ROOT/eslint.config.js" ]]; then
  echo "ERROR: eslint.config.js not found." >&2
  exit 2
fi
for f in "$HEALTH" "$EPHEMERAL"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found — cannot check its named exemption." >&2
    exit 2
  fi
done

TMP="$(mktemp -d)"
EMPTY_SUPPRESSIONS="$TMP/eslint-suppressions.json"
echo '{}' >"$EMPTY_SUPPRESSIONS"

cleanup() {
  rm -f "$SERVICE_FIXTURE" "$SERVICE_COPY" "$ROOT_COPY" "$REPO_FIXTURE" "$DB_FIXTURE" "$TEST_FIXTURE"
  rm -rf "$TMP"
}
trap cleanup EXIT
# A crashed earlier run could have left fixtures behind; they would be
# linted as real source by every later run.
rm -f "$SERVICE_FIXTURE" "$SERVICE_COPY" "$ROOT_COPY" "$REPO_FIXTURE" "$DB_FIXTURE" "$TEST_FIXTURE"
mkdir -p "$(dirname "$TEST_FIXTURE")" || exit 2

pass=0
fail=0
failures=()

# Count of messages ESLint reports for one file whose rule matches the
# regex (default: exactly this rule). Prints `ERR`
# when ESLint produced no parseable JSON, or reported a fatal or
# rule-not-found message, so a broken invocation fails a case instead of
# reading as zero.
count_violations() {
  local file="$1" pattern="${2:-^${RULE}\$}"
  (cd "$REPO_ROOT" &&
    npx --no-install eslint --no-warn-ignored --suppressions-location "$EMPTY_SUPPRESSIONS" \
      -f json "$file" 2>/dev/null) |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const report = JSON.parse(s);
          const fatal = report.some((f) =>
            f.messages.some((m) => m.fatal || /could not find|not found/i.test(m.message)),
          );
          if (fatal) throw new Error("rule or parse failure");
          console.log(
            report.reduce(
              (n, f) => n + f.messages.filter((m) => new RegExp(process.argv[1]).test(m.ruleId ?? "")).length,
              0,
            ),
          );
        } catch {
          console.log("ERR");
        }
      });
    ' "$pattern"
}

record() {
  local ok="$1" label="$2" detail="$3"
  if [[ "$ok" == yes ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label ($detail)"
  else
    fail=$((fail + 1))
    failures+=("$label: $detail")
    echo "  FAIL — $label ($detail)"
  fi
}

# Exact count.
assert_case() {
  local expected="$1" label="$2" file="$3" actual
  actual="$(count_violations "$file")"
  [[ "$actual" == "$expected" ]] && ok=yes || ok=no
  record "$ok" "$label" "expected $expected, got $actual violation(s)"
}

# At least one — for copies of real files, whose exact count is theirs, and
# for inline disables, which the rule or its guard may report.
assert_caught() {
  local label="$1" file="$2" pattern="${3:-}" actual
  actual="$(count_violations "$file" ${pattern:+"$pattern"})"
  [[ "$actual" =~ ^[0-9]+$ && "$actual" -gt 0 ]] && ok=yes || ok=no
  record "$ok" "$label" "expected >0, got $actual violation(s)"
}

QUERY_BODY="import { users } from '../db/schema.js';
import type { Database } from '../db/connection.js';
export function all(db: Database) {
  return db.select().from(users);
}"

# --- Covered: the mistake the rule exists for -----------------------------

echo "Case: a direct query in a service is caught"
printf '%s\n' "$QUERY_BODY" >"$SERVICE_FIXTURE"
assert_case 1 "table reference in services/" "$SERVICE_FIXTURE"

echo "Case: a new module in db/ is caught"
# db/ is exempt file by file (schema, connection, ...), not as a directory:
# a query module dropped there would otherwise pass unseen.
printf '%s\n' "$QUERY_BODY" | sed "s#'\.\./db/#'./#" >"$DB_FIXTURE"
assert_case 1 "table reference in a new db/ module" "$DB_FIXTURE"

# --- Quiet: places the rule must not fire ---------------------------------

echo "Case: a repository may query"
printf '%s\n' "$QUERY_BODY" >"$REPO_FIXTURE"
assert_case 0 "query in repositories/" "$REPO_FIXTURE"

echo "Case: a repository may not re-export a table"
printf '%s\n' "export { users } from '../db/schema.js';" >"$REPO_FIXTURE"
assert_case 1 "table re-export from repositories/" "$REPO_FIXTURE"

echo "Case: tests are exempt"
printf '%s\n' "$QUERY_BODY" | sed "s#'\.\./db/#'../../db/#" >"$TEST_FIXTURE"
assert_case 0 "test file in services/__tests__/" "$TEST_FIXTURE"

# --- Inline disables --------------------------------------------------------
# Each form must still fail lint. Why: the guard block in eslint.config.js.

echo "Case: inline disables do not bypass the rule"
for directive in \
  '// eslint-disable-next-line local/no-direct-db-access' \
  '/* eslint-disable local/no-direct-db-access */' \
  '/* eslint-disable */'; do
  {
    printf '%s\n' "import { users } from '../db/schema.js';"
    printf '%s\n' "import type { Database } from '../db/connection.js';"
    printf '%s\n' "export function all(db: Database) {"
    printf '%s\n' "  $directive"
    printf '%s\n' "  return db.select().from(users);"
    printf '%s\n' "}"
  } >"$SERVICE_FIXTURE"
  assert_caught "$directive" "$SERVICE_FIXTURE" "$GUARDED"
done

# --- The named exemptions --------------------------------------------------
# Each exempt file is quiet as committed, and the same code one file over is
# caught: otherwise the exemption no longer matters, and a misspelled or
# widened one would go unnoticed.

echo "Case: the health-probe exemption is load-bearing"
assert_case 0 "health.ts as committed" "$HEALTH"
cp "$HEALTH" "$ROOT_COPY"
assert_case 1 "health.ts copied within the server root" "$ROOT_COPY"

echo "Case: the ephemeral-database exemption is load-bearing"
assert_case 0 "services/ephemeralPg.ts as committed" "$EPHEMERAL"
cp "$EPHEMERAL" "$SERVICE_COPY"
assert_caught "ephemeralPg.ts copied within services/" "$SERVICE_COPY"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
