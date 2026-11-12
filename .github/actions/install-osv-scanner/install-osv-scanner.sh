#!/usr/bin/env bash
# Installs the pinned OSV-Scanner CLI to /usr/local/bin. See action.yml.
set -euo pipefail
# renovate: datasource=github-release-attachments depName=google/osv-scanner
version="v2.7.1"
expected_sha="fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8"
url="https://github.com/google/osv-scanner/releases/download/${version}/osv-scanner_linux_amd64"
code=$(curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 -w '%{http_code}' -o /tmp/osv-scanner "$url") \
  || { echo "::error::OSV-Scanner download failed (curl exit $?, HTTP ${code:-000}): $url"; exit 1; }
actual_sha=$(sha256sum /tmp/osv-scanner | awk '{print $1}')
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "::error::OSV-Scanner binary SHA256 mismatch — expected $expected_sha got $actual_sha"
  exit 1
fi
chmod +x /tmp/osv-scanner
sudo mv /tmp/osv-scanner /usr/local/bin/osv-scanner
osv-scanner --version
