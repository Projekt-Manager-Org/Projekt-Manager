# Binary Attachment Key — Rotation

Rotate the binary `age` keypair: a new key becomes active, the old one is retired but stays in the **keyring** ([ADR-0024 §Decision "Key rotation"](../../adr/0024-binary-attachment-e2e-encryption.md#decision)). New wraps use only the active key; everything written before keeps opening in the app. Nothing is re-uploaded.

Trigger it on:

- Suspected compromise of the workstation, the VPS, or any custody copy — first see [§ After a compromise](#after-a-compromise).
- Operator handover.
- A scheduled interval the operator chooses (no project-mandated cadence).

Concept map: [overview.md](overview.md). Recovery from key loss (different problem, different procedure): [recovery.md](recovery.md).

## What rotation does — and does not do

```
before:  active = K1                 keyring file = {K1}
after:   active = K2, retired = K1   keyring file = {K2, K1}
```

- **Protects only data written after it.** Old envelopes stay on their rows and in Object-Locked versions and DB backups. Everything written before the rotation stays readable to whoever holds K1 and bucket access — rotation cannot change that.
- **A retired key is needed as long as any row or object version from before the rotation exists.** Issued invoices cannot be deleted, so in practice that is forever. Never destroy a retired key.
- The keyring grows by one key per rotation. Every reboot paste carries all of them.

The workstation file `~/secrets/binary-identity.txt` is the keyring; custody copies are copies of that file.

## After a compromise

The old key keeps opening everything written before the rotation; bucket access is the only guard left for that data. Rotating onto a compromised machine hands the attacker the new key too.

- **Bucket access:** rotate every B2 key the compromised location held — the app key (VPS), the recovery and master keys (workstation, password manager) — per [object-storage-provisioning.md § Master-key handling](../object-storage-provisioning.md#master-key-handling).
- **Workstation compromised:** mint and build the keyring (step 1) on a clean machine, and keep the new `~/secrets` there.
- **VPS compromised:** rebuild it ([server-setup.md](../server-setup.md)) before the paste in step 2.
- **Custody location compromised:** do not reuse it for the new copies.

## Procedure

### 1. Mint the new key and build the keyring

```bash
(
  umask 077   # no window in which the keyring is readable by others
  age-keygen -o ~/secrets/binary-identity.new.txt &&
    cat ~/secrets/binary-identity.new.txt ~/secrets/binary-identity.txt > ~/secrets/binary-identity.next.txt
)
age-keygen -y ~/secrets/binary-identity.new.txt                  # BINARY_AGE_RECIPIENT
age-keygen -y ~/secrets/binary-identity.txt | paste -sd, -      # BINARY_AGE_RETIRED_RECIPIENTS
```

The second line covers every earlier retired recipient plus the previously active one.

Make **two off-system custody copies of `~/secrets/binary-identity.next.txt`**, per [setup.md §2](setup.md#2-generate-the-age-key-pair).

### 2. Update both recipient variables and redeploy

Change both values in `secrets.env.age` and redeploy per [manual-deploy.md § Rotate a secret](../manual-deploy.md#rotate-a-secret), using the two outputs from step 1:

```bash
BINARY_AGE_RECIPIENT='age1...'
BINARY_AGE_RETIRED_RECIPIENTS='age1...,age1...'
```

At the deploy's paste prompt ([load.md](load.md)), paste the full contents of `~/secrets/binary-identity.next.txt`. A missing or an extra key is rejected with its recipient named ([troubleshooting.md § Keyring mismatch](troubleshooting.md#keyring-mismatch)).

### 3. Verify

1. In the app, open an invoice PDF and an attachment from before the rotation. Both must open.
2. Check each new custody copy holds the whole keyring — `age-keygen -y <copy> | sort` lists exactly the recipients from step 1.
3. Run the drill ([drills.md](drills.md)) with a new custody copy against a fresh upload.

### 4. Finalise

```bash
mv ~/secrets/binary-identity.next.txt ~/secrets/binary-identity.txt
rm ~/secrets/binary-identity.new.txt
```

Destroy the previous custody copies and keep the new ones in their place: each new copy holds every key the old ones did. Record the rotation per [Operations record](../index.md#operations-record): date, reason, new and retired recipients.

## Rollback

If step 3 fails after the deploy, anything uploaded since is wrapped to the new key — so swap roles instead of restoring: the previous active recipient back in `BINARY_AGE_RECIPIENT`, the new one added to `BINARY_AGE_RETIRED_RECIPIENTS`, earlier retired ones kept. Redeploy, paste `~/secrets/binary-identity.next.txt`, and run step 4's `mv`/`rm` — the next reboot's paste needs the new key. Keep the previous custody copies until new ones pass step 3. Investigate before retrying.
