#!/usr/bin/env bash
# Layer 2 Tier 1 round-trip against the REAL Postgres binaries (#301 scope B).
#
# Runs one complete production backup cycle — `pg_dump -Fc` on a seeded
# database, `ephemeralPgVerify()` restoring that artifact through `initdb`
# + `postgres` + `pg_restore`, `age` encryption, S3 upload — and then
# independently restores the uploaded artifact a second time and asserts it
# matches. Covers verification.md §15.22 AC-165 / AC-166 [crit] on the path
# that actually ships.
#
# WHY A SCRIPT AND NOT `npm run test`
#   The binaries exist only in the backup image (Dockerfile.backup:
#   postgresql17 + -client + -contrib on Alpine musl), never on a dev host
#   or a CI runner. Installing PGDG on the host would exercise glibc builds
#   of different packaging than production runs — the packaging layer, most
#   likely to break on a base-image bump, would stay uncovered either way.
#   And `check-shard` has no compose stack: a `docker run` inside vitest
#   would need a bespoke timeout far past the 5s default. See #301 for the
#   rejected alternatives.
#
# WHAT IT ASSERTS
#   1. `backup-runner run` exits 0 against a seeded DB.
#   2. `meta_backup_status.last_backup_ok` is true with `last_error` NULL —
#      the DB row AND the status mirror both landed (AC-169).
#   3. The uploaded artifact decrypts to bytes starting with `PGDMP`.
#   4. Restoring that artifact through the production `ephemeralPgVerify()`
#      reproduces the uploaded source manifest, table by table, with the
#      fixture rows present (verify-tier1-artifact.mjs arm 1).
#   5. A corrupted artifact is rejected by the real `pg_restore` — AC-165's
#      failure branch, reached without `manifestPerturb` (arm 2).
#
# OWNS ITS OWN ENVIRONMENT
#   Its own Postgres, its own MinIO, its own Docker network, no published
#   host ports — so it neither collides with a running dev stack nor needs
#   one. Callers supply only a prebuilt image. It builds nothing:
#   Dockerfile.backup's first stage is `FROM ghcr.io/.../projekt-manager:
#   ${APP_IMAGE_TAG}`, which CI resolves through buildx `build-contexts:
#   oci-layout://` (ADR-0027 §"Backup image at PR time") — a named-context
#   form compose cannot express, and at PR time no GHCR tag exists to pull.
#
# USAGE
#   Locally, via the npm entry point — it supplies the dev image tag as the
#   BACKUP_IMAGE default, nothing else. Build that image first (order
#   matters; compose has no build-ordering primitive, see
#   docker-compose.dev.yml):
#     docker compose build app
#     docker compose --profile backup build backup
#     npm run test:backup-roundtrip
#
#   CI, and any run against a different tag, calls this script directly:
#     BACKUP_IMAGE=projekt-manager-backup:ci scripts/backup/verify-roundtrip.sh
#
#   BACKUP_IMAGE stays REQUIRED here rather than defaulting in-script: CI
#   must fail loudly if its tag ever goes missing, instead of silently
#   testing whatever stale dev image happens to sit in the local store.
#
# No skip path. A missing Docker daemon fails the run loudly — Docker is
# already a prerequisite for `npm run test` (CONTRIBUTING.md § Testing),
# and downgrading a safety requirement to "skipped" is what CLAUDE.md
# § Principles forbids.

set -euo pipefail

# --- Caller-supplied ---------------------------------------------------

if [ -z "${BACKUP_IMAGE:-}" ]; then
  echo "ERROR: BACKUP_IMAGE is required (a prebuilt backup image tag)." >&2
  echo "       CI passes projekt-manager-backup:ci; see the header for local use." >&2
  exit 1
fi

# The image must already be in the local store — this script builds nothing
# (see the header). Without this check the first `docker run` below reaches
# for a registry and reports "pull access denied", which reads as a
# credentials problem rather than "you have not built the image yet". CI is
# unaffected: the `docker` job loads projekt-manager-backup:ci one step up.
if ! docker image inspect "$BACKUP_IMAGE" >/dev/null 2>&1; then
  echo "ERROR: image '$BACKUP_IMAGE' is not in the local Docker image store." >&2
  echo "       This script builds nothing. Build it first — order matters," >&2
  echo "       compose has no build-ordering primitive:" >&2
  echo "" >&2
  echo "         docker compose build app" >&2
  echo "         docker compose --profile backup build backup" >&2
  echo "" >&2
  echo "       See docs/ops/backup/overview.md." >&2
  exit 1
