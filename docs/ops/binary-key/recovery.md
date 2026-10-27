# Binary Attachment Key — Recovery

When the binary `age` identity is lost, suspected lost, or has drifted from what's deployed. The harshest failure mode in the system: **lost binary identity = unrecoverable customer deliverables.** Binaries are work-product (Aufmaß, photos, signed offers — see [DATA.md §Layer 3](../../../DATA.md#layer-3--binary-attachments-provider-enforced-durability--e2e)), not a recovery artifact like a backup dump. The B2 ciphertext sits there indefinitely, perfectly preserved by the bucket's durability primitives ([ADR-0022](../../adr/0022-binary-storage-b2-compliance-object-lock.md)), and is just as undecodable as random noise.

State this baldly to stakeholders if a full custody loss happens. There is no fallback identity, no recovery key, no escrow service. The mitigation is **multi-location custody** — the password-manager entry plus the off-system copies the operating company keeps ([Key custody](../index.md#key-custody)); recovery is the procedure for using one of those copies when needed.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0024 §Decision "Operator workflow"](../../adr/0024-binary-attachment-e2e-encryption.md#decision).

## 1. Identify the loss

Common triggers:

- **Password-manager entry lost.** Vault locked out, entry deleted, or provider gone. The deployed VPS keeps serving until the next reboot — uploads and downloads still work because the identity is in the `app` tmpfs.
- **Password-manager entry corrupted.** The entry exists but `age-keygen -y` rejects it. Same urgency as above.
- **A custody copy fails the monthly drill.** [drills.md § step 3](drills.md#3-run-the-recovery-tool) reported `no identity matched any of the recipients` in the index entry's `error`. This is a custody-copy failure, not necessarily a deployment failure.
- **Suspected key drift.** A subset of attachments decrypt fine, others don't, in a pattern matching a retired key dropped from the keyring or a replaced password-manager entry.

Do **not** reboot the VPS or recreate the `app` container until you have at least one intact custody copy of the identity. A reboot wipes the tmpfs; the boot probe blocks startup; there is no copy of the identity left to paste. The window between custody loss and reboot is the recovery window.

## 2. Restore from an off-system custody copy

This assumes at least one off-system copy ([Key custody](../index.md#key-custody)) is intact. None left? Extract the identity from the running app per [§3 step 3](#3-drill-failure-escalation) — before any reboot.

1. Retrieve an off-system copy by label (location per the label map): encrypted USB mounted, paper transcribed, KeePass entry exported. Put it in a [working file](../index.md#working-file) — transcribe a paper copy once, here.
2. Verify it matches the deployed keyring:

   ```bash
   age-keygen -y "$W/identity.txt" | sort
   ```

   The output must be exactly `BINARY_AGE_RECIPIENT` plus every `BINARY_AGE_RETIRED_RECIPIENTS` entry from `secrets.env.age`, one per line. A missing active recipient = this copy predates the last rotation; a missing retired one = the copy is incomplete. Try another copy.

3. Store it as the binary identity's password-manager entry (`cat "$W/identity.txt"`; new vault if the old one is gone), then `rm -rf "$W"`.

4. Run a workstation-side decrypt drill against a current attachment per [drills.md](drills.md), loading the new entry. A clean pass confirms the copy is the deployed identity and is good against live ciphertext.

5. Record the restore per [Operations record](../index.md#operations-record) — date, which custody copy was used, why it was needed, and a note to schedule a custody-replenishment task (re-verify the other off-system copies; mint a replacement for any consumed copy).

6. **Resume normal ops.** No production state changes; the deployed VPS keeps running because the identity in tmpfs was never touched. The restored entry serves the next reboot's paste and the monthly drills.

## 3. Drill-failure escalation

A monthly drill that fails to unwrap with the loaded copy is a **custody emergency**: a copy you trusted is dead. The deployment still works — the in-tmpfs copy is whatever the operator pasted last reboot — but the safety margin is now thinner than designed.

Escalation steps:

1. **Test the other copies immediately.** Repeat [drills.md](drills.md) with each remaining custody copy — password-manager entry and off-system copies. If one passes, replace every failed copy from it.
2. **If every custody copy fails**, you are down to whatever is in the `app` tmpfs on the VPS — and that copy is unreachable except by the running app. **Do not reboot.** Do not recreate the `app` container. Do not run `scripts/deploy.sh`. Any of those wipes the tmpfs.
3. **Pull the identity out of tmpfs while the app is alive.** This is a one-time emergency procedure — the identity in tmpfs is not exfiltrated under normal operation. Justified here because the alternative is permanent loss. Interactively — `sudo` needs a terminal for its password, so a one-shot `ssh host "sudo …"` fails and captures nothing:

   ```bash
   ssh <admin-username>@<vps-hostname>
   sudo -u deploy docker exec projekt-manager-app-1 cat /run/binary-key/identity
   clear
   ```

   Copy the printed text, comment lines included, into a new password-manager entry; `clear` before leaving the session, then clear the clipboard (in tmux, also `tmux clear-history`). Verify the entry with the [recipient check](../index.md#working-file) against `BINARY_AGE_RECIPIENT`.

4. **Restore custody before any reboot:** mint fresh off-system copies from the new entry. Treat the next 24 hours as a no-reboot window until custody is restored. Then run a workstation-side drill per [drills.md](drills.md) against the new entry.

If every custody copy has failed AND the VPS has been rebooted before step 3 completed, see § Burn-and-restart below.

## 4. Burn-and-restart (all copies lost, no working tmpfs)

Last resort. Every custody copy is dead, the VPS has been rebooted (or the `app` container has been recreated), and the in-tmpfs identity is gone. The B2 ciphertext is now permanently unreadable by anyone, including the operator. The wrapped DEKs in the DB are now permanently unwrappable.

State this clearly to stakeholders:

> The end-to-end-encryption identity protecting customer binary attachments has been lost beyond recovery. The encrypted bytes on B2 are intact but cannot be decrypted. All historical photos, Aufmaß scans, signed PDFs, and DOCX documents stored as attachments are permanently inaccessible. The application is being restarted with a new keypair; new uploads from this point forward are protected by the new identity. Any historical attachments needed for ongoing business must be re-supplied by their originator (re-photographed, re-scanned, re-signed).

Procedure:

1. **Generate a fresh keypair** per [setup.md §2](setup.md#2-generate-the-age-key-pair). This is a brand-new identity, unrelated to the lost one.
2. **Update `BINARY_AGE_RECIPIENT`** per [setup.md §3](setup.md#3-push-the-recipient-to-the-vps) with the new public recipient, and set `BINARY_AGE_RETIRED_RECIPIENTS=''` — the lost keys can't be in the new keyring.
3. **Wipe the dead attachments from the DB.** The rows reference unwrappable DEKs; leaving them in place produces the [AC-244](../../spec/verification.md#1526-attachments) "Schlüssel nicht verfügbar" placeholder render forever (distinct from the missing-backing-object render in [AC-436](../../spec/verification.md#1526-attachments) — both pinned, both rendered, but recovering by wiping the rows is cleaner than leaving permanent placeholders for every historical attachment). Coordinate with stakeholders before truncating — this is irreversible. Procedure depends on policy (full purge vs. soft-mark "permanently unrecoverable"); align with the project owner before issuing the SQL.
4. **Wipe the dead ciphertext from B2.** The objects sit under Compliance Object Lock for `R` days ([ADR-0022](../../adr/0022-binary-storage-b2-compliance-object-lock.md)) and cannot be deleted within that window. Outside the window, the bucket lifecycle reaps them on the configured `daysFromHidingToDeleting` schedule; wait it out, or accept that they sit unreadable until the lifecycle catches up.
5. **Redeploy** per [setup.md §4](setup.md#4-first-deploy). The boot probe accepts the new identity; new uploads wrap to it.
6. **Communicate to every user** that historical attachments are gone and to re-upload anything still needed.

This procedure exists to be documented, not to be used. Independent custody copies + monthly drill is the design's mitigation; if every copy is lost at once, custody discipline broke down, not the cryptography.
