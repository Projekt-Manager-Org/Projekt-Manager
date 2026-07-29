#!/usr/bin/env bash
#
# Markdown link check (AC-348) — local runner.
#
# CI runs the same check through `lycheeverse/lychee-action` in the
# `lint` job. Both read `lychee.toml`, which holds every flag; the only
# argument either passes is `.` — see that file for why the input is the
# repository root and not a `**/*.md` glob.
#
# lychee is a Rust binary, not a project dependency. This script uses a
# native binary when one is on PATH and otherwise falls back to the
# pinned container image, so a checkout with Docker (or Podman) needs no
# install step. To install natively instead:
#   cargo install lychee
#   brew install lychee
#   https://github.com/lycheeverse/lychee/releases
#
# Exit codes:
#   0 — every link resolves
#   1 — at least one broken link (lychee prints them)
#   2 — no lychee binary and no container runtime

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

WORKFLOW=".github/workflows/ci.yml"

if command -v lychee >/dev/null 2>&1; then
  exec lychee --config lychee.toml .
fi

# The version is NOT duplicated here. It is read from the `lycheeVersion`
# input of the CI step, which Renovate keeps current — a local run and CI
# cannot end up on different versions.
VERSION="$(sed -n 's/.*lycheeVersion:[[:space:]]*v\{0,1\}\([0-9][0-9.]*\).*/\1/p' "$WORKFLOW" | head -1)"

if [ -z "$VERSION" ]; then
  echo "ERROR: could not read lycheeVersion from $WORKFLOW." >&2
  echo "       The CI step is the single source for the pinned version;" >&2
  echo "       if that input was renamed, update this script with it." >&2
  exit 2
fi

for runtime in docker podman; do
  if command -v "$runtime" >/dev/null 2>&1; then
    # `--network none` makes `offline = true` structural rather than
    # merely configured. Read-only mount: a link checker never writes.
    exec "$runtime" run --rm --network none \
      -v "$PROJECT_ROOT":/input:ro -w /input \
      "docker.io/lycheeverse/lychee:${VERSION}" \
      --config lychee.toml .
  fi
done

echo "ERROR: no lychee binary and no container runtime found." >&2
echo "       Install lychee (cargo install lychee / brew install lychee)," >&2
echo "       or install Docker/Podman to use the pinned v${VERSION} image." >&2
exit 2
