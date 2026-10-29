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
