/**
 * AC-372 — self-describing objects (data-model.md §5.13, ADR-0024).
 *
 * Every object the app writes carries, as object metadata set by the same
 * PUT, the wrapped envelope of its own DEK and `wrappedDekVersion`; a
 * rendered invoice PDF also carries its number. The values equal the
 * row's, so the object decrypts with the binary identity even when the
 * row is lost to a Layer 2 restore.
 *
 * Writers covered here: the browser's presigned PUT (original + thumbnail,
 * including the rejection of a PUT that omits or alters the metadata),
 * invoice issuance and cancellation, and the Papierkorb restore
 * (`copyFromVersion`) keeping the metadata. The import job's writes are
 * pinned in `data-exchange-import-archive.test.ts`, next to the archive
 * round-trip helpers they need.
 *
 * Metadata is read with a raw HEAD (`storageObjectMetadata.ts`), not the
 * app's storage client, so the assertion is independent of the code under
 * test. Runs against MinIO like the other presigned-PUT tests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  startApp,
  stopApp,
  getDb,
  login,
  authGet,
  authPost,
  authDelete,
} from '../../test/api-helpers.js';
import { SEED_DEFAULT_PASSWORD, SEED_USERS } from '../../test/seedAssumptions.js';
import { photoInitBody } from '../../test/fixtures/attachmentInit.js';
import {
  freshDekMaterial,
  md5Base64,
  presignedPut,
  type PresignedUpload,
} from '../../test/fixtures/presignedPut.js';
import {
  headObjectMetadata,
  META_INVOICE_NUMBER,
  META_WRAPPED_DEK,
  META_WRAPPED_DEK_VERSION,
} from '../../test/storageObjectMetadata.js';
import { attachments } from '../db/schema.js';

const year = new Date().getFullYear();
const META_HEADER_PREFIX = 'x-amz-meta-';

/**
 * Strip every `x-amz-meta-*` the descriptor carries — from the headers and
 * from the URL query alike, so the arm holds whichever way the metadata is
 * signed into the PUT.
 */
function withoutMetadata(descriptor: PresignedUpload): PresignedUpload {
  const url = new URL(descriptor.url);
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase().startsWith(META_HEADER_PREFIX)) url.searchParams.delete(name);
  }
  const headers = Object.fromEntries(
    Object.entries(descriptor.headers).filter(
      ([name]) => !name.toLowerCase().startsWith(META_HEADER_PREFIX),
    ),
  );
  return { url: url.toString(), headers };
}

/** Replace one metadata value — header or query parameter. */
function withAltered(name: string, forged: string) {
  const target = `${META_HEADER_PREFIX}${name}`;
  return (descriptor: PresignedUpload): PresignedUpload => {
    const url = new URL(descriptor.url);
    for (const param of [...url.searchParams.keys()]) {
      if (param.toLowerCase() === target) url.searchParams.set(param, forged);
    }
    const headers = Object.fromEntries(
      Object.entries(descriptor.headers).map(([header, value]) =>
        header.toLowerCase() === target ? [header, forged] : [header, value],
      ),
    );
    return { url: url.toString(), headers };
  };
}

