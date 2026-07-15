#!/usr/bin/env bash
#
# Bootstrap the local-dev binary `age` identity (ADR-0024).
#
# In production the operator pastes a real keypair into a tmpfs mount
# inside the app container (see scripts/binary-key/load-binary-key.sh
# and docs/ops/binary-key/load.md). In local dev there is no
# operator and no tmpfs — the boot probe still fires, so we need a
# persistent keypair on the host filesystem. This script is the dev-
# loop equivalent of the operator paste:
#
#   - generates an age keypair at $BINARY_AGE_IDENTITY_PATH if absent
#     (default: ~/.local/share/projekt-manager/binary-identity-dev);
#   - never overwrites an existing identity (idempotent);
#   - writes the matching BINARY_AGE_RECIPIENT / BINARY_AGE_IDENTITY_PATH
#     lines into .env after an explicit y/N confirmation, so a fresh
#     `cp .env.example .env` followed by this script unblocks
#     `npm run dev` in two commands with no manual copy/paste.
#
# This identity protects nothing of value (test data only). It exists
# purely to satisfy the boot probe with the same shape the production
# code path uses, so the dev loop exercises the real probe contract.
#
# Usage:
#   scripts/binary-key/init-local-key.sh
#
# Override the path:
#   BINARY_AGE_IDENTITY_PATH=/some/other/path scripts/binary-key/init-local-key.sh
#
# Override the target .env file:
#   ENV_FILE=/some/other/.env scripts/binary-key/init-local-key.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

DEFAULT_PATH="${HOME}/.local/share/projekt-manager/binary-identity-dev"
IDENTITY_PATH="${BINARY_AGE_IDENTITY_PATH:-$DEFAULT_PATH}"

if ! command -v age-keygen >/dev/null 2>&1; then
  echo "ERROR: age-keygen not found in PATH. Install age — see CONTRIBUTING.md § Runtime Requirements." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Run 'cp .env.example .env' first." >&2
  exit 1
fi

mkdir -p "$(dirname "$IDENTITY_PATH")"

if [[ -s "$IDENTITY_PATH" ]]; then
  echo "Identity already present at $IDENTITY_PATH — leaving in place."
else
  # Mode 0600 — no other uid on the host should read it. Production
  # uses 0400 with a privileged loader; the dev account is its own
  # loader so the writable bit on the owner is fine.
  umask 0077
  age-keygen -o "$IDENTITY_PATH" >/dev/null 2>&1
  chmod 0600 "$IDENTITY_PATH"
  echo "Generated dev identity at $IDENTITY_PATH (mode 0600)."
fi

# `age-keygen -y` re-derives the public recipient deterministically
# from the private file — same call shape `load-binary-key.sh` uses
# for its round-trip validation.
RECIPIENT="$(age-keygen -y "$IDENTITY_PATH")"

CURRENT_RECIPIENT="$(grep -m1 '^BINARY_AGE_RECIPIENT=' "$ENV_FILE" | cut -d= -f2- || true)"
CURRENT_IDENTITY_PATH="$(grep -m1 '^BINARY_AGE_IDENTITY_PATH=' "$ENV_FILE" | cut -d= -f2- || true)"

if [[ "$CURRENT_RECIPIENT" == "$RECIPIENT" && "$CURRENT_IDENTITY_PATH" == "$IDENTITY_PATH" ]]; then
  echo "$ENV_FILE already has the matching BINARY_AGE_* values — nothing to do."
  echo "Start the dev stack: npm run dev"
  exit 0
fi

echo
echo "About to write to $ENV_FILE:"
echo
echo "  BINARY_AGE_RECIPIENT=$RECIPIENT"
echo "  BINARY_AGE_IDENTITY_PATH=$IDENTITY_PATH"
echo
if [[ -n "$CURRENT_RECIPIENT" || -n "$CURRENT_IDENTITY_PATH" ]]; then
  echo "This overwrites the existing values:"
  echo "  BINARY_AGE_RECIPIENT=$CURRENT_RECIPIENT"
  echo "  BINARY_AGE_IDENTITY_PATH=$CURRENT_IDENTITY_PATH"
  echo
fi

read -r -p "Write these values into $ENV_FILE? [y/N] " REPLY
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "Aborted — no changes made. Paste the values above into $ENV_FILE manually if needed."
  exit 1
fi

TMP_FILE="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

awk -v recipient="BINARY_AGE_RECIPIENT=$RECIPIENT" \
    -v identity="BINARY_AGE_IDENTITY_PATH=$IDENTITY_PATH" '
  /^BINARY_AGE_RECIPIENT=/ { print recipient; found_r=1; next }
  /^BINARY_AGE_IDENTITY_PATH=/ { print identity; found_i=1; next }
  { print }
  END {
    if (!found_r) print recipient
    if (!found_i) print identity
  }
' "$ENV_FILE" > "$TMP_FILE"

mv "$TMP_FILE" "$ENV_FILE"
trap - EXIT

echo "Wrote BINARY_AGE_RECIPIENT and BINARY_AGE_IDENTITY_PATH into $ENV_FILE."
echo "Start the dev stack: npm run dev"
