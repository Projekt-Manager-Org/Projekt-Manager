#!/usr/bin/env bash
#
# Runtime smoke of the production compose stack — catch bugs that "does it
# compile?" misses. Shared by:
#
#   - .github/actions/build-scan-smoke   start → verify → stop, every PR
#   - scripts/ci/docker-upgrade-path.sh  start, then verify after every
#                                        Docker converge (ADR-0009)
#
# History (pre-#199): iteration 7 landed with six distinct runtime
# defects that all passed `npm ci && npm test && docker build`. Each one
# fired only when the container actually booted and ran its real code
# path on a real DB:
#   - dcron EPERM on setpgid (needed init:true) — gone with #199
#     (croner does not fork; container runs non-root)
#   - shared env schema required STORAGE_* (unused by backup-runner)
#   - listen_addresses='' literal quotes in execve
#   - pg Pool defaulting to a role that doesn't exist
#   - /var/run tmpfs shadowing /run/drill-key
#   - seed fixture readFileSync at module load (since fixed to an
#     inlined JSON import so the specific ENOENT can't recur)
#
# Cheap defence: boot the full stack with the in-stack MinIO standing in
# as the R2 target. Confirm the scheduler logged its registered-jobs lines
# (catches a schedule-registration regression in scheduleSubcommand), then
# run one `node backup-runner.js run` cycle end to end. MinIO is
# S3-compatible for every call the uploader makes (HeadBucket / PutObject
# / GetObject / ListObjectsV2), so this exercises the real pipeline
# including the startup R2 HeadBucket probe and the ephemeral-pg spawn
# under the postgres UID. An env-schema error, spawn-quoting crash,
# peer-auth failure, missing binary, or schedule-registration regression
# all surface here.
#
# Usage (from the repo root):
#   scripts/ci/stack-smoke.sh start    # boot the stack, load keys, add backup
#   scripts/ci/stack-smoke.sh mark     # write a marker row and object
#   scripts/ci/stack-smoke.sh redeploy # deploy.sh's compose steps, on the
#                                      # running stack
#   scripts/ci/stack-smoke.sh verify   # every runtime check, plus the markers
#                                      # once written; re-runnable
#   scripts/ci/stack-smoke.sh stop     # dump logs, tear down with volumes
#
# Environment:
#   APP_IMAGE_TAG      required; the app + backup images must already be
#                      in the local store under it (compose declares no
#                      pull_policy, so `missing` resolves them locally).
#   SMOKE_STATE_DIR    required; holds the binary keypair across calls.
#                      `verify` after a daemon restart needs the same
#                      identity, because the recipient was interpolated
#                      into the app container's env at `start`.
#   SMOKE_CADDY=1      also build and run Caddy (as deploy.sh does) with
#                      `tls internal`, and probe health through it from
#                      the host. Off by default: the xcaddy compile costs
#                      minutes, and the `docker` job builds Caddy only
#                      when its inputs change.
set -euo pipefail

cmd="${1:?usage: $0 start|mark|redeploy|verify|stop}"
: "${APP_IMAGE_TAG:?APP_IMAGE_TAG must be set}"
: "${SMOKE_STATE_DIR:?SMOKE_STATE_DIR must be set}"

