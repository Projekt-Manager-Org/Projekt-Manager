#!/usr/bin/env bash
#
# Poll https://$DOMAIN/api/health through Caddy from the host until it
# returns HTTP 200, or fail with a diagnostic. The outside-in counterpart
# of scripts/smoke-app-health.sh, which probes from inside the app
# container and so never touches the published port, Caddy or TLS — the
# layers a Docker Engine upgrade changes (ADR-0009). Run by
# scripts/deploy.sh after the Caddy reload.
#
# Usage:
#   scripts/smoke-caddy-health.sh [timeout_seconds]
#
# Domain and address come from the running Caddy container — its DOMAIN
# env and the host address Docker actually published 443/tcp on — so the
# probe follows what is deployed, not a second copy of the .env values.
# On the VPS that address is the WireGuard IP; the probe runs on the host
# itself, so it does not cover a WireGuard client's path to it.
#
# The certificate must verify against the system store: a probe that
# skipped verification would pass a broken or wrong certificate.
#
# Exit:
#   0  HTTP 200 within the timeout.
#   1  timeout exceeded; per-attempt reasons on stdout, summary on stderr.
set -euo pipefail

TIMEOUT="${1:-60}"
CONTAINER=projekt-manager-caddy-1

domain=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" |
  sed -n 's/^DOMAIN=//p')
binding=$(docker port "$CONTAINER" 443/tcp | head -n 1)
if [[ -z "$domain" || -z "$binding" ]]; then
  echo "ERROR: $CONTAINER has no DOMAIN env or no published 443/tcp (got '$domain', '$binding')" >&2
  exit 1
fi
addr="${binding%:*}"
port="${binding##*:}"

url="https://$domain:$port/api/health"
echo "Probing $url via $addr (up to ${TIMEOUT}s)"
deadline=$((SECONDS + TIMEOUT))
attempt=0
while :; do
  attempt=$((attempt + 1))
  status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$domain:$port:$addr" "$url" 2>&1) || true
  if [[ "$status" == 200 ]]; then
    echo "  attempt $attempt: HTTP 200"
    exit 0
  fi
  echo "  attempt $attempt: $status"
  if ((SECONDS >= deadline)); then
    echo "ERROR: $url did not return 200 through Caddy within ${TIMEOUT}s" >&2
    exit 1
  fi
  sleep 2
done
