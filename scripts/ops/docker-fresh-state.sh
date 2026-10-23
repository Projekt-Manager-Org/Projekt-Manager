#!/usr/bin/env bash
# Fresh Docker state, named volumes kept: revert step 5c of the Docker bump
# runbook (docs/ops/server-setup.md § Upgrading pinned versions). For a
# failed containerd minor bump (upstream supports no downgrade), or when an
# apt downgrade left the daemon broken or without its images. The next
# deploy rebuilds images, containers and networks; named volumes (Postgres
# data) stay in place.
#
# Installs the pins of this checkout's docker/host-versions.txt. On the VPS,
# run deploy.sh <target> first: it checks out the target's pins and refuses
# at the drift guard.
#
# Order: stop, move the state aside, install the pins, start, check. The
# older binaries never start on state the newer ones wrote. The old state
# stays in <dir>.pre-revert-<timestamp> until the operator deletes it after
# acceptance.
#
# Usage:
#   sudo scripts/ops/docker-fresh-state.sh
#
# Exit codes: 0 fresh state in sync with the pins; 1 aborted or failed;
# 2 usage or not root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONVERGE="${DOCKER_CONVERGE:-$REPO_ROOT/scripts/ops/docker-converge.sh}"
DOCKER_ROOT="${DOCKER_ROOT:-/var/lib/docker}"
CONTAINERD_ROOT="${CONTAINERD_ROOT:-/var/lib/containerd}"
DAEMON_JSON="${DOCKER_DAEMON_JSON:-/etc/docker/daemon.json}"
START_ATTEMPTS="${DOCKER_START_ATTEMPTS:-30}" # 2s apart

if [[ $# -ne 0 ]]; then
  echo "usage: sudo $0" >&2
  exit 2
fi
if [[ "$(id -u)" != 0 ]]; then
  echo "error: run as root: sudo $0" >&2
  exit 2
fi
# A relocated root would leave the real state where the daemon reads it.
if [[ -f "$DAEMON_JSON" ]] && grep -q '"data-root"' "$DAEMON_JSON"; then
  echo "error: $DAEMON_JSON sets data-root; this script handles $DOCKER_ROOT only" >&2
  exit 1
fi
if [[ ! -d "$DOCKER_ROOT" ]]; then
  echo "error: $DOCKER_ROOT not found" >&2
  exit 1
fi
# A symlinked root: move the contents of its target, next to it.
DOCKER_ROOT="$(realpath -e "$DOCKER_ROOT")"

suffix=".pre-revert-$(date +%Y%m%d-%H%M%S)"
old_docker="$DOCKER_ROOT$suffix"
old_containerd="$CONTAINERD_ROOT$suffix"

echo "Pins to install, against this host:"
"$CONVERGE" --check || true
echo
echo "Disk headroom (the old state stays on this disk while fresh images are pulled):"
df -h "$DOCKER_ROOT"
df -i "$DOCKER_ROOT"
echo
echo "This stops Docker and every container, moves $CONTAINERD_ROOT and"
echo "everything in $DOCKER_ROOT except volumes/ to *$suffix, and installs"
echo "the pins above."
answer=""
read -r -p "Continue? [y/N] " answer || true # EOF keeps what was read
if [[ "$answer" != [yY] ]]; then
  echo "Aborted; nothing changed."
  exit 1
fi

# From here a failing command leaves Docker stopped and the state possibly
# half moved: say where everything is and how to go on.
# shellcheck disable=SC2317  # invoked via `trap on_error ERR`
on_error() {
  echo "error: stopped mid-procedure. Docker is stopped; do not start it before the pins are installed." >&2
  echo "State: $DOCKER_ROOT (volumes/ stays there); moved so far: $old_docker, $old_containerd" >&2
  echo "Inspect, then: sudo $CONVERGE --packages-only && sudo systemctl start containerd.service docker.service" >&2
}
trap on_error ERR

systemctl stop docker.socket docker.service containerd.service

# A crashed dockerd leaves its containers running under their shims
# (KillMode=process). A second Postgres on the same volume corrupts it.
if shims="$(pgrep -a '^containerd-shim')"; then
  trap - ERR
  echo "error: container processes survived the stop (dockerd crashed?):" >&2
  echo "$shims" >&2
  echo "Nothing was moved; Docker is stopped. Reboot the host (stops them cleanly), then re-run." >&2
  exit 1
fi

if [[ -e "$CONTAINERD_ROOT" ]]; then
  mv "$CONTAINERD_ROOT" "$old_containerd"
  moved="$old_docker $old_containerd"
else
  moved="$old_docker"
fi
mkdir "$old_docker"
find "$DOCKER_ROOT" -mindepth 1 -maxdepth 1 ! -name volumes -exec mv -t "$old_docker" {} +
left="$(find "$DOCKER_ROOT" -mindepth 1 -maxdepth 1 ! -name volumes)"
if [[ -n "$left" ]]; then
  on_error
  echo "error: $DOCKER_ROOT still holds: $left" >&2
  exit 1
fi
echo "Old state kept in: $moved"

# Before any daemon starts. When packages change, their postinst starts the
# daemon, on the now empty state.
if ! "$CONVERGE" --packages-only; then
  trap - ERR
  echo "error: installing the pins failed; Docker is stopped, old state kept in: $moved" >&2
  echo "Fix apt, then install the pins and start Docker:" >&2
  echo "  sudo $CONVERGE --packages-only" >&2
  echo "  sudo systemctl start containerd.service docker.service" >&2
  exit 1
fi

# --no-block: docker.service is Type=notify without a start timeout, so a
# blocking start could hang or fail before the poll below reports it.
systemctl start --no-block containerd.service docker.service
trap - ERR
attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if ((attempt >= START_ATTEMPTS)); then
    echo "error: the Docker daemon did not come up; old state kept in: $moved" >&2
    echo "See: journalctl -u docker.service -u containerd.service" >&2
    exit 1
  fi
  sleep 2
done

if ! "$CONVERGE" --check; then
  echo "error: fresh state is not in sync with the pins (above); old state kept in: $moved" >&2
  exit 1
fi

echo
echo "Fresh Docker state, in sync with the pins. Next:"
echo "  VPS:             sudo -u deploy /opt/projekt-manager/scripts/deploy.sh <target>"
echo "  dev workstation: docker compose up -d"
echo "Run the acceptance. Only after it passes:"
echo "  sudo rm -rf $moved"
