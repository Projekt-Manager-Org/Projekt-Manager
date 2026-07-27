#!/usr/bin/env bash
#
# Markdown link check (AC-348) — local runner.
#
# CI runs the same check through `lycheeverse/lychee-action` in the
# `lint` job. Both read `lychee.toml`, which holds every flag; the only
# thing passed on the command line is the input glob below, and it is
# duplicated in exactly one other place — keep the two in step.
#
# lychee is a Rust binary and is not a project dependency. Install it
# with one of:
#   cargo install lychee
#   brew install lychee
#   https://github.com/lycheeverse/lychee/releases
#
# Exit codes:
#   0 — every link resolves
#   1 — at least one broken link (lychee prints them)
#   2 — lychee not installed

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v lychee >/dev/null 2>&1; then
  echo "ERROR: lychee not found on PATH." >&2
  echo "       Install it (cargo install lychee / brew install lychee)," >&2
  echo "       or let CI run this check — the \`lint\` job installs it." >&2
  exit 2
fi

# Mirrors the `args:` input of the CI step in .github/workflows/ci.yml.
exec lychee --config lychee.toml './**/*.md'