async function readRow(id: string) {
  const rows = await getDb().select().from(attachments).where(eq(attachments.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`attachment row ${id} missing`);
  return row;
}

describe('AC-372: every written object carries its own wrapped envelope', () => {
  let ownerToken: string;
  let projectId: string;

  beforeAll(async () => {
    await startApp();
    ownerToken = await login(SEED_USERS.owner.username, SEED_DEFAULT_PASSWORD);
    const res = await authGet(ownerToken, '/api/projects?limit=200');
    const project = (res.json().data as { id: string; number: string }[]).find(
      (row) => row.number === `${year}-007`,
    );
    if (!project) throw new Error(`seed missing ${year}-007`);
    projectId = project.id;
  });

  afterAll(async () => {
    await stopApp();
  });

  /** init a photo; returns the init body plus the ciphertexts to PUT. */
  async function initPhoto() {
    const original = crypto.randomBytes(180);
    const thumb = crypto.randomBytes(120);
    const res = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/init`,
      photoInitBody({
        sizeBytes: 120,
        thumbSizeBytes: 80,
        ciphertextSizeBytes: original.length,
        ciphertextContentMd5: md5Base64(original),
        ciphertextThumbSizeBytes: thumb.length,
        ciphertextThumbContentMd5: md5Base64(thumb),
        dekMaterial: freshDekMaterial(),
        thumbDekMaterial: freshDekMaterial(),
      }),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      attachment: { id: string };
      originalUpload: PresignedUpload;
      thumbnailUpload: PresignedUpload;
    };
    return { body, original, thumb };
  }

  async function uploadReadyPhoto(): Promise<string> {
    const { body, original, thumb } = await initPhoto();
    for (const [descriptor, bytes] of [
      [body.originalUpload, original],
      [body.thumbnailUpload, thumb],
    ] as const) {
      const put = await presignedPut(descriptor, bytes);
      expect(put.status).toBeLessThan(300);
      await put.arrayBuffer();
    }
    const complete = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
    );
    expect(complete.statusCode).toBe(200);
    return body.attachment.id;
  }

  it('presigned PUT: original and thumbnail each carry their own envelope and the version', async () => {
    const id = await uploadReadyPhoto();
    const row = await readRow(id);

    expect(await headObjectMetadata(row.originalKey)).toMatchObject({
      [META_WRAPPED_DEK]: row.wrappedDek,
      [META_WRAPPED_DEK_VERSION]: String(row.wrappedDekVersion),
    });
    expect(await headObjectMetadata(row.thumbKey!)).toMatchObject({
      [META_WRAPPED_DEK]: row.wrappedThumbDek,
      [META_WRAPPED_DEK_VERSION]: String(row.wrappedDekVersion),
    });
  });

  // The other blob is PUT validly, so `complete` returning 409 can only
  // mean storage refused the tampered PUT.
  const tampers = [
    ['omits the metadata', withoutMetadata],
    ['alters the wrapped envelope', withAltered(META_WRAPPED_DEK, 'Zm9yZ2Vk')],
    ['alters the envelope version', withAltered(META_WRAPPED_DEK_VERSION, '2')],
  ] as const;
  const blobs = ['originalUpload', 'thumbnailUpload'] as const;
  it.each(
    blobs.flatMap((blob) => tampers.map(([label, tamper]) => [blob, label, tamper] as const)),
  )(
    '%s: a presigned PUT that %s is rejected; the row stays pending',
    async (blob, _label, tamper) => {
      const { body, original, thumb } = await initPhoto();
      const bytes = { originalUpload: original, thumbnailUpload: thumb };
      for (const which of blobs) {
        const descriptor = which === blob ? tamper(body[which]) : body[which];
        const put = await presignedPut(descriptor, bytes[which]);
        const responseBody = await put.text();
        // Signature-layer refusal. The status is provider-specific (MinIO:
        // 400 for a missing signed header, 403 for a mismatched value);
        // the error code is not.
        if (which === blob)
          expect(responseBody, which).toMatch(/<Code>(AccessDenied|SignatureDoesNotMatch)<\/Code>/);
        else expect(put.status, which).toBe(200);
      }

      const complete = await authPost(
        ownerToken,
        `/api/projects/${projectId}/attachments/${body.attachment.id}/complete`,
      );
      expect(complete.statusCode).toBe(409);
      expect((await readRow(body.attachment.id)).status).toBe('pending');
    },
  );

  it('Papierkorb restore keeps the metadata on the new current version', async () => {
    const id = await uploadReadyPhoto();
    const before = await readRow(id);

    const hide = await authDelete(ownerToken, `/api/projects/${projectId}/attachments/${id}`);
    expect(hide.statusCode).toBe(204);
    const restore = await authPost(
      ownerToken,
      `/api/projects/${projectId}/attachments/${id}/restore`,
    );
    expect(restore.statusCode).toBe(200);

    const after = await readRow(id);
    expect(after.versionId).not.toBe(before.versionId);
    expect(await headObjectMetadata(after.originalKey, after.versionId!)).toMatchObject({
      [META_WRAPPED_DEK]: before.wrappedDek,
      [META_WRAPPED_DEK_VERSION]: String(before.wrappedDekVersion),
    });
    expect(await headObjectMetadata(after.thumbKey!, after.thumbVersionId!)).toMatchObject({
      [META_WRAPPED_DEK]: before.wrappedThumbDek,
    });
  });

  it('invoice issuance and cancellation: each PDF carries its envelope, version and number', async () => {
    const pr = await authGet(ownerToken, '/api/projects?status=rechnung_faellig&limit=200');
    const project = (pr.json() as { data: { id: string }[] }).data[0];
    if (!project) throw new Error('seed missing a project in rechnung_faellig');
    const draft = await authPost(ownerToken, '/api/invoices', {
      projectId: project.id,
      lines: [
        {
          description: 'Anstrich Fassade',
          quantity: 1,
          unit: 'pauschal',
          unitPrice: 1500,
          lineTotal: 1500,
          taxRate: 19,
        },
      ],
      performanceDate: `${year}-04-10`,
    });
    expect(draft.statusCode).toBe(201);
    const issued = await authPost(ownerToken, `/api/invoices/${draft.json().id}/issue`);
    expect(issued.statusCode).toBe(200);
    const invoice = issued.json() as {
      id: string;
      number: string;
      renderedPdfBinaryDescriptorId: string;
    };

    const cancelled = await authPost(ownerToken, `/api/invoices/${invoice.id}/cancel`, {
      reason: 'Tippfehler in der Beschreibung',
    });
    expect(cancelled.statusCode).toBe(200);
    const storno = cancelled.json().storno as {
      number: string;
      renderedPdfBinaryDescriptorId: string;
    };
    expect(storno.number).not.toBe(invoice.number);

    for (const { number, renderedPdfBinaryDescriptorId } of [invoice, storno]) {
      const row = await readRow(renderedPdfBinaryDescriptorId);
      expect(await headObjectMetadata(row.originalKey)).toMatchObject({
        [META_WRAPPED_DEK]: row.wrappedDek,
        [META_WRAPPED_DEK_VERSION]: String(row.wrappedDekVersion),
        [META_INVOICE_NUMBER]: number,
      });
    }
  });
});
