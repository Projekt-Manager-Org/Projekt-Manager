#!/usr/bin/env bash
#
# The images a deploy runs, as one line of JSON for a workflow matrix.
#
# WHY THIS EXISTS
#   The nightly inventory scan (#637, ADR-0027 § 2026-10-27) must scan
#   every image the deployment runs. A hand-picked list is how `caddy` and
#   `postgres` went unscanned for months, so the set is derived from the
#   same compose file and profiles deploy.sh uses (scripts/lib/
#   deploy-compose.sh). A new service — profile-gated or not — is scanned
#   with no change here.
#
# CONTRACT
#   Reads from the environment:
#     APP_IMAGE_TAG     tag of the first-party images to scan (required).
#     DEPLOY_REPO_ROOT  tree holding docker-compose.yml (default: this
#                       repo); the test harness points it at fixtures.
#
#   Writes one JSON array on stdout, one object per service:
#     {"service", "image", "build": false}             pulled image
#     {"service", "image", "build": true,
#      "context", "dockerfile"}                        built on deploy; the
#                                                      image name is the one
#                                                      compose would give it
#                                                      (<project>-<service>),
#                                                      context is relative
#                                                      to the repo root
#
#   Interpolation is off: the real compose file requires secrets and
#   endpoints (`${VAR:?}`) a scanner does not have and must not need. Only
#   APP_IMAGE_TAG is substituted; an image still holding a `$` afterwards
#   names a variable this script cannot resolve, so it refuses rather
#   than hand a literal `${…}` to the scanner.
#
#   `--no-interpolate` also switches off compose's profile filtering
#   (measured, Compose v5.3.1: every profile's services come back), so the
#   rule is applied here: a service runs if it has no profiles or shares
#   one with DEPLOY_PROFILES.
#
# EXIT CODES
#   0  inventory printed
#   1  an image reference holds an unresolved variable, a build uses
#      args/target this script does not pass on, or COMPOSE_FILE /
#      COMPOSE_PROFILES overrides the deploy file set (see the helper)
#   2  APP_IMAGE_TAG unset or empty
#
# Usage:
#   APP_IMAGE_TAG=main bash scripts/ci/deploy-inventory.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${DEPLOY_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

if [ -z "${APP_IMAGE_TAG:-}" ]; then
  echo "::error::deploy-inventory.sh: APP_IMAGE_TAG is unset or empty" >&2
  exit 2
fi

# shellcheck source=scripts/lib/deploy-compose.sh
. "$SCRIPT_DIR/../lib/deploy-compose.sh"
assert_no_compose_overrides "$REPO_ROOT" || exit 1

active_json=$(jq -cn '$ARGS.positional' --args "${DEPLOY_PROFILES[@]}")

config=$(cd "$REPO_ROOT" && docker compose "${DEPLOY_COMPOSE_PROFILES[@]}" config --no-interpolate --format json)

jq -c --arg tag "$APP_IMAGE_TAG" --arg root "$REPO_ROOT" --argjson active "$active_json" '
  .name as $project
  | .services | to_entries
  | map(select((.value.profiles // []) as $p | ($p == [] or any($p[]; IN($active[])))))
  | map(
      if .value.build then
        if (.value.build | has("args") or has("target")) then
          error("\(.key): build args/target are not passed on by the scan")
        else
          { service: .key, build: true,
            image: (.value.image // "\($project)-\(.key)"),
            context: (.value.build.context | ltrimstr($root + "/")),
            dockerfile: (.value.build.dockerfile // "Dockerfile") }
        end
      else
        { service: .key, build: false,
          image: (.value.image | gsub("\\$\\{APP_IMAGE_TAG(:?[-?][^}]*)?\\}"; $tag)) }
      end
    )
  | map(if (.image | contains("$")) then error("\(.service): unresolved variable in \(.image)") else . end)
' <<<"$config" || exit 1
