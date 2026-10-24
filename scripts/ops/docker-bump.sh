#!/usr/bin/env bash
# Moves the VPS to the Docker pins of a ref and runs the acceptance: steps
# 2-4 (test, merge-check) and 5b/5c (revert) of the Docker bump runbook
# (docs/ops/server-setup.md § Upgrading pinned versions).
#
# Usage:
#   sudo scripts/ops/docker-bump.sh test <ref>               # e.g. origin/renovate/docker-host
#   sudo scripts/ops/docker-bump.sh merge-check <ref>        # pins unchanged since the passed test?
#   sudo scripts/ops/docker-bump.sh revert [--fresh-state]   # back to origin/main's pins
#
# test:        record the Postgres system_identifier, restore point (one
#              backup cycle), switch, acceptance; on PASS, record the SHA.
# merge-check: compares that SHA's pins with the ref's. The PR rebases
#              when main moves, so its head is no longer the tested SHA.
# revert:      switch to origin/main, acceptance. Needs no healthy stack
#              first.
#
# Switch: `deploy.sh <ref>` checks out the ref's pins and refuses at the
# drift guard; converge (revert --fresh-state: docker-fresh-state.sh);
# `deploy.sh <sha>`, the SHA the first deploy checked out, even if the
# branch moved since. A host already on the ref's pins deploys once.
#
# Acceptance, numbered as in the runbook:
#   1. The last deploy.sh exits 0 (containers up, binary key loaded, health
#      inside the app and through Caddy) and the drill key is loaded.
#   2. One backup cycle exits 0.
#   3. From a WireGuard client: printed, it cannot run from here.
#   4. The system_identifier equals the recorded one: the same Postgres
#      cluster. A lost volume comes back empty and still reports healthy.
#
# The identifier is recorded once, in $SYSID_FILE, and outlives a round:
# it names the cluster. `test` refuses when the running cluster differs
# from the record; delete the file only after replacing the cluster on
# purpose (a restore or a reseed). The tested SHA ($TESTED_FILE) lives
# from a passed test to the next test or revert.
#
# Interactive: deploy.sh asks for the secrets passphrase and the key
# pastes, docker-fresh-state.sh before it stops Docker.
#
# Exit codes: 0 accepted / pins unchanged; 1 failed (names the check and
# what next) / pins changed; 2 usage or not root.
set -euo pipefail

REPO_DIR="${DOCKER_BUMP_REPO_DIR:-/opt/projekt-manager}"
STATE_DIR="${DOCKER_BUMP_STATE_DIR:-/var/lib/projekt-manager}"
SYSID_FILE="$STATE_DIR/docker-bump-sysid"
TESTED_FILE="$STATE_DIR/docker-bump-tested"
DB=projekt-manager-db-1
BACKUP=projekt-manager-backup-1
CADDY=projekt-manager-caddy-1
RUNBOOK="docs/ops/server-setup.md § Upgrading pinned versions"
UNTOUCHED="Docker untouched; fix the deploy (output above) and re-run"

usage() {
  echo "usage: sudo $0 test <ref> | merge-check <ref> | revert [--fresh-state]" >&2
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
  local ref="$1" how="$2" head want after="$next"
  next="$UNTOUCHED"
  echo "==> deploy.sh $ref (checks out its pins; refuses on drift)"
  if as_deploy "$REPO_DIR/scripts/deploy.sh" "$ref"; then
    # A ref older than the drift guard deploys on any Docker.
    if ! "$REPO_DIR/scripts/ops/docker-converge.sh" --check; then
      next="pick a ref that carries docker/host-versions.txt; $after"
      fail "deploy.sh $ref deployed without the drift guard: the host is not on the ref's pins"
    fi
    sha="$(as_deploy git -C "$REPO_DIR" rev-parse HEAD)"
    echo "Host already on the pins of $ref: deployed once, nothing to switch."
    next="$after"
    return 0
  fi
  head="$(as_deploy git -C "$REPO_DIR" rev-parse HEAD)"
  want="$(as_deploy git -C "$REPO_DIR" rev-parse "$ref")" || want=""
  [[ "$head" == "$want" ]] || fail "deploy.sh did not check out $ref (HEAD is $head)"
  if "$REPO_DIR/scripts/ops/docker-converge.sh" --check >/dev/null 2>&1; then
    fail "deploy.sh $ref failed, but not at the drift guard (output above)"
  fi
  echo "Refused on drift, as expected."
  next="$after"
  sha="$head"
  if [[ "$how" == fresh-state ]]; then
    next="docker-fresh-state.sh says above what it moved; then step 5d"
    "$REPO_DIR/scripts/ops/docker-fresh-state.sh" || fail "docker-fresh-state.sh (output above)"
    next="$after"
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
    echo "WARN: no recorded system_identifier ($SYSID_FILE); check 4 skipped, now $now" >&2
  elif [[ "$now" != "$recorded" ]]; then
    next="restore from backup, step 5d"
    fail "system_identifier is $now, recorded $recorded: not the same Postgres cluster"
  fi
}

