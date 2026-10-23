#!/usr/bin/env bash
# Brings this host's Docker packages to the pins in docker/host-versions.txt
# and holds them there (ADR-0009). One path for every host: dev
# workstations and the VPS.
#
# Usage:
#   sudo scripts/ops/docker-converge.sh                   # converge; a no-op when in sync
#   scripts/ops/docker-converge.sh --check                # report drift only, never installs
#   sudo scripts/ops/docker-converge.sh --packages-only   # pins only, no image-store check
#
# --packages-only is for scripts/ops/docker-fresh-state.sh, which installs
# the pins while the daemon is deliberately stopped and checks the store
# itself once the daemon runs.
#
# "In sync" means every pinned package is installed at exactly its pinned
# version AND the daemon runs the containerd image store, which the hosts
# got as the Engine 29 fresh-install default. An in-place upgrade from an
# older Engine keeps the overlay2 graph driver instead, so matching versions
# alone do not guarantee the same storage backend.
#
# `--check` is the deploy.sh drift guard (refuse to deploy) and the
# pre-push warning. It needs no root.
#
# A converge that moves docker-ce or containerd.io restarts the Docker
# daemon (package postinst), which stops every container and wipes tmpfs
# mounts. On the VPS, re-run deploy.sh afterwards to reload the binary and
# drill keys.
#
# The image store is checked, never switched: apt cannot change it, and a
# switch hides every existing image and container. Store drift alone is
# reported with the manual remediation.
#
# Exit codes: 0 in sync, 2 bad pins file/usage, 1 drift (check) or a host
# converge could not fix; a failing apt run exits with apt's own code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PINS_FILE="${DOCKER_PINS_FILE:-$REPO_ROOT/docker/host-versions.txt}"
WANT_STORE="io.containerd.snapshotter.v1"

mode=converge
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  --packages-only) mode=packages ;;
  *)
    echo "usage: $0 [--check | --packages-only]" >&2
    exit 2
    ;;
esac

pkgs=()
vers=()
[[ -r "$PINS_FILE" ]] || {
  echo "error: cannot read $PINS_FILE" >&2
  exit 2
}
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ ! "$line" =~ ^([a-z0-9][a-z0-9.+-]*)=([A-Za-z0-9.+:~-]+)$ ]]; then
    echo "error: $PINS_FILE: not <package>=<version>: $line" >&2
    exit 2
  fi
  pkgs+=("${BASH_REMATCH[1]}")
  vers+=("${BASH_REMATCH[2]}")
done <"$PINS_FILE"
if [[ ${#pkgs[@]} -eq 0 ]]; then
  echo "error: $PINS_FILE pins no packages" >&2
  exit 2
fi

# Each prints one line per drifted item, nothing when in sync.
pkg_drift() {
  local i installed
  for i in "${!pkgs[@]}"; do
    # shellcheck disable=SC2016  # dpkg-query format, not a shell expansion
    installed="$(dpkg-query -W -f='${db:Status-Status} ${Version}' "${pkgs[i]}" 2>/dev/null)" ||
      installed="not-installed"
    if [[ "$installed" != "installed ${vers[i]}" ]]; then
      echo "  ${pkgs[i]}: have '${installed#installed }', pinned '${vers[i]}'"
    fi
  done
}
store_drift() {
  local store
  [[ "$mode" != packages ]] || return 0
  store="$(docker info --format '{{json .DriverStatus}}' 2>/dev/null)" || store=""
  if [[ -z "$store" ]]; then
    echo "  daemon: unreachable (stopped, or no permission), so the image store is unknown"
  elif [[ "$store" != *"$WANT_STORE"* ]]; then
    echo "  image store: have '$store', want containerd ($WANT_STORE)"
  fi
}

DAEMON_FIX="Fix: start the daemon (sudo systemctl start docker.service), or run as root or a docker-group member; then re-run with --check"
STORE_FIX="Fix: set \"features\": {\"containerd-snapshotter\": true} in /etc/docker/daemon.json and restart dockerd -- existing images and containers become invisible, volumes stay (https://docs.docker.com/engine/storage/containerd/)"

# The daemon-down advice when the daemon is unreachable; the store switch
# only when it runs on the wrong store.
store_fix() {
  if [[ "$store_report" == *"daemon: unreachable"* ]]; then echo "$DAEMON_FIX"; else echo "$STORE_FIX"; fi
}

pkg_report="$(pkg_drift)"
store_report="$(store_drift)"

if [[ -z "$pkg_report$store_report" ]]; then
  echo "Docker host matches $PINS_FILE"
  exit 0
fi
echo "Docker host drifted from $PINS_FILE:"
[[ -z "$pkg_report" ]] || echo "$pkg_report"
[[ -z "$store_report" ]] || echo "$store_report"

if [[ "$mode" == check ]]; then
  [[ -z "$pkg_report" ]] || echo "Fix: sudo $REPO_ROOT/scripts/ops/docker-converge.sh"
  [[ -z "$store_report" ]] || store_fix
  exit 1
fi

if [[ -z "$pkg_report" ]]; then
  store_fix >&2
  exit 1
fi

# All pins in one call, so the five packages move in lockstep. Downgrades
# and held packages are allowed: the previous converge held them, and a
# revert moves back to older pins.
pinned=()
for i in "${!pkgs[@]}"; do
  pinned+=("${pkgs[i]}=${vers[i]}")
done
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  --allow-downgrades --allow-change-held-packages "${pinned[@]}"
apt-mark hold "${pkgs[@]}"

pkg_report="$(pkg_drift)"
store_report="$(store_drift)"
if [[ -n "$pkg_report$store_report" ]]; then
  echo "error: still drifted after install:" >&2
  [[ -z "$pkg_report" ]] || echo "$pkg_report" >&2
  [[ -z "$store_report" ]] || { echo "$store_report"; store_fix; } >&2
  exit 1
fi
if [[ "$mode" == packages ]]; then
  echo "Docker packages converged to $PINS_FILE."
else
  echo "Docker host converged to $PINS_FILE. If the daemon restarted,"
  echo "re-run deploy.sh on the VPS to reload the binary and drill keys."
fi
