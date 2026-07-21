# Binary Attachment Key — Troubleshooting and Escalation

When the `app` won't start, the load script rejects the paste, attachments fail to render, or the monthly drill fails.

Concept map: [overview.md](overview.md). Setup / rotation: [setup.md](setup.md), [rotation.md](rotation.md). Recovery from key loss: [recovery.md](recovery.md).

## First-deploy failure modes

Symptoms that appear during or right after [setup.md §4](setup.md#4-first-deploy):

| Symptom                                                           | Likely cause                                                            | Fix                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app` container exits with `BINARY_AGE_RECIPIENT not set`         | Missing env var in `secrets.env.age`                                    | Re-run [setup.md §3](setup.md#3-push-the-recipient-to-the-vps), redeploy.                                                                        |
| `app` container exits with `binary identity not loaded`           | Boot probe hit; tmpfs at `/run/binary-key/identity` is empty            | Run the loader per [load.md § The paste](load.md#the-paste).                                                                                     |
| `BINARY_AGE_RECIPIENT` reads as the private identity, not `age1…` | Operator pasted the wrong half of the keypair into `secrets.env.age`    | Rerun [setup.md §2](setup.md#2-generate-the-age-key-pair) extraction with `age-keygen -y`, rerun [§3](setup.md#3-push-the-recipient-to-the-vps). |
| compose parse aborts with `BINARY_AGE_RECIPIENT must be declared` | The compose file's `:?` gate fires; secrets file did not source the var | Check `secrets.env.age` for typos / missing line; re-run `scripts/deploy.sh` so it re-sources the env.                                           |

## App refuses to start

The boot probe is the most common failure surface — by design ([ADR-0024 §Decision "Boot probe"](../../adr/0024-binary-attachment-e2e-encryption.md#decision)). The probe waits up to 5 minutes for the identity file to appear before giving up; during that window the container is **alive but not serving** (no listener on `:3000`). Past the 5-minute timeout the app exits 1, docker restarts the container per `restart: unless-stopped`, and the wait window starts over — slow restart loop, ~5 min per cycle.

```bash
sudo -u deploy docker logs projekt-manager-app-1 --tail=50
```

Expected progress log line during the wait:

```
binary-identity probe: waiting up to 300s for /run/binary-key/identity (paste via load-binary-key)
binary-identity probe: still waiting for /run/binary-key/identity (30s elapsed, 270s remaining)
```

Expected log line after the timeout (or on a hard failure — perms drift, malformed paste, recipient mismatch):

```
Refusing to start: binary-identity probe failed (ADR-0024) — binary `age` identity not loaded: file at BINARY_AGE_IDENTITY_PATH is absent. ... (probe waited 300s for the file to appear)
```

**Fix:** load the identity per [load.md](load.md). The next poll tick (≤2s) picks it up and the boot continues.

If the log shows a different error class (e.g., `tmpfs not mounted`), see § Recipient mismatch / tmpfs missing below.

## Recipient mismatch

`load-binary-key` rejects the paste with:

```
ERROR: the pasted identity's public recipient does not match BINARY_AGE_RECIPIENT.
```

Cause: the operator pasted the **wrong** identity. The most common case is pasting the **backup drill identity** into `load-binary-key` (or the binary identity into `load-drill-key`) — same shape file, different keypair. Check the workstation:

```bash
age-keygen -y ~/secrets/binary-identity.txt    # should match BINARY_AGE_RECIPIENT
age-keygen -y ~/secrets/age-backup.key         # should match AGE_RECIPIENT
```

If the two recipients on the workstation don't match the two `…_RECIPIENT` env vars on the VPS, an identity-mixup happened somewhere upstream — most likely a recent rotation didn't update one side. Resolve before retrying the paste.

If the two pairs match correctly on the workstation but the loader still rejects, the `secrets.env.age` `BINARY_AGE_RECIPIENT` value drifted from the workstation copy. Re-run [setup.md §3](setup.md#3-push-the-recipient-to-the-vps) with the current workstation recipient.

## Tmpfs not a mount

`load-binary-key` rejects the paste with:

```
ERROR: /run/binary-key is not a tmpfs mount.
       Refusing to write the identity to persistent storage.
       Fix: check docker-compose.yml services.app.tmpfs directive.
```

Cause: a `docker-compose.yml` regression dropped or renamed the `tmpfs:` directive on the `app` service. Writing the identity to a non-tmpfs path would persist it to disk — the script refuses on principle.

Fix: inspect and restore the directive on the `app` service. Reference shape (uid/gid 1001 match the `app` user pinned in the Dockerfile — the boot probe and the loader both run as `app` and need to read/write the tmpfs):

```yaml
services:
  app:
    tmpfs:
      - /run/binary-key:mode=0700,uid=1001,gid=1001
```

After the edit, redeploy and retry the paste. If the directive is intact in the file but the mount isn't taking effect, see [docs/ops/backup/drills.md § Loading](../backup/drills.md#loading-the-drill-key-on-the-vps) note about tmpfs stacking on `/run` — the same class of issue applies here.

## Decryption fails for one attachment

A specific attachment renders as the [AC-244](../../spec/verification.md#1526-attachments) "Schlüssel nicht verfügbar" placeholder in the gallery / binary list while others render fine. (Distinct from the [AC-224](../../spec/verification.md#1526-attachments) "Datei fehlt" placeholder which fires when the storage object is absent.)

Two distinct causes, with different remediations:

1. **Wrapped envelope corrupted on the row.** The DB row's `wrappedDek` is malformed or no longer a valid age envelope (e.g., partial DB corruption, an aborted migration that dropped bytes). Rare but recoverable from a Layer 2 backup if the corruption post-dates the most recent good backup. Cross-check the row's `wrappedDek` length against a known-good attachment of similar age:

   ```bash
   sudo -u deploy docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc \
     "SELECT id, octet_length(wrapped_dek) FROM attachments WHERE status='ready' ORDER BY created_at DESC LIMIT 10;"
   ```

   A drastic outlier in `octet_length` is the smoking gun. Restore the row from Layer 2 backup ([docs/ops/backup/recovery.md](../backup/recovery.md)) — surgical row restore is out of scope, so this is a full-DB restore decision the owner approves.

2. **Storage object replaced or missing.** The B2 object at `originalKey` is no longer the ciphertext that was uploaded — overwritten (rare, since the bucket is versioned + lock-protected per [ADR-0022](../../adr/0022-binary-storage-b2-compliance-object-lock.md)), or the key drifted from the row. Indicates a separate incident — investigate via [docs/ops/backup/troubleshooting.md](../backup/troubleshooting.md) escalation patterns and B2 audit logs. Not a binary-identity problem.

If decryption fails for **all** attachments and not just one, see § Drill failure on the workstation below.

## Drill failure on the workstation

The monthly drill ([drills.md](drills.md)) failed at step 3 (`age -d`) or step 4 (AES-GCM `InvalidTag`).

`age -d` failure (`no identity matched any of the recipients`):

- The custody copy you loaded does not match the deployed `BINARY_AGE_RECIPIENT`. Either the custody copy is from a previous keypair (rotation gap — the custody copy predates the most recent rotation) or the custody copy is corrupted.
- **Action:** test the _other_ off-system custody copy immediately per [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation). If both copies fail, you are in a custody emergency — extract the in-tmpfs identity per recovery.md before any reboot.

AES-GCM `InvalidTag` (decrypt step):

- The DEK is wrong (wrong attachment, wrong row's `wrappedDek`, base64 transcription error in step 1). Re-extract the row's `wrappedDek` and retry.
- Or the ciphertext was modified after upload (extremely rare; would indicate a separate incident on the bucket).
- Or the nonce framing drifted (check that the first 12 bytes are being treated as the nonce per [drills.md § step 4](drills.md#4-aes-256-gcm-decrypt-the-bytes)).

## Escalation threshold

If you cannot decrypt the most recent test upload using the current workstation identity copy, the binary domain is **broken**. Escalate immediately to the owner — this is the same severity class as Layer 2 escalation in [docs/ops/backup/troubleshooting.md § Escalation threshold](../backup/troubleshooting.md#escalation-threshold), with worse business impact (binaries are deliverables).

Next steps depend on the failure surface:

1. **If the workstation identity is gone but the VPS tmpfs has the correct identity** (i.e., the deployed app is still serving uploads/downloads correctly): see [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation) — extract the tmpfs identity to the workstation before any reboot.
2. **If the deployed app is also broken** (uploads or downloads failing): the in-tmpfs identity may be wrong or the recipient drifted. Reload from the workstation working copy per [load.md](load.md). If the workstation copy doesn't match either, [recovery.md § Burn-and-restart](recovery.md#4-burn-and-restart-both-copies-lost-no-working-tmpfs) is the last-resort path.

## Owner / escalation contact

The project is currently single-operator. The owner (Vladimir) is the escalation contact for every failure class above. Binary-identity loss has worse business impact than backup-key loss — historical attachments are not recoverable from any layer. Treat any custody-related failure as immediate-attention.

Review this section at every staffing change.
