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
#   4. Both refuse a COMPOSE_FILE / COMPOSE_PROFILES override (shell env or
#      the checkout's .env): compose would load files or profiles the
#      nightly — which has no .env — never sees.
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
    image: postgres:17-alpine
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

  expected='[{"build":false,"image":"ghcr.io/example/app:main","service":"app"},{"build":false,"image":"ghcr.io/example/backup:main","service":"backup"},{"build":false,"image":"postgres:17-alpine","service":"db"},{"build":true,"context":"web","dockerfile":"Dockerfile","image":"fixture-web","service":"web"}]'
  actual=$(jq -cS 'sort_by(.service)' <<<"$out" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    ok "fixture: unprofiled + deploy-profile services; build-only as <project>-<service> with context; other profiles out"
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

# --- 2. the real compose file --------------------------------------------

# Subset check: a new service must not break this case, only add to it.
# The real compose file is staged in a clean dir: a dev checkout's .env
# sets COMPOSE_FILE, which the inventory rightly refuses (case 4).
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

# --- 4. no compose overrides ---------------------------------------------

HELPER="$REPO_ROOT/scripts/$HELPER_REL"

# $1 label, $2 expected rc, $3 .env content ('' = no .env), $4.. env assignments
guard_case() {
  local label="$1" expected="$2" dotenv="$3" dir rc
  shift 3
  dir="$(mktemp -d "$TMP/guard.XXXX")"
  [[ -n "$dotenv" ]] && printf '%s\n' "$dotenv" > "$dir/.env"
  # shellcheck disable=SC2016  # $1/$2 expand in the inner bash, by design
  env -u COMPOSE_FILE -u COMPOSE_PROFILES "$@" \
    bash -c '. "$1" && assert_no_compose_overrides "$2"' _ "$HELPER" "$dir" >/dev/null 2>&1
  rc=$?
  if [[ "$rc" -eq "$expected" ]]; then
    ok "guard: $label"
  else
    ko "guard: $label (expected $expected, got $rc)"
  fi
}

guard_case "no overrides passes" 0 ""
guard_case "unrelated .env passes" 0 "POSTGRES_PASSWORD=x"
guard_case "COMPOSE_FILE in env refused" 1 "" COMPOSE_FILE=docker-compose.yml:extra.yml
guard_case "COMPOSE_PROFILES in env refused" 1 "" COMPOSE_PROFILES=debug
guard_case "COMPOSE_FILE in .env refused" 1 "COMPOSE_FILE=docker-compose.yml:docker-compose.minio.yml"
guard_case "export COMPOSE_PROFILES in .env refused" 1 "  export COMPOSE_PROFILES=debug"
guard_case "commented-out override passes" 0 "# COMPOSE_FILE=docker-compose.yml:extra.yml"
# .env also accepts `KEY: value`.
guard_case "colon-syntax COMPOSE_PROFILES in .env refused" 1 "COMPOSE_PROFILES: debug"

# Bare `docker compose` also loads files the operator never names: an
# override next to docker-compose.yml, or a compose.yaml it prefers.
for extra in docker-compose.override.yml compose.yaml compose.override.yml docker-compose.yaml; do
  dir="$(mktemp -d "$TMP/guard.XXXX")"
  touch "$dir/$extra"
  if env -u COMPOSE_FILE -u COMPOSE_PROFILES \
    bash -c '. "$1" && assert_no_compose_overrides "$2"' _ "$HELPER" "$dir" >/dev/null 2>&1; then
    ko "guard: $extra present passes"
  else
    ok "guard: $extra present refused"
  fi
done

# The inventory refuses the same way, so a dev checkout with the dev .env
# cannot produce a misleading inventory either.
mkdir -p "$TMP/withenv"
cp "$TMP/fixture/docker-compose.yml" "$TMP/withenv/"
echo "COMPOSE_PROFILES=debug" > "$TMP/withenv/.env"
if DEPLOY_REPO_ROOT="$TMP/withenv" APP_IMAGE_TAG=main bash "$SCRIPT" >/dev/null 2>&1; then
  ko "inventory: .env override exits 0"
else
  ok "inventory: .env override refused"
fi

# In deploy.sh the guard must see the decrypted secrets (they are exported
# into the same env compose reads) and still precede every compose call.
guard_line=$(grep -nE '^[[:space:]]*assert_no_compose_overrides[[:space:]]' "$DEPLOY" | head -1 | cut -d: -f1)
secrets_line=$(grep -nE '^[[:space:]]*unset SECRETS_PLAINTEXT' "$DEPLOY" | head -1 | cut -d: -f1)
compose_line=$(grep -vnE '^[0-9]*:[[:space:]]*#' <(grep -n '' "$DEPLOY") | grep -E 'docker compose' | head -1 | cut -d: -f1)
if [[ -n "$guard_line" && -n "$secrets_line" && -n "$compose_line" ]] &&
  ((secrets_line < guard_line && guard_line < compose_line)); then
  ok "deploy.sh: guard runs after secrets are exported, before the first compose call"
else
  ko "deploy.sh: guard at line ${guard_line:-?}, secrets exported at ${secrets_line:-?}, first compose call at ${compose_line:-?}"
fi

for f in "$DEPLOY" "$SCRIPT"; do
  name="${f#"$REPO_ROOT"/}"
  if grep -vE '^[[:space:]]*#' "$f" | grep -qE 'assert_no_compose_overrides[[:space:]]'; then
    ok "$name calls assert_no_compose_overrides"
  else
    ko "$name never calls assert_no_compose_overrides"
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
