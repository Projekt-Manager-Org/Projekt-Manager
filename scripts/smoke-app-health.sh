#!/usr/bin/env bash
#
# Poll /api/health from inside the app container until it returns HTTP 200,
# or fail with a diagnostic. Single source of truth for the readiness gate
# used by:
#
#   - scripts/ci/stack-smoke.sh        (CI runtime smoke, upgrade path)
#   - scripts/deploy.sh                (post-deploy verification)
#   - scripts/ops/sync-restore-vps.sh  (post-restore verification, via the
#                                       copy shipped in $REMOTE_TMP)
#
# Why a shared script: three inline copies of this loop drifted (effaee4
# dropped the docker healthcheck; the CI loop kept polling
# .State.Health.Status while the other two used a fetch probe — only CI
# broke). Centralizing the contract here so future tweaks land in one place.
#
# Usage:
#   scripts/smoke-app-health.sh <container_name> [timeout_seconds]
#
# Args:
#   container_name     Name of the running app container — typically
#                      'projekt-manager-app-1' under the default compose
#                      project name. Caller is the authoritative source.
#   timeout_seconds    Wall-clock budget. Defaults to 60.
#
# Exit:
#   0  /api/health returned HTTP 200 within the timeout.
#   1  timeout exceeded; per-attempt failure reasons printed to stdout,
#      final summary on stderr.
#
# Why `docker exec <name>` (not `docker compose exec <service>`): callers
# invoke this from multiple cwd contexts. SSH-streamed callers
# (sync-restore-vps.sh) start in $HOME on the VPS, where `docker compose`
# cannot resolve the project. The container name is unambiguous regardless.

set -euo pipefail

CONTAINER="${1:?usage: $0 <container_name> [timeout_seconds]}"
TIMEOUT="${2:-60}"

# Probe runs inside the container. The app listens on :3000 internally
# regardless of any host-port mapping, so localhost is correct here. Using
# `node -e` (not curl) because the app image is Node-based — no extra
# binary needed.
#
# Diagnostic on failure:
#   - non-2xx response   -> "HTTP <status> <body>" so an operator can tell
#                           DB-fail from storage-fail without grepping app
#                           logs (probeHealth returns checks.db / .storage
#                           in the JSON body).
#   - ECONNREFUSED       -> "starting (ECONNREFUSED)" — port not bound yet,
#                           benign during the boot window. Spelled out (not
#                           silenced) because it is also the signal we want
#                           to see disappear once the app is up.
#   - other fetch error  -> "transport: <code>" where the code comes from
#                           `err.cause` (undici flattens system errors there).
#                           Without this, Node's top-level message is the
#                           literal "fetch failed" for every cause —
#                           ECONNRESET (event loop wedged mid-handshake)
#                           looks identical to ETIMEDOUT (kernel accepted,
#                           Fastify never replied).
#   - docker exec error  -> the daemon's message ("No such container",
#                           "Container ... is not running") falls through
#                           unchanged.
PROBE_JS=$(cat <<'JS'
fetch('http://localhost:3000/api/health')
  .then(async r => {
    if (r.ok) process.exit(0);
    const body = await r.text();
    process.stderr.write(`HTTP ${r.status} ${body}\n`);
    process.exit(1);
  })
  .catch(err => {
    const code = err.cause?.code ?? err.cause?.message ?? err.message;
    const label = code === 'ECONNREFUSED' ? `starting (${code})` : `transport: ${code}`;
    process.stderr.write(`${label}\n`);
    process.exit(1);
  });
JS
)

elapsed=0
attempt=0
while [ "$elapsed" -lt "$TIMEOUT" ]; do
  attempt=$((attempt + 1))
  # Capture stdout+stderr together. A successful probe prints nothing; a
  # failure prints the diagnostic line emitted by PROBE_JS, or docker
  # exec's own error if the container is not yet up.
  if reason=$(docker exec "$CONTAINER" node -e "$PROBE_JS" 2>&1); then
    echo "  attempt ${attempt}: ready"
    exit 0
  fi
  # Trim to the first line — the smoke loop log stays compact; fuller
  # dumps belong to the caller's failure path (`docker logs --tail=N`
  # after this script returns non-zero).
  echo "  attempt ${attempt}: ${reason%%$'\n'*}"
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "ERROR: /api/health did not return 200 within ${TIMEOUT}s on ${CONTAINER}" >&2
exit 1
