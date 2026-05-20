# Manual Deploy

Pull-based deploy over WireGuard per ADR-0012. CI builds and pushes the image to GHCR; the operator pulls it onto the VPS.

```
operator dispatch on PR -> CI build-and-push -> GHCR (sha-<pr-tip>, <branch-slug>)
                                                  |
PR merge to main         -> CI promote        -> GHCR (sha-<merge-sha>, main)
                                                  |
operator (over WireGuard):                        v
  ssh vps -> sudo -u deploy /opt/projekt-manager/scripts/deploy.sh [ref]
    -> git fetch + checkout SHA
    -> decrypt secrets.env.age (age passphrase prompt)
    -> docker compose pull app + up -d
    -> smoke test /api/health (60s timeout)
    -> drill-key reload prompt (when /run/drill-key/identity is empty)
```

The merge-time `promote` job re-tags the dispatched artifact instead of rebuilding (~30s, no rescan, no smoke — the bytes were validated end-to-end during dispatch). If `workflow_dispatch` was skipped (Renovate auto-merge, direct push to main, force-push that invalidated the dispatched SHA), `promote` falls through to a full rebuild via the same composite action — ~5 min, with a `::warning::` in the run log naming the failed guard. See ADR-0011 §"Build once, promote on merge" for the full topology.

Have `~/secrets/age-backup.key` open on the operator workstation before invoking the deploy — when the backup container was recreated by the deploy, the script will prompt to paste the age private identity into the container's tmpfs (AC-175). See [backup/drills.md](backup/drills.md) for the threat model.

## Preconditions

| Requirement                                     | Verify                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `/opt/projekt-manager` is a git clone           | `sudo -u deploy git -C /opt/projekt-manager remote -v`                        |
| `age` installed                                 | `command -v age`                                                              |
| `deploy` logged in to GHCR                      | `sudo -u deploy docker pull ghcr.io/projekt-manager-org/projekt-manager:main` |
| `secrets.env.age` exists, owned `deploy:deploy` | `ls -l /opt/projekt-manager/secrets.env.age`                                  |
| `deploy` has no interactive login               | `getent passwd deploy` shows `/usr/sbin/nologin`                              |
| `deploy` can fetch from origin                  | `sudo -u deploy git -C /opt/projekt-manager fetch --dry-run origin`           |

## Deploy

```bash
# Deploy origin/main (default)
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh

# Deploy an iteration branch
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/iteration/N-name

# Deploy a specific SHA (rollback)
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh <sha>
```

The script: fetches origin, checks out the exact SHA, decrypts `secrets.env.age` via process substitution (plaintext never on disk), sets `APP_IMAGE_TAG=sha-<sha>`, runs `docker compose pull app && docker compose up -d`, polls `/api/health` for 60s, reloads Caddy, and — when the backup container's tmpfs is empty — prompts the operator to paste the age private identity into `/run/drill-key/identity` via the existing `load-drill-key` tool (no key persisted to disk). A failed or skipped paste warns but does not abort the deploy; reload manually with `docker exec -it projekt-manager-backup-1 load-drill-key`.

## How upgrades reach the VPS

`deploy.sh` covers everything except the Docker engine itself.

| Layer                                 | How                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| App / backup (npm, app code, Node)    | CI builds + pushes to GHCR per commit SHA → `deploy.sh` pulls + recreates containers                                                 |
| Caddy (`docker/caddy/Dockerfile`)     | `deploy.sh` runs `docker compose build caddy` — Docker's layer cache makes it near-free when nothing changed                         |
| Postgres / MinIO (pinned tags)        | `deploy.sh`'s `up -d` pulls on tag change. Same-tag-new-digest (rare) requires explicit `compose pull <service>` before deploy.      |
| Docker engine + Compose plugin (host) | Manual, lockstep per [ADR-0009](../adr/0009-pin-docker-versions-across-environments.md) → [server-setup.md](server-setup.md) Phase 4 |

## Rollback

Same as forward-deploy with an older SHA:

```bash
sudo -u deploy git -C /opt/projekt-manager log --oneline -20   # find good SHA
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh <sha>
```

The GHCR image must still exist. If pruned, use forward-rollback: `git revert` on operator machine, push, wait for CI, redeploy.

## Verify a deploy

