# Binary Attachment Key — Setup

End-to-end provisioning for a fresh VPS. Credential rotation reuses §1, §2, §3 — the dedicated walkthrough lives at [rotation.md](rotation.md). Design rationale: [ADR-0024](../../adr/0024-binary-attachment-e2e-encryption.md). Concept map: [overview.md](overview.md).

## Prerequisites

**Operator workstation:**

- Shell with `age`, `age-keygen` ([CONTRIBUTING.md § Runtime Requirements](../../../CONTRIBUTING.md#runtime-requirements)), `ssh`, `wg-quick` (or `wg` + a platform-native WireGuard client), `docker` + `docker compose` plugin, `openssl`, `shred`. Debian/Ubuntu: `sudo apt install openssl`.
- Repo checked out locally: `git clone git@github.com:Projekt-Manager-Org/Projekt-Manager.git`.
- WireGuard peer config imported and active ([wireguard-setup.md](../wireguard-setup.md)).
- Password manager entries for: the binary `age` private identity (backed up off-system in **at least two locations** — see §2), the `secrets.env.age` passphrase.

**VPS:**

- Provisioned per [server-setup.md](../server-setup.md) — Docker Engine, `age`, `deploy` user with `nologin`, repo cloned at `/opt/projekt-manager`.
- Backup drill identity already provisioned ([docs/ops/backup/setup.md](../backup/setup.md)) — the binary identity is the second of the two operator-loaded keys.
- `docker compose` stack is running (`app`, `db`, `storage`, `storage-init`, `caddy`, `backup`).
- `/opt/projekt-manager/secrets.env.age` exists and is decryptable with the known passphrase.

Runtime versions are not pinned here — [CONTRIBUTING.md § Runtime Requirements](../../../CONTRIBUTING.md#runtime-requirements) owns that.

## 1. Confirm app-service tmpfs and boot probe

The `app` service must mount a tmpfs at the binary-identity path. Without it, `scripts/binary-key/load-binary-key.sh` refuses to write (mirrors the backup `load-drill-key.sh` invariant — see [scripts/backup/load-drill-key.sh](../../../scripts/backup/load-drill-key.sh) for the precedent). The boot probe in the `app` process refuses to start the container without the identity loaded.

Verify the compose definition before generating the key — a missing tmpfs directive turns step 4 into a deploy failure.

```bash
grep -A2 'binary-key' /opt/projekt-manager/docker-compose.yml
```

Expected: a `tmpfs:` entry under `services.app` of the form `/run/binary-key:mode=0700,uid=1001,gid=1001` (uid/gid match the `app` user pinned in the Dockerfile so the boot probe can read and the loader can write without a privilege override), and a `BINARY_AGE_RECIPIENT` reference under `services.app.environment`. If either is missing, the compose file regressed — fix before proceeding.

## 2. Generate the age key pair

The private identity is the root of the binary recovery chain. Lost private identity = unrecoverable customer deliverables (binaries are work-product, not recovery artifacts — [ADR-0024 §Consequences](../../adr/0024-binary-attachment-e2e-encryption.md#negative)). Generate it on the operator workstation and never let it leave.

```bash
mkdir -p ~/secrets
age-keygen -o ~/secrets/binary-identity.txt
chmod 600 ~/secrets/binary-identity.txt
age-keygen -y ~/secrets/binary-identity.txt    # prints the public recipient (age1...)
```

The `age1...` line is what `BINARY_AGE_RECIPIENT` takes in §3. The `AGE-SECRET-KEY-1...` inside the file is the private identity and stays on the workstation.

**Back up the private identity to at least two off-system locations.** The two-copy minimum is mandated by [ADR-0024 §Decision "Operator workflow"](../../adr/0024-binary-attachment-e2e-encryption.md#decision) — binaries are deliverables, not recovery artifacts, and identity loss is worse than backup-key loss. Pick **two** of the following; document both in the password manager:

- Encrypted USB kept in a physical safe (owner site).
- Paper printout in a sealed envelope, stored in a separate physical location.
- Offline password manager vault (e.g., KeePass DB on an air-gapped device) at a second site.

Do **not** rely on a single off-system copy. A safe fire, a corrupted USB, a missing envelope — any single point of failure cascades to "every customer binary on B2 is unreadable forever." Two independent custody locations are the minimum mitigation.

**Never** write the private identity to the project tree, `secrets.env.age`, the VPS filesystem persistently (see [load.md](load.md) for the tmpfs-only flow), or any location tracked by git, cloud sync, or chat history. The binary identity has the same custody discipline as the backup drill identity, with worse business impact on loss.

## 3. Push the recipient to the VPS

The VPS needs the public recipient in `secrets.env.age` (the variable lives there, alongside `AGE_RECIPIENT`, per [secrets.manifest.txt](../../../secrets.manifest.txt)). This reuses the rotation flow in [manual-deploy.md § Rotate a secret](../manual-deploy.md#rotate-a-secret); the addition is the single `BINARY_AGE_RECIPIENT` key.

You are about to replace the live `secrets.env.age`; this is reversible **only** if the previous file is still on hand. A fat-fingered edit with no prior copy overwrites the live file and leaves the VPS non-bootable.

1. On the operator workstation, pull the current VPS copy as a typo-recovery snapshot; keep it until step 6 in §4 succeeds. Then SSH to the VPS as the admin user — keep that session open; subsequent VPS-side commands run in it.

   ```bash
   # workstation
   scp <admin-username>@<vps-hostname>:/opt/projekt-manager/secrets.env.age ./secrets.env.age.bak
   ssh <admin-username>@<vps-hostname>
   ```

2. On the operator workstation, decrypt the current envelope and add the new line. `age -d` prompts once for the passphrase already in the password manager:

   ```bash
   age -d ./secrets.env.age.bak > /tmp/secrets.env
   echo "BINARY_AGE_RECIPIENT='age1...'" >> /tmp/secrets.env   # paste the recipient from §2
   ```

3. Re-encrypt with the same passphrase. `age -p` prompts twice (enter + confirm) — reuse the existing passphrase so `scripts/deploy.sh` keeps working:

   ```bash
   age -p -o secrets.env.age /tmp/secrets.env
   shred -u /tmp/secrets.env
   ```

4. Upload and move into place. `scp` runs on the workstation; the `sudo mv`/`chown`/`chmod` run on the VPS in the ssh session opened in step 1:

   ```bash
   # workstation
   scp secrets.env.age <admin-username>@<vps-hostname>:/tmp/secrets.env.age
   # VPS
   sudo mv /tmp/secrets.env.age /opt/projekt-manager/secrets.env.age
   sudo chown deploy:deploy /opt/projekt-manager/secrets.env.age
   sudo chmod 0600 /opt/projekt-manager/secrets.env.age
   ```

5. On the VPS: verify the new value round-trips (`age -d` prompts once for the same passphrase).

   ```bash
   sudo -u deploy age -d /opt/projekt-manager/secrets.env.age | grep -E '^BINARY_AGE_RECIPIENT'
   ```

   You should see exactly the recipient sent in §2. If missing or mangled, restore the pre-change snapshot (re-run the step-4 `scp` + `mv/chown/chmod` with `./secrets.env.age.bak` as the source) and repeat from step 2.

   After the deploy in §4 succeeds, `shred -u ./secrets.env.age.bak` on the operator workstation — the snapshot is a window into live credentials and should not linger.

## 4. First deploy

The deploy picks up the new env values and starts the `app` service with the boot probe enabled. The probe blocks on `/run/binary-key/identity` being non-empty — so the **first** post-deploy start will fail until §5 loads the identity. That is expected; the failure window is the time between `docker compose up -d` and the first successful `load-binary-key` invocation.

You are about to cycle the running stack; `db`, `storage`, `caddy`, and `backup` survive the pull, the `app` container is recreated.

On the VPS (continuing in the ssh session from §3):

```bash
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
```

`scripts/deploy.sh` decrypts `secrets.env.age`, exports all keys (including the new `BINARY_AGE_RECIPIENT`) into the compose env, pulls the pinned image, `docker compose up -d`, and polls `/api/health` ([manual-deploy.md](../manual-deploy.md)).

The `app` container will fail its first `/api/health` probe — the boot gate is waiting on the identity. `scripts/deploy.sh` should auto-prompt for the binary-identity paste (mirrors the backup deploy auto-prompt in [docs/ops/backup/drills.md § Loading](../backup/drills.md#loading-the-drill-key-on-the-vps)). If it does, follow [load.md § The paste](load.md#the-paste); if it skips the prompt (deploy script regression), invoke the loader manually per [load.md § Standalone reload](load.md#standalone-reload).

## 5. Load the identity

See [load.md](load.md). After the paste, `scripts/deploy.sh` re-polls `/api/health`; a green response means the boot probe accepted the loaded identity. The stack is now serving.

First-run expectations:

1. `app` container is `Up` and healthy (`docker ps --filter name=projekt-manager-app`).
2. The Service Worker registers on the next browser load of the SPA (`navigator.serviceWorker` in DevTools shows it as `activated`).
3. A test upload via the UI lands at B2 as `application/octet-stream` opaque ciphertext (verify with the B2 console or a signed `aws s3 head-object` against the key).
4. The same upload renders correctly in the gallery — the SW intercepts the synthetic origin, fetches the DEK, decrypts, serves plaintext bytes.

First-run failure modes are catalogued in [troubleshooting.md § First-deploy failure modes](troubleshooting.md#first-deploy-failure-modes).
