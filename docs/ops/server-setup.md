# Server Setup -- Hetzner VPS

## Server

| Property | Value                                 |
| -------- | ------------------------------------- |
| Provider | Hetzner Cloud                         |
| OS       | Ubuntu 24.04 LTS                      |
| Tier     | CX23 (2 vCPU / 4 GB RAM / 40 GB disk) |
| Firewall | Hetzner Cloud Firewall                |

## Accounts

| Account    | Purpose                               | SSH                                | sudo           | docker |
| ---------- | ------------------------------------- | ---------------------------------- | -------------- | ------ |
| `root`     | Disabled for SSH                      | --                                 | --             | --     |
| Admin user | Interactive admin                     | Personal key                       | Yes (password) | No     |
| `deploy`   | Container ops (`sudo -u deploy` only) | None (nologin, no authorized_keys) | No             | Yes    |

Admin credentials in password manager. `deploy` is a system account, no password.

## SSH hardening

- `PermitRootLogin no`
- `PasswordAuthentication no`
- Key-only auth
- fail2ban: 5 attempts / 10 min / 1 hour ban

## Firewall rules

Two layers: ufw on the host (always present, provider-independent) and the cloud provider firewall (Hetzner Cloud Firewall in this setup). Both enforce the same policy — defense in depth.

| Port  | Protocol | Status | Purpose                             |
| ----- | -------- | ------ | ----------------------------------- |
| 22    | TCP      | Open   | SSH (admin only)                    |
| 51820 | UDP      | Open   | WireGuard                           |
| --    | ICMP     | Open   | Ping / diagnostics                  |
| 80    | TCP      | Closed | Not needed (DNS-01 ACME)            |
| 443   | TCP      | Closed | Caddy binds only to `wg0` interface |

ICMP is allowed by default in both ufw (`/etc/ufw/before.rules`) and Hetzner Cloud Firewall. No explicit rule needed.

## Network topology

- **VPN:** plain WireGuard (kernel module). Server `wg0` at `10.213.17.1/24`, peers at `10.213.17.10+`. Setup: see [wireguard-setup.md](wireguard-setup.md).
- **Application:** `https://${DOMAIN}`, Caddy bound to `10.213.17.1:443`. Clients join WireGuard and resolve `${DOMAIN}` to `10.213.17.1`.
- **Caddy:** custom xcaddy build (`docker/caddy/Dockerfile`) with `caddy-dns/cloudflare` plugin. DNS-01 ACME via Cloudflare. No public ACME port needed.
- **HTTPS is mandatory** regardless of VPN -- defense in depth (ADR-0008).

## Key file locations

