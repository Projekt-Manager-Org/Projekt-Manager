#!/usr/bin/env bash
#
# Scenario tests for scripts/check-image-pins.sh.
#
# The pin gate is what makes "scanned = declared" hold: a floating tag
# resolves to whatever the registry serves today, so scanning it says
# nothing about what was pulled months ago (#637: `postgres:17-alpine`
# scanned as 17.11 while 17.9 ran). Each case stages one file in a fresh
# tree and runs the real check against it via $IMAGE_PINS_REPO_ROOT.
#
# Exits 0 when every case matches; 1 otherwise.
#
# Usage:
#   bash scripts/__tests__/check-image-pins.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHECK_SCRIPT="$REPO_ROOT/scripts/check-image-pins.sh"

if [[ ! -f "$CHECK_SCRIPT" ]]; then
  echo "ERROR: $CHECK_SCRIPT not found." >&2
  exit 2
fi

DIGEST="sha256:$(printf 'a%.0s' {1..64})"

TMP_DIRS=()
# shellcheck disable=SC2317  # invoked via `trap cleanup EXIT`
cleanup() {
  local d
  for d in "${TMP_DIRS[@]:-}"; do
    [[ -n "${d:-}" && -d "$d" ]] && rm -rf "$d"
  done
}
trap cleanup EXIT

mktmp() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  mkdir -p "$d/.github/workflows" "$d/docker/caddy"
  # Every real tree has the base compose file; the check refuses one without
  # it (see the last case). Cases that stage their own overwrite it.
  printf 'services:\n  db:\n    image: postgres:17-alpine@%s\n' "$DIGEST" > "$d/docker-compose.yml"
  echo "$d"
}

pass=0
fail=0
failures=()

# Asserts the exit code and, on a failing case, that the report names the
# offending file:line — the operator's only pointer to what to pin.
assert_case() {
  local expected="$1" label="$2" dir="$3" expect_loc="${4:-}"
  local out actual
  out=$(IMAGE_PINS_REPO_ROOT="$dir" bash "$CHECK_SCRIPT" 2>&1)
  actual=$?
  if [[ "$actual" != "$expected" ]]; then
    fail=$((fail + 1))
    failures+=("$label: expected exit $expected, got $actual; output:"$'\n'"$out")
    echo "  FAIL — $label"
    return
  fi
  if [[ -n "$expect_loc" ]] && ! grep -qF "$expect_loc" <<<"$out"; then
    fail=$((fail + 1))
    failures+=("$label: expected '$expect_loc' in output; got:"$'\n'"$out")
    echo "  FAIL — $label"
    return
  fi
  pass=$((pass + 1))
  echo "  PASS — $label"
}

# --- compose -------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/docker-compose.yml" <<'EOF'
services:
  db:
    image: postgres:17-alpine
EOF
assert_case 1 "compose: floating tag fails" "$dir" "docker-compose.yml:3"

dir="$(mktmp)"
cat > "$dir/docker-compose.yml" <<EOF
services:
  db:
    image: 'postgres:17-alpine@$DIGEST'
EOF
assert_case 0 "compose: tag + digest passes (quoted)" "$dir"

# An overlay is a separate file a deployment can load; the gate covers
# every compose file, not just the base.
dir="$(mktmp)"
cat > "$dir/docker-compose.http.yml" <<'EOF'
services:
  caddy:
    image: caddy:2-alpine
EOF
assert_case 1 "compose overlay: floating tag fails" "$dir" "docker-compose.http.yml:3"

# First-party images are tagged by commit SHA and built by this repo's CI;
# they cannot carry a digest in the file that selects them.
dir="$(mktmp)"
cat > "$dir/docker-compose.yml" <<'EOF'
services:
  app:
    image: ghcr.io/projekt-manager-org/projekt-manager:${APP_IMAGE_TAG:?APP_IMAGE_TAG must be set}
  backup:
    image: ghcr.io/projekt-manager-org/projekt-manager-backup:${APP_IMAGE_TAG:?APP_IMAGE_TAG must be set}
