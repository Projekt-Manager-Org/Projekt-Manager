# Binary Attachment Key — Drills

Monthly operator-side decrypt drill. Proves the off-system custody copy of the binary `age` identity still works against live B2 ciphertext + a live wrapped envelope. Same cadence as ADR-0020's Tier 2 monthly drill, same purpose: catch silent corruption of the off-system identity backup before a real recovery needs it.

Concept map: [overview.md](overview.md). Design rationale: [ADR-0024 §Decision "Operator workflow"](../../adr/0024-binary-attachment-e2e-encryption.md#decision).

## Why this exists

The binary identity's only proof-of-life is the working app — every successful upload + render exercises the wrap path on the VPS, but never the off-system custody copy. A corrupted USB, a faded paper printout, or a forgotten encrypted-vault password is invisible until the day a recovery needs the identity. The monthly drill closes the gap: pull a real ciphertext from B2, fetch its real wrapped envelope from the DB, decrypt with the off-system identity copy, verify the bytes round-trip.

If the drill passes, the off-system custody copy is known-good as of today. If it fails, escalate per [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation) — a failed drill on the **only** off-system copy that matters is a custody emergency, not a routine bug.

## Procedure

You run this on the operator workstation. The VPS is not involved beyond the database query and the B2 download — both done from the workstation through existing credentials. **No production state changes.** This is a read-only verification; if anything writes back to the DB or B2, you are off the runbook.

### 1. Pick a sample attachment

Pick a recent `status = 'ready'` attachment with a known plaintext (e.g., a photo you uploaded yourself and can visually identify, or a small PDF whose plaintext SHA-256 you have on record).

From a WireGuard client, query the app DB through the deploy user:

```bash
ssh <admin-username>@<vps-hostname> \
  "sudo -u deploy docker exec projekt-manager-db-1 psql -U pm -d projekt_manager -tAc \
    \"SELECT id, project_id, original_key, ciphertext_size_bytes, mime_type, encode(wrapped_dek, 'base64') FROM attachments WHERE status='ready' ORDER BY created_at DESC LIMIT 5;\""
```

Pick one row. Capture `originalKey` (the B2 object key), `ciphertextSizeBytes`, and the base64 `wrappedDek`. Working values for the rest of this section: `KEY="<originalKey>"`, `WRAPPED_DEK_B64="<base64>"`.

### 2. Download the ciphertext from B2

The bucket is private; every fetch is signed with the existing B2 credentials from the operator's password manager (the same `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` documented in [docs/ops/object-storage-provisioning.md](../object-storage-provisioning.md)).

```bash
mkdir -p ~/binary-drill && cd ~/binary-drill

AWS_ACCESS_KEY_ID="$STORAGE_ACCESS_KEY" \
AWS_SECRET_ACCESS_KEY="$STORAGE_SECRET_KEY" \
AWS_DEFAULT_REGION="$STORAGE_REGION" \
  aws s3 cp "s3://${STORAGE_BUCKET}/${KEY}" ./ciphertext.bin \
  --endpoint-url "$STORAGE_ENDPOINT"
```

Verify the size matches `ciphertextSizeBytes` from step 1. A mismatch means storage drift between row and object — stop, escalate per [troubleshooting.md § Decryption mismatch](troubleshooting.md#decryption-fails-for-one-attachment).

### 3. Unwrap the DEK with the off-system identity

This is the load-bearing step — it touches the off-system identity custody copy, not the workstation's working copy. Pull one of the off-system copies into a temporary file (encrypted USB mounted, paper printout transcribed into a tmpfs file, KeePass entry exported) at `~/binary-drill/identity-from-custody.txt`.

```bash
echo "$WRAPPED_DEK_B64" | base64 -d > wrapped-dek.age
age -d -i ~/binary-drill/identity-from-custody.txt wrapped-dek.age > dek.bin

# DEK should be exactly 32 bytes (AES-256 key).
test "$(wc -c < dek.bin)" -eq 32 && echo "DEK length OK (32 bytes)"
```

If `age -d` fails with `no identity matched any of the recipients`, the off-system identity does **not** match the deployed `BINARY_AGE_RECIPIENT`. Two possibilities: the custody copy is from a previous keypair (rotation gap — see [rotation.md](rotation.md)), or the custody copy is corrupted. Either way, this drill is a fail and the custody copy needs immediate attention — escalate per [recovery.md § Drill-failure escalation](recovery.md#3-drill-failure-escalation).

### 4. AES-256-GCM-decrypt the bytes

The ciphertext layout is **nonce (12 bytes) + ciphertext + GCM auth tag (16 bytes)**, per [ADR-0024 §Decision "Encryption"](../../adr/0024-binary-attachment-e2e-encryption.md#decision). The 16-byte tag is verified on decrypt and is the cryptographic-integrity guarantee.

`openssl enc` does not support AES-GCM cleanly on most distros; use a small Python helper:

```bash
python3 - <<'PY'
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import sys
with open("ciphertext.bin","rb") as f:
    blob = f.read()
nonce, ct = blob[:12], blob[12:]
with open("dek.bin","rb") as f:
    key = f.read()
pt = AESGCM(key).decrypt(nonce, ct, None)
sys.stdout.buffer.write(pt)
PY > plaintext.bin
```

If the script raises `InvalidTag`, the GCM auth check failed — the ciphertext was modified after upload, the DEK is wrong (see step 3), or the nonce framing drifted. Either way, fail the drill and escalate.

### 5. Verify against a known plaintext checksum

For a file whose plaintext SHA-256 you recorded at upload time:

```bash
sha256sum plaintext.bin
# compare against the recorded value
```

For a photo: open `plaintext.bin` with the appropriate viewer (rename with the `mimeType` extension first), confirm visually that it matches the original you uploaded. Visual confirmation is acceptable for image drills — the test is "do the bytes round-trip", not "does a hash match a database column."

### 6. Tear down

```bash
shred -u ~/binary-drill/dek.bin ~/binary-drill/plaintext.bin ~/binary-drill/identity-from-custody.txt
rm -f ~/binary-drill/ciphertext.bin ~/binary-drill/wrapped-dek.age
```

The DEK and the identity custody copy are the sensitive artifacts; `shred` them before deleting the directory. The ciphertext is harmless without the DEK; plain `rm` is fine.

## Recording the result

Record the result in `~/ops-log/binary-drill-YYYY-MM.md` (create if absent) or in your operations calendar entry. Include:

- Drill date.
- Sample attachment id + project id (no plaintext, no DEK).
- Custody copy used (e.g., "USB in office safe", "paper copy in home safe").
- Pass / fail.
- For fail: which step broke (download, unwrap, decrypt, verify) and the error text.
- Workstation `age --version`, `python3 --version`, `aws --version` (catches tooling drift).

Cadence: first working day of each month. A missed month is not a failure — run it as soon as noticed.

## Cycle the custody copies

Across drills, alternate which off-system custody copy you load. Drilling only the USB never exercises the paper copy; a year later the paper copy could be unreadable and you'd never know. Two custody copies × monthly drill = each copy exercised every two months.