# Placeholder secrets — the stack must start and one
# `node backup-runner.js run` cycle must complete before any of these
# matter to anything outside the compose network.
export POSTGRES_PASSWORD=smoke
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=smoke123
# Capability-restricted MinIO app user (#45 / ADR-0022) — `:?`-gated in
# the minio overlay because the app must NEVER run as root. storage-init
# provisions this user.
export MINIO_APP_ACCESS_KEY=pmappsmoke
export MINIO_APP_SECRET_KEY=pmappsmokesecret
# Object-storage env consumed by the app. The minio overlay overrides
# STORAGE_ENDPOINT / STORAGE_PUBLIC_ENDPOINT / STORAGE_REGION for the
# in-compose target; the base file's `:?` gates need values at parse time
# so we set them too. STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY mirror
# MINIO_APP_* (the user the app actually runs as).
export STORAGE_ENDPOINT=http://storage:9000
export STORAGE_REGION=us-east-1
export STORAGE_BUCKET=projekt-manager
export STORAGE_ACCESS_KEY=pmappsmoke
export STORAGE_SECRET_KEY=pmappsmokesecret
export CLOUDFLARE_API_TOKEN=smoke
# R2 target points at the in-stack MinIO. The backup container's schedule
# subcommand (backup-runner.ts) runs an authenticated HeadBucket probe on
# startup and exits non-zero on any failure — an unreachable endpoint or a
# missing bucket would crash the container into a restart loop before any
# tick could be exercised. A reachable, authenticated target lets the
# probe, the schedule registration, and the upload pipeline run end to end.
export R2_ACCESS_KEY_ID=minioadmin
export R2_SECRET_ACCESS_KEY=smoke123
export R2_ENDPOINT=http://storage:9000
export R2_BUCKET=projekt-manager-backup-smoke
export R2_REGION=auto
# Throwaway age recipient — must be a real Bech32-valid key so `age`
# accepts it during encrypt. The private half is discarded: smoke only
# exercises the forward path (encrypt + upload), never decryption, so
# nothing in the smoke can read what it wrote.
export AGE_RECIPIENT=age15nf2qq4znfwup9khgjk0rdgp5wg9vx33fngc727m3zdkctq29djqyr9su6
# App-side env vars normally sourced from .env on the VPS.
export DOMAIN=smoke.invalid
export WG_BIND_IP=127.0.0.1
# COMPOSE_FILE makes every plain `docker compose` call below implicitly
# load BOTH the prod base file AND the MinIO mirror overlay. The base file
# alone has no `storage` / `storage-init` services (prod talks to B2); the
# smoke stands MinIO in for B2. `:` is the file separator on POSIX.
export COMPOSE_FILE=docker-compose.yml:docker-compose.minio.yml
if [[ "${SMOKE_CADDY:-0}" == 1 ]]; then
  COMPOSE_FILE="$COMPOSE_FILE:scripts/ci/compose.caddy-ci.yml"
  export SMOKE_CADDYFILE="$SMOKE_STATE_DIR/Caddyfile"
fi

identity_file="$SMOKE_STATE_DIR/binary-identity"
# Per-run binary `age` keypair (ADR-0024). The boot probe
# (assertBinaryIdentityLoaded) refuses to serve without a tmpfs-loaded
# identity matching BINARY_AGE_RECIPIENT, which compose interpolates into
# the app container's env at parse time — so the recipient must exist
# BEFORE `docker compose up`, and every later compose call must see the
# same one. Mirrors the per-fork keypair pattern in
# src/test/integration-setup.ts and playwright.config.ts.
if [[ "$cmd" == start ]]; then
  mkdir -p "$SMOKE_STATE_DIR"
  (umask 077 && age-keygen 2>/dev/null >"$identity_file")
fi
if [[ "$cmd" != stop || -s "$identity_file" ]]; then
  BINARY_AGE_RECIPIENT="$(age-keygen -y "$identity_file")"
  export BINARY_AGE_RECIPIENT
fi

# Load the binary identity via the operator script — not a tee bypass — so
# regressions in the script's runtime environment (missing bash, missing
# age-keygen, broken tmpfs-invariant check, etc.) surface here instead of
# on first real deploy. The script reads stdin via `read -r -s -d $'\004'`,
# which accepts EOF as a terminator, so piping the identity works without
# a literal Ctrl-D byte. No `-t` because GHA has no TTY.
#
# Retries until the container accepts the exec and the write lands: right
# after `up` or a daemon restart the container may not be running yet.
# Skipped when the tmpfs is still warm (`verify` without a restart).
load_binary_key() {
  local i last_out=""
  if docker exec projekt-manager-app-1 test -s /run/binary-key/identity 2>/dev/null; then
    echo "  binary identity already in tmpfs"
    return 0
  fi
  for i in $(seq 1 60); do
    if last_out=$(printf '%s' "$(<"$identity_file")" |
      docker exec -i projekt-manager-app-1 load-binary-key 2>&1); then
      echo "  $last_out"
      echo "  loaded via load-binary-key (attempt $i)"
      return 0
    fi
    sleep 1
  done
  echo "::error::load-binary-key did not succeed within 60s"
  printf '%s\n' "$last_out" >&2
  return 1
}