fi

# --- Repo root ---------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BASELINE_SQL="src/server/db/migrations/0000_baseline.sql"
SEED_SQL="scripts/backup/verify-roundtrip-seed.sql"
VERIFY_MJS="scripts/backup/verify-tier1-artifact.mjs"
INIT_STORAGE="docker/init-storage.sh"

for f in "$BASELINE_SQL" "$SEED_SQL" "$VERIFY_MJS" "$INIT_STORAGE"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found — run this from a full checkout." >&2
    exit 1
  fi
done

# --- Image tags, derived from the compose files -----------------------
#
# Read rather than hardcoded, deliberately. The Postgres major here MUST
# match the `db` service (pg_restore older→newer is the unsupported
# direction, which is also why Dockerfile.backup's apk pin is
# Renovate-tracked), and the MinIO pair MUST match the mirror the rest of
# dev and CI runs. Deriving them makes that drift impossible instead of
# merely detectable, and adds no new pin for Renovate to track.

image_pin() {
  # $1 = compose file, $2 = ERE anchored on the image name
  local found
  found="$(grep -oE "$2" "$1" | head -1)"
  if [ -z "$found" ]; then
    echo "ERROR: no image matching /$2/ in $1 — the pin moved; update this script." >&2
    exit 1
  fi
  printf '%s\n' "$found"
}

PG_IMAGE="$(image_pin docker-compose.yml 'postgres:[0-9]+(\.[0-9]+)*-alpine')"
MINIO_IMAGE="$(image_pin docker-compose.minio.yml 'minio/minio:RELEASE\.[0-9TZ-]+')"
MC_IMAGE="$(image_pin docker-compose.minio.yml 'minio/mc:RELEASE\.[0-9TZ-]+')"

# --- Fixed test parameters -------------------------------------------
#
# None of these are secrets: nothing is published to a host port, the
# containers live for the duration of this script, and the volumes are
# anonymous. They are values, not credentials.
#
# Deliberately NOT the dev defaults `minioadmin` / `postgres`: the env
# schema's `assertNoDevCredentials` guard rejects those under
# NODE_ENV=production, which is what the backup container runs as below.
PG_USER="pm"
PG_DB="projekt_manager"
PG_PASSWORD="roundtrip-pg"
MINIO_ROOT_USER="roundtrip-root"
MINIO_ROOT_PASSWORD="roundtrip-root-secret"
MINIO_APP_ACCESS_KEY="roundtrip-app"
MINIO_APP_SECRET_KEY="roundtrip-app-secret"
STORAGE_BUCKET="pm-roundtrip-backups"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_APP_ACCESS_KEY MINIO_APP_SECRET_KEY STORAGE_BUCKET

# PID-suffixed so two runs on one host (two worktrees, two agents) do not
# fight over container names. The MinIO container additionally answers to
# the bare name `storage` via a network alias, because docker/init-storage.sh
# hardcodes `mc alias set minio http://storage:9000` — reusing that script
# rather than forking a second provisioning path is what keeps this bucket
# the same shape as the dev and CI ones (Object Lock, versioning,
# capability-restricted app user; ADR-0022).
SUFFIX="$$"
NETWORK="pm-roundtrip-net-${SUFFIX}"
DB_CONTAINER="pm-roundtrip-db-${SUFFIX}"
MINIO_CONTAINER="pm-roundtrip-storage-${SUFFIX}"

WORKDIR="$(mktemp -d)"
# The backup image runs as uid 70 (`postgres`, Dockerfile.backup USER) and
# has to read the decrypted artifact out of this directory. mktemp -d gives
# 0700, so without this the mount is unreadable to that uid and the failure
# looks like a corrupt archive rather than a permission problem.
chmod 0755 "$WORKDIR"

