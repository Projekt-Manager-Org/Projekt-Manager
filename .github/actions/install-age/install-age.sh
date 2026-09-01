#!/usr/bin/env bash
# Installs the `age` and `age-keygen` binaries to /usr/bin from a
# SHA256-pinned upstream release tarball. Invoked by the sibling composite
# action (action.yml), which is called from ci.yml's `check-shard` and from
# e2e.yml.
#
# Lives in a real .sh file, not an inline `run:` block, so CI's shellcheck
# gate covers it: actionlint does not read composite action.yml files
# (forcing one in parses it as a workflow and reports `"jobs" section is
# missing`), and the gate's `find` only walks real scripts. Inline, this
# would be the repo's only checksum-verifying install that nothing lints.
#
# Single source of truth for the pin — `scripts/check-renovate-annotations.mjs`
# scans this file class and fails the build if the annotation below stops
# being matched by a Renovate customManager.
set -euo pipefail

# Upstream ships no checksum asset (only Sigsum `.proof` files), so the
# digest is the tarball's own SHA256 — which is what
# `github-release-attachments` resolves by hashing release assets when no
# checksum file matches.
#
# Nothing may sit between the annotation and `version=`: the customManager
# regex joins them with `\s+`, so an interposed comment silently drops the
# pin out of tracking. Prose goes ABOVE the annotation, as here.
# renovate: datasource=github-release-attachments depName=FiloSottile/age
version="v1.3.1"
expected_sha="bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377"
url="https://github.com/FiloSottile/age/releases/download/${version}/age-${version}-linux-amd64.tar.gz"
curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 -o /tmp/age.tar.gz "$url"
actual_sha=$(sha256sum /tmp/age.tar.gz | awk '{print $1}')
if [ "$actual_sha" != "$expected_sha" ]; then
  echo "::error::age tarball SHA256 mismatch — expected $expected_sha got $actual_sha"
  exit 1
fi

# Tarball roots at `age/`. Both binaries are needed: the suite shells out to
# `age-keygen`, the route layer to `age`.
#
# /usr/bin, NOT /usr/local/bin — the code resolves both by absolute path
# (AGE_KEYGEN_BIN in storage/binaryIdentity.ts, AGE_BINARY in
# services/KeyEnvelopeService.ts) so a hijacked PATH cannot swap the crypto
# binary. That makes the install location load-bearing: anywhere else and
# every wrap/unwrap fails with `spawn /usr/bin/age ENOENT`.
tar -xzf /tmp/age.tar.gz -C /tmp age/age-keygen age/age
sudo mv /tmp/age/age-keygen /tmp/age/age /usr/bin/
/usr/bin/age-keygen --version
/usr/bin/age --version
