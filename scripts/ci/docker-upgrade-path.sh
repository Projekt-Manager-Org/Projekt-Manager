#!/usr/bin/env bash
#
# Docker upgrade path (ADR-0009): what a host does when a pin bump merges,
# run in CI before it merges. A host never installs new pins fresh; it
# converges a running stack in place — existing images, containers and
# volumes, and a daemon restart that stops every container (no
# live-restore). Then, if the bump misbehaves, it converges back. Both
# directions run here, on the full stack including Caddy:
#
#   base pins: start the stack, write data markers, verify
#   PR pins:   converge → containers back on their own → redeploy → verify
#   base pins: converge back (the revert) → same
#
# "redeploy" is what deploy.sh does next on the host: build Caddy and
# `compose up` with the new Compose and BuildKit, against the containers,
# networks, volumes and build cache the old versions created. "verify" is
# scripts/ci/stack-smoke.sh: keys reloaded, health in the container and
# through Caddy on its published port, the backup pipeline, and the
# markers read back.
#
# Usage (from the repo root, as the `docker-upgrade` CI job runs it):
#   scripts/ci/docker-upgrade-path.sh <base-pins-file>
#
# Preconditions: the daemon already runs <base-pins-file> on the
# containerd image store (.github/actions/install-docker with
# DOCKER_PINS_FILE); the app + backup images are in the local store under
# APP_IMAGE_TAG; SMOKE_STATE_DIR is set (both read by stack-smoke.sh).
set -euo pipefail

BASE_PINS="${1:?usage: $0 <base-pins-file>}"
HEAD_PINS=docker/host-versions.txt
smoke=scripts/ci/stack-smoke.sh
export SMOKE_CADDY=1

# Without live-restore a converge stops every container, as on the VPS.
# A daemon with it would keep them running and test less than the host.
if [[ "$(docker info --format '{{.LiveRestoreEnabled}}')" != false ]]; then
  echo "::error::live-restore is enabled on this daemon; the hosts run without it"
  exit 1
fi
if cmp -s "$BASE_PINS" "$HEAD_PINS"; then
  echo "::notice::Pins unchanged against the base; both converges are no-ops"
fi

# Every service the restart policy must bring back, with no compose call:
# on the VPS nothing runs compose between the converge and deploy.sh.
# Running is enough here; `redeploy` and `verify` check that they work.
wait_containers_back() {
  local i svc down
  echo "::group::Containers back without compose? (up to 120s)"
  for i in $(seq 1 60); do
    down=()
    for svc in db storage app backup caddy; do
      [[ "$(docker inspect "projekt-manager-$svc-1" --format '{{.State.Running}}' 2>/dev/null)" == true ]] ||
        down+=("$svc")
    done
    if [[ ${#down[@]} -eq 0 ]]; then
      echo "  all running (attempt $i)"
      echo "::endgroup::"
      return 0
    fi
    echo "  attempt $i: not running: ${down[*]}"
    sleep 2
  done
  echo "::error::not back after the converge: ${down[*]}"
  return 1
}

converge_and_verify() {
  local label="$1" pins="$2"
  echo "::group::Converge to the $label pins"
  sudo DOCKER_PINS_FILE="$pins" scripts/ops/docker-converge.sh
  docker version --format 'Engine {{.Server.Version}}'
  docker compose version
  echo "::endgroup::"
  wait_containers_back
  "$smoke" redeploy
  "$smoke" verify
}

trap '"$smoke" stop' EXIT
"$smoke" start
"$smoke" mark
"$smoke" verify
converge_and_verify PR "$HEAD_PINS"
converge_and_verify base "$BASE_PINS"