# Host uid for the containers that write into $WORKDIR, so the files land
# owned by the caller and cleanup does not need root. Not applied to the
# backup image: `initdb` resolves the current uid through getpwuid() and
# refuses outright for a uid with no passwd entry.
HOST_UID_GID="$(id -u):$(id -g)"

cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    # Errors only. A full Postgres boot log is ~60 lines of initdb chatter
    # that buries the failing step's own message scrolled just above —
    # which is the message that actually explains the exit.
    echo ""
    echo "--- container errors (empty = the failure was not inside a container) ---"
    docker logs "$DB_CONTAINER" 2>&1 | grep -E 'ERROR|FATAL|PANIC' | tail -20 |
      sed 's/^/  db    | /' || true
    docker logs "$MINIO_CONTAINER" 2>&1 | grep -iE 'error|fatal' | tail -20 |
      sed 's/^/  minio | /' || true
  fi
  docker rm -f "$DB_CONTAINER" "$MINIO_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  return "$code"
}
trap cleanup EXIT

step() { echo ""; echo "=== $* ==="; }

# --- 1. Network + Postgres -------------------------------------------

step "Starting Postgres ($PG_IMAGE) and MinIO ($MINIO_IMAGE)"
docker network create "$NETWORK" >/dev/null

# No `-p`: everything talks over $NETWORK by container name, so this never
# contends with a dev stack's published 5432/9000.
docker run -d --name "$DB_CONTAINER" --network "$NETWORK" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB="$PG_DB" \
  "$PG_IMAGE" >/dev/null

docker run -d --name "$MINIO_CONTAINER" --network "$NETWORK" \
  --network-alias storage \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
  "$MINIO_IMAGE" server /data >/dev/null

READY_TIMEOUT=60
started=$SECONDS
# `-h 127.0.0.1` — a TCP probe, deliberately not pg_isready's default unix
# socket. The official entrypoint's init phase runs a temporary server with
# `listen_addresses=''` (docker-entrypoint.sh `docker_temp_server_start`) to
# create the role and database: socket up, TCP closed. A socket probe reports
# ready inside that window while the very next step — psql from another
# container, over the network — gets ECONNREFUSED and fails the run for a
# reason that has nothing to do with backups. Measured window ~0.3s against a
# 1s poll interval, so it is rare, timing-dependent, and reddens a merge gate
# when it hits. Only the TCP form asserts what this gate claims to assert.
until docker exec "$DB_CONTAINER" \
  pg_isready -h 127.0.0.1 -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; do
  if [ $((SECONDS - started)) -ge "$READY_TIMEOUT" ]; then
    echo "ERROR: Postgres did not accept connections within ${READY_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 1
done
echo "Postgres ready after $((SECONDS - started))s"

# --- 2. Schema + fixture rows ----------------------------------------
#
# The baseline migration applied with psql rather than through drizzle's
# `migrate()`: the ledger table only matters to the app's startup guard,
# and pulling in the app's Node entrypoint just to populate it would drag
# the whole app env schema into this script. `0000_baseline.sql` is the
# single migration (see docs/ops/recover-from-schema-change.md), so
# applying it IS the schema.
step "Applying $BASELINE_SQL and the fixture seed"
psql_in() {
  docker run --rm --network "$NETWORK" --user "$HOST_UID_GID" \
    -e PGPASSWORD="$PG_PASSWORD" \
    -v "${REPO_ROOT}/$1:/sql:ro" \
    "$PG_IMAGE" \
    psql -h "$DB_CONTAINER" -U "$PG_USER" -d "$PG_DB" \
    -v ON_ERROR_STOP=1 --quiet -f /sql
}
psql_in "$BASELINE_SQL"
psql_in "$SEED_SQL"

psql_query() {
  docker run --rm --network "$NETWORK" --user "$HOST_UID_GID" \
    -e PGPASSWORD="$PG_PASSWORD" "$PG_IMAGE" \
    psql -h "$DB_CONTAINER" -U "$PG_USER" -d "$PG_DB" -Atqc "$1"
}
echo "Seeded rows: users=$(psql_query 'SELECT count(*) FROM users')" \
  "audit_log=$(psql_query 'SELECT count(*) FROM audit_log')"

# --- 3. Bucket -------------------------------------------------------

