# Binary Attachment Key — Overview

Operator navigation page for the binary-attachment end-to-end-encryption identity ([ADR-0024](../../adr/0024-binary-attachment-e2e-encryption.md)). Design rationale and alternatives live in the ADR; this runbook is procedures only. The big-picture map across all three data layers lives in the root [DATA.md](../../../DATA.md).

## What the binary identity is

A long-lived `age` X25519 key pair whose public recipient (`BINARY_AGE_RECIPIENT`) is embedded in the `app` container env, and whose private identity lives only on the operator workstation. Every binary uploaded through the app is encrypted in the browser with a fresh per-blob AES-256-GCM data-encryption key (DEK); the server wraps that DEK with the public recipient and stores the wrapped envelope (`wrappedDek`) on the `attachment` row. B2 sees only ciphertext — the bytes plus a per-blob nonce, opaque to the provider.

```
┌──────────────────────┐    presigned PUT (ciphertext)   ┌──────────────────────────┐
│  browser             │ ──────────────────────────────▶ │  Backblaze B2 bucket     │
│  AES-256-GCM encrypt │                                 │  /<projectId>/<attId>... │
│  (per-blob DEK)      │                                 │                          │
└──────────────────────┘                                 └──────────────────────────┘
           │
           │ init: { dekMaterial, ciphertextSizeBytes, ciphertextContentMd5, ... }
           ▼
┌──────────────────────┐   age-wrap with recipient   ┌──────────────────────────────┐
│  app server          │ ──────────────────────────▶ │  attachments.wrappedDek      │
│  KeyEnvelopeService  │                             │  (schema-level audit-excl.)  │
│  reads identity from │                             └──────────────────────────────┘
│  /run/binary-key/    │
│  identity (tmpfs)    │
└──────────────────────┘
           ▲
           │ paste after every reboot
           │
┌──────────────────────┐
│  operator workstation│  age private identity, ≥2 off-system custody copies
└──────────────────────┘
```

The Service Worker decrypt path (synthetic origin `/encrypted-storage/<projectId>/<attachmentId>.<variant>`) fetches DEK material from the app, decrypts ciphertext from B2, and serves plaintext bytes to `<img>`, `<iframe>` PDF preview, and `<a href download>` consumers. Bulk download uses per-file `bulk-fetch` + browser-side streaming-zip — no server-side zip artifact.

## What it protects

B2 ciphertext. Provider operations, support staff with bucket access, leaked data-plane S3 tokens, and subpoenas served to Backblaze all see only opaque bytes ([ADR-0024 §Threat model](../../adr/0024-binary-attachment-e2e-encryption.md#decision)). A live VPS with the identity loaded is **out of scope** — code execution on the running app reads DEKs as the app does. Lost VPS disk is fine — the identity is tmpfs-only.

## Relation to the backup drill key

The binary identity and the backup drill identity are **independent keypairs** (separate env vars `BINARY_AGE_RECIPIENT` / `AGE_RECIPIENT`, separate tmpfs files, independent rotation cadence, independent blast radius). After every VPS reboot, the operator pastes **both** identities — order does not matter, but the failure modes diverge:

- Missed binary paste = **app refuses to start** ([ADR-0024 §Decision "Boot probe"](../../adr/0024-binary-attachment-e2e-encryption.md#decision)). Hard down. Operator notices because the app is unreachable.
- Missed backup paste = Tier 2 drills stale, freshness badge amber ([ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md)). App keeps serving.

Two pastes after every reboot is the canonical post-restart workflow. See [load.md § Two-paste workflow](load.md#two-paste-workflow).

## When to use this runbook

| Situation                                                               | Start here                               |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| Bring the binary identity up on a fresh VPS, or re-issue the keypair    | [setup.md](setup.md)                     |
| Reload the identity into VPS tmpfs after a reboot or container recreate | [load.md](load.md)                       |
| Run the monthly workstation-side decrypt drill                          | [drills.md](drills.md)                   |
| Lost identity, lost custody copy, recovery from key drift               | [recovery.md](recovery.md)               |
| Plan a key rotation (new keypair, re-upload all attachments)            | [rotation.md](rotation.md)               |
| App refuses to start, load script rejects the paste, drill fails        | [troubleshooting.md](troubleshooting.md) |

## References

- [ADR-0024](../../adr/0024-binary-attachment-e2e-encryption.md) — design, alternatives, consequences.
- [ADR-0020](../../adr/0020-layer-2-encrypted-r2-backups-with-operator-loaded-drills.md) — operator-loaded-key precedent for the backup domain.
- [ADR-0022](../../adr/0022-binary-storage-b2-compliance-object-lock.md) — durability layer (unchanged by ADR-0024; bucket primitives operate on opaque bytes).
- [DATA.md §Layer 3](../../../DATA.md#layer-3--binary-attachments-provider-enforced-durability--e2e) — bird's-eye map across all three data layers.
- [docs/ops/backup/](../backup/overview.md) — sibling runbook for the backup drill identity.
