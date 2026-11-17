#!/usr/bin/env bash
#
# Scenario tests for the storage-layer import zones in eslint.config.js:
#   - repositories/ (#956): only db/, src/domain/, src/config/ and other
#     repositories;
#   - storage/ (#974): only siblings, repositories/, db/, src/server/config/,
#     src/domain/ and src/config/.
# Type-only imports are allowed in both.
#
# Each zone is an allowlist of regexes scoped by a `files:` glob. A mistyped
# glob, a widened `ignores:` or a loosened regex fails open — lint stays
# green and a repository starts importing a service. Only running ESLint on
# real paths shows that.
#
# Fixtures are written into the zone's own directory (a zone is scoped by
# path, so a fixture elsewhere would prove nothing) and removed on exit.
# Assertions count this rule's messages only, so an unrelated lint error in
# a fixture cannot be mistaken for a hit.
#
# Usage:
#   bash scripts/__tests__/check-server-import-zones.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RULE='no-restricted-imports'
REPO_DIR="$REPO_ROOT/src/server/repositories"
STORAGE_DIR="$REPO_ROOT/src/server/storage"
ZONE_DIRS=("$REPO_DIR" "$STORAGE_DIR")
FIXTURE_PREFIX='__import_zone_fixture_'

if [[ ! -f "$REPO_ROOT/eslint.config.js" ]]; then
  echo "ERROR: eslint.config.js not found." >&2
  exit 2
fi
for d in "${ZONE_DIRS[@]}"; do
  if [[ ! -d "$d" ]]; then
    echo "ERROR: $d not found." >&2
    exit 2
  fi
done

cleanup() {
  local d
  for d in "${ZONE_DIRS[@]}"; do
    rm -f "$d/$FIXTURE_PREFIX"*.ts "$d/__tests__/$FIXTURE_PREFIX"*.ts
    # The directory may exist only because this script made it.
    [[ -d "$d/__tests__" ]] && rmdir --ignore-fail-on-non-empty "$d/__tests__"
  done
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

# assert_import <dir> <expected> <label> <import statement>
# Writes a fixture holding the statement (plus a use of the binding, so no
# other rule complains) into <dir> and checks the violation count.
assert_import() {
  local dir="$1" expected="$2" label="$3" statement="$4"
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

# === repositories/ ========================================================

echo "Repositories, caught:"
assert_import "$REPO_DIR" 1 "a service (#956's reproduction)" \
  "import { mutate as x } from '../services/mutate.js';"
assert_import "$REPO_DIR" 1 "a route" "import { x } from '../routes/projects.js';"
assert_import "$REPO_DIR" 1 "middleware, value import" "import { x } from '../middleware/auth.js';"
assert_import "$REPO_DIR" 1 "object storage" "import { x } from '../storage/s3.js';"
assert_import "$REPO_DIR" 1 "a src/server/ root file" "import { x } from '../errors.js';"
assert_import "$REPO_DIR" 1 "server config" "import { x } from '../config/env.js';"
assert_import "$REPO_DIR" 1 "client code" "import { x } from '../../ui/App.js';"
assert_import "$REPO_DIR" 1 "a detour through the sibling path" \
  "import { x } from './../services/mutate.js';"
assert_import "$REPO_DIR" 1 "a service through the @/ alias" \
  "import { x } from '@/server/services/mutate.js';"
assert_import "$REPO_DIR" 1 "a re-export" "export { x } from '../services/mutate.js'; const x = 0;"

echo "Repositories, allowed:"
assert_import "$REPO_DIR" 0 "middleware, type-only import" \
  "import type { AuthUser as x } from '../middleware/auth.js';"
assert_import "$REPO_DIR" 0 "a service, type-only import" \
  "import type { x } from '../services/mutate.js';"
assert_import "$REPO_DIR" 0 "db/" "import { x } from '../db/connection.js';"
assert_import "$REPO_DIR" 0 "src/domain/" "import { x } from '../../domain/types.js';"
assert_import "$REPO_DIR" 0 "src/config/" "import { x } from '../../config/strings.js';"
assert_import "$REPO_DIR" 0 "another repository" "import { x } from './scope.js';"
assert_import "$REPO_DIR" 0 "src/domain/ through the @/ alias" "import { x } from '@/domain/types.js';"
assert_import "$REPO_DIR" 0 "a package" "import { sql as x } from 'drizzle-orm';"

echo "Repositories, exempt:"
mkdir -p "$REPO_DIR/__tests__" || exit 2
assert_import "$REPO_DIR/__tests__" 0 "a repository test" \
  "import { x } from '../../services/mutate.js';"

# === storage/ =============================================================

echo "Storage, caught:"
assert_import "$STORAGE_DIR" 1 "a service (#974's reproduction)" \
  "import { mutate as x } from '../services/mutate.js';"
assert_import "$STORAGE_DIR" 1 "a route" "import { x } from '../routes/projects.js';"
assert_import "$STORAGE_DIR" 1 "middleware, value import" "import { x } from '../middleware/auth.js';"
assert_import "$STORAGE_DIR" 1 "a src/server/ root file" "import { x } from '../errors.js';"
assert_import "$STORAGE_DIR" 1 "client code" "import { x } from '../../ui/App.js';"
assert_import "$STORAGE_DIR" 1 "a detour through the sibling path" \
  "import { x } from './../services/mutate.js';"
assert_import "$STORAGE_DIR" 1 "a service through the @/ alias" \
  "import { x } from '@/server/services/mutate.js';"

echo "Storage, allowed:"
assert_import "$STORAGE_DIR" 0 "a service, type-only import" \
  "import type { x } from '../services/mutate.js';"
assert_import "$STORAGE_DIR" 0 "a sibling" "import { x } from './keyNamespaces.js';"
assert_import "$STORAGE_DIR" 0 "a repository" "import { x } from '../repositories/attachment.js';"
assert_import "$STORAGE_DIR" 0 "db/" "import { x } from '../db/connection.js';"
assert_import "$STORAGE_DIR" 0 "server config" "import { x } from '../config/index.js';"
assert_import "$STORAGE_DIR" 0 "src/domain/" "import { x } from '../../domain/attachments.js';"
assert_import "$STORAGE_DIR" 0 "src/config/" "import { x } from '../../config/strings.js';"
assert_import "$STORAGE_DIR" 0 "a repository through the @/ alias" \
  "import { x } from '@/server/repositories/attachment.js';"
assert_import "$STORAGE_DIR" 0 "a package" "import { S3Client as x } from '@aws-sdk/client-s3';"

echo "Storage, exempt:"
mkdir -p "$STORAGE_DIR/__tests__" || exit 2
assert_import "$STORAGE_DIR/__tests__" 0 "a storage test" \
  "import { x } from '../../services/mutate.js';"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
