#!/usr/bin/env bash
#
# Scenario tests for the server import zones in eslint.config.js
# (`SERVER_IMPORT_ZONES`; #956, #974, #976): each listed directory under
# src/server/ imports only its allowlisted targets; type-only imports are
# allowed.
#
# The zones are regexes generated per nesting depth and scoped by `files:`
# globs. A mistyped glob, a wrong relative path at some depth, a widened
# `ignores:` or a loosened regex fails open — lint stays green and a service
# starts importing a route. Only running ESLint on real paths shows that.
#
# Fixtures are written into the zones' own directories (a zone is scoped by
# path, so a fixture elsewhere would prove nothing), linted in one ESLint
# run, and removed on exit. Assertions count this rule's messages only, so
# an unrelated lint error in a fixture cannot be mistaken for a hit.
#
# Usage:
#   bash scripts/__tests__/check-server-import-zones.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RULE='no-restricted-imports'
SERVER="$REPO_ROOT/src/server"
FIXTURE_PREFIX='__import_zone_fixture_'
# A server directory no zone names, as one added later would be.
UNZONED='__import_zone_unzoned__'
# Every directory a case writes into; created ones are removed again.
DIRS=(
  repositories repositories/__tests__ storage storage/__tests__
  services services/invoice services/invoice/xsd services/__tests__
  middleware config db sse "$UNZONED"
)

if [[ ! -f "$REPO_ROOT/eslint.config.js" ]]; then
  echo "ERROR: eslint.config.js not found." >&2
  exit 2
fi

created=()
cleanup() {
  local d
  for d in "${DIRS[@]}"; do
    rm -f "$SERVER/$d/$FIXTURE_PREFIX"*.ts
  done
  for d in "${created[@]}"; do
    rmdir --ignore-fail-on-non-empty "$d"
  done
}
trap cleanup EXIT
# A crashed earlier run could have left fixtures behind; they would be
# linted as real source by every later run.
cleanup
for d in "${DIRS[@]}"; do
  if [[ ! -d "$SERVER/$d" ]]; then
    mkdir -p "$SERVER/$d" || exit 2
    created=("$SERVER/$d" "${created[@]}")
  fi
done

files=()
expected=()
labels=()

# expect <dir under src/server> <violations> <label> <import statement>
# Writes a fixture holding the statement (plus a use of the binding, so no
# other rule complains).
expect() {
  local dir="$1" count="$2" label="$3" statement="$4"
  local file="$SERVER/$dir/$FIXTURE_PREFIX${#files[@]}.ts"
  printf '%s\nexport const used: unknown = x;\n' "$statement" >"$file"
  files+=("$file")
  expected+=("$count")
  labels+=("$dir: $label")
}

# --- repositories/ (#956) ---------------------------------------------------
expect repositories 1 "a service (#956's reproduction)" \
  "import { mutate as x } from '../services/mutate.js';"
expect repositories 1 "a route" "import { x } from '../routes/projects.js';"
expect repositories 1 "middleware, value import" "import { x } from '../middleware/auth.js';"
expect repositories 1 "object storage" "import { x } from '../storage/client.js';"
expect repositories 1 "a src/server/ root file" "import { x } from '../errors.js';"
expect repositories 1 "server config" "import { x } from '../config/env.js';"
expect repositories 1 "client code" "import { x } from '../../ui/App.js';"
expect repositories 1 "a detour through the sibling path" \
  "import { x } from './../services/mutate.js';"
expect repositories 1 "a detour through an allowed path" \
  "import { x } from '../db/../services/mutate.js';"
expect repositories 1 "a service through the @/ alias" \
  "import { x } from '@/server/services/mutate.js';"
expect repositories 1 "a re-export" "export { x } from '../services/mutate.js'; const x = 0;"
expect repositories 0 "middleware, type-only import" \
  "import type { AuthUser as x } from '../middleware/auth.js';"
