/**
 * AC-782 — no file the system serves carries a secret of an external
 * service. The served files are the Vite build of the client sources
 * (everything under `src/` outside `src/server/` and the tests) plus
 * `public/`. Vite inlines into the bundle only what `define` names and
 * `import.meta.env` reads, so the scan pins both ends: the client
 * reads no server env var, and the build config injects nothing else.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

const clientFiles = walk(path.join(root, 'src')).filter((f) => {
  const rel = path.relative(root, f);
  return (
    /\.(ts|tsx|js|css|html|json)$/.test(rel) &&
    !rel.startsWith('src/server/') &&
    !rel.startsWith('src/test/') &&
    !/\.test\.tsx?$/.test(rel)
  );
});
const publicFiles = walk(path.join(root, 'public'));

// The production build drops comments, so only code counts.
function servedText(file: string): string {
  const text = readFileSync(file, 'utf8');
  if (!/\.(ts|tsx|js)$/.test(file)) return text;
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// NODE_ENV is the one server variable the client may read: Vite replaces
// it with the build mode, which is no secret.
const serverVars = Object.keys(envSchema.shape).filter((k) => k !== 'NODE_ENV');

describe('AC-782: served files carry no external-service secret', () => {
  it('scans a non-trivial client tree', () => {
    expect(clientFiles.length).toBeGreaterThan(50);
    expect(serverVars).toContain('OPENROUTER_API_KEY');
  });

  it('client sources and public/ name no server env var', () => {
    const offenders = [...clientFiles, ...publicFiles].flatMap((f) => {
      const text = servedText(f);
      return serverVars
        .filter((v) => new RegExp(`\\b${v}\\b`).test(text))
        .map((v) => `${path.relative(root, f)}: ${v}`);
    });
    expect(offenders).toEqual([]);
  });

  it('client sources read no import.meta.env variable beyond the build flags', () => {
    const offenders = clientFiles.flatMap((f) =>
      [...servedText(f).matchAll(/import\.meta\.env\.(\w+)/g)]
        .map((m) => m[1]!)
        .filter((v) => !['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL'].includes(v))
        .map((v) => `${path.relative(root, f)}: ${v}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the Vite config injects only the git SHA and keeps the default env prefix', () => {
    const config = readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/\benvPrefix\b/);
    const define = config.match(/define:\s*\{([^}]*)\}/)?.[1] ?? '';
    expect([...define.matchAll(/(\w+)\s*:/g)].map((m) => m[1])).toEqual(['__APP_GIT_SHA__']);
  });
});