wg_hint() {
  local domain
  domain="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CADDY" 2>/dev/null |
    sed -n 's/^DOMAIN=//p')" || domain=""
  echo "  - Check 3, from a WireGuard client: curl -fsS https://${domain:-<DOMAIN>}/api/health   # \"status\":\"ok\""
}

# merge_check <ref> — in the VPS clone, which still holds the tested SHA
# after a rebase moved the branch past it.
merge_check() {
  local ref="$1" tested rc=0
  if [[ ! -r "$TESTED_FILE" ]]; then
    echo "error: no passed test recorded ($TESTED_FILE): run step 2 first" >&2
    exit 1
  fi
  tested="$(<"$TESTED_FILE")"
  as_deploy git -C "$REPO_DIR" fetch -q origin
  as_deploy git -C "$REPO_DIR" diff --quiet "$tested" "$ref" -- docker/host-versions.txt || rc=$?
  case "$rc" in
    0) echo "Pins of $ref unchanged since the passed test at $tested: merge." ;;
    1)
      echo "Pins of $ref changed since the passed test at $tested: repeat step 2." >&2
      exit 1
      ;;
    *)
      echo "error: cannot compare $tested with $ref (git exit $rc, output above)" >&2
      exit 1
      ;;
  esac
}

main() {
  local mode="${1:-}" ref how=converge cur recorded=""
  case "$mode" in
    test)
      [[ $# -eq 2 ]] || usage
      ref="$2"
      ;;
    merge-check)
      [[ $# -eq 2 ]] || usage
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
  if [[ "$mode" == merge-check ]]; then
    merge_check "$2"
    return
  fi
  # A test or revert invalidates the last passed test until a new one passes.
  rm -f "$TESTED_FILE"
  [[ -r "$SYSID_FILE" ]] && recorded="$(<"$SYSID_FILE")"

  if [[ "$mode" == test ]]; then
    # Nothing changes until the restore point exists.
    next="nothing changed. Fix the stack; mid-bump (rolling forward), revert instead: step 5b or 5c"
    cur="$(sysid)" || fail "cannot read the Postgres system_identifier"
    [[ -n "$cur" ]] || fail "cannot read the Postgres system_identifier"
    if [[ -z "$recorded" ]]; then
      install -d -m 700 "$STATE_DIR"
      echo "$cur" >"$SYSID_FILE"
      recorded="$cur"
      echo "Recorded system_identifier $cur in $SYSID_FILE"
    elif [[ "$cur" != "$recorded" ]]; then
      fail "the running cluster ($cur) is not the recorded one ($recorded). Replaced on purpose (restore, reseed)? Then: sudo rm $SYSID_FILE"
    fi
    backup_cycle || fail "restore-point backup"
    next="revert, step 5"
  fi

  switch "$ref" "$how"
  accept "$recorded"

  echo
  echo "PASS: acceptance 1, 2 and 4 at $sha. By hand:"
  wg_hint
  if [[ "$mode" == test ]]; then
    echo "$sha" >"$TESTED_FILE"
    echo "  - Before merging the PR: sudo $0 merge-check $ref"
  else
    [[ "$how" == converge ]] ||
      echo "  - Delete the old Docker state with the rm -rf line docker-fresh-state.sh printed above."
    echo "  - Close the PR after the schedule window."
  fi
}

# The deploys check out other versions of this file while it runs: parse
# everything first: main and exit on one line.
main "$@"; exit
