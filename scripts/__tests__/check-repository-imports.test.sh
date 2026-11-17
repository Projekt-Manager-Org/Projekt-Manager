#!/usr/bin/env bash
#
# Scenario tests for the repository import zone in eslint.config.js (#956):
# a repository imports only db/, src/domain/, src/config/ and other
# repositories; type-only imports are allowed.
#
# The zone is an allowlist of regexes scoped by a `files:` glob. A mistyped
# glob, a widened `ignores:` or a loosened regex fails open — lint stays
# green and a repository starts importing a service. Only running ESLint on
# real paths shows that.
#
# Fixtures are written under src/server/repositories/ (the zone is scoped by
# path, so a fixture elsewhere would prove nothing) and removed on exit.
# Assertions count this rule's messages only, so an unrelated lint error in
# a fixture cannot be mistaken for a hit.
#
# Usage:
#   bash scripts/__tests__/check-repository-imports.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RULE='no-restricted-imports'
REPO_DIR="$REPO_ROOT/src/server/repositories"
FIXTURE_PREFIX='__repo_imports_fixture_'
TEST_DIR="$REPO_DIR/__tests__"

if [[ ! -f "$REPO_ROOT/eslint.config.js" || ! -d "$REPO_DIR" ]]; then
  echo "ERROR: eslint.config.js or $REPO_DIR not found." >&2
  exit 2
fi

cleanup() {
  rm -f "$REPO_DIR/$FIXTURE_PREFIX"*.ts "$TEST_DIR/$FIXTURE_PREFIX"*.ts
  # The directory may exist only because this script made it.
  [[ -d "$TEST_DIR" ]] && rmdir --ignore-fail-on-non-empty "$TEST_DIR"
}
trap cleanup EXIT
# A crashed earlier run could have left fixtures behind; they would be
# linted as real source by every later run.
cleanup

pass=0
fail=0
failures=()
n=0

# Count of this rule's messages ESLint reports for one file. Prints `ERR`
# when ESLint produced no parseable JSON, or a fatal or rule-not-found
# message, so a broken invocation fails a case instead of reading as zero.
count_violations() {
  local file="$1"
  (cd "$REPO_ROOT" && npx --no-install eslint --no-warn-ignored -f json "$file" 2>/dev/null) |
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
              (n, f) => n + f.messages.filter((m) => m.ruleId === process.argv[1]).length,
              0,
            ),
          );
        } catch {
          console.log("ERR");
        }
      });
    ' "$RULE"
}

# assert_import <expected> <label> <import statement> [<dir>]
# Writes a fixture holding the statement (plus a use of the binding, so no
# other rule complains) and checks the violation count.
assert_import() {
  local expected="$1" label="$2" statement="$3" dir="${4:-$REPO_DIR}"
  n=$((n + 1))
  local file="$dir/$FIXTURE_PREFIX$n.ts"
  printf '%s\nexport const used: unknown = x;\n' "$statement" >"$file"
  local actual
  actual="$(count_violations "$file")"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $label ($actual violation(s))"
  else
    fail=$((fail + 1))
    failures+=("$label: expected $expected violation(s), got $actual")
    echo "  FAIL — $label (expected $expected, got $actual)"
  fi
}

# --- Caught: imports against the arrows -----------------------------------

echo "Caught:"
assert_import 1 "a service (the issue's reproduction)" \
  "import { mutate as x } from '../services/mutate.js';"
assert_import 1 "a route" "import { x } from '../routes/projects.js';"
assert_import 1 "middleware, value import" "import { x } from '../middleware/auth.js';"
assert_import 1 "object storage" "import { x } from '../storage/s3.js';"
assert_import 1 "a src/server/ root file" "import { x } from '../errors.js';"
assert_import 1 "server config" "import { x } from '../config/env.js';"
assert_import 1 "client code" "import { x } from '../../ui/App.js';"
assert_import 1 "a detour through the sibling path" "import { x } from './../services/mutate.js';"
assert_import 1 "a service through the @/ alias" "import { x } from '@/server/services/mutate.js';"
assert_import 1 "a re-export" "export { x } from '../services/mutate.js'; const x = 0;"

# --- Allowed: the arrows, and type-only imports ---------------------------

echo "Allowed:"
assert_import 0 "middleware, type-only import" \
  "import type { AuthUser as x } from '../middleware/auth.js';"
assert_import 0 "a service, type-only import" "import type { x } from '../services/mutate.js';"
assert_import 0 "db/" "import { x } from '../db/connection.js';"
assert_import 0 "src/domain/" "import { x } from '../../domain/types.js';"
assert_import 0 "src/config/" "import { x } from '../../config/strings.js';"
assert_import 0 "another repository" "import { x } from './scope.js';"
assert_import 0 "src/domain/ through the @/ alias" "import { x } from '@/domain/types.js';"
assert_import 0 "a package" "import { sql as x } from 'drizzle-orm';"

# --- Exempt ---------------------------------------------------------------

echo "Exempt:"
mkdir -p "$TEST_DIR" || exit 2
assert_import 0 "a repository test" "import { x } from '../../services/mutate.js';" "$TEST_DIR"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
