#!/usr/bin/env bash
# Brings the runner's Docker to the pins in docker/host-versions.txt, on
# the containerd image store. Invoked by the sibling composite action
# (action.yml); see its description for where and why.
#
# Lives in a real .sh file, not an inline `run:` block, so CI's shellcheck
# gate covers it: actionlint does not read composite action.yml files.
set -euo pipefail

# Docker's release signing key, as published in its install docs. The
# runner image installs Docker from this repo but deletes the apt source
# and the key afterwards, so both are re-added here. Only the key with the
# pinned fingerprint is exported into the keyring apt trusts: checking the
# downloaded file's first key would let an extra key ride along.
key_fpr="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 \
  -o /tmp/docker.asc https://download.docker.com/linux/ubuntu/gpg
GNUPGHOME=$(mktemp -d)
export GNUPGHOME
gpg --batch --quiet --import /tmp/docker.asc
gpg --batch --export "$key_fpr" >/tmp/docker.gpg
if [ ! -s /tmp/docker.gpg ]; then
  echo "::error::Docker apt key with fingerprint $key_fpr not found in the downloaded key file"
  exit 1
fi
sudo install -m 0755 -d /etc/apt/keyrings
sudo install -m 0644 /tmp/docker.gpg /etc/apt/keyrings/docker.gpg
codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" |
  sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

# The hosts run the containerd image store, the Engine 29 fresh-install
# default. The runner's daemon was installed as Engine 28 on overlay2, and
# an upgraded daemon keeps overlay2, so enable the store explicitly. Merge
# rather than overwrite: the runner may ship its own daemon.json. The
# restart applies it even when the package install below is a no-op.
daemon_json=/etc/docker/daemon.json
current='{}'
if [ -s "$daemon_json" ]; then current=$(sudo cat "$daemon_json"); fi
jq '.features["containerd-snapshotter"] = true' <<<"$current" | sudo tee "$daemon_json" >/dev/null
sudo systemctl restart docker

sudo bash "${GITHUB_WORKSPACE}/scripts/ops/docker-converge.sh"
docker version --format 'Engine {{.Server.Version}}'
docker compose version
docker buildx version