# The production Caddyfile with its DNS-01 `tls` block swapped for
# `tls internal`: every route stays the real one, only the certificate
# source differs (no ACME against a fake domain and token).
write_ci_caddyfile() {
  awk '
    /^\ttls \{$/ { print "\ttls internal"; skip = 1; n++; next }
    skip && /^\t\}$/ { skip = 0; next }
    !skip { print }
    END { if (n != 1) exit 1 }
  ' Caddyfile >"$SMOKE_CADDYFILE" || {
    echo "::error::Caddyfile: expected exactly one top-level tls block to replace"
    return 1
  }
}

start() {
  if [[ "${SMOKE_CADDY:-0}" == 1 ]]; then
    echo "::group::Build Caddy on this daemon's BuildKit (as deploy.sh does)"
    write_ci_caddyfile
    docker compose build caddy
    echo "::endgroup::"
  fi

  echo "::group::Compose up (app stack, no backup yet)"
  # Explicit service list. Backup is deferred until the R2 bucket exists
  # on MinIO, otherwise the schedule subcommand's startup HeadBucket probe
  # would 404 and the container would restart-loop.
  docker compose up -d db storage storage-init app
  echo "::endgroup::"

  echo "::group::Load binary identity via load-binary-key (operator path)"
  load_binary_key
  echo "::endgroup::"

  echo "::group::Wait for app readiness (up to 90s)"
  ./scripts/smoke-app-health.sh projekt-manager-app-1 90
  echo "::endgroup::"

  echo "::group::Create R2 smoke bucket on MinIO"
  # One-off mc container attached to the compose network, reusing the
  # storage-init service definition so no network-name lookup is needed.
  # --no-deps skips depends_on resolution (storage is already up); -T
  # disables TTY for cleaner logs.
  docker compose run --rm --no-deps -T \
    --entrypoint /bin/sh \
    storage-init \
    -c "mc alias set local http://storage:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" && mc mb --ignore-existing local/${R2_BUCKET}"
  echo "::endgroup::"

  echo "::group::Bring up backup container"
  docker compose --profile backup up -d backup
  echo "::endgroup::"

  if [[ "${SMOKE_CADDY:-0}" == 1 ]]; then
    echo "::group::Start Caddy (tls internal)"
    docker compose up -d caddy
    echo "::endgroup::"
  fi
}

# What deploy.sh runs against an existing stack: rebuild Caddy (cached),
# then `up -d` every service. After a Docker converge this is where a new
# Compose or BuildKit meets resources the old one created.
redeploy() {
  echo "::group::Redeploy as deploy.sh does (compose build caddy, up -d)"
  [[ "${SMOKE_CADDY:-0}" != 1 ]] || docker compose build caddy
  docker compose --profile backup up -d
  echo "::endgroup::"
}

# Running (not restarting), with a RestartCount that holds still for 20s,
# within 90s.
# Relative, not "== 0": after a daemon restart the backup container may
# crash once on its startup R2 probe while MinIO is still coming up, and
# the restart policy recovering it is the behaviour under test.
wait_backup_stable() {
  local i running restarts last="" still=0
  for i in $(seq 1 45); do
    running=$(docker inspect projekt-manager-backup-1 \
      --format '{{and .State.Running (not .State.Restarting)}}' 2>/dev/null || echo false)
    restarts=$(docker inspect projekt-manager-backup-1 --format '{{.RestartCount}}' 2>/dev/null || echo -1)
    echo "  attempt $i: running=$running restarts=$restarts"
    if [[ "$running" == true && "$restarts" == "$last" ]]; then
      still=$((still + 1))
      [[ $still -ge 10 ]] && return 0
    else
      still=0
    fi
    last="$restarts"
    sleep 2
  done
  echo "::error::Backup container is not stable (running=$running restarts=$restarts)"
  return 1
}

