#!/usr/bin/env bash
#
# Static drift check for the Node version, pinned in four places that must
# agree (#700):
#
#   .nvmrc                       nvm on workstations, setup-node in CI
#   package.json devEngines      npm refuses to run on any other Node
#   Dockerfile, Dockerfile.backup  every `FROM node:` stage — what the VPS runs
#
# Renovate bumps them in one grouped PR, but nothing else holds them
# together: a split or hand-edited bump would leave dev, CI and the images on
# different Nodes with every check green.
#
# EXIT CODES
#   0  in sync
#   1  drift (each pin is printed)
#   2  structural problem — a file is missing, devEngines.runtime is not a
#      single `node` entry with a version, or a Dockerfile has no `FROM node:`
#      stage, which would otherwise pass as "no drift".
#
# Usage:
#   bash scripts/check-node-pin.sh
#
# The root is overridable so the self-test
# (scripts/__tests__/check-node-pin.test.sh) can stage mutated copies.

set -euo pipefail

ROOT="${PIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DOCKERFILES=(Dockerfile Dockerfile.backup)

for f in .nvmrc package.json "${DOCKERFILES[@]}"; do
  if [[ ! -f "$ROOT/$f" ]]; then
    echo "ERROR: $ROOT/$f not found." >&2
    exit 2
  fi
done

nvmrc="$(tr -d '[:space:]' <"$ROOT/.nvmrc")"

dev_engines="$(node -e '
  const r = require(process.argv[1]).devEngines?.runtime;
  if (r?.name === "node" && typeof r.version === "string") console.log(r.version);
' "$ROOT/package.json")"
if [[ -z "$dev_engines" ]]; then
  echo "ERROR: package.json devEngines.runtime must be { \"name\": \"node\", \"version\": ... }." >&2
  exit 2
fi

# "<file>:<tag version>" per `FROM node:<version>-<variant>` stage.
pins=(".nvmrc:$nvmrc" "package.json devEngines:$dev_engines")
for f in "${DOCKERFILES[@]}"; do
  versions="$(sed -nE 's/^FROM[[:space:]]+(--platform=[^[:space:]]+[[:space:]]+)?node:([^-@[:space:]]+).*/\2/p' "$ROOT/$f")"
  if [[ -z "$versions" ]]; then
    echo "ERROR: $f has no \`FROM node:\` stage." >&2
    exit 2
  fi
  while read -r v; do pins+=("$f:$v"); done <<<"$versions"
done

drift=0
for p in "${pins[@]}"; do
  [[ "${p##*:}" == "$nvmrc" ]] || drift=1
done

if ((drift)); then
  echo "::error::Node pin drift — these must all name the same version:" >&2
  printf '  %s\n' "${pins[@]}" >&2
  echo "Fix: set every pin to one version (Renovate's Node PR bumps them together)." >&2
  exit 1
fi
echo "Node pins in sync: $nvmrc"
