# Binary Attachment Key — Drills

Monthly operator-side decrypt drill. Proves a custody copy of the binary `age` identity still decrypts live B2 ciphertext — through the same recovery tool a disaster would use ([AC-441](../../spec/verification.md#1526-attachments), [AC-374](../../spec/verification.md#1526-attachments)). Same cadence as ADR-0020's Tier 2 monthly drill.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0024 §Decision "Self-describing objects"](../../adr/0024-binary-attachment-e2e-encryption.md#decision).

## Why this exists

Every upload exercises the wrap path on the VPS, never a custody copy — and a reboot paste proves only that the entry parses and matches the recipient. A corrupted USB, a faded printout or a forgotten vault password stays invisible until a recovery needs the identity. The drill also proves the recovery tool, the read-only recovery key and the object metadata it reads — the path a Layer 2 restore depends on ([backup/recovery.md § 6](../backup/recovery.md#6-restore-into-production)).

A failed drill is a custody emergency — escalate per [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation).

## Procedure

The recovery tool runs on the operator workstation, read-only: no database, no VPS, nothing written to B2.

**Prerequisites:** repo checkout with `npm ci` done, Node per `package.json` `engines`, `age` + `age-keygen` at `/usr/bin/`, and the read-only recovery key from the password manager ([object-storage-provisioning.md § Recovery key](../object-storage-provisioning.md#recovery-key-read-only)).

**One-time setup:** a dedicated drill customer and project in the app (e.g. the operating company as customer, project `Betrieb – Schlüsselprobe`). Samples never go under a real customer: each upload is visible to the project's members and leaves permanent audit entries in that customer's record.

### 1. Upload a sample

```bash
SINCE=$(date -u -d '-2 min' +%FT%TZ)
```

Upload a fresh photo or small PDF to the drill project. Copy its object key from the URL path of the storage `PUT` in the browser's network tab, without the bucket segment — `attachments/<projectId>/<attachmentId>.orig`. A photo issues a second `PUT` for its `.thumb`; the drill uses `.orig`.

```bash
KEY="attachments/<projectId>/<attachmentId>.orig"
```

Then delete the attachment in the app. The drill now reads a version behind a delete marker — as a disaster restore does — and the Papierkorb purges the sample after `L` days ([architecture.md §12.2](../../spec/architecture.md#122-company-configurable-settings)).

### 2. Load a custody copy

After a rotation the custody copy is the keyring; the recovery tool tries every key in it. The sample proves only the active key — check the retired ones are present per [rotation.md § 3](rotation.md#3-verify). This month's copy per [§ Cycle the custody copies](#cycle-the-custody-copies) — the load-bearing step. Paste it into a [working file](../index.md#working-file) (`$W/identity.txt`); the teardown in step 5 removes it.

### 3. Run the recovery tool

The secret is read without echo, so it stays out of shell history:

```bash
cd <repo>
read -rs STORAGE_SECRET_KEY && export STORAGE_SECRET_KEY   # paste the recovery applicationKey, Enter
STORAGE_ENDPOINT=<B2 S3 endpoint> STORAGE_BUCKET=<bucket> STORAGE_REGION=<region> \
STORAGE_ACCESS_KEY=<recovery keyId> \
  npx tsx scripts/binary-key/recover-objects.ts \
    --identity "$W/identity.txt" --since "$SINCE" --key "$KEY" --out "$W/out"
```

`--key` keeps customer uploads from the same window out of the run. Exit 0 and `"outcome": "recovered"` in `$W/out/index.json` = the envelope on the object unwrapped with the loaded copy and the AES-GCM tag verified. A `failed` entry carries the reason — see [troubleshooting.md § Drill failure](troubleshooting.md#drill-failure-on-the-workstation).

### 4. Verify the plaintext

Open the file named by the entry's `file` (relative to `--out`; no extension — `file <path>` names the type) and confirm it is the photo or PDF you uploaded. The tag check already proves integrity; this proves it is the right object.

### 5. Tear down

```bash
unset STORAGE_SECRET_KEY
rm -rf "$W"
```

## Recording the result

Record the result per [Operations record](../index.md#operations-record). Include:

- Drill date.
- Sample object key (no plaintext, no DEK).
- Custody copy used, by label (password manager, copy A, …).
- Pass / fail.
- For fail: the index entry's `error`.
- Workstation `age --version`, `node --version` (catches tooling drift).

Cadence: first working day of each month. A missed month is not a failure — run it as soon as noticed.

## Cycle the custody copies

One copy per drill, in turn: the password-manager entry, then each off-system copy the operating company keeps ([Key custody](../index.md#key-custody)). Drilling only one never exercises the others; a year later the paper copy could be unreadable and you'd never know. Password manager + two off-system copies = each exercised every three months; without off-system copies, every drill loads the password-manager entry.
