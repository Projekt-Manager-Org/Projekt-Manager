#!/usr/bin/env bash
#
# Operator helper: load the binary-attachment age keyring — the active
# private identity plus every retired one — into the app container's
# tmpfs (docs/ops/binary-key/load.md § The paste).
#
# Invoked from the VPS as:
#   sudo -u deploy docker exec -it projekt-manager-app-1 load-binary-key
#
# Safety invariants enforced here (ADR-0024 §Operator workflow):
#   1. The destination directory MUST be a tmpfs mount. If a prior
#      compose edit accidentally dropped the tmpfs directive, this
#      script refuses to write — a persisted identity on the VPS disk
#      defeats the entire threat model.
#   2. The pasted material is validated by round-tripping through
#      age-keygen -y before anything is written; a malformed paste
#      (e.g., the operator copied the public recipient file instead of
#      the private identity) is rejected.
#   3. The derived recipients must equal BINARY_AGE_RECIPIENT plus
#      BINARY_AGE_RETIRED_RECIPIENTS as a set — the boot probe's check
#      (ADR-0024 § Key rotation). A missing key leaves everything wrapped
#      to it unreadable; an unlisted one is a mispaste (most often the
#      backup drill identity). Reject before the boot probe sees it.
#   4. The identity string lives in shell memory only for the duration
#      of this script; the variable is `unset` before exit. A
#      kernel-level secure-wipe of the memory pages is not attempted —
#      bash + libc do not provide that primitive, and pretending
#      otherwise would be a false assurance. `read -s` suppresses echo;
#      shell history doesn't capture variable contents.
#
# Output: one success line, no other stdout. Validation failures go to
# stderr. NEVER echo the pasted material.
set -euo pipefail

BINARY_DIR="/run/binary-key"
BINARY_FILE="${BINARY_DIR}/identity"

# --- Invariant 1: /run/binary-key MUST be a tmpfs mount --------------
#
# findmnt -T resolves the given path to its backing mount and prints
# the fstype. We accept only tmpfs. If findmnt isn't on this image for
# some reason, fall back to /proc/mounts.
fstype=""
if command -v findmnt >/dev/null 2>&1; then
  fstype="$(findmnt -T "$BINARY_DIR" -n -o FSTYPE 2>/dev/null || true)"
fi
if [[ -z "$fstype" ]]; then
  # /proc/mounts fallback: find the longest mount whose path is a
  # prefix of BINARY_DIR. A bare `index(p, mp) == 1` string-prefix
  # match is wrong: for BINARY_DIR="/run/binary-key" a mount at
  # "/run/binary" would match (as would "/run/binary-keyboard" if a
  # sibling mount existed). Require that the next character after the
  # match is either end-of-string (exact equality) or `/` (the path is
  # strictly inside that mount). Longest match wins — sort-by-length,
  # first hit.
  fstype="$(awk -v p="$BINARY_DIR" '
    {
      mp = $2
      mlen = length(mp)
      if (substr(p, 1, mlen) == mp \
          && (length(p) == mlen || substr(p, mlen + 1, 1) == "/") \
          && (mlen > best_len || best_len == 0)) {
        best_len = mlen
        best = $3
      }
    }
    END { print best }
  ' /proc/mounts)"
fi

if [[ "$fstype" != "tmpfs" ]]; then
  echo "ERROR: $BINARY_DIR is not a tmpfs mount (detected: ${fstype:-unknown})." >&2
  echo "       Refusing to write the identity to persistent storage." >&2
  echo "       Fix: check docker-compose.yml services.app.tmpfs directive." >&2
  exit 1
fi

# --- Invariant 3 preflight: BINARY_AGE_RECIPIENT must be set ---------
if [[ -z "${BINARY_AGE_RECIPIENT:-}" ]]; then
  echo "ERROR: BINARY_AGE_RECIPIENT not set in the app container env." >&2
  echo "       Cannot verify the pasted identity matches the deployed recipient." >&2
  exit 1
fi
# Shape check before the value can reach the mismatch error below — a
# private key put there by mistake must never be echoed.
RECIPIENT_RE='^age1[02-9ac-hj-np-z]{58}$'
if [[ ! "$BINARY_AGE_RECIPIENT" =~ $RECIPIENT_RE ]]; then
  echo "ERROR: BINARY_AGE_RECIPIENT is not a public age recipient. Fix the deploy's secrets.env.age." >&2
  exit 1
fi

