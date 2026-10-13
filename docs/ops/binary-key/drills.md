# Binary Attachment Key — Drills

Monthly operator-side decrypt drill. Proves the off-system custody copy of the binary `age` identity still decrypts live B2 ciphertext — through the same recovery tool a disaster would use ([AC-373](../../spec/verification.md#1526-attachments), [AC-374](../../spec/verification.md#1526-attachments)). Same cadence as ADR-0020's Tier 2 monthly drill.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0024 §Decision "Self-describing objects"](../../adr/0024-binary-attachment-e2e-encryption.md#decision).

## Why this exists

Every upload exercises the wrap path on the VPS, never the off-system custody copy. A corrupted USB, a faded printout or a forgotten vault password stays invisible until a recovery needs the identity. The drill also proves the recovery tool, the read-only recovery key and the object metadata it reads — the path a Layer 2 restore depends on ([backup/recovery.md § 6](../backup/recovery.md#6-restore-into-production)).

A failed drill on the only off-system copy that matters is a custody emergency — escalate per [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation).

## Procedure

The recovery tool runs on the operator workstation, read-only: no database, no VPS, nothing written to B2.

**Prerequisites:** repo checkout with `npm ci` done, Node per `package.json` `engines`, `age` + `age-keygen` at `/usr/bin/`, and the read-only recovery key from the password manager ([object-storage-provisioning.md § Recovery key](../object-storage-provisioning.md#recovery-key-read-only)).

**One-time setup:** a dedicated drill project in the app (e.g. `Betrieb – Schlüsselprobe`). Samples never go into a customer project: each upload is visible to that project's members and leaves permanent audit entries there.

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

One off-system copy (encrypted USB mounted, paper copy transcribed, KeePass entry exported) — never the workstation's working copy; this is the load-bearing step. It goes to tmpfs, never to disk, and never through an editor (swap and backup files outlive the teardown):

```bash
D="$XDG_RUNTIME_DIR/binary-drill"
install -d -m 700 "$D"
(umask 077; cat > "$D/identity.txt")   # paste the identity, then Ctrl-D
```

### 3. Run the recovery tool

The secret is read without echo, so it stays out of shell history:

```bash
read -rs STORAGE_SECRET_KEY && export STORAGE_SECRET_KEY   # paste the recovery applicationKey, Enter
STORAGE_ENDPOINT=<B2 S3 endpoint> STORAGE_BUCKET=<bucket> STORAGE_REGION=<region> \
STORAGE_ACCESS_KEY=<recovery keyId> \
  npx tsx scripts/binary-key/recover-objects.ts \
    --identity "$D/identity.txt" --since "$SINCE" --key "$KEY" --out "$D/out"
```

`--key` keeps customer uploads from the same window out of the run. Exit 0 and `"outcome": "recovered"` in `$D/out/index.json` = the envelope on the object unwrapped with the custody copy and the AES-GCM tag verified. A `failed` entry carries the reason — see [troubleshooting.md § Drill failure](troubleshooting.md#drill-failure-on-the-workstation).

### 4. Verify the plaintext

Open the file named by the entry's `file` (relative to `--out`; no extension — `file <path>` names the type) and confirm it is the photo or PDF you uploaded. The tag check already proves integrity; this proves it is the right object.

### 5. Tear down

```bash
unset STORAGE_SECRET_KEY
rm -rf "$D"
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
