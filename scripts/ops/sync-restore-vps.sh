#!/usr/bin/env bash
#
# VPS side of scripts/sync-dev-to-vps.sh. Not intended to be run directly.
# The orchestrator streams this script over SSH (`ssh hetzner bash -s`) with
# these env vars already transferred plus a $REMOTE_TMP directory on the VPS
# containing db.sql and bucket/ prepared by the orchestrator.
#
# Env contract:
#   REMOTE_TMP       directory on VPS holding db.sql and bucket/
#   MC_IMAGE         mc image ref, passed by scripts/sync-dev-to-vps.sh
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
: "${MC_IMAGE:?MC_IMAGE must be set}"
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
# but zero bytes on B2 after the mirror below — restore would surface 422
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

# Mirror local-dump → B2 bucket. `mc alias set` avoids URL-encoding
# pitfalls of `MC_HOST_*=` when an applicationKey contains `+` or `/`.
# `--overwrite` replaces objects whose keys match (creating a new B2
# version, never destroying the previous one); `--remove` drops keys at the
# destination that are absent in the source (issuing a version-less
# DeleteObject, which on B2 creates a delete marker — safe under ADR-0022's
# capability split: the app key has writeFiles but not deleteFiles, so no
# version is destroyed). Together they make the VPS bucket an exact mirror
# of the local dump, with no destructive writes.
#
# `--md5` is required: the bucket has Compliance Object Lock with a
# bucket-default retention (ADR-0022), so every PutObject implicitly carries
# Object Lock parameters. The S3 spec requires PutObject with Object Lock
# parameters to include Content-MD5 or x-amz-checksum-* — B2 enforces this
# and rejects bare PUTs with "Content-MD5 OR x-amz-checksum-* HTTP header
# is required for Put Object requests with Object Lock parameters". Trades
# one extra read pass per file for compliance with the lock contract.
echo "  restoring object storage..."
docker run --rm \
  -v "$REMOTE_TMP/bucket:/data:ro" \
  -e B2_ENDPOINT="$B2_ENDPOINT" \
  -e B2_KEY="$B2_KEY" \
  -e B2_SECRET="$B2_SECRET" \
  -e B2_BUCKET="$B2_BUCKET" \
  --entrypoint sh \
  "$MC_IMAGE" \
  -c '
    mc alias set b2 "$B2_ENDPOINT" "$B2_KEY" "$B2_SECRET" --api S3v4 >/dev/null
    mc mirror --overwrite --remove --md5 /data "b2/$B2_BUCKET"
  ' >/dev/null

# Repair attachments.{version_id,thumb_version_id} so they reference
# the freshly-PUT B2 versions just produced by `mc mirror`. Without
# this, every row arrives with a dev-side MinIO version_id (UUID-shaped)
# that B2 does not recognise — gallery downloads would surface as
# `S3ServiceException InternalError 500` from CopyObject (or now 410
# GONE per the HEAD-probe in the storage layer, 961fa9c). The Python
# helper walks list_object_versions once, joins against the attachments
# table extracted via psql, and emits UPDATE statements; we pipe them
# straight back into psql.
#
# Idempotent: re-running converges to the same state.
echo "  repairing attachments version_ids..."
ATTACHMENTS_TSV="$REMOTE_TMP/attachments.tsv"
docker exec "$DB_CONTAINER" \
  psql -U pm -d projekt_manager -tA -F $'\t' -c "
    SELECT id,
           original_key,
           COALESCE(thumb_key, ''),
           COALESCE(version_id, ''),
           COALESCE(thumb_version_id, '')
      FROM attachments
  " > "$ATTACHMENTS_TSV"
REPAIR_SQL="$REMOTE_TMP/repair-versionids.sql"
B2_ENDPOINT="$B2_ENDPOINT" \
B2_BUCKET="$B2_BUCKET" \
B2_KEY="$B2_KEY" \
B2_SECRET="$B2_SECRET" \
ATTACHMENTS_TSV="$ATTACHMENTS_TSV" \
  python3 "$REMOTE_TMP/repair-bucket-versionids.py" > "$REPAIR_SQL"
if [ -s "$REPAIR_SQL" ]; then
  docker exec -i "$DB_CONTAINER" \
    psql -U pm -d projekt_manager -v ON_ERROR_STOP=1 --quiet \
    < "$REPAIR_SQL" >/dev/null
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
  # paste the age private identity, then Ctrl-D

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