# --- Prompt ----------------------------------------------------------
echo "Paste the binary keyring (active + retired identities), finish with Ctrl-D:"
# -s  suppress echo (no visible leak to the terminal)
# -r  raw mode (preserve backslashes in the pasted material)
# -d $'\004' use EOT (Ctrl-D) as the delimiter so multi-line paste works
#
# shellcheck disable=SC2162  # -r is passed; -s implies no visible echo
# which makes the absence of -r's "no backslash escape" warning moot
IDENTITY=""
if ! IFS= read -r -s -d $'\004' IDENTITY; then
  # Non-zero from read on EOF is expected with -d; only care if the
  # buffer is empty.
  :
fi
# Clear the prompt line so `ps` / terminal scrollback don't linger on
# it. The value is already out-of-band in $IDENTITY.
printf '\n'

if [[ -z "$IDENTITY" ]]; then
  echo "ERROR: empty input — nothing written." >&2
  unset IDENTITY
  exit 1
fi

# --- Invariant 2 + 3: validate in memory, before any write ----------
# age-keygen -y reads the keyring from stdin (no argv exposure) and
# prints one derived public recipient per identity; malformed input
# exits non-zero. Nothing touches the tmpfs until the paste is valid, so
# the boot probe never sees an unvalidated file and a bad paste leaves
# an already-loaded keyring in place.
derived=""
if ! derived="$(printf '%s' "$IDENTITY" | age-keygen -y 2>/dev/null)" || [[ -z "$derived" ]]; then
  unset IDENTITY derived
  echo "ERROR: pasted material does not parse as a valid age identity." >&2
  echo "       Expected the file produced by 'age-keygen -o ...' —" >&2
  echo "       the one containing a line 'AGE-SECRET-KEY-1...'. Nothing persisted." >&2
  exit 1
fi

# Expected set, parsed exactly as the env schema does: the active
# recipient verbatim; the retired list split on commas, each entry
# trimmed, an empty value meaning none. A malformed entry is refused
# without echoing it — it may be a private key pasted by mistake. The
# recipients are public; naming them in the mismatch error below is safe
# and tells the operator which custody copy is missing or extra.
expected="$BINARY_AGE_RECIPIENT"
if [[ -n "${BINARY_AGE_RETIRED_RECIPIENTS:-}" ]]; then
  IFS=',' read -r -a retired_entries <<<"${BINARY_AGE_RETIRED_RECIPIENTS},"
  for entry in "${retired_entries[@]}"; do
    entry="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' <<<"$entry")"
    if [[ ! "$entry" =~ $RECIPIENT_RE ]]; then
      unset IDENTITY derived
      echo "ERROR: BINARY_AGE_RETIRED_RECIPIENTS holds an entry that is not a public age recipient." >&2
      echo "       Fix the deploy's secrets.env.age. Nothing persisted." >&2
      exit 1
    fi
    expected+=$'\n'"$entry"
  done
fi
expected="$(printf '%s\n' "$expected" | sort -u)"
derived="$(printf '%s\n' "$derived" | sort -u)"
missing="$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$derived"))"
unlisted="$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$derived"))"
if [[ -n "$missing" || -n "$unlisted" ]]; then
  unset IDENTITY derived
  echo "ERROR: the pasted keyring does not match BINARY_AGE_RECIPIENT + BINARY_AGE_RETIRED_RECIPIENTS." >&2
  if [[ -n "$missing" ]]; then
    while read -r r; do echo "       missing:  $r"; done <<<"$missing" >&2
  fi
  if [[ -n "$unlisted" ]]; then
    while read -r r; do echo "       unlisted: $r"; done <<<"$unlisted" >&2
  fi
  echo "       Nothing persisted." >&2
  exit 1
fi

# --- Write to tmpfs, atomically --------------------------------------
# Write a temp file on the same tmpfs, then rename it into place: the
# probe sees either the previous file or the complete new one. The trap
# wipes the temp file on any exit short of success. umask 0077 so a race
# between creat() and chmod() cannot expose it to other UIDs.
TMP_FILE="${BINARY_FILE}.tmp.$$"
trap 'rm -f "$TMP_FILE"; unset IDENTITY; exit 1' ERR HUP INT TERM
umask 0077
printf '%s' "$IDENTITY" > "$TMP_FILE"
chmod 0400 "$TMP_FILE"
mv -f "$TMP_FILE" "$BINARY_FILE"
trap - ERR HUP INT TERM

# Clear the in-memory copy; the tmpfs file is the only remaining holder.
unset IDENTITY derived

echo "Binary keyring loaded. Boot probe will accept on next poll."