expect repositories 0 "db/" "import { x } from '../db/connection.js';"
expect repositories 0 "src/domain/" "import { x } from '../../domain/types.js';"
expect repositories 0 "src/config/" "import { x } from '../../config/strings.js';"
expect repositories 0 "another repository" "import { x } from './scope.js';"
expect repositories 0 "src/domain/ through the @/ alias" "import { x } from '@/domain/types.js';"
expect repositories 0 "a package" "import { sql as x } from 'drizzle-orm';"
expect repositories/__tests__ 0 "a test (exempt)" "import { x } from '../../services/mutate.js';"

# --- storage/ (#974) --------------------------------------------------------
expect storage 1 "a service (#974's reproduction)" \
  "import { mutate as x } from '../services/mutate.js';"
expect storage 1 "middleware, value import" "import { x } from '../middleware/auth.js';"
expect storage 1 "a src/server/ root file" "import { x } from '../errors.js';"
expect storage 1 "a service through the @/ alias" "import { x } from '@/server/services/mutate.js';"
expect storage 0 "a repository" "import { x } from '../repositories/attachment.js';"
expect storage 0 "server config" "import { x } from '../config/index.js';"
expect storage 0 "src/config/" "import { x } from '../../config/strings.js';"
expect storage 0 "a sibling" "import { x } from './keyNamespaces.js';"
expect storage/__tests__ 0 "a test (exempt)" "import { x } from '../../services/mutate.js';"

# --- services/ (#976) -------------------------------------------------------
expect services 1 "a route (#976's reproduction)" "import { x } from '../routes/projects.js';"
expect services 1 "middleware, value import" "import { x } from '../middleware/auth.js';"
expect services 1 "app assembly" "import { x } from '../app.js';"
expect services 1 "a route through the @/ alias" "import { x } from '@/server/routes/projects.js';"
expect services 1 "client code" "import { x } from '../../ui/App.js';"
expect services 0 "middleware, type-only import" \
  "import type { AuthUser as x } from '../middleware/auth.js';"
expect services 0 "a sibling" "import { x } from './mutate.js';"
expect services 0 "a nested service" "import { x } from './invoice/payloadCrypto.js';"
expect services 0 "a repository" "import { x } from '../repositories/user.js';"
expect services 0 "object storage" "import { x } from '../storage/client.js';"
expect services 0 "db/" "import { x } from '../db/connection.js';"
expect services 0 "server config" "import { x } from '../config/index.js';"
expect services 0 "the SSE bus" "import { x } from '../sse/emitters.js';"
expect services 0 "error factories" "import { x } from '../errors.js';"
expect services 0 "password hashing" "import { x } from '../password.js';"
expect services 0 "the static root" "import { x } from '../staticRoot.js';"
expect services 0 "src/domain/" "import { x } from '../../domain/types.js';"
expect services 0 "src/config/" "import { x } from '../../config/strings.js';"
expect services 0 "a repository through the @/ alias" \
  "import { x } from '@/server/repositories/user.js';"
expect services/__tests__ 0 "a test (exempt)" "import { x } from '../../routes/projects.js';"

# One level down, the same targets sit one `../` further away.
expect services/invoice 1 "nested: a route" "import { x } from '../../routes/projects.js';"
expect services/invoice 1 "nested: app assembly" "import { x } from '../../app.js';"
expect services/invoice 0 "nested: a parent service" "import { x } from '../KeyEnvelopeService.js';"
expect services/invoice 0 "nested: a sibling" "import { x } from './payloadCrypto.js';"
expect services/invoice 0 "nested: server config" "import { x } from '../../config/index.js';"
expect services/invoice 0 "nested: error factories" "import { x } from '../../errors.js';"
expect services/invoice 0 "nested: src/config/" "import { x } from '../../../config/strings.js';"
expect services/invoice 0 "nested: src/domain/" "import { x } from '../../../domain/types.js';"
# Deeper than the zones are generated for: refused until someone extends them.
expect services/invoice/xsd 1 "too deep: any parent import" \
  "import { x } from '../../KeyEnvelopeService.js';"

