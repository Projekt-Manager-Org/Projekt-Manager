#!/usr/bin/env bash
# Moves the VPS to the Docker pins of a ref and runs the acceptance: steps
# 2-3 (test) and 5b/5c (revert) of the Docker bump runbook
# (docs/ops/server-setup.md § Upgrading pinned versions).
#
# Usage:
#   sudo scripts/ops/docker-bump.sh test <ref>               # e.g. origin/renovate/docker-host
#   sudo scripts/ops/docker-bump.sh revert [--fresh-state]   # back to origin/main's pins
#
# test:   restore point (one backup cycle), record the Postgres
#         system_identifier, switch, acceptance.
# revert: switch to origin/main, acceptance. Needs no healthy stack first.
#
# Switch: `deploy.sh <ref>` checks out the ref's pins and refuses at the
# drift guard; converge (revert --fresh-state: docker-fresh-state.sh);
# `deploy.sh <sha>`, the SHA the first deploy checked out, even if the
# branch moved since. A host already on the ref's pins deploys once.
#
# Acceptance:
#   1. The last deploy.sh exits 0 (containers up, binary key loaded, health
#      inside the app and through Caddy) and the drill key is loaded.
#   2. One backup cycle exits 0.
#   3. The system_identifier equals the recorded one: the same Postgres
#      cluster. A lost volume comes back empty and still reports healthy.
#   The check from a WireGuard client is printed: it cannot run from here.
#
# The identifier is recorded once, in $STATE_FILE, and outlives a round:
# it names the cluster. `test` refuses when the running cluster differs
# from the record; delete the file only after replacing the cluster on
# purpose (a restore or a reseed).
#
# Interactive: deploy.sh asks for the secrets passphrase and the key
# pastes, docker-fresh-state.sh before it stops Docker.
#
# Exit codes: 0 accepted; 1 failed (names the check and what next);
# 2 usage or not root.
set -euo pipefail

REPO_DIR="${DOCKER_BUMP_REPO_DIR:-/opt/projekt-manager}"
STATE_FILE="${DOCKER_BUMP_STATE_FILE:-/var/lib/projekt-manager/docker-bump-sysid}"
DB=projekt-manager-db-1
BACKUP=projekt-manager-backup-1
CADDY=projekt-manager-caddy-1
RUNBOOK="docs/ops/server-setup.md § Upgrading pinned versions"

usage() {
  echo "usage: sudo $0 test <ref> | revert [--fresh-state]" >&2
  exit 2
}

# fail <what> — names the failed check and the next runbook step.
fail() {
  echo >&2
  echo "FAIL: $1" >&2
  echo "Next: $next ($RUNBOOK)" >&2
  exit 1
}

as_deploy() { sudo -u deploy "$@"; }

sysid() {
  docker exec "$DB" psql -U pm -d projekt_manager -tAc \
    'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]'
}

backup_cycle() {
  echo "==> One backup cycle"
  docker exec "$BACKUP" node /app/dist/server/backup-runner.js run
}

# switch <ref> <converge|fresh-state> — sets $sha to the deployed SHA.
switch() {
  local ref="$1" how="$2" head want
  echo "==> deploy.sh $ref (checks out its pins; refuses on drift)"
  if as_deploy "$REPO_DIR/scripts/deploy.sh" "$ref"; then
    sha="$(as_deploy git -C "$REPO_DIR" rev-parse HEAD)"
    echo "Host already on the pins of $ref: deployed once, nothing to switch."
    return 0
  fi
  head="$(as_deploy git -C "$REPO_DIR" rev-parse HEAD)"
  want="$(as_deploy git -C "$REPO_DIR" rev-parse "$ref")" || want=""
  [[ "$head" == "$want" ]] || fail "deploy.sh did not check out $ref (HEAD is $head)"
  if "$REPO_DIR/scripts/ops/docker-converge.sh" --check >/dev/null 2>&1; then
    fail "deploy.sh $ref failed, but not at the drift guard (output above)"
  fi
  echo "Refused on drift, as expected."
  sha="$head"
  if [[ "$how" == fresh-state ]]; then
    "$REPO_DIR/scripts/ops/docker-fresh-state.sh" || fail "docker-fresh-state.sh (output above)"
  else
    echo "==> Converge to the pins of $sha"
    "$REPO_DIR/scripts/ops/docker-converge.sh" || fail "converge (output above)"
  fi
  echo "==> deploy.sh $sha"
  as_deploy "$REPO_DIR/scripts/deploy.sh" "$sha" || fail "deploy.sh $sha (output above)"
}