| What                | Where                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Project directory   | `/opt/projekt-manager`                                                                    |
| Non-secret env vars | `/opt/projekt-manager/.env`                                                               |
| Encrypted secrets   | `/opt/projekt-manager/secrets.env.age` (see [manual-deploy.md](manual-deploy.md#secrets)) |
| Deploy GitHub key   | `/home/deploy/.ssh/github_deploy`                                                         |
| Deploy SSH config   | `/home/deploy/.ssh/config`                                                                |
| fail2ban config     | `/etc/fail2ban/jail.local`                                                                |

## Software

- Docker Engine + Compose plugin (official repo, pinned versions, apt hold)
- WireGuard (`wireguard-tools`, kernel module)
- `ufw`, fail2ban, `qrencode`, `age`, `unattended-upgrades`

---

## Provisioning Phases

**Golden rule:** always verify access in a second terminal before changing authentication.

### Prerequisites

- Hetzner Cloud account
- ED25519 SSH keypair
- GitHub repo settings access (for Deploy Key)
- Password manager access

### Phase 1 -- Base OS

1. Create VPS: Ubuntu 24.04, CX23, add SSH key during creation.
2. Configure Hetzner Firewall: allow 22/TCP, block everything else.
3. SSH in as root:
   ```bash
   apt update && apt upgrade -y && reboot
   ```
4. Create admin user:
   ```bash
   adduser <admin-username>
   usermod -aG sudo <admin-username>
   ```
5. Copy SSH key:
   ```bash
   mkdir -p /home/<admin-username>/.ssh
   cp /root/.ssh/authorized_keys /home/<admin-username>/.ssh/authorized_keys
   chown -R <admin-username>:<admin-username> /home/<admin-username>/.ssh
   chmod 700 /home/<admin-username>/.ssh
   chmod 600 /home/<admin-username>/.ssh/authorized_keys
   ```

**Verify:** `ssh <admin-username>@<ip>` works, `sudo whoami` returns `root`. Do NOT proceed until verified.

### Phase 2 -- SSH hardening

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl reload sshd
```

**Verify:** `ssh root@<ip>` is rejected. Admin key login still works.

### Phase 3 -- Deploy user

```bash
sudo adduser --system --group --shell /usr/sbin/nologin --home /home/deploy deploy
sudo mkdir -p /home/deploy/.ssh
sudo chown deploy:deploy /home/deploy/.ssh
sudo chmod 700 /home/deploy/.ssh
```

**Verify:** `sudo -u deploy whoami` -> `deploy`. `sudo -u deploy sudo whoami` -> denied.

### Phase 4 -- Docker

Pinned versions (ADR-0009):

| Package                 | Version                         |
| ----------------------- | ------------------------------- |
| `docker-ce`             | `5:29.5.0-1~ubuntu.24.04~noble` |
| `docker-ce-cli`         | `5:29.5.0-1~ubuntu.24.04~noble` |
| `containerd.io`         | `2.2.3-1~ubuntu.24.04~noble`    |
| `docker-buildx-plugin`  | `0.34.0-1~ubuntu.24.04~noble`   |
| `docker-compose-plugin` | `5.1.3-1~ubuntu.24.04~noble`    |

1. Add Docker apt repository:

   ```bash
   sudo apt-get install -y ca-certificates curl
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
     https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME}") stable" | \
     sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
   sudo apt-get update
   ```

2. Install pinned versions:

   ```bash
   sudo apt-get install -y \
     docker-ce=5:29.5.0-1~ubuntu.24.04~noble \
     docker-ce-cli=5:29.5.0-1~ubuntu.24.04~noble \
     containerd.io=2.2.3-1~ubuntu.24.04~noble \
     docker-buildx-plugin=0.34.0-1~ubuntu.24.04~noble \
     docker-compose-plugin=5.1.3-1~ubuntu.24.04~noble
   sudo usermod -aG docker deploy
   ```

3. Hold versions:
   ```bash
   sudo apt-mark hold docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
   ```

**Verify:**

```bash
docker --version              # 29.5.0
docker compose version        # v5.1.3
apt-mark showhold             # all five listed
sudo -u deploy docker ps      # empty table, not "permission denied"
```

**Upgrades:** follow lockstep procedure in ADR-0009. Unhold, install new version on non-prod first, smoke test, then VPS.

**Note:** Docker group membership = effective root. See ADR-0012 residual risks.

### Phase 5 -- Host firewall & brute-force protection

Host-level firewall (ufw) mirrors the cloud firewall policy. If the cloud provider has no firewall, or the server moves to a different provider, ufw is the baseline.

```bash
sudo apt-get install -y ufw fail2ban

# Default deny inbound, allow outbound
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH and WireGuard only
sudo ufw allow 22/tcp
sudo ufw allow 51820/udp

sudo ufw enable
```

**Verify:** `sudo ufw status verbose` -- 22/tcp and 51820/udp ALLOW, default deny incoming.

```bash
sudo tee /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled = true
port = ssh
filter = sshd
maxretry = 5
bantime = 3600
findtime = 600
EOF
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

Confirm unattended-upgrades:

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # select Yes
```

**Verify:** `sudo fail2ban-client status sshd` -- jail active, 0 banned.

### Phase 6 -- WireGuard

See [wireguard-setup.md](wireguard-setup.md).

### Phase 7 -- Git access for deploy user

Read-only Deploy Key scoped to this repo (outbound only).

1. Generate keypair:

   ```bash
   sudo -u deploy ssh-keygen -t ed25519 -C "deploy-git@projekt-manager" \
     -f /home/deploy/.ssh/github_deploy -N ""
   ```

2. Configure SSH:

   ```bash
   sudo tee /home/deploy/.ssh/config << 'EOF'
   Host github.com
     IdentityFile ~/.ssh/github_deploy
     IdentitiesOnly yes
   EOF
   sudo chown deploy:deploy /home/deploy/.ssh/config
   sudo chmod 600 /home/deploy/.ssh/config
   ```

3. Add public key as **read-only** Deploy Key on GitHub (Repo > Settings > Deploy keys, write access unchecked):
   ```bash
   sudo cat /home/deploy/.ssh/github_deploy.pub
   ```

**Verify:** `sudo -u deploy ssh -T git@github.com` -- "successfully authenticated" (exit code 1 is normal).

### Phase 8 -- Application

1. Clone:

   ```bash
   sudo mkdir -p /opt/projekt-manager
   sudo chown deploy:deploy /opt/projekt-manager
   sudo -u deploy git clone <repo-ssh-url> /opt/projekt-manager
   ```

2. Create `.env` from the production template:

   ```bash
   sudo -u deploy cp /opt/projekt-manager/.env.production.example /opt/projekt-manager/.env
   ```

   Fill in `DOMAIN`, plus the object-storage values per [object-storage-provisioning.md § Wire the deploy](object-storage-provisioning.md): `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`. Defaults for `WG_BIND_IP` and `SEED` are pre-set.

   Secrets (`POSTGRES_PASSWORD`, `STORAGE_SECRET_KEY`, `CLOUDFLARE_API_TOKEN`) go in `secrets.env.age` only -- see Phase 9.
   `DATABASE_URL` is built by `docker-compose.yml` from `POSTGRES_PASSWORD` -- do not set it in `.env`.

3. Complete Phase 9, then deploy:
   ```bash
   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh origin/main
   ```

**Verify:** reads use `docker` directly, not `docker compose`. The compose path re-parses the compose file, which requires secret interpolation vars (`POSTGRES_PASSWORD`, `CLOUDFLARE_API_TOKEN`, etc.) in shell env; a bare sudo shell doesn't have them sourced, so parse aborts. Phase 8.1 step 2 applies the same docker-direct workaround (established in commit 5484903).

```bash
sudo -u deploy docker ps --filter name=projekt-manager-
sudo -u deploy docker exec projekt-manager-app-1 \
  node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1))"