# --- middleware/ (#976) -----------------------------------------------------
expect middleware 1 "a repository" "import { x } from '../repositories/session.js';"
expect middleware 1 "db/, value import" "import { x } from '../db/connection.js';"
expect middleware 1 "a route" "import { x } from '../routes/projects.js';"
expect middleware 0 "db/, type-only import" "import type { Database as x } from '../db/connection.js';"
expect middleware 0 "a service" "import { x } from '../services/AuthService.js';"
expect middleware 0 "error factories" "import { x } from '../errors.js';"
expect middleware 0 "src/config/" "import { x } from '../../config/permissions.js';"

# --- config/ (src/server/config/, #976) -------------------------------------
expect config 1 "a service" "import { x } from '../services/AuthService.js';"
expect config 1 "src/domain/" "import { x } from '../../domain/types.js';"
expect config 0 "a sibling" "import { x } from './common-passwords.js';"
expect config 0 "src/config/" "import { x } from '../../config/strings.js';"

# --- db/ (#976) -------------------------------------------------------------
expect db 1 "a repository" "import { x } from '../repositories/user.js';"
expect db 0 "server config" "import { x } from '../config/env.js';"

# --- sse/ (#976) ------------------------------------------------------------
expect sse 1 "a service" "import { x } from '../services/AuthService.js';"
expect sse 0 "src/config/" "import { x } from '../../config/sseEvents.js';"

# --- A directory with no zone ---------------------------------------------------
expect "$UNZONED" 1 "a route" "import { x } from '../routes/projects.js';"
expect "$UNZONED" 1 "a repository through the @/ alias" \
  "import { x } from '@/server/repositories/user.js';"
expect "$UNZONED" 0 "a sibling" "import { x } from './other.js';"

# --- Lint and compare -------------------------------------------------------

# Reads an ESLint JSON report on stdin; prints, per file argument in order,
# this rule's message count, or `ERR` when the report is unparseable, lacks
# the file, or carries a fatal or rule-not-found message — so a broken
# invocation fails a case instead of reading as zero.
COUNT_JS='
  const [rule, ...files] = process.argv.slice(1);
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let report = [];
    try { report = JSON.parse(s); } catch {}
    const byFile = new Map(report.map((f) => [f.filePath, f.messages]));
    for (const file of files) {
      const messages = byFile.get(file);
      const broken = !messages ||
        messages.some((m) => m.fatal || /could not find|not found/i.test(m.message));
      console.log(broken ? "ERR" : messages.filter((m) => m.ruleId === rule).length);
    }
  });
'

pass=0
fail=0
failures=()
# record <label> <expected> <actual>
record() {
  if [[ "$3" == "$2" ]]; then
    pass=$((pass + 1))
    echo "  PASS — $1 ($3 violation(s))"
  else
    fail=$((fail + 1))
    failures+=("$1: expected $2 violation(s), got $3")
    echo "  FAIL — $1 (expected $2, got $3)"
  fi
}

# One ESLint run over every fixture.
mapfile -t actual < <(
  (cd "$REPO_ROOT" && npx --no-install eslint --no-warn-ignored -f json "${files[@]}" 2>/dev/null) |
    node -e "$COUNT_JS" "$RULE" "${files[@]}"
)
for i in "${!files[@]}"; do
  record "${labels[$i]}" "${expected[$i]}" "${actual[$i]:-ERR}"
done

# Server-shared leaves (#976) are named root files, so no fixture can stand
# in for one: ESLint lints the statement as if it were that file.
expect_leaf() {
  local leaf="$1" count="$2" label="$3" statement="$4" got
  got="$(printf '%s\nexport const used: unknown = x;\n' "$statement" |
    (cd "$REPO_ROOT" && npx --no-install eslint -f json --stdin --stdin-filename "src/server/$leaf" 2>/dev/null) |
    node -e "$COUNT_JS" "$RULE" "$SERVER/$leaf")"
  record "$leaf: $label" "$count" "${got:-ERR}"
}
expect_leaf errors.ts 1 "a service" "import { x } from './services/AuthService.js';"
expect_leaf password.ts 1 "server config" "import { x } from './config/index.js';"
expect_leaf errors.ts 0 "src/config/" "import { x } from '../config/strings.js';"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