step "Provisioning the bucket with $INIT_STORAGE"
# Same script the dev compose stack and the CI start-minio action run, so
# this bucket carries the same Object Lock / versioning / lifecycle shape
# and the same capability-restricted app user the app runs as. It polls
# `mc alias set` for up to 30s, which doubles as the MinIO readiness wait.
docker run --rm --network "$NETWORK" \
  -v "${REPO_ROOT}/${INIT_STORAGE}:/init-storage.sh:ro" \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD \
  -e MINIO_APP_ACCESS_KEY -e MINIO_APP_SECRET_KEY \
  -e STORAGE_BUCKET \
  --entrypoint /bin/sh "$MC_IMAGE" /init-storage.sh

# --- 4. age keypair --------------------------------------------------
#
# Generated inside the backup image so the host needs no `age` on PATH
# (the `docker` CI job installs none). The private half never leaves this
# script's temp dir and dies with the trap. AGE_RECIPIENT — the public
# half — is all the backup container gets, exactly as in production where
# the identity is operator-held (AC-175).
step "Generating an ephemeral age keypair"
AGE_IDENTITY="$(docker run --rm --user "$HOST_UID_GID" \
  --entrypoint age-keygen "$BACKUP_IMAGE" 2>/dev/null)"
printf '%s\n' "$AGE_IDENTITY" > "${WORKDIR}/identity"
chmod 0600 "${WORKDIR}/identity"
AGE_RECIPIENT="$(printf '%s\n' "$AGE_IDENTITY" | docker run --rm -i --user "$HOST_UID_GID" \
  --entrypoint age-keygen "$BACKUP_IMAGE" -y 2>/dev/null)"
if [[ ! "$AGE_RECIPIENT" =~ ^age1 ]]; then
  echo "ERROR: age-keygen did not produce an age1… recipient (got '${AGE_RECIPIENT}')" >&2
  exit 1
fi
echo "Recipient: ${AGE_RECIPIENT}"

# --- 5. The production run -------------------------------------------

step "Running 'backup-runner run' in $BACKUP_IMAGE"
# Container shape mirrors docker-compose.yml's `backup` service, because
# the shape is part of what is under test:
#   --read-only + --tmpfs /tmp  — prod runs read_only with a /tmp tmpfs;
#     the ephemeral cluster's PGDATA, WAL and socket all land there. A
#     write that escaped /tmp would pass here and fail in production.
#   TZ=Europe/Berlin            — load-bearing, not cosmetic. This is the
#     value that makes `initdb` inherit a non-UTC zone, so it is what
#     makes `-c TimeZone=UTC` in buildPostgresArgv necessary. Drop it and
#     the seeded timestamptz columns can no longer detect that override
#     going missing.
#   NODE_ENV=production         — the env schema's production-only guards
#     (assertNoDevCredentials) are then live, as in prod.
# Size on the tmpfs is explicit: a fresh PGDATA plus WAL segments needs
# more than the daemon's small default, and running out surfaces as an
# opaque initdb failure.
docker run --rm --network "$NETWORK" \
  --read-only --tmpfs /tmp:rw,size=1g \
  -e DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${DB_CONTAINER}:5432/${PG_DB}" \
  -e R2_ENDPOINT="http://storage:9000" \
  -e R2_BUCKET="$STORAGE_BUCKET" \
  -e R2_ACCESS_KEY_ID="$MINIO_APP_ACCESS_KEY" \
  -e R2_SECRET_ACCESS_KEY="$MINIO_APP_SECRET_KEY" \
  -e R2_REGION="us-east-1" \
  -e AGE_RECIPIENT="$AGE_RECIPIENT" \
  -e TZ="Europe/Berlin" \
  -e NODE_ENV="production" \
  "$BACKUP_IMAGE" run

# --- 6. Status row ---------------------------------------------------

step "Asserting meta_backup_status"
# `last_error IS NULL` as well as ok=true on purpose: a status-mirror
# failure after the artifacts land still returns ok:true from runBackup and
# records the reason here (AC-169 orphan-artifact semantics), so ok alone
# would not prove the mirror write happened.
#
# `true`, not psql's `t`: the `||` renders the boolean through
# `boolean::text` rather than through psql's own column formatting.
status="$(psql_query "SELECT last_backup_ok || '|' || coalesce(last_error, '<null>') FROM meta_backup_status")"
if [ "$status" != "true|<null>" ]; then
  echo "ERROR: expected last_backup_ok=true with no last_error, got '${status}'" >&2
  exit 1
