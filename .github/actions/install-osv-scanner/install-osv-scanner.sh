#!/usr/bin/env bash
# Installs the pinned OSV-Scanner CLI to /usr/local/bin. See action.yml.
set -euo pipefail
# renovate: datasource=github-release-attachments depName=google/osv-scanner
version="v2.7.0"
expected_sha="160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b"
url="https://github.com/google/osv-scanner/releases/download/${version}/osv-scanner_linux_amd64"
curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 -o /tmp/osv-scanner "$url"
actual_sha=$(sha256sum /tmp/osv-scanner | awk '{print $1}')
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "::error::OSV-Scanner binary SHA256 mismatch — expected $expected_sha got $actual_sha"
  exit 1
fi
chmod +x /tmp/osv-scanner
sudo mv /tmp/osv-scanner /usr/local/bin/osv-scanner
osv-scanner --version
