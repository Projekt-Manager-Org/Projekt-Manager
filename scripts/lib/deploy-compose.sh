# shellcheck shell=bash
#
# The compose profiles a deploy runs, in one place. Sourced by
# scripts/deploy.sh (pull/up/logs) and scripts/ci/deploy-inventory.sh (the
# nightly inventory scan, #637), so what is scanned is what is deployed: a
# profile added here is pulled, started AND scanned; one passed inline in
# either script would drift. scripts/__tests__/deploy-inventory.test.sh
# fails if either selects profiles any other way.
#
# shellcheck disable=SC2034  # consumed by the sourcing script
DEPLOY_PROFILES=(backup)

# The same set as compose flags: `docker compose "${DEPLOY_COMPOSE_PROFILES[@]}" …`
DEPLOY_COMPOSE_PROFILES=()
for _profile in "${DEPLOY_PROFILES[@]}"; do
  DEPLOY_COMPOSE_PROFILES+=(--profile "$_profile")
done
unset _profile

# Refuse anything that makes bare `docker compose` in $1 load more than
# docker-compose.yml with DEPLOY_PROFILES: COMPOSE_FILE / COMPOSE_PROFILES
# from the shell or $1/.env, an override file compose merges on its own,
# or a compose.yaml it would prefer. Any of them would make a deploy run
# files or profiles the nightly inventory — which runs without them —
# never scans. Production runs docker-compose.yml alone
# (docker-compose.minio.yml header); the dev .env sets COMPOSE_FILE and
# must not reach a deploy host. Call it after every source of env the
# compose calls see (deploy.sh: after the secrets are exported).
assert_no_compose_overrides() {
  local dir="$1" var file found=0
  for var in COMPOSE_FILE COMPOSE_PROFILES; do
    if [ -n "${!var:-}" ]; then
      echo "ERROR: $var is set in the environment (${!var}); a deploy runs docker-compose.yml with DEPLOY_PROFILES only." >&2
      found=1
    fi
  done
  # .env takes `KEY=value` and `KEY: value`.
  if [ -f "$dir/.env" ] && grep -qE '^[[:space:]]*(export[[:space:]]+)?COMPOSE_(FILE|PROFILES)[[:space:]]*[=:]' "$dir/.env"; then
    echo "ERROR: $dir/.env sets COMPOSE_FILE or COMPOSE_PROFILES; a deploy runs docker-compose.yml with DEPLOY_PROFILES only." >&2
    found=1
  fi
  for file in compose.yaml compose.yml compose.override.yaml compose.override.yml \
    docker-compose.yaml docker-compose.override.yaml docker-compose.override.yml; do
    if [ -e "$dir/$file" ]; then
      echo "ERROR: $dir/$file exists; bare docker compose would load it alongside or instead of docker-compose.yml." >&2
      found=1
    fi
  done
  return "$found"
}
