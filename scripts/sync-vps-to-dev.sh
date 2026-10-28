#!/usr/bin/env bash
#
# Destructively overwrite the local dev Postgres database and MinIO bucket
# with whatever is currently on the VPS. Mirror of scripts/sync-dev-to-vps.sh
# for the opposite direction. See docs/ops/sync-vps-to-dev.md for the
# runbook, preconditions, and failure modes.
#
# Why this exists: reproducing a VPS-only bug locally, or resetting dev to
# a known-good deployed state without manually recreating users +
# re-uploading attachments.
#
# Topology note: prod's bucket is on Backblaze B2 since ddff944 (ADR-0022);
# the VPS-side dump helper reads B2 credentials from the running app
# container's env and pulls the bucket via mc. The local restore writes
# into the dev MinIO mirror (docker-compose.minio.yml).
#
# Binaries stay usable on dev (#632): the DEK envelopes are re-wrapped to
# the dev recipient on the VPS, inside the app container that holds the
# operator-loaded identity (scripts/ops/rewrap-dek-envelopes.sh); only the
# dev public recipient crosses SSH. The objects are written to MinIO with
# metadata rebuilt from the restored rows and the dev invoice lock, and
# the rows point at the new MinIO versions
# (scripts/ops/restore-bucket-objects.py). Hidden (Papierkorb) rows are
# dropped: the bucket dump holds no bytes for them.
#
# Usage:
#   scripts/sync-vps-to-dev.sh            # runs preflight only, then refuses
#   scripts/sync-vps-to-dev.sh --i-know   # proceeds after preflight
#
# Preconditions (enforced):
#   - ssh hetzner is reachable as the deploy user
#   - local docker compose stack has `db` and `storage` running (the
#     `storage` service is the dev MinIO mirror)
#   - the baseline migration hash matches between local and VPS, and the
#     VPS DB's baseline ledger entry matches it
#   - the VPS DB has at least one user (would be pointless to pull an
#     empty/uninitialised DB over the top of local)
#   - the VPS app has its binary identity loaded; .env carries the dev
#     BINARY_AGE_RECIPIENT; python3 with boto3 is installed
#
# What gets overwritten on LOCAL:
#   - Postgres database `projekt_manager` (all tables DROPped and recreated)
#   - Local MinIO bucket `projekt-manager` (every synced object written as
#     a new version; objects absent on VPS get a delete marker)
#
# Stopping `npm run dev` first is optional. The script terminates any
# stray connections to projekt_manager before the DROP TABLE statements
# run; the dev app's pool absorbs the resulting client errors via the
# 'error' handler in src/server/db/connection.ts (attachPoolErrorHandler).
# Restart `npm run dev` afterwards if you want a clean log — the watch
# process keeps running, but transient query errors from the kill
# window will appear in its output before pool reconnect kicks in.

set -euo pipefail

SSH_TARGET="${SSH_TARGET:-hetzner}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Local MinIO bucket name — the VPS bucket name lives in the VPS app
# container's env (read by scripts/ops/sync-dump-vps.sh) since prod is
# Backblaze B2 with an operator-chosen bucket name (typically
# `prmng-object-storage`).
LOCAL_BUCKET="projekt-manager"
COMPOSE_PROJECT="projekt-manager"
# Must match docker/init-storage.sh. Used on the VPS for the bucket dump.
# Tag drift would break it silently; kept literal to match the forward
# script.
MC_IMAGE="ghcr.io/projekt-manager-org/mc:RELEASE.2025-08-13T08-35-41Z@sha256:eb4ea9884b77704230e2423e9004d2fa738dc272876b9cc41a297d29443b8780"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_TMP="/tmp/pm-rsync-$TS"
REMOTE_TMP="/tmp/pm-rsync-$TS"
REMOTE_SCRIPT="$REPO_DIR/scripts/ops/sync-dump-vps.sh"
REWRAP_SCRIPT="$REPO_DIR/scripts/ops/rewrap-dek-envelopes.sh"
# Where the operator-loaded identity lives in the VPS app container
# (ADR-0024).
VPS_AGE_IDENTITY_PATH="/run/binary-key/identity"

I_KNOW=0
for arg in "$@"; do
  case "$arg" in
    --i-know) I_KNOW=1 ;;
    -h|--help)
      sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