```

Note: `curl https://localhost/api/health` does NOT work from the server -- Caddy binds to `${WG_BIND_IP}:443` only. Use the `docker exec` path above or test from a WireGuard client.

### Phase 8.1 -- First-login ritual (one-time)

Creates the first admin account on a fresh `pgdata` volume. The app's startup hook reads `BOOTSTRAP_ADMIN_*` vars, inserts one `owner`-role user, and is a no-op on subsequent starts (ADR-0010).

1. Confirm stack is running (Phase 8 verify).

2. Verify empty users table. Use `docker exec` directly rather than `docker compose exec` — the compose path re-parses the compose file, which in a sudo'd child shell lacks the secret interpolation vars (they live only in `secrets.env.age`, not `.env`) and aborts on `CLOUDFLARE_API_TOKEN must be declared`:

   ```bash
   sudo -u deploy docker exec projekt-manager-db-1 \
     psql -U pm -d projekt_manager -c 'SELECT count(*) FROM users;'
   # expect: 0
   ```

3. Set bootstrap vars in `.env`:

   ```bash
   openssl rand -base64 24   # generate password
   sudo -u deploy nano /opt/projekt-manager/.env
   ```

   Set `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_DISPLAY_NAME` (optional).
   Password policy: >=8 chars, <=72 UTF-8 bytes, not in common-password blocklist.

