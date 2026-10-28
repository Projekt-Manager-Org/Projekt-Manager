#!/usr/bin/env bash
#
# VPS side of scripts/sync-dev-to-vps.sh. Not intended to be run directly.
# The orchestrator streams this script over SSH (`ssh hetzner bash -s`) with
# these env vars already transferred plus a $REMOTE_TMP directory on the VPS
# containing db.sql and bucket/ prepared by the orchestrator.
#
# Env contract:
#   REMOTE_TMP       directory on VPS holding db.sql, bucket/ and the
#                    helpers the orchestrator ships alongside
#   COMPOSE_PROJECT  compose project name (projekt-manager) — used to find
#                    the running containers. The bucket itself lives at
#                    Backblaze B2 since the ddff944 topology switch (ADR-0022);
#                    this script reads B2 credentials, endpoint, and bucket
#                    name from the running app container's env.
#
# Exit codes:
#   0  success
#   1  restore failed (backup container is unpaused if it was paused)
#
# The app container is left running throughout. Earlier versions did
# `docker stop`/`start` to keep psql's DROP/CREATE off open connections,
# but stopping wipes the operator-loaded binary `age` identity from the
# /run/binary-key tmpfs (ADR-0024) and the boot probe then waits up to
# five minutes for an operator paste — the 60 s smoke probe downstream
# always timed out before that paste could land. We clear the app's
# pool with `pg_terminate_backend` instead (same pattern the reverse
# script `sync-vps-to-dev.sh` has used since it landed).
#
# The backup container is `pause`d, not stopped, for the same reason:
# `docker pause` freezes via cgroup freezer so /run/drill-key (AC-175)
# survives, while still preventing the in-process croner schedule
# (#199) from firing a backup tick mid-restore.

set -euo pipefail

: "${REMOTE_TMP:?REMOTE_TMP must be set}"
: "${COMPOSE_PROJECT:?COMPOSE_PROJECT must be set}"

DB_CONTAINER="${COMPOSE_PROJECT}-db-1"
APP_CONTAINER="${COMPOSE_PROJECT}-app-1"
BACKUP_CONTAINER="${COMPOSE_PROJECT}-backup-1"