# Set once the VPS dump starts; before that there is nothing to remove there.
REMOTE_DUMP_STARTED=0
cleanup() {
  rm -rf "$LOCAL_TMP" 2>/dev/null || true
  [ "$REMOTE_DUMP_STARTED" = 1 ] || return 0
  # Loud on failure: a dump left behind is staging data outside the app.
  ssh -o BatchMode=yes "$SSH_TARGET" "rm -rf $REMOTE_TMP" \
    || echo "WARN: could not remove $SSH_TARGET:$REMOTE_TMP — remove it by hand." >&2
}
trap cleanup EXIT

echo "[1/10] SSH preflight ($SSH_TARGET)..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" true

echo "[2/10] Local stack check..."
# The dev `.env` sets COMPOSE_FILE so bare `docker compose` picks up the dev
# overlay triple automatically — no `-f` flags needed here.
cd "$REPO_DIR"
running_services=$(docker compose ps --services --status running 2>/dev/null || true)
for svc in db storage; do
  if ! echo "$running_services" | grep -qx "$svc"; then
    echo "ERROR: local service '$svc' is not running." >&2
    echo "  Start the dev stack:" >&2
    echo "    docker compose up -d" >&2
    exit 1
  fi
done

echo "[3/10] Schema parity check..."
local_hash=$(sha256sum "$REPO_DIR/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')
vps_hash=$(ssh "$SSH_TARGET" "sha256sum /opt/projekt-manager/src/server/db/migrations/0000_baseline.sql" | awk '{print $1}')
if [ "$local_hash" != "$vps_hash" ]; then
  cat <<ERR >&2
ERROR: schema hash mismatch — VPS and local are on incompatible schemas.
  local: $local_hash
  vps:   $vps_hash
Check out the matching commit locally (or deploy the matching commit to
the VPS) and retry.
ERR
  exit 1
fi

# Mirror of the forward script's "local DB non-empty" guard: refuse to
# pull from an empty/uninitialised VPS, which would silently wipe local
# state for nothing.
vps_users=$(ssh "$SSH_TARGET" \
  "docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc 'SELECT COUNT(*) FROM users;' 2>/dev/null || echo 0")
if [ -z "$vps_users" ] || [ "$vps_users" -lt 1 ]; then
  echo "ERROR: VPS users table is empty or DB is not initialised — nothing to pull." >&2
  exit 1
fi

# Mirror of the forward script's ledger guard (#644): a VPS DB built on an
# older baseline would overwrite dev, ledger row included, and dev would
# learn only at its next boot.
vps_ledger=$(ssh "$SSH_TARGET" \
  "docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc 'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id ASC LIMIT 1;' 2>/dev/null" \
  | tr -d '[:space:]' || true)
if [ "$vps_ledger" != "$local_hash" ]; then
  cat <<ERR >&2
ERROR: baseline schema mismatch — VPS DB ledger does not match 0000_baseline.sql.
  expected (file): $local_hash
  recorded (db):   ${vps_ledger:-<empty or unreadable>}
The VPS DB was built on another baseline. Recover it first:
see docs/ops/recover-from-schema-change.md.
ERR
  exit 1
fi

echo "[4/10] Binary key and restore prerequisites..."
# The VPS re-wraps every DEK envelope to the dev recipient (step [7/10])
# with its operator-loaded identity; without it nothing on dev would
# decrypt. Checked here so a missing paste fails before anything local
# is touched.
if ! ssh "$SSH_TARGET" \
  "docker exec ${COMPOSE_PROJECT}-app-1 test -r $VPS_AGE_IDENTITY_PATH"; then
  echo "ERROR: the VPS app has no readable binary identity at $VPS_AGE_IDENTITY_PATH." >&2
  echo "  Load it (docs/ops/binary-key/load.md), then retry." >&2
  exit 1
fi
# The dev recipient is the one the dev app wraps new DEKs to. Public —
# fine to send over SSH. It must belong to the dev identity, or every
# envelope would be validly wrapped to a key dev does not hold. Values are
# not echoed: a pasted private key is the mistake these checks catch.
DEV_AGE_RECIPIENT=$(grep -E '^BINARY_AGE_RECIPIENT=' "$REPO_DIR/.env" | cut -d= -f2- || true)
if ! [[ "$DEV_AGE_RECIPIENT" =~ ^age1[02-9ac-hj-np-z]{58}$ ]]; then
  echo "ERROR: BINARY_AGE_RECIPIENT in .env is missing or not an age X25519 recipient." >&2
  exit 1
fi
DEV_AGE_IDENTITY_PATH=$(grep -E '^BINARY_AGE_IDENTITY_PATH=' "$REPO_DIR/.env" | cut -d= -f2- || true)
if [ -z "$DEV_AGE_IDENTITY_PATH" ] || [ ! -r "$DEV_AGE_IDENTITY_PATH" ]; then
  echo "ERROR: BINARY_AGE_IDENTITY_PATH from .env is missing or unreadable: $DEV_AGE_IDENTITY_PATH" >&2
  exit 1
fi
if ! age-keygen -y "$DEV_AGE_IDENTITY_PATH" | grep -qxF "$DEV_AGE_RECIPIENT"; then
  echo "ERROR: BINARY_AGE_RECIPIENT in .env does not belong to the identity at $DEV_AGE_IDENTITY_PATH." >&2
  exit 1
fi
# Everything the object restore ([9/10]) needs is read here, so a bad
# value fails before the local DB is overwritten. The restore locks each
# synced invoice PDF for the dev app's INVOICE_OBJECT_LOCK_DAYS, as on
# issuance; empty means 0, as in the app.
DEV_INVOICE_LOCK_DAYS=$(grep -E '^INVOICE_OBJECT_LOCK_DAYS=' "$REPO_DIR/.env" | cut -d= -f2- || true)
DEV_INVOICE_LOCK_DAYS="${DEV_INVOICE_LOCK_DAYS:-0}"
if ! [[ "$DEV_INVOICE_LOCK_DAYS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: INVOICE_OBJECT_LOCK_DAYS in .env is not an integer: $DEV_INVOICE_LOCK_DAYS" >&2
  exit 1
fi
# Endpoint from .env (the dev app's own); root credentials from the
# running local storage container.
LOCAL_STORAGE_ENDPOINT=$(grep -E '^STORAGE_ENDPOINT=' "$REPO_DIR/.env" | cut -d= -f2- || true)
if [ -z "$LOCAL_STORAGE_ENDPOINT" ]; then
  echo "ERROR: STORAGE_ENDPOINT is missing from .env." >&2
  exit 1
fi
LOCAL_MINIO_USER=$(docker exec "${COMPOSE_PROJECT}-storage-1" printenv MINIO_ROOT_USER)
LOCAL_MINIO_PASS=$(docker exec "${COMPOSE_PROJECT}-storage-1" printenv MINIO_ROOT_PASSWORD)
if ! python3 -c 'import boto3' 2>/dev/null; then
  echo "ERROR: python3 with boto3 is required (python3-boto3, CONTRIBUTING.md § Runtime Requirements)." >&2
  exit 1
fi

if [ "$I_KNOW" != "1" ]; then
  cat <<MSG >&2
Preflight passed.

This command will DESTRUCTIVELY OVERWRITE LOCAL:
  - Postgres database: projekt_manager (all tables dropped and recreated)
  - MinIO bucket:      $LOCAL_BUCKET (objects absent on VPS get a delete
                       marker; invoice PDFs are locked for
                       INVOICE_OBJECT_LOCK_DAYS=$DEV_INVOICE_LOCK_DAYS (.env))

Any local-only state will be lost. Stop 'npm run dev' first to release
DB connections, and restart it afterwards.

Re-run with --i-know to proceed.
MSG
  exit 1
fi

mkdir -p "$LOCAL_TMP"

echo "[5/10] Dumping VPS state..."
# Stream the remote dump script over SSH — same pattern as the forward
# script's restore helper. Env vars pass configuration. The script writes
# db.sql and bucket/ under $REMOTE_TMP on the VPS.
REMOTE_DUMP_STARTED=1
ssh "$SSH_TARGET" \
  "REMOTE_TMP='$REMOTE_TMP' MC_IMAGE='$MC_IMAGE' COMPOSE_PROJECT='$COMPOSE_PROJECT' bash -s" \
  < "$REMOTE_SCRIPT"

echo "[6/10] Transferring from VPS..."
rsync -az "$SSH_TARGET:$REMOTE_TMP/" "$LOCAL_TMP/"

echo "[7/10] Re-wrapping DEK envelopes to the dev recipient (on VPS)..."
# Canonical envelope re-encryption, run where the source identity lives:
# streamed to the VPS, `age` runs inside the app container, so the
# plaintext DEK never leaves it. The UPDATEs land after the dump in
# db.sql, so the restore applies them in the same psql pass.
vps_envelopes=$(ssh "$SSH_TARGET" \
  "docker exec ${COMPOSE_PROJECT}-db-1 psql -U pm -d projekt_manager -tAc 'SELECT COUNT(*) FROM attachments WHERE wrapped_dek IS NOT NULL;'")
ssh "$SSH_TARGET" \
  "COMPOSE_PROJECT='$COMPOSE_PROJECT' AGE_CONTAINER='${COMPOSE_PROJECT}-app-1' BINARY_AGE_IDENTITY_PATH='$VPS_AGE_IDENTITY_PATH' TARGET_RECIPIENT='$DEV_AGE_RECIPIENT' bash -s" \
  < "$REWRAP_SCRIPT" > "$LOCAL_TMP/rewrap.sql"
# Catches a re-wrap that stopped short: a row left out would keep an
# envelope dev cannot open, and nothing later would say so. A concurrent
# upload fails it too — retry. Both counts are live, so a row deleted
# after the [5/10] snapshot is not caught (docs/ops/sync-vps-to-dev.md).
rewrapped=$(wc -l < "$LOCAL_TMP/rewrap.sql")
if [ "$rewrapped" != "$vps_envelopes" ]; then
  echo "ERROR: re-wrapped $rewrapped of $vps_envelopes envelopes — retry." >&2
  exit 1
fi
cat "$LOCAL_TMP/rewrap.sql" >> "$LOCAL_TMP/db.sql"
echo "      envelopes: $rewrapped"
echo "      db.sql: $(du -h "$LOCAL_TMP/db.sql" | awk '{print $1}')"
echo "      bucket: $(du -sh "$LOCAL_TMP/bucket" | awk '{print $1}') ($(find "$LOCAL_TMP/bucket" -type f | wc -l) files)"

echo "[8/10] Restoring local database..."
# Terminate any other backend connections to projekt_manager before the
# restore — a running `npm run dev` holds a connection pool that would
# otherwise race `pg_dump --clean`'s DROP TABLE statements. The exclusion
# of pg_backend_pid() spares our own admin connection.
#
# The dev app survives this kill because the pool in
# src/server/db/connection.ts installs the canonical 'error' listener
# (attachPoolErrorHandler) — without it the idle-client error from
# pg_terminate_backend would crash the tsx watch process and force a
# manual `npm run dev` restart on every sync. Same contract the prod
# side relies on in scripts/ops/sync-restore-vps.sh.
docker exec "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d postgres -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='projekt_manager' AND pid <> pg_backend_pid();" \
  >/dev/null

docker exec -i "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 --quiet \
  < "$LOCAL_TMP/db.sql" >/dev/null

# Drop hidden attachments, as sync-restore-vps.sh does for the forward
# direction: the bucket dump (`mc cp`) is not version-aware, so a
# hidden row's delete-markered object arrives without bytes. The
# attachments_storage_usage_delta trigger keeps the usage side-table
# consistent.
docker exec "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 -tAc \
  "DELETE FROM attachments WHERE status = 'hidden';" \
  >/dev/null

echo "[9/10] Restoring local object storage..."
# Write the bucket dump to local MinIO, each object with its metadata
# rebuilt from the restored row (#632, as #627 for the forward
# direction): the plain directory holds none, and the VPS metadata
# carried envelopes wrapped to the VPS key anyway. The helper writes new
# versions and delete markers only, and emits the UPDATEs that point
# version_id / thumb_version_id at the MinIO versions — the B2 ids from
# the dump mean nothing here. Connection values were read in [4/10].
docker exec -i "${COMPOSE_PROJECT}-db-1" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 -tA -F $'\t' \
  < "$REPO_DIR/scripts/ops/restore-bucket-objects.sql" > "$LOCAL_TMP/objects.tsv"
B2_ENDPOINT="$LOCAL_STORAGE_ENDPOINT" \
B2_BUCKET="$LOCAL_BUCKET" \
B2_KEY="$LOCAL_MINIO_USER" \
B2_SECRET="$LOCAL_MINIO_PASS" \
SOURCE_DIR="$LOCAL_TMP/bucket" \
INVOICE_OBJECT_LOCK_DAYS="$DEV_INVOICE_LOCK_DAYS" \
OBJECTS_TSV="$LOCAL_TMP/objects.tsv" \
  python3 "$REPO_DIR/scripts/ops/restore-bucket-objects.py" > "$LOCAL_TMP/versionids.sql"
if [ -s "$LOCAL_TMP/versionids.sql" ]; then
  docker exec -i "${COMPOSE_PROJECT}-db-1" \
    psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 --quiet \
    < "$LOCAL_TMP/versionids.sql" >/dev/null
fi

echo "[10/10] Done — local synced from VPS at $(date -u -Iseconds)"