4. Re-run deploy to pick up the new `.env`. `compose up -d` (invoked by `deploy.sh`) detects the interpolated-config change for `app` and recreates it; `deploy.sh` sources `secrets.env.age` internally so nothing needs to be in the admin shell:

   ```bash
   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh   # same ref used in Phase 8 step 3
   ```

5. Confirm bootstrap. Same rationale as step 2 — bypass compose with `docker logs`:

   ```bash
   sudo -u deploy docker logs projekt-manager-app-1 --tail=30 | grep -F 'Bootstrap admin user'
   ```

6. From WireGuard client: log in at `https://${DOMAIN}`, then rotate password immediately:

   ```bash
   NEW_PW="$(openssl rand -base64 24)"
   echo "$NEW_PW"   # save to password manager NOW

   curl -sS -c /tmp/pm-cookies.txt \
     -H 'Content-Type: application/json' \
     -d '{"username":"<USERNAME>","password":"<BOOTSTRAP_PW>"}' \
     "https://${DOMAIN}/api/auth/login"

   curl -sS -b /tmp/pm-cookies.txt \
     -H 'Content-Type: application/json' \
     -d "{\"currentPassword\":\"<BOOTSTRAP_PW>\",\"newPassword\":\"${NEW_PW}\"}" \
     "https://${DOMAIN}/api/auth/change-password"

   shred -u /tmp/pm-cookies.txt
   ```

7. Scrub bootstrap vars from `.env` (delete or comment out all three `BOOTSTRAP_ADMIN_*` lines).

8. Re-run deploy to pick up the scrubbed `.env`, then confirm no bootstrap warning:

   ```bash
   sudo -u deploy /opt/projekt-manager/scripts/deploy.sh   # same ref used in Phase 8 step 3
   sudo -u deploy docker logs projekt-manager-app-1 --tail=30 | grep -F 'Bootstrap admin user' || echo 'ok -- no bootstrap'
   ```

9. Log in from WireGuard client with new password to confirm.

### Phase 8.2 -- Reset pgdata (test VPS only)

Wipes the Postgres and MinIO volumes, then re-runs the first-login ritual on a clean DB. **Do not run on a VPS that holds real data** — this deletes all users, customers, projects, sessions, and every attachment (both the `attachment` rows and the stored objects). The test-VPS use case: a schema change or migration collapse has diverged from the deployed DB's ledger (see troubleshooting's `source <(age -d …)` entry and the 2026-04-18 session), and recreating is cheaper than reconciling.

The MinIO wipe matters because the attachment orphan reaper only handles `status='pending'` rows; once a row is gone, its backing object has no cleanup path and would accumulate forever (`src/server/services/AttachmentService.ts:468` comments aside — the "bucket lifecycle" safety net is only configured on the R2 backup bucket, not the primary MinIO bucket). Wiping `miniodata` keeps the dev environment aligned to the planned production pattern (soft-delete + provider lifecycle), where a full-DB reset can't happen in the first place.

Unlike Phase 8.1 (which writes `BOOTSTRAP_ADMIN_*` to `.env` and relies on a later scrub step), 8.2 injects them as shell env on the admin account. The plaintext admin password never touches disk, removing the risk of a forgotten scrub leaving it in the repo.

1. Stop and remove app, db, and storage containers. Use `docker` directly rather than `docker compose down` — the latter requires all secret vars to interpolate, which aren't sourced at this point:

   ```bash
   sudo -u deploy docker stop projekt-manager-app-1 projekt-manager-db-1 projekt-manager-storage-1
   sudo -u deploy docker rm   projekt-manager-app-1 projekt-manager-db-1 projekt-manager-storage-1
   ```

2. Remove both data volumes. `storage-init` re-creates the MinIO bucket on the next `up`, so no separate bootstrap is needed for storage:

   ```bash
   sudo -u deploy docker volume rm projekt-manager_pgdata projekt-manager_miniodata
   ```

