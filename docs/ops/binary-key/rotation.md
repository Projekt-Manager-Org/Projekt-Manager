# Binary Attachment Key — Rotation

Rotate the binary `age` keypair. Per [ADR-0024 §Decision "Key rotation"](../../adr/0024-binary-attachment-e2e-encryption.md#decision), automated in-place rotation is **out of scope** — there is no "rotate-and-rewrap-every-envelope" path in the application. Rotation is operator-driven and works by minting a new keypair, redeploying, and re-uploading all attachments through the app so the new uploads wrap to the new recipient.

This is a planned operator procedure — not a routine cadence. Trigger it on:

- Suspected compromise of the workstation copy or any custody copy.
- Operator handover.
- A scheduled interval the operator chooses (no project-mandated cadence; the design treats the binary identity as long-lived).

Concept map: [overview.md](overview.md). Recovery from key loss (different problem, different procedure): [recovery.md](recovery.md).

## What rotation costs

The cost is **proportional to the attachment count**. Every existing attachment was wrapped to the **old** recipient; the new identity cannot decrypt those wrapped envelopes. Two paths exist:

1. **Re-upload through the app.** The attachment owner re-uploads each file; the new init wraps to the new recipient; the old row is marked obsolete. Labour-intensive but correct — the new attachment carries the same plaintext through a fresh encrypt path.
2. **Keep the old identity around indefinitely.** The old wrapped envelopes still decrypt with the old identity. The deployed app reads `BINARY_AGE_RECIPIENT` (the **new** recipient) for new uploads, but historical decrypts via the SW DEK-fetch endpoint use whichever identity is loaded in tmpfs. Loading the old identity post-rotation breaks the "one identity per deploy" invariant the boot probe relies on — **this path is not supported** without further design work and is documented only to explain why option 1 is the supported path.

The supported path is **option 1**. Plan the rotation around an attachment-count budget the operator can re-upload.

## Procedure

You are about to mint a new keypair, deploy it, and accept that every existing attachment renders as the [AC-244](../../spec/verification.md#1526-attachments) "Schlüssel nicht verfügbar" placeholder (the wrapped envelope on each historical row was made for the old recipient; the new app cannot unwrap it) until re-uploaded. The placeholder is distinct from [AC-224](../../spec/verification.md#1526-attachments) "Datei fehlt" (which fires when the storage object is absent). Communicate this to users before starting.

### Before — quiesce uploads

Tell users to stop uploading new attachments for the rotation window. New uploads against the old recipient produce wrapped envelopes that the post-rotation app cannot unwrap — same outcome as historical attachments, but avoidable by quiescing.

### 1. Mint a new keypair

Re-run [setup.md §2](setup.md#2-generate-the-age-key-pair) with a different output filename so the old identity is preserved on the workstation for the recovery window:

```bash
age-keygen -o ~/secrets/binary-identity.new.txt
chmod 600 ~/secrets/binary-identity.new.txt
age-keygen -y ~/secrets/binary-identity.new.txt    # new public recipient
```

Mint **two off-system custody copies** of the new identity immediately, per the same multi-location discipline as setup. Mark the old custody copies "retired, read-only" — they decrypt historical envelopes during the recovery window but should not be used for new operations.

### 2. Update `BINARY_AGE_RECIPIENT`

Re-run [setup.md §3](setup.md#3-push-the-recipient-to-the-vps) with the new `age1...` from step 1. The old recipient line is replaced; the new line goes into `secrets.env.age`.

### 3. Redeploy

Re-run [setup.md §4](setup.md#4-first-deploy). The `app` container restarts, the boot probe waits for the **new** identity, the operator pastes per [load.md](load.md). Until that paste, the app is down — same gating as a fresh setup.

### 4. Re-upload attachments

Walk users through re-uploading each existing attachment they still need. The app's upload flow now wraps to the new recipient. The old rows can be hidden (soft-delete) once re-uploaded; the old B2 ciphertext sits under bucket retention until lifecycle reaps it.

A bulk re-upload UI does not exist; the re-upload is one file at a time through the existing upload affordances.

### 5. Verify with a drill

Immediately run the workstation-side drill ([drills.md](drills.md)) against a freshly re-uploaded attachment, using the new identity custody copy. A passing drill confirms the rotation is end-to-end: new uploads wrap to the new recipient, the new custody copy decrypts them, and the off-system custody chain is alive.

### 6. Retire the old identity

After all attachments are re-uploaded (or after the operator accepts that the un-re-uploaded ones are abandoned):

1. Move the old custody copies to a "retired, read-only" vault. Keep them — historical compliance audits, late discoveries that an old attachment was actually needed, etc. Do not destroy.
2. Remove the old workstation working copy: `shred -u ~/secrets/binary-identity.txt` then `mv ~/secrets/binary-identity.new.txt ~/secrets/binary-identity.txt` so the canonical filename keeps pointing at the active identity.
3. Record the rotation per [Operations record](../index.md#operations-record) — date, reason, attachment count re-uploaded, attachment count abandoned.

## Rollback

If step 5's drill fails, the rotation has a problem. Rollback is "redeploy with the old `BINARY_AGE_RECIPIENT`":

1. Restore the previous `secrets.env.age` from the password manager (or from the `secrets.env.age.bak` snapshot taken in [setup.md §3](setup.md#3-push-the-recipient-to-the-vps)).
2. Redeploy per [setup.md §4](setup.md#4-first-deploy).
3. Paste the **old** identity (from the workstation working copy preserved in step 1) into `load-binary-key`.

Rollback is fast as long as the old identity custody is still intact and the rotation has not yet involved data destruction. Investigate the drill failure before retrying the rotation.
