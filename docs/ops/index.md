# Ops Docs

Who does what in operations — the operating company's duties, the operator role, the system's limits: [Betriebsverantwortung](../compliance/betriebsverantwortung.md).

## Setup (one-time)

| Document                                                         | Purpose                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| [server-setup.md](server-setup.md)                               | VPS provisioning: OS, SSH, deploy user, Docker, fail2ban |
| [wireguard-setup.md](wireguard-setup.md)                         | WireGuard VPN server and peer onboarding                 |
| [dns-setup.md](dns-setup.md)                                     | Domain DNS configuration (A record → WireGuard IP)       |
| [caddy-tls-bootstrap.md](caddy-tls-bootstrap.md)                 | First-time TLS certificate provisioning via LE staging   |
| [object-storage-provisioning.md](object-storage-provisioning.md) | Backblaze B2 bucket + app key + CORS for attachments     |

## Operations (repeatable)

| Document                                                       | Purpose                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [manual-deploy.md](manual-deploy.md)                           | Deploy, rollback, secrets management                                                                   |
| [sync-dev-to-vps.md](sync-dev-to-vps.md)                       | Destructive sync of dev DB + object storage to the VPS                                                 |
| [sync-vps-to-dev.md](sync-vps-to-dev.md)                       | Destructive sync in reverse — VPS state back into dev                                                  |
| [recover-from-schema-change.md](recover-from-schema-change.md) | Wipe + reseed + sync after a `0000_baseline.sql` edit                                                  |
| [backup/](backup/overview.md)                                  | Layer 2 backup — setup, DR restore, drills, troubleshooting                                            |
| [binary-key/](binary-key/overview.md)                          | Layer 3 binary `age` identity — setup, paste-after-reboot, drills, recovery, rotation, troubleshooting |
| [local-dev.md](local-dev.md)                                   | Local development environment                                                                          |
| [http-only-evaluation.md](http-only-evaluation.md)             | Domain-less HTTP testing on a bare VPS                                                                 |
| [dep-management.md](dep-management.md)                         | Renovate cadence, CVE handling, quarterly lifecycle review                                             |

## Operations record

Drills, restores and rotations are recorded outside the systems they exercise — a file on the workstation dies with the workstation. Use the procedure's recurring calendar event (monthly drills) or a one-off event (restore, rotation), and name custody copies by label (copy A / copy B), never by location.

## Key custody

Applies to both operator-held `age` identities — binary ([binary-key/](binary-key/overview.md)) and backup ([backup/](backup/overview.md)). Custody copies = the working copy plus any off-system copies.

| Copy              | Where                                                                                                 | Role                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Working copy      | One password-manager entry per identity: the full file text, in a multi-line field                    | Every routine paste and command reads from here. Not an off-system copy. |
| Off-system copies | Offline: encrypted USB, paper written by hand (a print spooler writes it to disk), air-gapped KeePass | Survive loss of the password manager. Labelled copy A, copy B, …         |
| Retired           | Entry and copies marked "retired, read-only"                                                          | Decrypt what the old keypair protected; kept, never destroyed            |

The system's line: the identity is operator-held — never on the VPS disk, in CI, git, chat or a plain cloud drive, and no identity file persists on the workstation. The rest is the operating company's call, recommended but not enforced: how the password manager keeps and backs up its vault, how many off-system copies and where ([Betriebsverantwortung §4](../compliance/betriebsverantwortung.md#4-empfehlungen-an-den-betreiber)). Without an off-system copy, losing the password-manager entry is losing the identity. Keep the label → location map outside the password manager too — it is needed exactly when the password manager is gone.

Plaintext secrets — identities, decrypted `secrets.env` — are handled on the operator workstation; only encrypted secret files travel (`scp`). The live VPS is inside the trusted domain: compromise there loses everything anyway ([ADR-0024 §Threat model](../adr/0024-binary-attachment-e2e-encryption.md#decision)). On the workstation, tmpfs can still be swapped to disk — encrypted swap or disk is the operating company's call.

### Working file

For a command that reads a secret from a file — an identity or a decrypted `secrets.env`. tmpfs only (`$XDG_RUNTIME_DIR` is `/run/user/<uid>` on systemd); `rm -rf "$W"` is the teardown, no `shred` needed. An identity never goes through an editor — swap and backup files outlive the teardown; editing `secrets.env` needs an editor without swap, viminfo or personal vimrc (`vim --clean -n`). Echo stays off while a key is pasted:

```bash
W="$XDG_RUNTIME_DIR/age-work"
install -d -m 700 "$W"
stty -echo; (umask 077; cat > "$W/identity.txt"); stty echo   # paste the entry, Enter, Ctrl-D
# … run the command with "$W/identity.txt" …
rm -rf "$W"
```

Interrupted mid-paste? `stty echo; rm -rf "$W"`.

A recipient check needs no file: `stty -echo; age-keygen -y; stty echo`, paste, Enter, Ctrl-D prints the `age1...` recipient.

### New identity

```bash
W="$XDG_RUNTIME_DIR/age-work"
install -d -m 700 "$W"
age-keygen -o "$W/identity.txt"   # prints "Public key: age1..." — the recipient
cat "$W/identity.txt"             # copy into a new password-manager entry
```

After the copy: clear the clipboard; in tmux, also `tmux clear-history`.

Mint the off-system copies the operating company keeps, then `rm -rf "$W"`.
