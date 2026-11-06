#!/usr/bin/env bash
#
# Runs every *.test.sh in a directory (default scripts/__tests__), so a new
# self-test needs no CI wiring. A failure does not stop the rest.
#
# Usage: run-self-tests.sh [<dir>]
#
# EXIT CODES
#   0  all passed
#   1  at least one failed; one `::error::` line each
#   2  no self-tests found

set -uo pipefail

dir="${1:-$(dirname "$0")/../__tests__}"

shopt -s nullglob
tests=("$dir"/*.test.sh)
if ((${#tests[@]} == 0)); then
  echo "::error::no self-tests in $dir"
  exit 2
fi

status=0
for t in "${tests[@]}"; do
  name="$(basename "$t")"
  echo "::group::$name"
  bash "$t"
  rc=$?
  echo '::endgroup::'
  if ((rc != 0)); then
    echo "::error::$name failed (exit $rc)"
    status=1
  fi
done
exit "$status"
