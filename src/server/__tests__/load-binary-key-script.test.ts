/**
 * `scripts/binary-key/load-binary-key.sh` — the operator loader for the
 * binary keyring (ADR-0024 § Operator workflow, § Key rotation).
 *
 * Runs the real script with one line changed: `BINARY_DIR` points at a
 * fresh directory on `/dev/shm` (tmpfs) instead of the container's
 * `/run/binary-key`, so the script's own tmpfs invariant still holds.
 * Every case pastes via stdin, as `docker exec -it … load-binary-key`
 * does, with a minimal env carrying only what the container provides.
 *
 * Pinned: the target must be tmpfs, the keyring check matches the boot
 * probe (exact set: active + retired), the retired list parses exactly
 * like the env schema, nothing is written until the paste is valid, and
 * no run prints private key material — the paste or a misconfigured env.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSchema } from '../config/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(repoRoot, 'scripts/binary-key/load-binary-key.sh');
const BINARY_DIR_LINE = 'BINARY_DIR="/run/binary-key"';
/** A private key body; the script's own hint text says only `AGE-SECRET-KEY-1...`. */
const SECRET_KEY_MATERIAL = /AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]/;

function ageKey(): { identity: string; recipient: string } {
  const identity = execFileSync('age-keygen', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const recipient = execFileSync('age-keygen', ['-y'], { input: identity, encoding: 'utf-8' });
  return { identity, recipient: recipient.trim() };
}

describe('load-binary-key.sh', () => {
  let tmpfsDir: string;
  let scriptCopy: string;
  let keyringFile: string;
  const [k1, k2, k3] = [ageKey(), ageKey(), ageKey()];

  /** The real script with only its target directory changed. */
  function scriptTargeting(dir: string): string {
    const source = readFileSync(SCRIPT, 'utf-8');
    expect(source.split('\n').filter((l) => l === BINARY_DIR_LINE)).toHaveLength(1);
    return source.replace(BINARY_DIR_LINE, `BINARY_DIR="${dir}"`);
  }

  function fsType(dir: string): string {
    return execFileSync('findmnt', ['-T', dir, '-n', '-o', 'FSTYPE'], { encoding: 'utf-8' }).trim();
  }

  beforeAll(() => {
    tmpfsDir = mkdtempSync('/dev/shm/load-binary-key-');
    expect(fsType(tmpfsDir), '/dev/shm must be tmpfs').toBe('tmpfs');
    keyringFile = path.join(tmpfsDir, 'identity');
    scriptCopy = path.join(tmpfsDir, 'load-binary-key.sh');
    writeFileSync(scriptCopy, scriptTargeting(tmpfsDir));
  });

  afterAll(() => {
    if (tmpfsDir) rmSync(tmpfsDir, { recursive: true, force: true });
  });

  /** Runs the loader; every run, success or not, must keep private keys off its output. */
  function load(paste: string, env: Record<string, string>, script = scriptCopy) {
    const res = spawnSync('bash', [script], {
      input: paste,
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    });
    expect(res.stdout + res.stderr).not.toMatch(SECRET_KEY_MATERIAL);
    return { status: res.status, stderr: res.stderr };
  }

  function loaded(): string | null {
    return existsSync(keyringFile) ? readFileSync(keyringFile, 'utf-8') : null;
  }

  function reset(): void {
    rmSync(keyringFile, { force: true });
  }

  /** Nothing but the script copy and (optionally) the keyring — no temp file left. */
  function strayFiles(): string[] {
    return readdirSync(tmpfsDir).filter((f) => f !== 'load-binary-key.sh' && f !== 'identity');
  }

  it('refuses to write to a directory that is not tmpfs', () => {
    // node_modules is on disk in every checkout; /tmp may itself be tmpfs.
    const diskDir = mkdtempSync(path.join(repoRoot, 'node_modules', '.load-binary-key-'));
    try {
      expect(fsType(diskDir), 'precondition: not tmpfs').not.toBe('tmpfs');
      const script = path.join(diskDir, 'load-binary-key.sh');
      writeFileSync(script, scriptTargeting(diskDir));
      const res = load(k1.identity, { BINARY_AGE_RECIPIENT: k1.recipient }, script);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/is not a tmpfs mount/);
      expect(existsSync(path.join(diskDir, 'identity'))).toBe(false);
    } finally {
      rmSync(diskDir, { recursive: true, force: true });
    }
  });

  it('loads a single key when no retired recipients are configured', () => {
    reset();
    const res = load(k1.identity, { BINARY_AGE_RECIPIENT: k1.recipient });
    expect(res).toMatchObject({ status: 0 });
    expect(loaded()).toBe(k1.identity);
    expect(statSync(keyringFile).mode & 0o777).toBe(0o400);
    expect(strayFiles()).toEqual([]);
  });

  it('loads a keyring holding exactly the active and the retired keys, in any order', () => {
    reset();
    const keyring = k1.identity + k3.identity + k2.identity;
    const res = load(keyring, {
      BINARY_AGE_RECIPIENT: k2.recipient,
      BINARY_AGE_RETIRED_RECIPIENTS: `${k3.recipient},${k1.recipient}`,
    });
    expect(res).toMatchObject({ status: 0 });
    expect(loaded()).toBe(keyring);
  });

  it('rejects a keyring missing a retired key, naming it, and writes nothing', () => {
    reset();
    const res = load(k2.identity, {
      BINARY_AGE_RECIPIENT: k2.recipient,
      BINARY_AGE_RETIRED_RECIPIENTS: k1.recipient,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`missing:  ${k1.recipient}`);
    expect(loaded()).toBeNull();
  });

  it('rejects a keyring missing the active key, naming it', () => {
    reset();
    const res = load(k1.identity, {
      BINARY_AGE_RECIPIENT: k2.recipient,
      BINARY_AGE_RETIRED_RECIPIENTS: k1.recipient,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`missing:  ${k2.recipient}`);
    expect(loaded()).toBeNull();
  });

  it('rejects an unlisted key in the paste (e.g. the backup drill identity), naming it', () => {
    reset();
    const res = load(k2.identity + k3.identity, { BINARY_AGE_RECIPIENT: k2.recipient });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`unlisted: ${k3.recipient}`);
    expect(loaded()).toBeNull();
  });

  it('rejects material that is not an age identity', () => {
    reset();
    const res = load(`${k1.recipient}\n`, { BINARY_AGE_RECIPIENT: k1.recipient });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/does not parse as a valid age identity/);
    expect(loaded()).toBeNull();
  });

  it('leaves an already-loaded keyring untouched when a paste is rejected', () => {
    reset();
    const env = { BINARY_AGE_RECIPIENT: k1.recipient };
    expect(load(k1.identity, env).status).toBe(0);
    const truncatedKeyring = k1.identity + k2.identity.replace(/(AGE-SECRET-KEY-1\S{20})\S+/, '$1');
    for (const badPaste of [
      k2.identity,
      'not an identity\n',
      k1.identity + k2.identity,
      truncatedKeyring,
    ]) {
      expect(load(badPaste, env).status).toBe(1);
      expect(loaded()).toBe(k1.identity);
    }
    expect(strayFiles()).toEqual([]);
  });

  it('never echoes a private key configured by mistake as a recipient', () => {
    reset();
    const secret = k3.identity.match(/AGE-SECRET-KEY-1\S+/)![0];
    for (const env of <Record<string, string>[]>[
      { BINARY_AGE_RECIPIENT: secret },
      { BINARY_AGE_RECIPIENT: k1.recipient, BINARY_AGE_RETIRED_RECIPIENTS: secret },
    ]) {
      const res = load(k1.identity, env);
      expect(res.status).toBe(1);
      expect(res.stderr).not.toContain(secret);
      expect(loaded()).toBeNull();
    }
  });

  // The loader and the boot probe must agree, or an operator is locked
  // out (loader rejects what the probe would accept) or the probe refuses
  // what the loader wrote. The schema parses the list the probe receives.
  describe('parses BINARY_AGE_RETIRED_RECIPIENTS exactly like the env schema', () => {
    const cases: Record<string, string> = {
      empty: '',
      'one entry': k1.recipient,
      'two entries': `${k1.recipient},${k3.recipient}`,
      'whitespace around entries': ` ${k1.recipient} ,\t${k3.recipient} `,
      'trailing CR': `${k1.recipient}\r`,
      'duplicate entry': `${k1.recipient},${k1.recipient}`,
      'active listed as retired': `${k1.recipient},${k2.recipient}`,
      'whitespace only': ' ',
      'trailing comma': `${k1.recipient},`,
      'leading comma': `,${k1.recipient}`,
      'empty entry': `${k1.recipient},,${k3.recipient}`,
      'inner whitespace': `${k1.recipient.slice(0, 30)} ${k1.recipient.slice(30)}`,
      truncated: k1.recipient.slice(0, 40),
      uppercase: k1.recipient.toUpperCase(),
    };

    for (const [name, value] of Object.entries(cases)) {
      it(name, () => {
        reset();
        const parsed = envSchema.shape.BINARY_AGE_RETIRED_RECIPIENTS.safeParse(value);
        // Accepted: paste exactly the keys the schema's reading names.
        // Rejected: the loader must refuse for the parse, not for a key
        // set mismatch — the stderr assertion below pins the reason.
        const retired = parsed.success ? parsed.data : [];
        const keys = parsed.success
          ? [k2, ...[k1, k3].filter((k) => retired.includes(k.recipient))]
          : [k1, k2, k3];
        const res = load(keys.map((k) => k.identity).join(''), {
          BINARY_AGE_RECIPIENT: k2.recipient,
          BINARY_AGE_RETIRED_RECIPIENTS: value,
        });
        expect(res.status, res.stderr).toBe(parsed.success ? 0 : 1);
        expect(loaded() !== null).toBe(parsed.success);
        if (!parsed.success) {
          expect(res.stderr).toMatch(/BINARY_AGE_RETIRED_RECIPIENTS holds an entry/);
        }
      });
    }
  });
});
