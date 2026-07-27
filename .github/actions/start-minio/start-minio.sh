#!/usr/bin/env bash
# Starts a pinned MinIO container and provisions it with
# docker/init-storage.sh. Invoked by the sibling composite action
# (action.yml), which supplies every variable read below.
#
# Lives in a real .sh file, not an inline `run:` block, so CI's shellcheck
# gate covers it: actionlint does not read composite action.yml files
# (forcing one in parses it as a workflow and reports `"jobs" section is
# missing`), and the gate's `find` only walks real scripts.
#
# Required env — all set by action.yml:
#   MINIO_ROOT_USER / MINIO_ROOT_PASSWORD   MinIO process + admin ops
#   MINIO_APP_ACCESS_KEY / _SECRET_KEY      capability-restricted app user
#   STORAGE_BUCKET                          always provisioned
#   STORAGE_BUCKET_TEST / _E2E              may be empty — init-storage.sh skips
set -euo pipefail

# Pinned to match docker-compose.minio.yml (ADR-0009 — version pinning
# across environments). Renovate tracks both tags via the
# `.github/actions/<name>/*.{yml,sh}` customManager in renovate.json.
MINIO_IMAGE="minio/minio:RELEASE.2025-09-07T16-13-09Z"
MC_IMAGE="minio/mc:RELEASE.2025-08-13T08-35-41Z"
NETWORK="pm-storage-net"
CONTAINER="storage"
# MinIO answers in ~2s on a healthy runner. The 2026-07-27 flake
# (run 30244304682) showed ~62s of unbroken unavailability, so a wider
# budget alone would NOT have rescued it — the retry below is what covers
# that case. 60s only keeps a merely-slow runner out of the retry path.
READY_TIMEOUT=60
# One retry. A container that died on boot or a runner whose Docker
# networking hiccuped gets a second chance; a systematic failure still
# fails the job. Every retry emits a ::warning:: so flakes stay visible
# instead of being silently papered over.
START_ATTEMPTS=2

INIT_SCRIPT="${GITHUB_WORKSPACE}/docker/init-storage.sh"
if [ ! -f "$INIT_SCRIPT" ]; then
  echo "::error::${INIT_SCRIPT} not found — check out the repository before this action"
  exit 1
fi

# Everything needed to tell "MinIO crashed" from "the runner's Docker
# networking is broken" apart after the fact. The 2026-07-27 flake
# (run 30244304682) was undiagnosable precisely because none of this
# was captured.
#
# Tolerant of a missing container: `docker run` may have failed before one
# existed, and `docker ps -a` is still the useful signal in that case.
dump_diagnostics() {
  echo "::group::MinIO diagnostics"
  echo "--- docker ps -a ---"
  docker ps -a || true
  echo "--- docker inspect ${CONTAINER} (.State) ---"
  docker inspect -f '{{json .State}}' "$CONTAINER" || true
  echo "--- docker logs ${CONTAINER} (last 200 lines) ---"
  docker logs --tail 200 "$CONTAINER" 2>&1 || true
  echo "--- health probe (verbose) ---"
  curl -sv --max-time 5 http://localhost:9000/minio/health/live 2>&1 | tail -20 || true
  echo "::endgroup::"
}

# Idempotent — a second invocation in the same job must not fail on an
# already-created network.
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"

start_minio() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    --network "$NETWORK" \
    -p 9000:9000 \
    -e MINIO_ROOT_USER \
    -e MINIO_ROOT_PASSWORD \
    "$MINIO_IMAGE" \
    server /data
}

# Poll the health endpoint, but bail out the moment the container is known
# to have stopped — a crashed MinIO never answers, and burning the full
# timeout only delays the real error.
wait_ready() {
  local started=$SECONDS state inspect_warned=0
  while [ $((SECONDS - started)) -lt "$READY_TIMEOUT" ]; do
    if curl -sf --max-time 5 http://localhost:9000/minio/health/live >/dev/null; then
      echo "MinIO ready after $((SECONDS - started))s"
      return 0
    fi
    if state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)"; then
      if [ "$state" != "running" ]; then
        echo "MinIO container is '${state}', not running"
        return 1
      fi
    elif [ "$inspect_warned" -eq 0 ]; then
      # `docker inspect` fails both when the container is gone and when the
      # daemon itself is unreachable — the latter being the condition this
      # step exists to diagnose. Not fatal: keep polling to READY_TIMEOUT so
      # a transient daemon hiccup gets a chance to settle rather than
      # aborting the wait 59s early.
      echo "docker inspect ${CONTAINER} failed — container gone or daemon unreachable; still polling"
      inspect_warned=1
    fi
    sleep 1
  done
  echo "MinIO did not answer /minio/health/live within ${READY_TIMEOUT}s"
  return 1
}

ready=false
for attempt in $(seq 1 "$START_ATTEMPTS"); do
  # `docker run` failing — an image pull hitting Docker Hub's anonymous
  # rate limit is the common case — belongs inside the retry envelope too,
  # not escaping via errexit with a bare docker error and no diagnostics.
  # `&&` short-circuits, and an `if` condition is exempt from `set -e`.
  if start_minio && wait_ready; then
    ready=true
    break
  fi
  dump_diagnostics
  if [ "$attempt" -lt "$START_ATTEMPTS" ]; then
    echo "::warning::MinIO not ready on attempt ${attempt}/${START_ATTEMPTS} — retrying"
  fi
done

if [ "$ready" != true ]; then
  echo "::error::MinIO failed to start after ${START_ATTEMPTS} attempts — see the diagnostics above"
  exit 1
fi

# Mounted read-only; the script is idempotent. Network-attached so its
# `mc alias set minio http://storage:9000` resolves.
if ! docker run --rm --network "$NETWORK" \
  -v "${INIT_SCRIPT}:/init-storage.sh:ro" \
  -e MINIO_ROOT_USER \
  -e MINIO_ROOT_PASSWORD \
  -e MINIO_APP_ACCESS_KEY \
  -e MINIO_APP_SECRET_KEY \
  -e STORAGE_BUCKET \
  -e STORAGE_BUCKET_TEST \
  -e STORAGE_BUCKET_E2E \
  --entrypoint /bin/sh \
  "$MC_IMAGE" \
  /init-storage.sh; then
  echo "::error::Bucket provisioning (docker/init-storage.sh) failed"
  dump_diagnostics
  exit 1
fi
