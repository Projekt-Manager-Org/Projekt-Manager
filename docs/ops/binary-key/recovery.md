# Binary Attachment Key — Recovery

When the binary `age` identity is lost, suspected lost, or has drifted from what's deployed. The harshest failure mode in the system: **lost binary identity = unrecoverable customer deliverables.** Binaries are work-product (Aufmaß, photos, signed offers — see [DATA.md §Layer 3](../../../DATA.md#layer-3--binary-attachments-provider-enforced-durability--e2e)), not a recovery artifact like a backup dump. The B2 ciphertext sits there indefinitely, perfectly preserved by the bucket's durability primitives ([ADR-0022](../../adr/0022-binary-storage-b2-compliance-object-lock.md)), and is just as undecodable as random noise.

State this baldly to stakeholders if a full custody loss happens. There is no fallback identity, no recovery key, no escrow service. The mitigation is **multi-location custody** mandated in [setup.md §2](setup.md#2-generate-the-age-key-pair); recovery is the procedure for using one of those copies when needed.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0024 §Decision "Operator workflow"](../../adr/0024-binary-attachment-e2e-encryption.md#decision).

## 1. Identify the loss

Common triggers:

- **Workstation lost or wiped.** The working copy at `~/secrets/binary-identity.txt` is gone. The deployed VPS keeps serving until the next reboot — uploads and downloads still work because the identity is in the `app` tmpfs.
- **Workstation copy corrupted.** The file exists but `age-keygen -y` rejects it. Same urgency as above.
- **Off-system copy fails the monthly drill.** [drills.md § step 3](drills.md#3-unwrap-the-dek-with-the-off-system-identity) reported `no identity matched any of the recipients`. This is a custody-copy failure, not necessarily a deployment failure.
- **Suspected key drift.** A subset of attachments decrypt fine, others don't, in a pattern matching a partial rotation or a replaced workstation copy.

Do **not** reboot the VPS or recreate the `app` container until you have at least one working copy of the identity. A reboot wipes the tmpfs; the boot probe blocks startup; there is no copy of the identity left to paste. The window between custody loss and reboot is the recovery window.

## 2. Restore from an off-system custody copy

This assumes at least one of the ≥2 off-system copies mandated in [setup.md §2](setup.md#2-generate-the-age-key-pair) is intact.

1. Retrieve the off-system copy: encrypted USB from the safe, paper printout transcribed, KeePass entry exported. Place it on the workstation as `~/secrets/binary-identity.txt`.
2. Verify it parses and matches the deployed recipient:

   ```bash
   chmod 600 ~/secrets/binary-identity.txt
   derived=$(age-keygen -y ~/secrets/binary-identity.txt)
   echo "Derived recipient: $derived"
   echo "Expected (BINARY_AGE_RECIPIENT from secrets.env.age): age1..."
   ```

   The two `age1...` strings must be byte-identical. Mismatch = this copy is from a previous keypair (predates the last rotation), not the current deployed one. Try the other custody copy.

3. Run a workstation-side decrypt drill against a current attachment per [drills.md](drills.md). A clean pass confirms the copy is the deployed identity and is good against live ciphertext.

4. Document the restore in `~/ops-log/binary-identity-restore-YYYY-MM-DD.md` — date, which custody location was used, why it was needed, and a note to schedule a custody-replenishment task (one copy is now in active use; the other off-system copies should be re-verified and a new redundant copy minted to replace any consumed copy).

5. **Resume normal ops.** No production state changes; the deployed VPS keeps running because the identity in tmpfs was never touched. The recovered workstation copy now exists for the next reboot's paste and for monthly drills.

## 3. Drill-failure escalation

A monthly drill that fails on `age -d` is a **custody emergency**: the off-system copy you trusted is dead. The deployment still works — the in-tmpfs copy is whatever the operator pasted last reboot — but the safety margin is now thinner than designed.

Escalation steps:

1. **Test the other off-system copy immediately.** Repeat [drills.md](drills.md) with the second custody copy. If it passes, the first copy is the only failure — replace it (mint a fresh copy from the workstation working copy or from the surviving custody copy).
2. **If the second custody copy also fails**, you are down to whatever is in the `app` tmpfs on the VPS — and that copy is unreachable except by the running app. **Do not reboot.** Do not recreate the `app` container. Do not run `scripts/deploy.sh`. Any of those wipes the tmpfs.
3. **Pull the identity out of tmpfs onto the workstation while the app is alive.** This is a one-time emergency procedure — the identity in tmpfs is not exfiltrated under normal operation. Justified here because the alternative is permanent loss:

   ```bash
   ssh <admin-username>@<vps-hostname> \
     "sudo -u deploy docker exec projekt-manager-app-1 cat /run/binary-key/identity" \
     > ~/secrets/binary-identity.txt
   chmod 600 ~/secrets/binary-identity.txt
   age-keygen -y ~/secrets/binary-identity.txt    # verify it parses
   ```

4. **Mint at least two fresh off-system custody copies from the recovered identity** before any reboot. Treat the next 24 hours as a no-reboot window until custody is restored. Then run a workstation-side drill per [drills.md](drills.md) against the recovered copy.

If both off-system copies have failed AND the VPS has been rebooted before step 3 completed, see § Burn-and-restart below.

## 4. Burn-and-restart (both copies lost, no working tmpfs)

Last resort. Both off-system copies are dead, the VPS has been rebooted (or the `app` container has been recreated), and the in-tmpfs identity is gone. The B2 ciphertext is now permanently unreadable by anyone, including the operator. The wrapped DEKs in the DB are now permanently unwrappable.

State this clearly to stakeholders:

> The end-to-end-encryption identity protecting customer binary attachments has been lost beyond recovery. The encrypted bytes on B2 are intact but cannot be decrypted. All historical photos, Aufmaß scans, signed PDFs, and DOCX documents stored as attachments are permanently inaccessible. The application is being restarted with a new keypair; new uploads from this point forward are protected by the new identity. Any historical attachments needed for ongoing business must be re-supplied by their originator (re-photographed, re-scanned, re-signed).

Procedure:

1. **Generate a fresh keypair** per [setup.md §2](setup.md#2-generate-the-age-key-pair). This is a brand-new identity, unrelated to the lost one. Mint at least two off-system custody copies immediately.
2. **Update `BINARY_AGE_RECIPIENT`** per [setup.md §3](setup.md#3-push-the-recipient-to-the-vps) with the new public recipient.
3. **Wipe the dead attachments from the DB.** The rows reference unwrappable DEKs; leaving them in place produces the [AC-244](../../spec/verification.md#1526-attachments) "Schlüssel nicht verfügbar" placeholder render forever (distinct from the missing-backing-object render in [AC-224](../../spec/verification.md#1526-attachments) — both pinned, both rendered, but recovering by wiping the rows is cleaner than leaving permanent placeholders for every historical attachment). Coordinate with stakeholders before truncating — this is irreversible. Procedure depends on policy (full purge vs. soft-mark "permanently unrecoverable"); align with the project owner before issuing the SQL.
4. **Wipe the dead ciphertext from B2.** The objects sit under Compliance Object Lock for `R` days ([ADR-0022](../../adr/0022-binary-storage-b2-compliance-object-lock.md)) and cannot be deleted within that window. Outside the window, the bucket lifecycle reaps them on the configured `daysFromHidingToDeleting` schedule; wait it out, or accept that they sit unreadable until the lifecycle catches up.
5. **Redeploy** per [setup.md §4](setup.md#4-first-deploy). The boot probe accepts the new identity; new uploads wrap to it.
6. **Communicate to every user** that historical attachments are gone and to re-upload anything still needed.

This procedure exists to be documented, not to be used. Two off-system custody copies + monthly drill is the design's mitigation; if both copies are lost on the same day, custody discipline broke down, not the cryptography.