fi
echo "last_backup_ok=true, last_error IS NULL"

# --- 7. Fetch + decrypt the artifact ---------------------------------

step "Fetching and decrypting the uploaded artifact"
# `mc mirror` of the whole `daily/` prefix rather than a lookup for the
# newest key: exactly one run happened, so the prefix holds exactly one
# dump and one sidecar, and mirroring avoids a nested-quoting layer inside
# `sh -c`. Runs as the host uid so the files are the caller's to delete —
# which also means $HOME is unwritable, hence the explicit --config-dir.
# The alias comes from MC_HOST_<name>, so no `mc alias set` is needed.
docker run --rm --network "$NETWORK" --user "$HOST_UID_GID" \
  -v "${WORKDIR}:/out" \
  -e MC_HOST_minio="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@storage:9000" \
  --entrypoint mc "$MC_IMAGE" \
  --config-dir /tmp/.mc \
  mirror --quiet "minio/${STORAGE_BUCKET}/daily" /out/daily

shopt -s nullglob
dump_cipher=("${WORKDIR}"/daily/*.dump.age)
manifest_cipher=("${WORKDIR}"/daily/*.manifest.json.age)
shopt -u nullglob
if [ ${#dump_cipher[@]} -ne 1 ] || [ ${#manifest_cipher[@]} -ne 1 ]; then
  echo "ERROR: expected exactly one dump + one manifest under daily/," \
    "found ${#dump_cipher[@]} and ${#manifest_cipher[@]}" >&2
  ls -la "${WORKDIR}/daily" >&2 || true
  exit 1
fi
echo "Artifact: $(basename "${dump_cipher[0]}")"

age_decrypt() {
  # $1 = ciphertext path (host), $2 = plaintext path (host)
  docker run --rm --user "$HOST_UID_GID" -v "${WORKDIR}:/w" \
    --entrypoint age "$BACKUP_IMAGE" \
    -d -i /w/identity -o "/w/$2" "/w/$1"
}
age_decrypt "daily/$(basename "${dump_cipher[0]}")" "dump.pgdump"
age_decrypt "daily/$(basename "${manifest_cipher[0]}")" "manifest.json"

# AC-167's other half is that the artifact is unreadable without the
# identity; that is covered by backup.test.ts. Here the point is the
# inverse — with the identity it decrypts to a real archive.
magic="$(head -c 5 "${WORKDIR}/dump.pgdump")"
if [ "$magic" != "PGDMP" ]; then
  echo "ERROR: decrypted dump does not start with PGDMP (got '${magic}')" >&2
  exit 1
fi
echo "Decrypted dump carries the PGDMP archive magic"

# The verifier below runs as the image's own uid 70, not the host uid, so
# the plaintexts need to be world-readable. A restrictive host umask would
# otherwise make them unreadable to it.
chmod 0644 "${WORKDIR}/dump.pgdump" "${WORKDIR}/manifest.json"

# --- 8. Restore the artifact through ephemeralPgVerify() -------------

step "Restoring the artifact through the production ephemeralPgVerify()"
# No --network: this arm needs no database and no bucket. It restores the
# artifact into an ephemeral cluster inside the container and compares the
# recomputed manifest against the uploaded source manifest, then repeats
# with corrupted bytes and requires a rejection. Same TZ and read-only
# shape as the run above, same reasons.
docker run --rm \
  --read-only --tmpfs /tmp:rw,size=1g \
  -v "${REPO_ROOT}/${VERIFY_MJS}:/verify-tier1-artifact.mjs:ro" \
  -v "${WORKDIR}/dump.pgdump:/w/dump.pgdump:ro" \
  -v "${WORKDIR}/manifest.json:/w/manifest.json:ro" \
  -e TZ="Europe/Berlin" \
  --entrypoint node "$BACKUP_IMAGE" \
  /verify-tier1-artifact.mjs /w/dump.pgdump /w/manifest.json

step "Tier 1 round-trip PASSED"