# Unpause the backup container on any exit. Without this a failed restore
# would leave it frozen and its croner schedule silent — drills and
# scheduled backups would stop firing until the operator manually unpaused.
was_backup_paused=0
unpause_paused() {
  rc=$?
  if [ "$was_backup_paused" = "1" ]; then
    docker unpause "$BACKUP_CONTAINER" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap unpause_paused EXIT

running() {
  docker ps --format '{{.Names}}' | grep -qx "$1"
}

# Read B2 credentials, endpoint, and bucket name from the running app
# container's env. The container is the authoritative source for the live
# config (compose interpolates from .env + secrets.env.age into its
# `environment:` block at startup), so we avoid re-parsing those files and
# don't need to prompt for the secrets.env.age passphrase here.
B2_ENDPOINT=$(docker exec "$APP_CONTAINER" printenv STORAGE_ENDPOINT)
B2_BUCKET=$(docker exec "$APP_CONTAINER" printenv STORAGE_BUCKET)
B2_KEY=$(docker exec "$APP_CONTAINER" printenv STORAGE_ACCESS_KEY)
B2_SECRET=$(docker exec "$APP_CONTAINER" printenv STORAGE_SECRET_KEY)
# Compose always defines it (empty means 0, as in the app), so a failed
# read aborts here rather than writing invoice PDFs without their lock.
INVOICE_OBJECT_LOCK_DAYS=$(docker exec "$APP_CONTAINER" printenv INVOICE_OBJECT_LOCK_DAYS)

# Pause the backup container if active (profile-gated, may not exist) so
# its in-process croner schedule can't fire a backup tick mid-restore —
# pg_dump racing `pg_dump --clean`'s DROP/CREATE statements would either
# lock-fight or capture stale tables. `docker pause` freezes the container
# via the cgroup freezer, so /run/drill-key (AC-175) is preserved.
if running "$BACKUP_CONTAINER"; then
  echo "  pausing backup..."
  docker pause "$BACKUP_CONTAINER" >/dev/null
  was_backup_paused=1
fi

# Drop the app's open connections to projekt_manager BEFORE the restore.
# `pg_dump --clean` writes DROP TABLE IF EXISTS CASCADE statements that
# would otherwise lock-fight the app's connection pool. The exclusion
# of pg_backend_pid() spares this admin connection. node-postgres
# reconnects transparently because the app installs a pool 'error'
# handler in db/connection.ts (attachPoolErrorHandler) — without it,
# the idle-client error from pg_terminate_backend would crash the
# process and wipe the tmpfs binary identity (ADR-0024), blocking
# subsequent boots on an operator paste. Mirrors the same pattern in
# sync-vps-to-dev.sh.
#
# Capture the app's StartedAt before terminating so we can detect any
# regression of the above contract: if the container restarted during
# this run, the smoke probe at the end of this script would time out
# blaming /api/health, when the real cause is the boot-time identity
# probe blocking on a missing paste. Surfacing the correct diagnostic
# saves the operator a docker-logs spelunk.
APP_STARTED_AT_BEFORE=$(docker inspect "$APP_CONTAINER" --format '{{.State.StartedAt}}')
echo "  terminating app db connections..."
docker exec "$DB_CONTAINER" \
  psql -U pm -d postgres -tAc \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='projekt_manager' AND pid <> pg_backend_pid();" \
  >/dev/null

# Restore DB. Using `psql` (not pg_restore) because the dump is plain SQL;
# the orchestrator chose plain format for readability and because the dump
# contains DROP TABLE IF EXISTS statements generated by `pg_dump --clean
# --if-exists`, which psql applies before recreating. ON_ERROR_STOP=1 aborts
# on the first failure instead of leaving the DB in a half-restored state.
echo "  restoring database..."
docker exec -i "$DB_CONTAINER" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 --quiet \
  < "$REMOTE_TMP/db.sql" >/dev/null

# Drop hidden attachments. The dev-side bucket dump (`mc mirror src /data`
# in sync-dev-to-vps.sh) is not version-aware: when the source's current
# version is a delete marker, `mc mirror` writes nothing for that key.
# Every dev-side `hidden` (Papierkorb) row therefore arrives with a DB row
# but zero bytes on B2 after the object restore below — restore would surface 422
# restoreMissingVersionId. Project policy is that "deleted means gone,
# even if takes some time to be truly gone": drop the rows so DB and
# bucket agree. The `attachments_storage_usage_delta` trigger fires per
# row and decrements `space_hidden_bytes` / `ciphertext_hidden_bytes` so
# the side-table stays consistent.
echo "  pruning hidden attachments..."
docker exec "$DB_CONTAINER" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 -tAc \
  "DELETE FROM attachments WHERE status = 'hidden';" \
  >/dev/null

# Write the bucket dump to B2, each object with its metadata rebuilt
# from the restored row (#627). The dump is a plain directory and holds
# no S3 user metadata, so `mc mirror` would land every object without its
# wrapped envelope and invoice number — undecryptable by the recovery
# tool (AC-439). The rows now carry the envelopes re-wrapped to this
# host's recipient (rewrap-dek-envelopes.sh); the invoice number comes
# from the invoice that renders the PDF, which also gets this app's
# INVOICE_OBJECT_LOCK_DAYS lock, as on issuance. The helper writes new
# versions for dumped keys that have a row and delete markers for the
# rest, nothing destroyed (ADR-0022), and emits the UPDATEs pointing
# version_id / thumb_version_id at the versions it wrote.
echo "  restoring object storage..."
OBJECTS_TSV="$REMOTE_TMP/objects.tsv"
docker exec -i "$DB_CONTAINER" \
  psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 -tA -F $'\t' \
  < "$REMOTE_TMP/restore-bucket-objects.sql" > "$OBJECTS_TSV"
VERSIONIDS_SQL="$REMOTE_TMP/versionids.sql"
B2_ENDPOINT="$B2_ENDPOINT" \
B2_BUCKET="$B2_BUCKET" \
B2_KEY="$B2_KEY" \
B2_SECRET="$B2_SECRET" \
SOURCE_DIR="$REMOTE_TMP/bucket" \
INVOICE_OBJECT_LOCK_DAYS="$INVOICE_OBJECT_LOCK_DAYS" \
OBJECTS_TSV="$OBJECTS_TSV" \
  python3 "$REMOTE_TMP/restore-bucket-objects.py" > "$VERSIONIDS_SQL"
if [ -s "$VERSIONIDS_SQL" ]; then
  docker exec -i "$DB_CONTAINER" \
    psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 --quiet \
    < "$VERSIONIDS_SQL" >/dev/null
fi

# Unpause backup before the smoke probe so its croner schedule resumes
# promptly and any deferred backup ticks fire against the restored DB.
# Clear the trap flag so the EXIT trap doesn't issue a redundant unpause.
if [ "$was_backup_paused" = "1" ]; then
  echo "  unpausing backup..."
  docker unpause "$BACKUP_CONTAINER" >/dev/null
  was_backup_paused=0
fi

# Detect whether the app container restarted during the restore. The
# pool error handler (attachPoolErrorHandler in db/connection.ts) is
# the contract that keeps the process alive through
# pg_terminate_backend; a restart here means that contract regressed.
# Without this guard the operator sees a generic "/api/health did not
# return 200" timeout below and has to grep app logs to discover the
# real cause (a boot-time binary-identity probe blocking on a missing
# paste). Surface the correct diagnostic up front instead.
APP_STARTED_AT_AFTER=$(docker inspect "$APP_CONTAINER" --format '{{.State.StartedAt}}')
if [ "$APP_STARTED_AT_BEFORE" != "$APP_STARTED_AT_AFTER" ]; then
  cat <<ERR >&2
ERROR: app container restarted during the restore.
  Was:  $APP_STARTED_AT_BEFORE
  Now:  $APP_STARTED_AT_AFTER

The pg_terminate_backend step is meant to be survivable for the app
process — db/connection.ts installs a pool 'error' handler so idle
client errors don't crash the process. A restart here regresses that
contract.

The container's tmpfs at /run/binary-key was wiped by the restart, so
the boot probe is now blocking on the operator paste (ADR-0024).
Recover:

  docker exec -it $APP_CONTAINER load-binary-key
  # paste the binary keyring, then Ctrl-D

Then re-run scripts/sync-dev-to-vps.sh.
ERR
  exit 1
fi

# Smoke probe via the SSOT script shipped in $REMOTE_TMP by the
# orchestrator (sync-dev-to-vps.sh). Same probe CI and deploy use; the
# script logs per-attempt failure reasons so a 503 from a degraded
# dependency surfaces without grepping app logs. The app was never
# stopped, so this verifies the restore didn't corrupt a running app
# rather than racing a fresh boot probe.
echo "  waiting for health..."
if ! bash "$REMOTE_TMP/smoke-app-health.sh" "$APP_CONTAINER" 60; then
  docker logs --tail=40 "$APP_CONTAINER" >&2
  exit 1
fi

echo "  healthy"
trap - EXIT