Reads use `docker` directly rather than `docker compose`. The compose path re-parses `docker-compose.yml` on every invocation, which requires every interpolation var (`POSTGRES_PASSWORD`, `STORAGE_SECRET_KEY`, `CLOUDFLARE_API_TOKEN`, …) in shell env; a bare sudo shell doesn't have them sourced, so parse aborts with `CLOUDFLARE_API_TOKEN must be declared`. `docker ps` / `docker exec` / `docker logs` don't parse compose, so they work directly. Same class of problem fixed in `server-setup.md` Phase 8.1 (commit 5484903).

```bash
# Running commit
sudo -u deploy git -C /opt/projekt-manager rev-parse --short HEAD

# Container status
sudo -u deploy docker ps --filter name=projekt-manager-

# Direct health check (bypasses Caddy)
sudo -u deploy docker exec projekt-manager-app-1 \
  node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"

# From WireGuard client (end-to-end with TLS)
curl -sS https://${DOMAIN}/api/health
```

## Secrets

### Contents of `secrets.env.age`

Shell `KEY='value'` format. Three required Layer 1 secrets (app + storage + TLS), one optional Layer 1 secret (push), and six Layer 2 secrets (offsite backup — ADR-0020; R2 values from [backup/setup.md §1.4](backup/setup.md#14-create-the-api-token), age recipient from [§2](backup/setup.md#2-generate-the-age-key-pair)):

Layer 1 (required):

- `POSTGRES_PASSWORD`
- `STORAGE_SECRET_KEY` — the `applicationKey` half of the B2 app key (created via `b2 key create … readFiles,writeFiles,listFiles`; see [object-storage-provisioning.md § App key](object-storage-provisioning.md)). The matching `keyId` is `STORAGE_ACCESS_KEY` in plain `.env`.
- `CLOUDFLARE_API_TOKEN`

Layer 1 (optional — push notifications, ADR-0023):

- `VAPID_PRIVATE_KEY` -- Web Push signing key. Generate once with `npx web-push generate-vapid-keys --json` and keep the `privateKey` value stable across deploys (rotating invalidates every browser subscription). The matching public key is derived at startup. Unset = push dispatch is a no-op, UI shows "nicht konfiguriert". `VAPID_SUBJECT` (e.g. `mailto:admin@<your-domain>`) is non-secret and lives in the plain `.env` next to `DOMAIN`.

Layer 2:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` -- `https://<accountid>.r2.cloudflarestorage.com`
- `R2_BUCKET` -- optional; defaults to `projekt-manager-backups` in `docker-compose.yml`
- `R2_REGION` -- optional; defaults to `auto` in `docker-compose.yml`
- `AGE_RECIPIENT` -- PUBLIC recipient only, for backup encryption at rest. The matching age identity lives on the operator workstation, never on the VPS.

### Rotate a secret

`age` re-encrypts the whole file, so rotating one value means writing all of them back. The full setup procedure (including per-secret sources) lives in [backup/setup.md §3](backup/setup.md#3-push-r2-credentials--recipient-to-the-vps). Short form for rotating one existing value:

```bash
# Workstation (age must be installed locally). Decrypt the current
# file to recover the non-rotated values, edit in place, re-encrypt.
age -d secrets.env.age > /tmp/secrets.env        # enter passphrase
$EDITOR /tmp/secrets.env                         # change the one value
age -p -o secrets.env.age.new /tmp/secrets.env   # enter passphrase
shred -u /tmp/secrets.env
mv secrets.env.age.new secrets.env.age

# Workstation: upload to the VPS
scp secrets.env.age <sudo-user>@vps:/tmp/secrets.env.age

# VPS: ssh in as <sudo-user>, then run
sudo mv /tmp/secrets.env.age /opt/projekt-manager/secrets.env.age
sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age
sudo chmod 0600 /opt/projekt-manager/secrets.env.age

# VPS: redeploy to pick up new values
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
```

### Passphrase loss recovery

1. Regenerate or re-read each secret from its source:
   - `POSTGRES_PASSWORD` -- `ALTER USER` from superuser, or re-provision
   - `STORAGE_SECRET_KEY` -- B2 console: re-issue the app key (`b2 key delete <oldKeyId>` then `b2 key create … readFiles,writeFiles,listFiles`) and capture the new `applicationKey`. See [object-storage-provisioning.md § App key](object-storage-provisioning.md).
   - `CLOUDFLARE_API_TOKEN` -- Cloudflare dashboard, scope **DNS Write + Zone Read** on the managed zone (legacy names: `Zone:DNS:Edit` + `Zone:Zone:Read`). See [dns-setup.md § Cloudflare API token scope](dns-setup.md#cloudflare-api-token-scope).
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` -- issue a new R2 API token in the Cloudflare dashboard; the endpoint URL is listed alongside. Revoke the old token after the rotation deploy.
   - `R2_BUCKET`, `R2_REGION` -- read off the R2 dashboard (or fall back to the compose defaults).
   - `AGE_RECIPIENT` -- not affected by `secrets.env.age` passphrase loss. Derive from the existing identity on the operator workstation: `age-keygen -y ~/secrets/age-backup.key`.
2. Rebuild `secrets.env`, encrypt with `age -p`, upload (see [backup/setup.md §3](backup/setup.md#3-push-r2-credentials--recipient-to-the-vps)).
3. Record new passphrase in password manager.

Backup blobs in R2 remain decryptable — they are encrypted against `AGE_RECIPIENT`'s keypair, not the `secrets.env.age` passphrase. Losing only the deploy passphrase does not cost backup recoverability.

### GHCR pull token

- **Location:** `~deploy/.docker/config.json`
- **Scope:** classic PAT, `read:packages` only
- **Rotation:** every 12 months
- **Re-issue:** `sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<new-PAT>'`

## Bootstrap (first run on fresh VPS)

```bash
# 1. Clone
sudo mkdir -p /opt/projekt-manager
sudo chown deploy:deploy /opt/projekt-manager
sudo -u deploy git clone https://github.com/Projekt-Manager-Org/Projekt-Manager.git /opt/projekt-manager

# 2. Install age
sudo apt update && sudo apt install -y age

# 3. GHCR login (classic PAT, read:packages)
sudo -u deploy docker login ghcr.io -u vlzware --password-stdin <<< '<PAT>'

# 4. Upload secrets.env.age (see "Rotate a secret" above for the scp flow)

# 5. First deploy
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main

# 6. Lock down deploy user (ONLY after step 5 succeeds)
sudo usermod -s /usr/sbin/nologin deploy
sudo rm -f /home/deploy/.ssh/authorized_keys

# 7. Prove locked-down flow works: stop everything, redeploy from scratch.
# `docker stop` bypasses the compose-parse path (no secret interpolation needed)
# and is idempotent — missing/stopped containers just no-op with `|| true`.
sudo -u deploy docker stop projekt-manager-app-1 projekt-manager-db-1 projekt-manager-storage-1 projekt-manager-caddy-1 projekt-manager-backup-1 2>/dev/null || true
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
```

## Failure modes

| Symptom                                                                | Cause                                                      | Fix                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git checkout` fails                                                   | Uncommitted changes in working tree                        | `git status`, reset or stash                                                                                                                                                  |
| `git checkout landed at X, expected Y`                                 | Post-checkout SHA assertion                                | Inspect `git status`, clean up                                                                                                                                                |
| `age: failed to read identity`                                         | Wrong passphrase                                           | Retry; verify against password manager after 3 attempts                                                                                                                       |
| `docker pull` unauthorized                                             | GHCR PAT expired                                           | `docker login ghcr.io` as `deploy` with fresh PAT                                                                                                                             |
| Smoke test timeout (60s)                                               | App container failed or `/api/health` returning 503        | `docker logs projekt-manager-app-1 --tail=50` (also `-db-1`, `-storage-1`)                                                                                                    |
| `no such container` on exec                                            | `docker compose up -d` did not start `app`                 | `docker ps --filter name=projekt-manager-`; confirm the resolved tag exists in GHCR                                                                                           |
| `APP_IMAGE_TAG must be set` or `CLOUDFLARE_API_TOKEN must be declared` | Compose operation without pinned tag and/or secrets in env | For reads use `docker` directly (no parse). For compose operations route through `scripts/deploy.sh` — it pins the SHA and sources secrets from `secrets.env.age` internally. |
| First request after deploy 500s with `column "<X>" does not exist`     | Schema baseline edited; live DB still on previous schema   | Wipe + reseed + sync — see [recover-from-schema-change.md](recover-from-schema-change.md)                                                                                     |
