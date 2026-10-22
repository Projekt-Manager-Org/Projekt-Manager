/**
 * Service Worker decrypt handler — pinned by AC-416 and AC-418 in
 * docs/spec/verification.md §15.26; the synthetic-origin seam is
 * ADR-0024's.
 *
 * The Service Worker installed by the SPA intercepts every request to
 * `/encrypted-storage/<projectId>/<attachmentId>.<variant>`
 * (`variant ∈ {original, thumbnail}`), then:
 *
 *   1. calls `GET /api/projects/:id/attachments/:attId/download-url?variant=<variant>`
 *      to obtain `{ url, expiresAt, dekMaterial }`;
 *   2. fetches `url` to obtain the ciphertext bytes from object storage;
 *   3. AES-256-GCM-decrypts with `dekMaterial` (per-blob nonce is the
 *      ciphertext's leading 12 bytes per ADR-0024 §Encryption);
 *   4. returns the plaintext bytes via the Fetch response.
 *
 * Pure-handler scope: vitest + jsdom does not host a real Service Worker
 * lifecycle, so the test exercises the handler function in isolation —
 * `handleEncryptedStorageRequest(request)` consumes a `Request` and
 * resolves to a `Response`. Mocks: the global `fetch` (for both the
 * download-url JSON call and the ciphertext-bytes call). The test
 * asserts the wire shape (URL, response shape) and the cryptographic
 * contract (decryption produces the original plaintext).
 *
 * NOTE — failing-test step (CONTRIBUTING.md § Workflow step 3): the
 * import `@/sw/decryptHandler` does not exist yet. This file pins the
 * AC-416 contract; the implementer iteration adds the module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The handler under test — implementation does not exist yet (step 3
// of the workflow). The first failure surfaces as an unresolved import.
const { handleEncryptedStorageRequest } = await import('@/sw/decryptHandler');

// ---------------------------------------------------------------------------
// Test crypto helpers — local to this file, NOT the production
// `clientEncryption` module. The point is to encrypt synthetic
// plaintexts with the same AES-GCM convention the SW must decrypt
// (12-byte nonce prefixed; 16-byte auth tag appended by WebCrypto).
// Co-locating the helpers makes the test's contract self-evident:
// ciphertext format = nonce(12) || ct || tag(16). If the SW deviates,
// these tests fail.
// ---------------------------------------------------------------------------

const NONCE_BYTES = 12;
const DEK_BYTES = 32;

async function importDek(rawDek: Uint8Array): Promise<CryptoKey> {
  // Copy into a fresh ArrayBuffer-backed view so the SubtleCrypto type
  // signatures (which refuse SharedArrayBuffer-backed views since TS
  // 5.x) accept it. The runtime semantics are identical.
  const buf = new Uint8Array(rawDek.byteLength);
  buf.set(rawDek);
  return crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptForTest(plaintext: Uint8Array, rawDek: Uint8Array): Promise<Uint8Array> {
  const key = await importDek(rawDek);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  // Ensure ArrayBuffer-backed buffers — see importDek note.
  const nonceBuf = new Uint8Array(nonce.byteLength);
  nonceBuf.set(nonce);
  const ptBuf = new Uint8Array(plaintext.byteLength);
  ptBuf.set(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBuf }, key, ptBuf),
  );
  const out = new Uint8Array(NONCE_BYTES + ct.byteLength);
  out.set(nonceBuf, 0);
  out.set(ct, NONCE_BYTES);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// ---------------------------------------------------------------------------
// Fetch mock — installed on the global so the SW handler reads through
// it. The handler issues two outbound requests per intercept (the
// download-url JSON GET, then the ciphertext GET); the mock returns
// per-URL configurable responses.
// ---------------------------------------------------------------------------

interface FetchPlan {
  downloadUrl?: () => Response | Promise<Response>;
  ciphertext?: () => Response | Promise<Response>;
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function installFetchPlan(plan: FetchPlan): void {
  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
    if (url.includes('/api/projects/') && url.includes('/download-url')) {
      if (!plan.downloadUrl) throw new Error(`unexpected download-url fetch: ${url}`);
      return plan.downloadUrl();
    }
    if (url.startsWith('https://storage.example/')) {
      if (!plan.ciphertext) throw new Error(`unexpected ciphertext fetch: ${url}`);
      return plan.ciphertext();
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Vitest's jsdom env keeps Node's `Request` global (undici), which
// requires an absolute URL — `window.location.href` is not consulted
// for relative-URL parsing the way a real Service Worker context
// would. Anchoring against the jsdom default origin keeps the test
// exercising the path-parsing contract the SW handler enforces.
const SYNTHETIC_ORIGIN = 'http://localhost';

function syntheticRequest(projectId: string, attachmentId: string, variant: string): Request {
  return new Request(
    `${SYNTHETIC_ORIGIN}/encrypted-storage/${projectId}/${attachmentId}.${variant}`,
  );
}

// jsdom's `TextEncoder` returns a `Uint8Array` from the JSDOM realm;
// `Response#arrayBuffer()` (Node's undici) returns one from the Node
// realm. Vitest's `toEqual` distinguishes typed-array realms, so an
// otherwise byte-identical pair fails deep equality. Re-wrap through
// the test-realm constructor before encoding so plaintext and the
// SW handler's response output share a prototype.
function utf8(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  const realm = new Uint8Array(encoded.byteLength);
  realm.set(encoded);
  return realm;
}

// ---------------------------------------------------------------------------
// AC-416 — happy path + variants
// ---------------------------------------------------------------------------

describe('AC-416: synthetic-origin intercept + decrypt', () => {
  it('decrypts the original-variant ciphertext and returns the plaintext via the Fetch response', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = utf8('Hello, encrypted world.');
    const ciphertext = await encryptForTest(plaintext, dek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/cipher-original',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.status).toBe(200);
    const out = new Uint8Array(await response.arrayBuffer());
    expect(out).toEqual(plaintext);
  });

  it('decrypts the thumbnail-variant ciphertext (different DEK from the original)', async () => {
    const thumbDek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = utf8('thumb-bytes');
    const ciphertext = await encryptForTest(plaintext, thumbDek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/cipher-thumb',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(thumbDek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'thumbnail'),
    );

    expect(response.status).toBe(200);
    const out = new Uint8Array(await response.arrayBuffer());
    expect(out).toEqual(plaintext);
  });

  it("propagates the descriptor's mimeType as the response Content-Type (PDF preview inline)", async () => {
    // Why this matters: `<iframe src='/encrypted-storage/...'>` only
    // renders a PDF inline when the response carries
    // `Content-Type: application/pdf`. The earlier SW served everything
    // as `application/octet-stream`, which the browser collapses to a
    // download — the "Ansehen" affordance produced a `<uuid>.original`
    // file in the downloads folder and a blank iframe.
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = utf8('%PDF-1.7 ...');
    const ciphertext = await encryptForTest(plaintext, dek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/cipher-original',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
          mimeType: 'application/pdf',
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
  });

  it('falls back to application/octet-stream when the descriptor omits mimeType (older server)', async () => {
    // Forward-compat: a worker that ships ahead of the server keeps
    // serving downloads (prior behavior) rather than crashing on a
    // missing field.
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = utf8('x');
    const ciphertext = await encryptForTest(plaintext, dek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('calls the download-url endpoint with the project id, attachment id, and variant in the query', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = new TextEncoder().encode('x');
    const ciphertext = await encryptForTest(plaintext, dek);

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(ciphertext.slice() as BlobPart),
    });

    await handleEncryptedStorageRequest(syntheticRequest('p-42', 'att-7', 'thumbnail'));

    // First outbound call must be the download-url endpoint with the
    // path-derived project id, attachment id, and variant. Asserting on
    // the URL pins the contract — the SW route table treats both
    // variants identically aside from the `?variant=...` query.
    const firstCallUrl = fetchMock.mock.calls[0][0] as string;
    expect(firstCallUrl).toContain('/api/projects/p-42/attachments/att-7/download-url');
    expect(firstCallUrl).toContain('variant=thumbnail');
  });

  it('returns a non-2xx Response when download-url returns 422 DEK_UNWRAP_FAILED so the consumer can render the key-unavailable placeholder', async () => {
    // A wrapped-envelope unwrap failure surfaces as `422 VALIDATION_ERROR` with `code = DEK_UNWRAP_FAILED`.
    // The SW must translate this into a Response that fails the
    // browser's image / fetch consumer (so `<img onError>` fires and
    // BinaryList's download promise rejects), letting the UI flip to
    // the "Schlüssel nicht verfügbar" placeholder.
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({ code: 'DEK_UNWRAP_FAILED', message: 'envelope unwrap failed' }, 422),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'thumbnail'),
    );

    expect(response.ok).toBe(false);
    // Error code surfaces in the body so a consumer that wants to
    // distinguish key-unavailable from bytes-missing
    // can do so without a second request.
    const body = await response.json();
    expect(body.code).toBe('DEK_UNWRAP_FAILED');
    // The signal contract also puts the code on the response header so the SW
    // wrapper / DOM-mirror layer can read it without re-parsing the
    // body.
    expect(response.headers.get('data-sw-error-code')).toBe('DEK_UNWRAP_FAILED');
  });

  it('returns a non-2xx Response when the storage GET on the ciphertext fails (object-absent path)', async () => {
    // The operator remediation differs between an envelope unwrap
    // failure and a storage 404 / NoSuchKey. The SW returns a Response that drives the consumer
    // toward the right placeholder; the body code disambiguates.
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response('NoSuchKey', { status: 404 }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
    expect(response.headers.get('data-sw-error-code')).toBe('OBJECT_ABSENT');
  });

  it('returns a non-2xx Response when the AES-GCM auth tag verification fails (tampered ciphertext, AC-418)', async () => {
    // Cryptographic-integrity failure on the read path: the underlying
    // bytes returned a 200 from storage but they no longer match the
    // committed bytes. Per AC-418 and ADR-0024's two integrity layers,
    // the AES-GCM tag is the catch — the
    // SW must surface this as a fetch failure, not silently serve
    // garbled bytes (browser would then render a broken image / corrupt
    // PDF and confuse the user about which layer failed).
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const plaintext = new TextEncoder().encode('original-bytes');
    const ciphertext = await encryptForTest(plaintext, dek);
    // Tamper with a byte inside the ciphertext region (not the nonce
    // prefix and not the tag) — AES-GCM detects any mutation.
    const tampered = ciphertext.slice();
    tampered[NONCE_BYTES + 1] ^= 0xff;

    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response(tampered.slice() as BlobPart),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signal-contract negative space — only sanctioned codes emit `data-sw-error-code`
// ---------------------------------------------------------------------------
// The SW MUST NOT invent additional codes. `OBJECT_ABSENT` is the storage-404 path; `DEK_UNWRAP_FAILED`
// is the explicit `422 + body.code === 'DEK_UNWRAP_FAILED'` path. Every
// other failure surface (transport drops, non-422 metadata errors,
// non-404 storage errors, malformed bodies) returns a Response with NO
// `data-sw-error-code` attribute set — the consumer's `<img onError>`
// reads the absence of the attribute as "generic error" and renders the
// generic error path (AC-437) rather than mis-routing to "Datei fehlt" or
// "Schlüssel nicht verfügbar".
// ---------------------------------------------------------------------------

describe('signal contract: data-sw-error-code only on sanctioned paths', () => {
  // ----- Metadata-call failure paths (Defect 3) ----------------------------

  it('omits data-sw-error-code when the metadata fetch fails in transit (network drop)', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code on a non-422 metadata error (e.g. 500)', async () => {
    installFetchPlan({
      downloadUrl: () => new Response('boom', { status: 500 }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code on a 422 metadata error whose body code is NOT DEK_UNWRAP_FAILED', async () => {
    // 422 with a different VALIDATION_ERROR code (e.g. unknown variant
    // on download-url). The contract sanctions DEK_UNWRAP_FAILED only for
    // the envelope-unwrap arm; other 422 codes route to generic.
    installFetchPlan({
      downloadUrl: () => jsonResponse({ code: 'UNKNOWN_VARIANT' }, 422),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code on a 422 metadata error whose body fails to parse as JSON', async () => {
    installFetchPlan({
      downloadUrl: () =>
        new Response('not json', {
          status: 422,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code when the metadata 200 body is missing url or dekMaterial', async () => {
    installFetchPlan({
      downloadUrl: () => jsonResponse({ expiresAt: '2026-04-30T12:00:00Z' }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code when dekMaterial is malformed base64 (not 32 bytes after decode)', async () => {
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(new Uint8Array(8)), // wrong length
        }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  // ----- Ciphertext-fetch failure paths (Defect 2) -------------------------

  it('omits data-sw-error-code when the ciphertext fetch fails in transit (network drop)', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => {
        throw new TypeError('storage offline');
      },
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code when the presigned URL has expired (403 from storage)', async () => {
    // An expired presigned URL is a transient failure — the user can
    // retry to get a fresh URL. Mis-routing this to OBJECT_ABSENT
    // would render "Datei fehlt" and confuse the operator about
    // storage state; spec restricts that code to 404 / NoSuchKey.
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response('AccessDenied', { status: 403 }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });

  it('omits data-sw-error-code on a 5xx storage error', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    installFetchPlan({
      downloadUrl: () =>
        jsonResponse({
          url: 'https://storage.example/c',
          expiresAt: '2026-04-30T12:00:00Z',
          dekMaterial: toBase64(dek),
        }),
      ciphertext: () => new Response('InternalError', { status: 500 }),
    });

    const response = await handleEncryptedStorageRequest(
      syntheticRequest('p-42', 'att-1', 'original'),
    );

    expect(response.ok).toBe(false);
    expect(response.headers.get('data-sw-error-code')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Signal-contract DOM-mirror seam — BroadcastChannel pub/sub (Defect 1)
// ---------------------------------------------------------------------------
// The SW writes `data-sw-error-code`
// on BOTH the failing Response (header) AND the requesting `<img>` /
// `<iframe>` element (DOM attribute). A Service Worker cannot touch the
// DOM directly, so the handler posts the code over a BroadcastChannel
// for a window-side listener to mirror onto the matching element. The
// channel name is the stable contract; the listener lives in
// `src/sw/installAttachmentErrorListener.ts`.
// ---------------------------------------------------------------------------

describe('signal contract DOM-mirror: handler posts to BroadcastChannel on sanctioned-code paths', () => {
  // Same-realm BroadcastChannel delivery is microtask-scheduled; a bare
  // `setTimeout(0)` flush is racy because we have no guarantee the
  // scheduled message is dispatched on that exact tick. For positive
  // assertions (a message MUST arrive) we await it deterministically.
  // For the negative case (no message) we still need a fixed window —
  // see that test for the rationale.
  async function awaitMessage<T>(
    channel: BroadcastChannel,
    predicate: (msg: T) => boolean,
    timeoutMs = 200,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`awaitMessage timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      channel.addEventListener('message', (event) => {
        const data = event.data as T;
        if (predicate(data)) {
          clearTimeout(timer);
          resolve(data);
        }
      });
    });
  }

  it('posts { requestUrl, code: OBJECT_ABSENT } when storage returns 404', async () => {
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const listener = new BroadcastChannel('sw-attachment-errors');
    // Node's BroadcastChannel takes one event-loop turn to fully join
    // the named channel after construction; without this flush, a
    // post-on-construction race intermittently drops the very first
    // message when the SW handler's freshly-created publisher posts.
    // Same shape as `installAttachmentErrorListener.test.ts` beforeEach.
    await new Promise((r) => setTimeout(r, 0));

    try {
      installFetchPlan({
        downloadUrl: () =>
          jsonResponse({
            url: 'https://storage.example/c',
            expiresAt: '2026-04-30T12:00:00Z',
            dekMaterial: toBase64(dek),
          }),
        ciphertext: () => new Response('NoSuchKey', { status: 404 }),
      });

      const requestUrl = `${SYNTHETIC_ORIGIN}/encrypted-storage/p-42/att-1.original`;
      const expected = awaitMessage<{ requestUrl: string; code: string }>(
        listener,
        (m) => m.code === 'OBJECT_ABSENT',
      );
      await handleEncryptedStorageRequest(new Request(requestUrl));

      const msg = await expected;
      expect(msg).toEqual({ requestUrl, code: 'OBJECT_ABSENT' });
    } finally {
      listener.close();
    }
  });

  it('posts { requestUrl, code: DEK_UNWRAP_FAILED } when download-url returns 422 + DEK_UNWRAP_FAILED', async () => {
    const listener = new BroadcastChannel('sw-attachment-errors');
    await new Promise((r) => setTimeout(r, 0));

    try {
      installFetchPlan({
        downloadUrl: () =>
          jsonResponse({ code: 'DEK_UNWRAP_FAILED', message: 'envelope unwrap failed' }, 422),
      });

      const requestUrl = `${SYNTHETIC_ORIGIN}/encrypted-storage/p-42/att-1.thumbnail`;
      const expected = awaitMessage<{ requestUrl: string; code: string }>(
        listener,
        (m) => m.code === 'DEK_UNWRAP_FAILED',
      );
      await handleEncryptedStorageRequest(new Request(requestUrl));

      const msg = await expected;
      expect(msg).toEqual({ requestUrl, code: 'DEK_UNWRAP_FAILED' });
    } finally {
      listener.close();
    }
  });

  it('does NOT post on generic-error paths (no sanctioned code)', async () => {
    // Network drop on storage fetch — the handler returns a generic
    // Response. The BroadcastChannel must stay silent so the SPA-side
    // listener does not write a poisoned attribute onto the element.
    //
    // Absence-proof needs a fixed window: there is no event to await,
    // so we wait long enough that any microtask-scheduled delivery has
    // had time to land. 50ms >> the same-realm dispatch path; smaller
    // than a perceptible test slowdown.
    const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
    const channelMessages: Array<{ requestUrl: string; code: string }> = [];
    const listener = new BroadcastChannel('sw-attachment-errors');
    listener.onmessage = (event) => {
      channelMessages.push(event.data as { requestUrl: string; code: string });
    };
    // Channel-join warm-up so a stray (bug-introduced) post wouldn't
    // be silently dropped by the join race and falsely pass the
    // assertion. Mirrors the positive cases above.
    await new Promise((r) => setTimeout(r, 0));

    try {
      installFetchPlan({
        downloadUrl: () =>
          jsonResponse({
            url: 'https://storage.example/c',
            expiresAt: '2026-04-30T12:00:00Z',
            dekMaterial: toBase64(dek),
          }),
        ciphertext: () => {
          throw new TypeError('storage offline');
        },
      });

      const requestUrl = `${SYNTHETIC_ORIGIN}/encrypted-storage/p-42/att-1.original`;
      await handleEncryptedStorageRequest(new Request(requestUrl));

      await new Promise((r) => setTimeout(r, 50));

      expect(channelMessages).toEqual([]);
    } finally {
      listener.close();
    }
  });
});
