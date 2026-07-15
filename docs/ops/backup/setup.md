# Layer 2 Backup — Setup

End-to-end provisioning for a fresh VPS. Credential rotation reuses §1.4, §2, §3, §4 — the dedicated walkthrough lives at [rotation.md](rotation.md). Design rationale: [ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md). Concept map: [overview.md](overview.md).

## Prerequisites

**Operator workstation:**

- Shell with `age`, `age-keygen` ([CONTRIBUTING.md § Runtime Requirements](../../../CONTRIBUTING.md#runtime-requirements)), `ssh`, `wg-quick` (or `wg` + a platform-native WireGuard client), `docker` + `docker compose` plugin, `aws` CLI (or `rclone` — this runbook uses `aws` examples; the container image does not ship aws), `curl`, `jq`, `openssl`, `shred`. Debian/Ubuntu: `sudo apt install awscli jq curl openssl`.
- Repo checked out locally: `git clone git@github.com:Projekt-Manager-Org/Projekt-Manager.git`.
- WireGuard peer config imported and active ([wireguard-setup.md](../wireguard-setup.md)).
- Password manager entries for: the R2 API token, the age private identity (backed up outside the system — see §2), the `secrets.env.age` passphrase.

**VPS:**

- Provisioned per [server-setup.md](../server-setup.md) — Docker Engine, `age`, `deploy` user with `nologin`, repo cloned at `/opt/projekt-manager`.
- `docker compose` stack is running (`app`, `db`, `storage`, `storage-init`, `caddy`).
- `/opt/projekt-manager/secrets.env.age` exists and is decryptable with the known passphrase.

**Cloudflare:**

- Account with R2 enabled. Billing set up (R2 egress is free; storage has a free tier — at current data scale the whole offsite surface fits within the free tier).

Runtime versions are not pinned here — [CONTRIBUTING.md § Runtime Requirements](../../../CONTRIBUTING.md#runtime-requirements) owns that.

## 1. Create off-site storage (Cloudflare R2)

### 1.1 Create the bucket

1. Cloudflare dashboard → R2 → **Create bucket**.
2. Name: `projekt-manager-backups` (exact — the backup script reads this literal via env per ADR-0020).
3. Location hint: **EEUR** (Eastern Europe).
4. Click **Create bucket**.

### 1.2 Configure retention (bucket lock)

R2 does not offer native object versioning or S3 Object Lock Compliance Mode. A bucket lock rule over timestamped filenames gives us the practical immutability window ([ADR-0020 §Alternatives](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#alternatives-considered)) — within the window, no destructive op on locked-prefix keys succeeds via the data-plane S3 token. Scope the rule to the `daily/` prefix — the `status/latest.json` mirror is overwritten every cycle and must stay outside the lock, or the badge freezes at its day-1 value. The rule UI exposes Rule Name, Prefix, Retention period; there is no Compliance/Governance mode toggle.

Let **D** be the immutable-window value from [ADR-0020 §Retention](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention).

1. Open the bucket → **Settings** → **Object lock rules** → **Add rule**.
2. **Rule name:** any descriptive label (e.g. `Lock daily backups`). **Rule scope prefix:** `daily/` (not empty). **Retention period:** D days. **Enabled:** on.
3. **Save**.

### 1.3 Configure deletion (lifecycle rule)

Lifecycle applies bucket-wide. The `status/latest.json` mirror is idempotent under delete — the next backup cycle rewrites it — so no narrower scope is needed.

Let **N** be the total-retention value from [ADR-0020 §Retention](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention).

1. Bucket → **Settings** → **Lifecycle rules** → **Add rule**.
2. Name: `delete-after-N-days` (substitute the actual N). Prefix scope: all objects. Action: **Delete objects** N days after upload.
3. **Save**.

Effective behaviour: `daily/*` objects are immutable for the immutability window and are eventually deleted by the lifecycle rule; the `status/latest.json` mirror is overwritten every cycle and harmlessly re-created on the first run after any lifecycle delete. Retention is linear — no weekly or monthly prefixes, no promotion logic. Canonical values and rationale: [ADR-0020 §Retention](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#retention).

### 1.4 Create the API token

Must be created through the R2 dashboard — not Profile → API Tokens. Only the R2-dashboard flow emits S3-compatible Access Key ID + Secret Access Key; a general-purpose account token with R2 permissions added does not, and pasting anything else into `R2_SECRET_ACCESS_KEY` produces a `SignatureDoesNotMatch` at the next backup. Keep this token R2-only — do not co-locate zone/DNS permissions on it; those belong on `CLOUDFLARE_API_TOKEN` per [dns-setup.md](../dns-setup.md).

1. Cloudflare dashboard → **R2 Object Storage** → **{ } API** (top-right) → **Manage API tokens** → **Create Account API token**.
2. Permissions: **Object Read & Write**.
3. Specify bucket: **Apply to specific buckets only** → select `projekt-manager-backups`. No token TTL.
4. **Create Account API Token**. Capture immediately (these values appear once):
   - Access Key ID
   - Secret Access Key
   - Endpoint URL (form: `https://<accountid>.r2.cloudflarestorage.com`)
5. Paste all three into the password manager. The values feed §3.

## 2. Generate the age key pair

The private identity is the root of the recovery chain — long-lived private key material, reversible only by discarding the ciphertext it protects. Generate it on the operator workstation and never let it leave.

```bash
mkdir -p ~/secrets
age-keygen -o ~/secrets/age-backup.key
chmod 600 ~/secrets/age-backup.key
age-keygen -y ~/secrets/age-backup.key    # prints the public recipient (age1...)
```

The `age1...` line is what `AGE_RECIPIENT` takes in §3. The `AGE-SECRET-KEY-1...` inside the identity file is the private identity and stays on the workstation.

**Back up the private identity off-system.** Options, pick one and document it in the password manager:

- Encrypted USB kept in a physical safe.
- Offline password manager vault (e.g., KeePass DB on an air-gapped device).
- Paper printout in a sealed envelope, stored with other recovery material.

Losing the private identity forfeits every Tier 2 drill and every DR restore from encrypted R2 objects ([ADR-0020 §Consequences](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md#consequences)). A single compromise invalidates future-read secrecy — rotate via [rotation.md](rotation.md) if suspected.

**Never** write the private identity to the project tree, `secrets.env.age`, the VPS filesystem persistently (see [drills.md](drills.md) for the tmpfs-only drill flow), or any location tracked by git, cloud sync, or chat history.

## 3. Push R2 credentials + recipient to the VPS

The VPS needs the new keys in `secrets.env.age`. This reuses the rotation flow in [manual-deploy.md § Rotate a secret](../manual-deploy.md#rotate-a-secret); the additions are the Layer 2 keys.

You are about to replace the live backup credentials; this is reversible **only** if the previous `secrets.env.age` is still on hand. A fat-fingered edit with no prior copy overwrites the live file and leaves the VPS non-bootable.

1. On the operator workstation, pull the current VPS copy as a typo-recovery snapshot; keep it until step 6 in §4 succeeds. Then SSH to the VPS as the admin user — keep that session open; subsequent VPS-side commands run in it.

   ```bash
   # workstation
   scp <admin-username>@<vps-hostname>:/opt/projekt-manager/secrets.env.age ./secrets.env.age.bak
   ssh <admin-username>@<vps-hostname>
   ```

2. On the operator workstation (not the VPS), assemble the new plaintext `secrets.env`:

   ```bash
   cat > /tmp/secrets.env <<'EOF'
   POSTGRES_PASSWORD='...'
   STORAGE_SECRET_KEY='...'
   CLOUDFLARE_API_TOKEN='...'
   R2_ACCESS_KEY_ID='...'
   R2_SECRET_ACCESS_KEY='...'
   R2_ENDPOINT='https://<accountid>.r2.cloudflarestorage.com'
   R2_BUCKET='projekt-manager-backups'
   R2_REGION='auto'
   AGE_RECIPIENT='age1xyz...'
   EOF
   ```

   The first three come from the current `secrets.env.age` — decrypt it locally first with `age -d secrets.env.age` if you don't have the plaintext handy. `STORAGE_SECRET_KEY` is the B2 app key's `applicationKey` per [object-storage-provisioning.md § App key](../object-storage-provisioning.md). The five new keys come from §1.4 (R2 token) and §2 (age recipient).

3. Re-encrypt. `age -p` prompts twice for the passphrase (enter + confirm) — reuse the passphrase already stored in the password manager so the VPS decrypt in step 5 and in `scripts/deploy.sh` both keep working:

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

5. On the VPS: verify the new values round-trip (`age -d` prompts once for the same passphrase).

   ```bash
   sudo -u deploy age -d /opt/projekt-manager/secrets.env.age | grep -E '^(R2_|AGE_RECIPIENT)'
   ```

   You should see the Layer 2 lines exactly as sent. If any value is missing or mangled, restore the pre-change snapshot (re-run the step-4 `scp` + `mv/chown/chmod` with `./secrets.env.age.bak` as the source) and repeat from step 2. Do not iterate against a broken file.

   After the deploy in §4 succeeds, `shred -u ./secrets.env.age.bak` on the operator workstation — the snapshot is a window into live credentials and should not linger. On journalled filesystems (ext4 default, APFS) `shred` is largely ceremonial, but still net-better than plain `rm`; do not downgrade.

## 4. First deploy

Pick up the new env values. This is a normal deploy; the backup service reads the new keys at container start.

You are about to cycle the running stack; the running app/db/storage containers survive the pull, the `backup` container is recreated.

On the VPS (continuing in the ssh session from §3):

```bash
sudo -u deploy /opt/projekt-manager/scripts/deploy.sh
```

`scripts/deploy.sh` decrypts `secrets.env.age`, exports all keys into the compose env, pulls the pinned image, `docker compose up -d` (which includes the `backup` service), and polls `/api/health` ([manual-deploy.md](../manual-deploy.md)).

> Compose operations outside `scripts/deploy.sh` need both `APP_IMAGE_TAG` and the secrets from `secrets.env.age` in shell env — `app` and `backup` are gated by `${APP_IMAGE_TAG:?...}`, and every `${POSTGRES_PASSWORD}` / `${CLOUDFLARE_API_TOKEN}` / `${STORAGE_SECRET_KEY}` reference is interpolated eagerly during parse. For the ops patterns in these runbooks, prefer `docker` directly (reads bypass compose parse entirely) or `scripts/deploy.sh` (sources secrets and pins SHA).

After the deploy settles, verify the backup service is healthy. `docker logs` reads the container's log stream without touching compose, so it works from a bare sudo shell:

```bash
sudo -u deploy docker logs projekt-manager-backup-1 --tail=50
```

First-run expectations, in order (next scheduled tick — see [overview.md § Cadence](overview.md#cadence)):

1. The in-process croner schedule inside the `backup` container logs a `backup-runner: schedule: registered backup-weekday next=…` line at startup and a `backup tick` line at the next scheduled hour.
2. A run writes a row into `meta_backup_status` with `lastBackupOk = true` and a fresh `lastBackupAt`.
3. Three R2 objects appear under `projekt-manager-backups`: `daily/<iso>.dump.age`, `daily/<iso>.manifest.json.age`, and `status/latest.json`.
4. The freshness badge on the login screen turns green (amber if no Tier 2 drill has run yet — that is expected until the drill key is loaded per [drills.md](drills.md)).

Sanity-check the status mirror from the operator workstation, using the new token. The bucket is private — unsigned calls return 401, so every fetch is signed:

```bash
AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=auto \
  aws s3 cp "s3://projekt-manager-backups/status/latest.json" /tmp/latest.json \
  --endpoint-url "$R2_ENDPOINT"

jq '.' /tmp/latest.json
```

Expected shape (from [data-model.md §5.9](../../spec/data-model.md#59-backup-status-entity)):

```json
{
  "lastBackupAt": "2026-04-17T02:00:12Z",
  "lastBackupOk": true,
  "lastDrillAt": null,
  "lastDrillOk": null,
  "lastError": null,
  "updatedAt": "2026-04-17T02:00:12Z"
}
```

First-run failure modes are catalogued in [troubleshooting.md § First-deploy failure modes](troubleshooting.md#first-deploy-failure-modes).
