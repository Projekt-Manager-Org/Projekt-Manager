/**
 * AC-670 — the system refuses no upload for storage reaching the warn
 * band (kickoff: cleanup is up to the users).
 *
 * The stored total is pushed past the warn band of a 1 GB capacity by
 * raising one project's counters directly: uploading a gibibyte in a test
 * is not practical, and the counters are what the threshold monitor reads
 * (AC-667). `STORAGE_QUOTA_GB` is set too, though no upload code reads it
 * today, so a refusal added later that reads it is caught.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  startApp,
  stopApp,
  login,
  authGet,
  authPost,
  seedProjectStatus,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { createDatabase } from '../db/connection.js';
import { createStorageClientFromEnv } from '../storage/fromEnv.js';
import { getEnv } from '../config/env.js';
import { binaryInitBody } from '../../test/fixtures/attachmentInit.js';
import { TEST_OBJECT_METADATA } from '../../test/fixtures/objectEnvelope.js';
import { BYTES_PER_GB, THRESHOLD_MONITOR } from '../../config/thresholdMonitor.js';
import { StorageUsageService } from '../services/StorageUsageService.js';

const CAPACITY_GB = 1;
const CAPACITY_BYTES = CAPACITY_GB * BYTES_PER_GB;

const conn = createDatabase();
const previousQuota = process.env.STORAGE_QUOTA_GB;
let ownerToken: string;
let customerId: string;

beforeAll(async () => {
  process.env.STORAGE_QUOTA_GB = String(CAPACITY_GB);
  await startApp();
  ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
  const custRes = await authGet(ownerToken, '/api/customers');
  customerId = ((custRes.json().customers ?? custRes.json().data) as { id: string }[])[0]!.id;
});

afterAll(async () => {
  await stopApp();
  await conn.pool.end();
  if (previousQuota === undefined) delete process.env.STORAGE_QUOTA_GB;
  else process.env.STORAGE_QUOTA_GB = previousQuota;
});

async function createProject(label: string): Promise<string> {
  const res = await authPost(ownerToken, '/api/projects', {
    number: `AC670${label[0]}-${Date.now().toString(36)}`,
    title: 'AC-670 fixture',
    customerId,
  });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { id: string }).id;
  await seedProjectStatus(id, 'beauftragt');
  return id;
}

describe('AC-670: an upload past the storage warn band is accepted', () => {
  it('completes an upload while the stored total is at full declared capacity', async () => {
    const filler = await createProject('filler');
    await conn.db.execute(
      sql`UPDATE project_storage_usage SET ciphertext_ready_bytes = ${CAPACITY_BYTES}
          WHERE project_id = ${filler}`,
    );
    const usage = await new StorageUsageService(conn.db).getGlobalUsage();
    const usedPercent = ((usage.ready.ciphertext + usage.hidden.ciphertext) / CAPACITY_BYTES) * 100;
    expect(usedPercent).toBeGreaterThanOrEqual(THRESHOLD_MONITOR.storageWarnPercent);

    const target = await createProject('target');
    const initBody = binaryInitBody({ fileName: 'ac670-upload.pdf' });
    const initRes = await authPost(
      ownerToken,
      `/api/projects/${target}/attachments/init`,
      initBody,
    );
    expect(initRes.statusCode).toBe(201);
    const { attachment } = initRes.json() as { attachment: { id: string; originalKey: string } };

    await createStorageClientFromEnv(getEnv()).upload(
      attachment.originalKey,
      Buffer.alloc(initBody.ciphertextSizeBytes as number, 0xff),
      'application/octet-stream',
      TEST_OBJECT_METADATA,
    );
    const completeRes = await authPost(
      ownerToken,
      `/api/projects/${target}/attachments/${attachment.id}/complete`,
    );
    expect(completeRes.statusCode).toBe(200);

    const row = await conn.db.execute(
      sql`SELECT status FROM attachments WHERE id = ${attachment.id}`,
    );
    expect((row.rows[0] as { status: string }).status).toBe('ready');
  });
});