verify() {
  echo "::group::Load binary identity (again if a restart or recreate wiped the tmpfs)"
  load_binary_key
  echo "::endgroup::"

  echo "::group::Wait for app readiness (up to 90s)"
  # Single source of truth in scripts/smoke-app-health.sh — same probe
  # deploy and sync-restore use.
  ./scripts/smoke-app-health.sh projekt-manager-app-1 90
  echo "::endgroup::"

  echo "::group::Service Worker served from the image?"
  # Nothing else checks the shipped /sw.js: E2E bundles it through the dev
  # middleware, the unit suite never builds. Without it attachments stop
  # decrypting and push goes dead. A missing file still answers 200
  # no-cache — the SPA fallback serves index.html — so content type and
  # both listeners are the load-bearing checks. no-cache pins
  # staticCache.ts's SW-update policy.
  if ! docker exec -i projekt-manager-app-1 node --input-type=module - <scripts/ci/probe-sw.mjs; then
    echo "::error::/sw.js is missing or incomplete in the app image"
    return 1
  fi
  echo "::endgroup::"

  echo "::group::Backup container stable?"
  wait_backup_stable
  echo "::endgroup::"

  echo "::group::Scheduler registered all four cron jobs?"
  # scheduleSubcommand logs one "registered <name> next=..." line per
  # croner job at boot. Confirming all four are present catches a
  # regression where a job's cron expression is malformed (croner throws
  # at construction → only the earlier jobs ever registered), or where
  # buildScheduleJobs returned fewer than four entries. Only the current
  # boot's logs count: after a restart the earlier boot's lines are still
  # in the log.
  local started backup_logs name
  started=$(docker inspect projekt-manager-backup-1 --format '{{.State.StartedAt}}')
  backup_logs=$(docker logs --since "$started" projekt-manager-backup-1 2>&1)
  echo "$backup_logs"
  for name in backup-weekday backup-weekend drill-weekday drill-weekend; do
    if ! printf '%s' "$backup_logs" | grep -q "schedule: registered ${name} next="; then
      echo "::error::scheduler did not log a 'registered ${name}' line at boot"
      return 1
    fi
  done
  echo "  all four croner jobs registered — smoke OK"
  echo "::endgroup::"

  echo "::group::Run one backup cycle"
  # Full pipeline: env parse, pg_dump, ephemeral-pg verify, age encrypt,
  # PutObject to MinIO. A non-zero rc here is a real runtime defect the
  # image-build phase did not catch.
  #
  # NOTE: this is a SEPARATE node process from the scheduler in PID 1; the
  # manual `run` subcommand is not serialised against an in-flight
  # scheduled tick (croner's protect: true only covers intra-process).
  # Acceptable here because the smoke clock is unlikely to land on the
  # schedule's tick window during the run.
  local backup_out backup_rc
  set +e
  backup_out=$(docker exec projekt-manager-backup-1 node /app/dist/server/backup-runner.js run 2>&1)
  backup_rc=$?
  set -e
  echo "$backup_out"
  echo "  exit code: $backup_rc"
  if [[ "$backup_rc" != 0 ]]; then
    echo "::error::backup-runner run failed end-to-end against MinIO — see output above"
    return 1
  fi
  echo "  backup-runner run completed end-to-end — smoke OK"
  echo "::endgroup::"

  echo "::group::Drill-key tmpfs reachable?"
  # Catches the /var/run tmpfs shadowing /run/drill-key bug by confirming
  # the script can at least reach the write path (sends an empty paste —
  # load-drill-key rejects with a clear "empty input" message, which
  # proves the tmpfs-invariant check passed).
  local dk_out
  dk_out=$(echo | docker exec -i projekt-manager-backup-1 /usr/local/bin/load-drill-key 2>&1 || true)
  echo "$dk_out"
  if echo "$dk_out" | grep -q "not a tmpfs mount"; then
    echo "::error::load-drill-key reports /run/drill-key is not tmpfs — the /var/run tmpfs is shadowing it again"
    return 1
  fi
  if echo "$dk_out" | grep -q "No such file or directory"; then
    echo "::error::load-drill-key cannot reach /run/drill-key/identity — mount topology regressed"
    return 1
  fi
  echo "  drill-key tmpfs path is reachable — smoke OK"
  echo "::endgroup::"

  if [[ "${SMOKE_CADDY:-0}" == 1 ]]; then
    echo "::group::Health through Caddy, from the host (up to 60s)"
    # The path deploy.sh probes on the VPS: published port → Caddy → app.
    # Trusts Caddy's own internal root instead of the system store.
    docker exec projekt-manager-caddy-1 cat /data/caddy/pki/authorities/local/root.crt \
      >"$SMOKE_STATE_DIR/caddy-root.crt"
    CADDY_CA_FILE="$SMOKE_STATE_DIR/caddy-root.crt" ./scripts/smoke-caddy-health.sh 60
    echo "::endgroup::"
  fi

  [[ ! -s "$marker_file" ]] || verify_markers
}