3. Bring the stack back up with inline bootstrap env. The `eval "$(age -d …)"` form avoids the process-substitution deadlock (troubleshooting.md):

   ```bash
   cd /opt/projekt-manager
   set -a
   eval "$(sudo -u deploy age -d secrets.env.age)"   # prompts for passphrase once
   set +a
   export BOOTSTRAP_ADMIN_USERNAME="admin"
   BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 24)"
   echo "$BOOTSTRAP_ADMIN_PASSWORD"   # save to password manager NOW
   export BOOTSTRAP_ADMIN_PASSWORD
   export BOOTSTRAP_ADMIN_DISPLAY_NAME="Admin"
   export APP_IMAGE_TAG="sha-$(git rev-parse HEAD)"
   sudo -u deploy -H --preserve-env docker compose up -d
   ```

   Both sudo flags are required. `--preserve-env` carries the decrypted-secret, `BOOTSTRAP_ADMIN_*`, and `APP_IMAGE_TAG` vars from the admin shell through to compose. `-H` resets `HOME` to `/home/deploy` so docker CLI finds its config and CLI-plugin dir under deploy's home — without it, `HOME` stays as the admin user's home, docker CLI warns `Error loading config file: … permission denied`, fails to register the `compose` plugin, and aborts with `unknown shorthand flag: 'f' in -f` (the cobra parser treating `compose` as a positional and `-f` as an unknown root flag).

   The backup service is profile-gated (`profiles: [backup]` in docker-compose.yml). Without `--profile backup`, compose does not include it in this `up -d`'s managed set, so its current state is left unchanged — `Up` stays `Up`, `Exited` stays `Exited`. Pass `--profile backup` to reconcile it alongside app+db against the target SHA; stop it explicitly with `docker stop projekt-manager-backup-1` before step 1 if you want it quiesced during the reset.

4. Confirm bootstrap ran. Use `docker logs` directly, not `docker compose logs` — the compose path would re-parse the compose file, which in a sudo'd child shell without `--preserve-env` lacks the interpolation vars and aborts:

   ```bash
   sudo -u deploy docker logs projekt-manager-app-1 --tail=30 | grep -F 'Bootstrap admin user'
   ```

5. Log in from a WireGuard client as `admin` with the generated password, then rotate via the UI (user menu → change password) or the `/api/auth/change-password` flow in Phase 8.1 step 6.

6. Clear the bootstrap vars and recreate the app container so they are no longer injected:

   ```bash
   unset BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_ADMIN_DISPLAY_NAME
   # APP_IMAGE_TAG + secrets are still in the admin shell from step 3.
   sudo -u deploy -H --preserve-env docker compose up -d --force-recreate app
   sudo -u deploy docker inspect projekt-manager-app-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep BOOTSTRAP
   # expect: BOOTSTRAP_ADMIN_USERNAME=, BOOTSTRAP_ADMIN_PASSWORD=, BOOTSTRAP_ADMIN_DISPLAY_NAME= (all empty)
   ```

   `--force-recreate app` is required: `BOOTSTRAP_ADMIN_*` flow through as compose-interpolated runtime env, not as part of the config hash compose compares, so a plain `up -d` would consider the existing container up-to-date and do nothing, leaving the password baked into the old container's docker metadata.

   Alternative: run `scripts/deploy.sh <ref>` — it sources `secrets.env.age` without bootstrap vars and recreates the app as part of the normal deploy flow.

### Phase 9 -- Deploy bootstrap

Sets up `scripts/deploy.sh` with encrypted secrets and performs the first deploy. See [manual-deploy.md § Bootstrap](manual-deploy.md#bootstrap-first-run-on-fresh-vps) for the authoritative procedure.

**Verify from WireGuard client:**

```bash
curl -v --resolve "${DOMAIN}:443:10.213.17.1" "https://${DOMAIN}/api/health"
# 200 OK with real Let's Encrypt cert (for initial cert, see caddy-tls-bootstrap.md)
```

**Verify from outside VPN:**

```bash
curl --connect-timeout 5 "https://<server-public-ip>/api/health"
# expect: timeout (443 not bound on public interface)
```
