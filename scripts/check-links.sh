#!/usr/bin/env bash
#
# Markdown link check (AC-348) — local runner.
#
# CI runs the same check through the pinned image in the `lint` job.
# Both read `lychee.toml`, which holds the check's flags; the only input
# either passes is `.` — see that file for why the input is the
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

# The image is NOT duplicated here. It is read from the CI step, which
# Renovate keeps current — a local run and CI cannot end up on different
# images.
IMAGE="$(sed -n 's|.*uses:[[:space:]]*docker://\(lycheeverse/lychee:[^[:space:]]*\).*|\1|p' "$WORKFLOW" | head -1)"

if [ -z "$IMAGE" ]; then
  echo "ERROR: could not read the lychee image from $WORKFLOW." >&2
  echo "       The CI step is the single source for the pinned image;" >&2
  echo "       if that step changed shape, update this script with it." >&2
  exit 2
fi

for runtime in docker podman; do
  if command -v "$runtime" >/dev/null 2>&1; then
    # `--network none` makes `offline = true` structural rather than
    # merely configured. Read-only mount: a link checker never writes.
    exec "$runtime" run --rm --network none \
      -v "$PROJECT_ROOT":/input:ro -w /input \
      "docker.io/${IMAGE}" \
      --config lychee.toml .
  fi
done

echo "ERROR: no lychee binary and no container runtime found." >&2
echo "       Install lychee (cargo install lychee / brew install lychee)," >&2
echo "       or install Docker/Podman to use the pinned ${IMAGE} image." >&2
exit 2
