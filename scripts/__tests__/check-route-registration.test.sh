#!/usr/bin/env bash
#
# Scenario tests for the route-registration rule in eslint.config.js —
# the guard behind AC-351's API-surface-completeness clause.
#
# The OpenAPI document is built from what `buildApp()` registers, so a
# route mounted anywhere else is a public endpoint the artifact never
# mentions. That property rests entirely on one `no-restricted-syntax`
# selector, and a selector typo or a widened `ignores:` fails open: lint
# stays green and the document silently goes incomplete. Same failure
# mode `$OPENAPI_INJECT_INVALID` closes for the validity gate, so it
# gets the same treatment.
#
# Fixtures are written under `src/server/` — the rule is scoped by path,
# so a fixture outside the tree would prove nothing — and removed on
# exit. Assertions count `no-restricted-syntax` messages only, so an
# unrelated lint error in a fixture cannot be mistaken for a hit.
#
# Usage:
#   bash scripts/__tests__/check-route-registration.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RULE='no-restricted-syntax'
FIXTURE_DIR="$REPO_ROOT/src/server/__route_reg_fixture__"
ROUTES_FIXTURE="$REPO_ROOT/src/server/routes/__route_reg_fixture__.ts"
STATIC_CACHE="$REPO_ROOT/src/server/staticCache.ts"

if [[ ! -f "$REPO_ROOT/eslint.config.js" ]]; then
  echo "ERROR: eslint.config.js not found." >&2
  exit 2
fi

cleanup() {
  rm -rf "$FIXTURE_DIR" "$ROUTES_FIXTURE"
}
trap cleanup EXIT
# An earlier crashed run could have left fixtures behind; they would be
# linted as real source by every later case.
cleanup

mkdir -p "$FIXTURE_DIR/__tests__" || exit 2

pass=0
fail=0
failures=()

# Count of `no-restricted-syntax` messages ESLint reports for one file.
# Prints `ERR` when ESLint produced no parseable JSON, so a broken
# invocation fails a case instead of reading as zero violations.
count_violations() {
  local file="$1"
  (cd "$REPO_ROOT" && npx --no-install eslint --no-warn-ignored -f json "$file" 2>/dev/null) |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const report = JSON.parse(s);
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

assert_case() {
  local expected="$1" label="$2" file="$3"
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

# --- Caught: the mistake the rule exists for ------------------------------

echo "Case: a route on \`app\` outside buildApp() is caught"
cat >"$FIXTURE_DIR/caught-app.ts" <<'EOF'
import type { FastifyInstance } from 'fastify';
export function mount(app: FastifyInstance): void {
  app.get('/api/fixture', async () => ({}));
}
EOF
assert_case 1 "app.get outside the factory" "$FIXTURE_DIR/caught-app.ts"

echo "Case: the same mistake under a different receiver name is caught"
# The selector pinned `app` until #284's review; `server.get(...)` passed
# clean while registering exactly the same invisible endpoint.
cat >"$FIXTURE_DIR/caught-alias.ts" <<'EOF'
import type { FastifyInstance } from 'fastify';
export function mount(server: FastifyInstance, fastify: FastifyInstance): void {
  server.get('/api/fixture-a', async () => ({}));
  fastify.post('/api/fixture-b', async () => ({}));
}
EOF
assert_case 2 "server.get / fastify.post outside the factory" "$FIXTURE_DIR/caught-alias.ts"

echo "Case: a plugin registration outside buildApp() is caught"
# `register` mounts routes no HTTP verb names — how @fastify/static adds
# a HEAD+GET pair per built file.
cat >"$FIXTURE_DIR/caught-register.ts" <<'EOF'
import type { FastifyInstance } from 'fastify';
export async function mount(app: FastifyInstance): Promise<void> {
  await app.register(async () => {});
}
EOF
assert_case 1 "app.register outside the factory" "$FIXTURE_DIR/caught-register.ts"

# --- Exempt: places the rule must stay quiet ------------------------------

echo "Case: route plugins under src/server/routes/ are exempt"
# They are the bodies buildApp() registers — the factory's own surface.
cat >"$ROUTES_FIXTURE" <<'EOF'
import type { FastifyInstance } from 'fastify';
export function fixtureRoutes() {
  return async function (app: FastifyInstance): Promise<void> {
    app.get('/api/fixture', async () => ({}));
  };
}
EOF
assert_case 0 "route plugin in routes/" "$ROUTES_FIXTURE"

echo "Case: tests are exempt"
cat >"$FIXTURE_DIR/__tests__/exempt.ts" <<'EOF'
import type { FastifyInstance } from 'fastify';
export function mount(app: FastifyInstance): void {
  app.get('/api/fixture', async () => ({}));
}
EOF
assert_case 0 "test file" "$FIXTURE_DIR/__tests__/exempt.ts"

echo "Case: a non-route .get on an allowlisted name is not a false positive"
# The receiver allowlist is what buys this. Matching every `.get` would
# flag Drizzle query builders and Map lookups across repositories/ and
# services/ — 61 of them when measured.
cat >"$FIXTURE_DIR/non-route-get.ts" <<'EOF'
export function lookup(cache: Map<string, string>): string | undefined {
  return cache.get('key');
}
EOF
assert_case 0 "Map.get on a non-allowlisted receiver" "$FIXTURE_DIR/non-route-get.ts"

# --- The one declared exception -------------------------------------------

echo "Case: the static-asset exception is load-bearing, not decorative"
# staticCache.ts registers @fastify/static outside the factory behind an
# inline disable. Strip the disable and the rule must fire: if it does
# not, the exception has quietly stopped being an exception — the
# selector no longer matches the call it was written for.
if [[ ! -f "$STATIC_CACHE" ]]; then
  echo "ERROR: $STATIC_CACHE not found — cannot check the declared exception." >&2
  exit 2
fi
assert_case 0 "staticCache.ts as committed" "$STATIC_CACHE"
grep -v 'eslint-disable-next-line no-restricted-syntax' "$STATIC_CACHE" \
  >"$FIXTURE_DIR/static-cache-undisabled.ts"
assert_case 1 "staticCache.ts with the disable removed" "$FIXTURE_DIR/static-cache-undisabled.ts"

echo
echo "Results: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  printf '%s\n' "${failures[@]}" >&2
  exit 1
fi
exit 0