# accept <recorded system_identifier, may be empty>
accept() {
  local recorded="$1" now
  if ! docker exec "$BACKUP" test -s /run/drill-key/identity 2>/dev/null; then
    echo "==> Drill key not loaded; paste it now"
    docker exec -it "$BACKUP" load-drill-key || fail "drill key not loaded"
  fi
  backup_cycle || fail "backup cycle after the switch"
  now="$(sysid)" || now=""
  [[ -n "$now" ]] || fail "cannot read the Postgres system_identifier"
  if [[ -z "$recorded" ]]; then
    echo "WARN: no recorded system_identifier ($STATE_FILE); check 3 skipped, now $now" >&2
  elif [[ "$now" != "$recorded" ]]; then
    next="restore from backup, step 5d"
    fail "system_identifier is $now, recorded $recorded: not the same Postgres cluster"
  fi
}

wg_hint() {
  local domain
  domain="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CADDY" 2>/dev/null |
    sed -n 's/^DOMAIN=//p')" || domain=""
  echo "  - From a WireGuard client: curl -fsS https://${domain:-<DOMAIN>}/api/health   # \"status\":\"ok\""
}

main() {
  local mode="${1:-}" ref how=converge cur recorded=""
  case "$mode" in
    test)
      [[ $# -eq 2 ]] || usage
      ref="$2"
      next="revert, step 5"
      ;;
    revert)
      ref=origin/main
      next="step 5c, or 5d"
      case "$#:${2:-}" in
        1:) ;;
        2:--fresh-state)
          how=fresh-state
          next="restore from backup, step 5d"
          ;;
        *) usage ;;
      esac
      ;;
    *) usage ;;
  esac
  if [[ "$(id -u)" != 0 ]]; then
    echo "error: run as root: sudo $0 $*" >&2
    exit 2
  fi
  [[ -r "$STATE_FILE" ]] && recorded="$(<"$STATE_FILE")"

  if [[ "$mode" == test ]]; then
    # Nothing changes until the restore point exists.
    next="nothing changed; fix the stack first"
    cur="$(sysid)" || fail "cannot read the Postgres system_identifier"
    [[ -n "$cur" ]] || fail "cannot read the Postgres system_identifier"
    if [[ -z "$recorded" ]]; then
      install -d -m 700 "$(dirname "$STATE_FILE")"
      echo "$cur" >"$STATE_FILE"
      recorded="$cur"
      echo "Recorded system_identifier $cur in $STATE_FILE"
    elif [[ "$cur" != "$recorded" ]]; then
      fail "the running cluster ($cur) is not the recorded one ($recorded). Replaced on purpose (restore, reseed)? Then: sudo rm $STATE_FILE"
    fi
    backup_cycle || fail "restore-point backup"
    next="revert, step 5"
  fi

  switch "$ref" "$how"
  accept "$recorded"

  echo
  echo "PASS: acceptance 1-3 at $sha. By hand:"
  wg_hint
  if [[ "$mode" == test ]]; then
    echo "  - Merge the PR if its pins are unchanged since the test:"
    echo "      git fetch && git diff --quiet $sha $ref -- docker/host-versions.txt && echo unchanged"
  else
    [[ "$how" == converge ]] ||
      echo "  - Delete the old Docker state with the rm -rf line docker-fresh-state.sh printed above."
    echo "  - Close the PR after the schedule window."
  fi
}

# The deploys check out other versions of this file while it runs: parse
# everything first: main and exit on one line.
main "$@"; exit
