# Binary Attachment Key — Drills

Monthly operator-side decrypt drill. Proves the off-system custody copy of the binary `age` identity still decrypts live B2 ciphertext — through the same recovery tool a disaster would use ([AC-373](../../spec/verification.md#1526-attachments), [AC-374](../../spec/verification.md#1526-attachments)). Same cadence as ADR-0020's Tier 2 monthly drill.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0024 §Decision "Self-describing objects"](../../adr/0024-binary-attachment-e2e-encryption.md#decision).

## Why this exists

Every upload exercises the wrap path on the VPS, never the off-system custody copy. A corrupted USB, a faded printout or a forgotten vault password stays invisible until a recovery needs the identity. The drill also proves the recovery tool, the read-only recovery key and the object metadata it reads — the path a Layer 2 restore depends on ([backup/recovery.md § 6](../backup/recovery.md#6-restore-into-production)).

A failed drill on the only off-system copy that matters is a custody emergency — escalate per [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation).

## Procedure

Runs on the operator workstation, read-only: no database, no VPS, nothing written to B2.

**Prerequisites:** repo checkout with `npm ci` done, Node per `package.json` `engines`, `age` + `age-keygen` at `/usr/bin/`, and the read-only recovery key from the password manager ([object-storage-provisioning.md § Recovery key](../object-storage-provisioning.md#recovery-key-read-only)).

### 1. Pick a sample object

Upload a fresh photo or small PDF through the app; note the time just before the upload. Its key is the path of the storage `PUT` in the browser's network tab, without the bucket segment. Working values: `KEY="attachments/<projectId>/<attId>.orig"`, `SINCE="<ISO time before the upload>"`.

### 2. Load a custody copy

Put one off-system copy into a temporary file (encrypted USB mounted, paper copy transcribed, KeePass entry exported) at `~/binary-drill/identity-from-custody.txt`. This is the load-bearing step — never the workstation's working copy.

### 3. Run the recovery tool

```bash
cd <repo>
STORAGE_ENDPOINT=<B2 S3 endpoint> STORAGE_BUCKET=<bucket> STORAGE_REGION=<region> \
STORAGE_ACCESS_KEY=<recovery keyId> STORAGE_SECRET_KEY=<recovery applicationKey> \
  npx tsx scripts/binary-key/recover-objects.ts \
    --identity ~/binary-drill/identity-from-custody.txt \
    --since "$SINCE" --key "$KEY" --out ~/binary-drill/out
```

Exit 0 and `"outcome": "recovered"` in `~/binary-drill/out/index.json` = the envelope on the object unwrapped with the custody copy and the AES-GCM tag verified. A `failed` entry carries the reason — see [troubleshooting.md § Drill failure](troubleshooting.md#drill-failure-on-the-workstation).

### 4. Verify the plaintext

Open the file named by the entry's `file` (relative to `--out`) and confirm it is the photo or PDF you uploaded. The tag check already proves integrity; this proves it is the right object.

### 5. Tear down

```bash
shred -u ~/binary-drill/identity-from-custody.txt
find ~/binary-drill/out -type f -exec shred -u {} +
rm -rf ~/binary-drill
```

## Recording the result

Record the result in `~/ops-log/binary-drill-YYYY-MM.md` (create if absent) or in your operations calendar entry. Include:

- Drill date.
- Sample object key (no plaintext, no DEK).
- Custody copy used (e.g., "USB in office safe", "paper copy in home safe").
- Pass / fail.
- For fail: the index entry's `error`.
- Workstation `age --version`, `node --version` (catches tooling drift).

Cadence: first working day of each month. A missed month is not a failure — run it as soon as noticed.

## Cycle the custody copies

Across drills, alternate which off-system custody copy you load. Drilling only the USB never exercises the paper copy; a year later the paper copy could be unreadable and you'd never know. Two custody copies × monthly drill = each copy exercised every two months.
