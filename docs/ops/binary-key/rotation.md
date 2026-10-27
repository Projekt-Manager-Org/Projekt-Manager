# Binary Attachment Key — Rotation

Rotate the binary `age` keypair: a new key becomes active, the old one is retired but stays in the **keyring** ([ADR-0024 §Decision "Key rotation"](../../adr/0024-binary-attachment-e2e-encryption.md#decision)). New wraps use only the active key; everything written before keeps opening in the app. Nothing is re-uploaded.

Trigger it on:

- Suspected compromise of the password-manager entry, the workstation, the VPS, or any custody copy — first see [§ After a compromise](#after-a-compromise).
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

The keyring is one text file, one `AGE-SECRET-KEY-1...` line per key. Wherever it is kept — the password manager and every custody copy — it is kept whole.

## After a compromise

The old key keeps opening everything written before the rotation; bucket access is the only guard left for that data. Rotating onto a compromised machine hands the attacker the new key too.

- **Bucket access:** rotate every B2 key the compromised location held — the app key (VPS), the recovery and master keys (workstation, password manager) — per [object-storage-provisioning.md § Master-key handling](../object-storage-provisioning.md#master-key-handling).
- **Workstation compromised:** run step 1 on a clean machine.
- **VPS compromised:** rebuild it ([server-setup.md](../server-setup.md)) before the paste in step 2.
- **Custody location compromised:** do not reuse it for the new copies.

## Procedure

### 1. Mint the new key and build the keyring

In a [working file](../index.md#working-file) directory:

```bash
W="$XDG_RUNTIME_DIR/age-work"
install -d -m 700 "$W"
stty -echo; (umask 077; cat > "$W/current.txt"); stty echo   # paste the current entry, Enter, Ctrl-D
```

Check the paste holds exactly the deployed keys — every later check derives from it, and step 4 destroys the entry it came from. Print the deployed values in an interactive SSH session (`sudo` needs a terminal for its password):

```bash
# VPS
sudo -u deploy docker exec projekt-manager-app-1 printenv BINARY_AGE_RECIPIENT BINARY_AGE_RETIRED_RECIPIENTS
```

Paste the printed lines on the workstation (public values, no echo suppression needed) and compare:

```bash
cat > "$W/deployed.txt"   # paste, Enter, Ctrl-D
diff <(age-keygen -y "$W/current.txt" | sort) \
     <(tr ',' '\n' < "$W/deployed.txt" | tr -d ' \t\r' | sed '/^$/d' | sort) \
  && echo "paste = deployed keyring"
```

Any diff output: stop — the paste or the entry is incomplete. Then:

```bash
(umask 077; age-keygen -o "$W/new.txt" && cat "$W/new.txt" "$W/current.txt" > "$W/next.txt")
age-keygen -y "$W/new.txt"                         # BINARY_AGE_RECIPIENT
age-keygen -y "$W/current.txt" | paste -sd, -      # BINARY_AGE_RETIRED_RECIPIENTS
```

The last line covers every earlier retired recipient plus the previously active one.

Copy `$W/next.txt` — the new keyring — into a **new** password-manager entry (clipboard hygiene per [Key custody § New identity](../index.md#new-identity)) and mint fresh off-system copies. Keep the current entry and copies until step 4.

### 2. Update both recipient variables and redeploy

Change both values in `secrets.env.age` and redeploy per [manual-deploy.md § Rotate a secret](../manual-deploy.md#rotate-a-secret), using the two outputs from step 1:

```bash
BINARY_AGE_RECIPIENT='age1...'
BINARY_AGE_RETIRED_RECIPIENTS='age1...,age1...'
```

At the deploy's paste prompt ([load.md](load.md)), paste the new keyring. A missing or an extra key is rejected with its recipient named ([troubleshooting.md § Keyring mismatch](troubleshooting.md#keyring-mismatch)).

### 3. Verify

1. In the app, open an invoice PDF and an attachment from before the rotation. Both must open.
2. Check each new custody copy holds the whole keyring: its [recipient check](../index.md#working-file), piped through `sort`, lists exactly the recipients from step 1.
3. Run the drill ([drills.md](drills.md)) with the new entry against a fresh upload. Later drills cycle through the new off-system copies.

### 4. Finalise

```bash
rm -rf "$W"
```

Destroy the previous password-manager entry and custody copies; the new ones hold every key the old ones did (step 1's check, step 3.2). Record the rotation per [Operations record](../index.md#operations-record): date, reason, new and retired recipients.

## Rollback

If step 3 fails after the deploy, anything uploaded since is wrapped to the new key — so swap roles instead of restoring: the previous active recipient back in `BINARY_AGE_RECIPIENT`, the new one added to `BINARY_AGE_RETIRED_RECIPIENTS`, earlier retired ones kept. Redeploy and paste the new keyring — the next reboot's paste needs the new key too. Keep the previous entry and custody copies until the new ones pass step 3. Investigate before retrying.
