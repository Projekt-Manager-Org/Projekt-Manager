#!/usr/bin/env bash
#
# Scenario tests for scripts/ci/deploy-inventory.sh.
#
# The nightly inventory scan (#637) scans what a deploy runs. That set is
# derived, not hand-listed: a hand-picked list is how `caddy` and
# `postgres` went unscanned. Three things must hold:
#
#   1. The inventory is what `docker compose` resolves under the deploy
#      profiles — profile-gated deploy services in, other profiles out,
#      build-only services named the way compose names their image and
#      carrying the build context the workflow needs to build them.
#   2. It works on the real compose file, whose other required `${VAR:?}`
#      settings (secrets, endpoints) the scanner does not have.
#   3. deploy.sh and the inventory select profiles only through the one
#      shared helper, so a deploy cannot run a profile the inventory does
#      not scan.
#
# Exits 0 when every case matches; 1 otherwise; 2 if docker compose is
# unavailable.
#
# Usage:
#   bash scripts/__tests__/deploy-inventory.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/deploy-inventory.sh"
DEPLOY="$REPO_ROOT/scripts/deploy.sh"
HELPER_REL="lib/deploy-compose.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "ERROR: $SCRIPT not found." >&2
  exit 2
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose not available." >&2
  exit 2
fi

TMP="$(mktemp -d)"
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

pass=0
fail=0
failures=()

ok() {
  pass=$((pass + 1))
  echo "  PASS — $1"
}
ko() {
  fail=$((fail + 1))
  failures+=("$1")
  echo "  FAIL — $1"
}

# --- 1. fixture: profile and build semantics -----------------------------

mkdir -p "$TMP/fixture/web"
echo "FROM scratch" > "$TMP/fixture/web/Dockerfile"
cat > "$TMP/fixture/docker-compose.yml" <<'EOF'
name: fixture
services:
  app:
    image: ghcr.io/example/app:${APP_IMAGE_TAG:?APP_IMAGE_TAG must be set}
  db:
    image: postgres:17-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000
  backup:
    image: ghcr.io/example/backup:${APP_IMAGE_TAG:?APP_IMAGE_TAG must be set}
    profiles: [backup]
  web:
    build: ./web
  debug:
    image: busybox:latest
    profiles: [debug]
EOF

# stdout only: it is the $GITHUB_OUTPUT payload; diagnostics go to stderr.
out=$(DEPLOY_REPO_ROOT="$TMP/fixture" APP_IMAGE_TAG=main bash "$SCRIPT" 2>/dev/null)
rc=$?

if [[ "$rc" -ne 0 ]]; then
  ko "fixture: inventory exits 0 (got $rc)"
else
  ok "fixture: inventory exits 0"

  expected='[{"build":false,"image":"ghcr.io/example/app:main","service":"app"},{"build":false,"image":"ghcr.io/example/backup:main","service":"backup"},{"build":false,"image":"postgres:17-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000","service":"db"},{"build":true,"context":"web","dockerfile":"Dockerfile","image":"fixture-web","service":"web"}]'
  actual=$(jq -cS 'sort_by(.service)' <<<"$out" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    ok "fixture: unprofiled + deploy-profile services; digest refs verbatim; build-only as <project>-<service> with context; other profiles out"
  else
    ko "fixture: inventory mismatch"$'\n'"    expected: $expected"$'\n'"    actual:   $actual"
  fi

  if [[ "$(wc -l <<<"$out")" -eq 1 ]]; then
    ok "fixture: inventory is a single line"
  else
    ko "fixture: inventory spans $(wc -l <<<"$out") lines; \$GITHUB_OUTPUT needs one"
  fi
fi

if DEPLOY_REPO_ROOT="$TMP/fixture" APP_IMAGE_TAG='' bash "$SCRIPT" >/dev/null 2>&1; then
  ko "fixture: missing APP_IMAGE_TAG exits 0"
else
  ok "fixture: missing APP_IMAGE_TAG fails"
fi

# Only APP_IMAGE_TAG is substituted; any other variable left in an image
# reference would be scanned as a literal `${…}` string, so refuse.
mkdir -p "$TMP/vartag"
cat > "$TMP/vartag/docker-compose.yml" <<'EOF'
services:
  db:
    image: postgres:${PG_TAG:-17-alpine}
EOF
if DEPLOY_REPO_ROOT="$TMP/vartag" APP_IMAGE_TAG=main bash "$SCRIPT" >/dev/null 2>&1; then
  ko "fixture: image with an unresolved variable exits 0"
else
  ok "fixture: image with an unresolved variable fails"
fi

# A build arg or target would make the deploy's image differ from the one
# the scan builds from the same context, so refuse rather than scan the
# wrong image.
mkdir -p "$TMP/buildargs/web"
echo "FROM scratch" > "$TMP/buildargs/web/Dockerfile"
cat > "$TMP/buildargs/docker-compose.yml" <<'EOF'
services:
  web:
    build:
      context: ./web
      args:
        FLAVOR: prod
EOF
if DEPLOY_REPO_ROOT="$TMP/buildargs" APP_IMAGE_TAG=main bash "$SCRIPT" >/dev/null 2>&1; then
  ko "fixture: build with args exits 0"
else
  ok "fixture: build with args fails"
fi

# --- 2. the real compose file --------------------------------------------

# Subset check: a new service must not break this case, only add to it.
# The real compose file is staged in a clean dir: a dev checkout's .env
# sets COMPOSE_FILE, which would merge the dev overlay into the result.
mkdir -p "$TMP/real"
cp "$REPO_ROOT/docker-compose.yml" "$TMP/real/"
ln -s "$REPO_ROOT/docker" "$TMP/real/docker"
out=$(DEPLOY_REPO_ROOT="$TMP/real" APP_IMAGE_TAG=main bash "$SCRIPT" 2>/dev/null)
rc=$?
if [[ "$rc" -ne 0 ]]; then
  ko "real tree: inventory exits 0 with only APP_IMAGE_TAG set (got $rc)"
else
  missing=$(jq -r '
    (map({(.service): .}) | add) as $by
    | [ ($by.app.image    | test("/projekt-manager:main$"))        // false,
        ($by.backup.image | test("/projekt-manager-backup:main$")) // false,
        ($by.db.build == false),
        ($by.caddy.build == true and $by.caddy.context == "docker/caddy") ]
    | to_entries | map(select(.value != true) | .key) | join(",")' <<<"$out" 2>&1)
  if [[ -z "$missing" ]]; then
    ok "real tree: app, backup, db and the caddy build are in the inventory"
  else
    ko "real tree: unexpected inventory (failed checks #$missing): $out"
  fi
fi

# --- 3. one profile source for both scripts ------------------------------

for f in "$DEPLOY" "$SCRIPT"; do
  name="${f#"$REPO_ROOT"/}"
  code=$(grep -vE '^[[:space:]]*#' "$f")
  if grep -qE -- '--profile([[:space:]=]|$)|(^|[^A-Z_])COMPOSE_PROFILES' <<<"$code"; then
    ko "$name selects profiles itself (--profile / COMPOSE_PROFILES); use DEPLOY_COMPOSE_PROFILES"
  else
    ok "$name selects no profiles of its own"
  fi
  if grep -qF "$HELPER_REL" <<<"$code" && grep -qF 'DEPLOY_COMPOSE_PROFILES[@]' <<<"$code"; then
    ok "$name sources $HELPER_REL and expands DEPLOY_COMPOSE_PROFILES"
  else
    ko "$name does not source $HELPER_REL and expand DEPLOY_COMPOSE_PROFILES"
  fi
done

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