# A row in its own database (the app's schema stays exactly the
# baseline) and an object in the backup bucket. `verify` reads both back:
# what a Docker upgrade must never lose is the volumes under them.
marker_file="$SMOKE_STATE_DIR/marker"
mark() {
  local token
  token="marker-$(date +%s%N)"
  echo "::group::Write data markers ($token)"
  docker exec projekt-manager-db-1 psql -U pm -d postgres -v ON_ERROR_STOP=1 -qc \
    "CREATE DATABASE smoke_marker"
  docker exec projekt-manager-db-1 psql -U pm -d smoke_marker -v ON_ERROR_STOP=1 -qc \
    "CREATE TABLE marker (v text); INSERT INTO marker VALUES ('$token')"
  docker compose run --rm --no-deps -T -e MARKER="$token" \
    --entrypoint /bin/sh storage-init \
    -c "mc alias set local http://storage:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" && printf %s \"\$MARKER\" | mc pipe local/${R2_BUCKET}/smoke-marker"
  echo "$token" >"$marker_file"
  echo "::endgroup::"
}

verify_markers() {
  local want db obj
  want=$(<"$marker_file")
  echo "::group::Data markers survived?"
  db=$(docker exec projekt-manager-db-1 psql -U pm -d smoke_marker -Atc "SELECT v FROM marker")
  obj=$(docker compose run --rm --no-deps -T --entrypoint /bin/sh storage-init \
    -c "mc alias set local http://storage:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null && mc cat local/${R2_BUCKET}/smoke-marker")
  echo "  db: '$db', object: '$obj', want '$want'"
  if [[ "$db" != "$want" || "$obj" != "$want" ]]; then
    echo "::error::data written before the converge did not survive it"
    return 1
  fi
  echo "::endgroup::"
}

stop() {
  echo "::group::Smoke teardown"
  docker compose --profile backup logs backup --tail=80 || true
  docker compose --profile backup logs app --tail=40 || true
  [[ "${SMOKE_CADDY:-0}" == 1 ]] && { docker compose logs caddy --tail=40 || true; }
  docker compose --profile backup down -v --remove-orphans || true
  echo "::endgroup::"
}

case "$cmd" in
  start) start ;;
  mark) mark ;;
  redeploy) redeploy ;;
  verify) verify ;;
  stop) stop ;;
  *)
    echo "usage: $0 start|mark|redeploy|verify|stop" >&2
    exit 2
    ;;
esac