EOF
assert_case 0 "compose: first-party APP_IMAGE_TAG refs (app, backup) are exempt" "$dir"

# The exemption is APP_IMAGE_TAG, not "any variable": an env-selected tag
# on a third-party image floats just the same.
dir="$(mktmp)"
cat > "$dir/docker-compose.yml" <<'EOF'
services:
  db:
    image: postgres:${PG_TAG:-17-alpine}
EOF
assert_case 1 "compose: third-party image with a variable tag fails" "$dir" "docker-compose.yml:3"

# The exemption is the per-commit tag, not the org: a third-party image
# mirrored under our namespace still needs its digest.
dir="$(mktmp)"
cat > "$dir/docker-compose.minio.yml" <<'EOF'
services:
  storage:
    image: ghcr.io/projekt-manager-org/minio:RELEASE.2025-09-07T16-13-09Z
EOF
assert_case 1 "compose: own-namespace mirror without digest fails" "$dir" "docker-compose.minio.yml:3"

dir="$(mktmp)"
cat > "$dir/docker-compose.yml" <<'EOF'
services:
  app:
    # the `image: foo:latest` tag from the base file is overridden here
    build: .
EOF
assert_case 0 "compose: commented image: mention is not a reference" "$dir"

# --- Dockerfiles ---------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/Dockerfile" <<'EOF'
FROM node:24.16.0-alpine AS build
EOF
assert_case 1 "Dockerfile: FROM without digest fails" "$dir" "Dockerfile:1"

dir="$(mktmp)"
cat > "$dir/Dockerfile.backup" <<EOF
ARG APP_IMAGE_TAG
FROM ghcr.io/projekt-manager-org/projekt-manager:\${APP_IMAGE_TAG} AS appsrc
FROM --platform=linux/amd64 node:24.16.0-alpine@$DIGEST AS runtime
COPY --from=appsrc /app /app
FROM runtime AS final
FROM scratch
EOF
assert_case 0 "Dockerfile: digest, --platform, first-party, stage ref, scratch pass" "$dir"

# A bare name is a stage reference only if an earlier stage declared it;
# otherwise it is an image at an implicit :latest.
dir="$(mktmp)"
cat > "$dir/Dockerfile" <<EOF
FROM node:24.16.0-alpine@$DIGEST AS build
FROM alpine
EOF
assert_case 1 "Dockerfile: bare image name without a matching stage fails" "$dir" "Dockerfile:2"

dir="$(mktmp)"
cat > "$dir/docker/caddy/Dockerfile" <<EOF
# syntax=docker/dockerfile:1.24
FROM caddy:2.11.7-builder@$DIGEST AS builder
EOF
assert_case 1 "Dockerfile: syntax directive without digest fails" "$dir" "docker/caddy/Dockerfile:1"

dir="$(mktmp)"
cat > "$dir/docker/caddy/Dockerfile" <<'EOF'
FROM caddy:2.11.7-builder AS builder
EOF
assert_case 1 "nested Dockerfile: FROM without digest fails" "$dir" "docker/caddy/Dockerfile:1"

# --- CI ------------------------------------------------------------------

dir="$(mktmp)"
cat > "$dir/.github/workflows/ci.yml" <<'EOF'
jobs:
  check:
    services:
      postgres:
        image: postgres:17-alpine
EOF
assert_case 1 "workflow services: floating tag fails" "$dir" ".github/workflows/ci.yml:5"

# --- whole tree ----------------------------------------------------------

dir="$(mktmp)"
assert_case 0 "pinned base compose file alone passes" "$dir"

# Fail closed: a tree without the base compose file means discovery is
# pointed at the wrong place, not that there is nothing to pin.
dir="$(mktmp)"
rm "$dir/docker-compose.yml"
assert_case 2 "missing docker-compose.yml is an error, not a pass" "$dir"

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
