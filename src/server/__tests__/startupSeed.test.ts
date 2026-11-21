import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, vi } from 'vitest';

import { envSchema } from '../config/env.js';
import { runStartupSeed } from '../startupSeed.js';

function spies() {
  return {
    seed: vi.fn(async () => {}),
    pruneBucket: vi.fn(async () => {}),
    warn: vi.fn(),
  };
}

describe('AC-764: production seeding changes no stored data', () => {
  it.each(['true', 'force'] as const)(
    'SEED=%s in production: no seed, no prune, a warning',
    async (SEED) => {
      const deps = spies();
      await runStartupSeed({ NODE_ENV: 'production', SEED }, deps);
      expect(deps.seed).not.toHaveBeenCalled();
      expect(deps.pruneBucket).not.toHaveBeenCalled();
      expect(deps.warn).toHaveBeenCalledOnce();
    },
  );

  it('an unset NODE_ENV parses as production, so SEED=force changes nothing', async () => {
    const deps = spies();
    await runStartupSeed(
      envSchema.parse({ DATABASE_URL: 'postgres://unused', SEED: 'force' }),
      deps,
    );
    expect(deps.seed).not.toHaveBeenCalled();
    expect(deps.pruneBucket).not.toHaveBeenCalled();
  });

  it('start.ts seeds only through runStartupSeed', () => {
    const startSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../start.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(startSource.match(/\brunStartupSeed\s*\(\s*env\s*,/g)).toHaveLength(1);
    expect(startSource.match(/\bseed\s*\(/g)).toHaveLength(1);
    expect(startSource).toMatch(/seed:\s*\(opts\)\s*=>\s*seed\(db,\s*opts\)/);
  });
});

describe('runStartupSeed outside production', () => {
  it.each(['development', 'test'] as const)(
    'NODE_ENV=%s SEED=true seeds if empty, no prune',
    async (NODE_ENV) => {
      const deps = spies();
      await runStartupSeed({ NODE_ENV, SEED: 'true' }, deps);
      expect(deps.seed).toHaveBeenCalledExactlyOnceWith({ force: false });
      expect(deps.pruneBucket).not.toHaveBeenCalled();
    },
  );

  it('SEED=force wipes, re-seeds, then prunes the bucket', async () => {
    const deps = spies();
    await runStartupSeed({ NODE_ENV: 'development', SEED: 'force' }, deps);
    expect(deps.seed).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(deps.pruneBucket).toHaveBeenCalledOnce();
    expect(deps.seed.mock.invocationCallOrder[0]).toBeLessThan(
      deps.pruneBucket.mock.invocationCallOrder[0]!,
    );
  });

  it('SEED=false does nothing and does not warn', async () => {
    const deps = spies();
    await runStartupSeed({ NODE_ENV: 'development', SEED: 'false' }, deps);
    expect(deps.seed).not.toHaveBeenCalled();
    expect(deps.pruneBucket).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
