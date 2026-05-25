import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertStagingDurable } from '../config/assertStagingDurable.js';

/**
 * Linux filesystem magic numbers (linux/magic.h).
 */
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;
const EXT4_MAGIC = 0xef53;
const XFS_MAGIC = 0x58465342;

const STAGING_DIR = '/var/lib/projekt-manager/takeout';

describe('assertStagingDurable — pure guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------ //
  // Production — RAM-backed → must throw                               //
  // ------------------------------------------------------------------ //

  it('production + tmpfs magic → throws mentioning staging/tmpfs/RAM', () => {
    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: TMPFS_MAGIC,
      }),
    ).toThrowError(/staging/i);

    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: TMPFS_MAGIC,
      }),
    ).toThrowError(/tmpfs/i);

    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: TMPFS_MAGIC,
      }),
    ).toThrowError(/RAM/i);
  });

  it('production + ramfs magic → throws mentioning staging/ramfs/RAM', () => {
    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: RAMFS_MAGIC,
      }),
    ).toThrowError(/staging/i);

    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: RAMFS_MAGIC,
      }),
    ).toThrowError(/ramfs/i);

    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: RAMFS_MAGIC,
      }),
    ).toThrowError(/RAM/i);
  });

  // ------------------------------------------------------------------ //
  // Production — disk-backed → must NOT throw                          //
  // ------------------------------------------------------------------ //

  it('production + ext4 magic → does not throw', () => {
    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: EXT4_MAGIC,
      }),
    ).not.toThrow();
  });

  it('production + xfs magic → does not throw', () => {
    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'production',
        fsType: XFS_MAGIC,
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------ //
  // Development — RAM-backed → must NOT throw (may warn)              //
  // ------------------------------------------------------------------ //

  it('development + tmpfs magic → does not throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'development',
        fsType: TMPFS_MAGIC,
      }),
    ).not.toThrow();

    // A warning is acceptable but not required by the contract.
    // If a warning fires it must mention the path.
    if (warnSpy.mock.calls.length > 0) {
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(STAGING_DIR);
    }
  });

  it('test env + tmpfs magic → does not throw', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      assertStagingDurable({
        stagingDir: STAGING_DIR,
        nodeEnv: 'test',
        fsType: TMPFS_MAGIC,
      }),
    ).not.toThrow();
  });

  // ------------------------------------------------------------------ //
  // Sanity — production + disk-backed is the happy path               //
  // ------------------------------------------------------------------ //

  it('production + disk-backed → no warning, no throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    assertStagingDurable({
      stagingDir: STAGING_DIR,
      nodeEnv: 'production',
      fsType: EXT4_MAGIC,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
