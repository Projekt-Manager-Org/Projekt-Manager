/**
 * Shared helpers for tests that drive the real presigned-PUT flow against
 * MinIO with exactly the URL + headers the server returns from `init`.
 */

import crypto from 'node:crypto';

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
}

/** RFC 1864 base64-of-MD5 — the form the signed `Content-MD5` expects. */
export function md5Base64(body: Buffer): string {
  return crypto.createHash('md5').update(body).digest('base64');
}

/**
 * A fresh 32-byte DEK, base64 — what the browser produces via
 * `crypto.getRandomValues(new Uint8Array(32))` before init.
 */
export function freshDekMaterial(): string {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * PUT `body` to the descriptor's URL with the descriptor's headers. Node's
 * fetch sets `Content-Length` from the body, so that header is dropped to
 * avoid a duplicate. Node's undici fetch accepts a Buffer at runtime; the
 * cast only satisfies the DOM `BodyInit` type.
 */
export async function presignedPut(descriptor: PresignedUpload, body: Buffer): Promise<Response> {
  const headers = { ...descriptor.headers };
  delete headers['Content-Length'];
  return fetch(descriptor.url, { method: 'PUT', headers, body: body as unknown as BodyInit });
}
