/**
 * Application factory.
 *
 * Builds a Fastify instance with database connection, auth middleware,
 * and all route plugins registered.
 */

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Database } from './db/connection.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { customerRoutes } from './routes/customers.js';
import { userRoutes } from './routes/users.js';
import { workerRoutes } from './routes/workers.js';
import { dataExchangeRoutes } from './routes/data-exchange.js';
import { exportJobRoutes } from './routes/export-jobs.js';
import { importJobRoutes } from './routes/import-jobs.js';
import { extractRoutes } from './routes/extract.js';
import { auditRoutes } from './routes/audit.js';
import { notificationRuleRoutes } from './routes/notification-rules.js';
import { pushSubscriptionRoutes } from './routes/push-subscriptions.js';
import { pushPublicRoutes } from './routes/push.js';
import { attachmentRoutes } from './routes/attachments.js';
import { storageUsageRoutes } from './routes/storage-usage.js';
import { eventsRoutes } from './routes/events.js';
import { invoiceRoutes } from './routes/invoices.js';
import { companyProfileRoutes } from './routes/company-profile.js';
import { configureSseBus } from './sse/bus.js';
import { emitAuditChanged } from './sse/emitters.js';
import { onAuditCommitted } from './services/audit-publisher.js';
import { registerNotificationPublisher } from './services/notification-publisher.js';
import { noopPushDispatcher, type PushDispatcher } from './services/PushDispatcher.js';
import { WebPushDispatcher } from './services/WebPushDispatcher.js';
import { getEnv } from './config/env.js';
import { resolveVapidKeyMaterial, type VapidKeyMaterial } from './config/vapid.js';
import { installErrorHandler } from './error-handler.js';

export interface AppOptions {
  logger?: boolean;
  db?: Database;
  /** Set false to disable rate limiting (useful in tests). Defaults to true. */
  rateLimit?: boolean;
}

/**
 * Map resolved VAPID material to a dispatcher. `null` (missing config
 * in production / test) → `noopPushDispatcher`. Logging lives in
 * `resolveVapidKeyMaterial`; this is a thin mapper.
 */
function pickPushDispatcher(material: VapidKeyMaterial | null): PushDispatcher {
  return material ? new WebPushDispatcher(material) : noopPushDispatcher;
}

/**
 * Return the scheme+host+port of `endpoint`, or `null` if it isn't a
 * parseable URL. Used by the CSP assembly to whitelist the object-storage
 * origin for presigned PUT / GET traffic without hard-coding the
 * hostname.
 */
function extractOrigin(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  // Redact paths that would otherwise leak credentials into structured
  // logs: `Authorization: Bearer <importToken>` on the binary leg of an
  // import, the `session` cookie on every authenticated route, and the
  // `confirmation_phrase` body field on `/api/import?override=true`.
  // Fastify's default request serializer does not log headers today, so
  // this is defense-in-depth — a future `req.log.info(request.headers, …)`
  // would otherwise serialize the bearer verbatim.
  const REDACT_PATHS = [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.confirmation_phrase',
  ];
  const logger = opts.logger === true ? { redact: REDACT_PATHS } : (opts.logger ?? false);
  const app = Fastify({
    logger,
    // Trust exactly one proxy hop — Caddy in production (terminating
    // TLS and forwarding to the app container), nothing in dev. With
    // trustProxy: true, Fastify would accept any X-Forwarded-For header
    // from any upstream, which would let a client spoof the rate-limit
    // key or the log-visible IP by setting X-Forwarded-For directly.
    // One hop is the tightest value that still gives the real client
    // IP through the Caddy → app chain. See consolidation review G F-4.
    trustProxy: 1,
  });

  // Global error handler — preserves 4xx HTTP statusCode and only
  // collapses 5xx-or-statusless errors to SERVER_ERROR. See
  // src/server/error-handler.ts and AC-247 / api.md §14.4.2.
  //
  // The not-found handler is mounted by the caller (start.ts for the
  // SPA fallback, the unit test directly), because Fastify rejects a
  // second setNotFoundHandler on the same prefix and start.ts needs
  // the SPA-vs-/api branch.
  installErrorHandler(app);

  // Cookie parsing — registered before all other plugins so
  // request.cookies is available in every route and hook.
  app.register(cookie);

  // Security headers — CSP allows only same-origin resources,
  // HSTS enforces HTTPS (when TLS is active), X-Frame-Options blocks framing.
  // Reads from validated env (see env.ts) — not process.env — so ADR-0013
  // and the assertProductionSafe() guard in start.ts share a single source
  // of truth for ALLOW_INSECURE_HTTP. See consolidation review C-3.
  const env = getEnv();
  const insecureHttp = env.ALLOW_INSECURE_HTTP === 'true';
  // The browser talks to object storage on a DIFFERENT origin — presigned
  // POST for uploads (`connect-src`) and presigned GET for thumbnails /
  // lightbox originals (`img-src`). Derive the storage origin from the
  // same env the client-side URL signer uses (STORAGE_PUBLIC_ENDPOINT in
  // production, STORAGE_ENDPOINT in dev), so the CSP auto-tracks
  // deployment topology. An unparseable / missing value collapses to
  // an empty list — CSP stays as strict as before.
  const storageOrigin = extractOrigin(env.STORAGE_PUBLIC_ENDPOINT ?? env.STORAGE_ENDPOINT);
  const storageSources = storageOrigin ? [storageOrigin] : [];
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // The PWA service worker is registered from a same-origin URL
        // (`/sw.js`); no inline blob: workers are spawned. Kept tight
        // at `'self'` — if a future feature needs `blob:` workers,
        // re-add it deliberately rather than carrying it forward.
        workerSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // `data:` is required by `@uploadcare/image-shrink`'s EXIF
        // orientation probe — it loads a tiny base64 JPEG into a hidden
        // `<img>` to detect whether the browser auto-rotates JPEGs from
        // EXIF Orientation. Without `data:`, the probe's load event
        // never fires, the library's internal Promise hangs, and photo
        // uploads stall (or get misclassified as non-JPEG, defeating
        // the EXIF-byte-splice guarantee that motivated the swap from
        // browser-image-compression). Eruda's toolbar / panel icons
        // are also data: PNG/SVG sprites, so this also unblocks the
        // mobile debug console.
        //
        // `blob:` is required by the same library's main path: after
        // the EXIF probe, `shrinkFile()` calls
        // `imageLoader(URL.createObjectURL(blob))` to decode the source
        // bytes into an `<img>` before drawing into the offscreen
        // canvas. Our own thumbnail encoder
        // (`src/domain/imagePipeline.ts`) does the same. Without
        // `blob:`, the browser blocks the resource, the `<img>` fires
        // `onerror` with "Failed to load image", and uploads fail at
        // the compression step — surfaced as "Bildbearbeitung
        // fehlgeschlagen" in the UI.
        //
        // Both schemes are helmet's own default for `img-src` and
        // widely accepted as low-risk: SVG loaded via `<img>` cannot
        // execute scripts, `data:` cannot initiate network requests,
        // and `blob:` URLs reference only bytes the same origin's JS
        // already created with `URL.createObjectURL`, so neither
        // scheme opens a cross-origin exfil channel.
        imgSrc: ["'self'", 'data:', 'blob:', ...storageSources],
        connectSrc: ["'self'", ...storageSources],
        fontSrc: ["'self'"],
        // PDF preview loads a same-origin `blob:` URL in an <iframe>.
        // Without `frame-src` set, the directive falls back to
        // `default-src 'self'`, which does NOT include the blob: scheme
        // — so the iframe is blocked and the user sees a blank modal.
        // Limit to 'self' + blob: so only our own origin and blobs we
        // authored can be framed.
        frameSrc: ["'self'", 'blob:'],
        // Chrome's built-in PDF viewer renders the PDF via an internal
        // <embed> element. With `object-src 'none'` the embed is blocked
        // and Chrome shows "This content is blocked. Contact the site
        // owner to fix the issue." — the exact error we hit on the PDF
        // preview path. `'self'` + blob: keeps third-party embeds out
        // while letting our own PDF blobs render.
        objectSrc: ["'self'", 'blob:'],
        frameAncestors: ["'none'"],
        // Helmet defaults to adding upgrade-insecure-requests, which tells
        // browsers to rewrite every HTTP subresource URL to HTTPS. Over
        // plain HTTP this silently breaks all asset loads (JS, CSS, images).
        ...(insecureHttp ? { upgradeInsecureRequests: null } : {}),
      },
    },
    // Disable HSTS in HTTP-only evaluation mode — the header is meaningless
    // over plain HTTP and creates browser state conflicts when the same
    // browser later visits the HTTPS version (or vice versa).
    hsts: insecureHttp
      ? false
      : {
          // 180 days — helmet's default. The previous value (2 years with
          // `preload: true`) was chosen with the browser HSTS preload list in
          // mind, but preload is a one-way commitment: removal from the list
          // takes months and requires a manual application. The project is
          // not yet ready for that commitment (LLM-generated code, not yet
          // independently audited — see ADR-0008). 180 days is long enough
          // that returning visitors always see HTTPS, short enough that a
          // future rollback is tractable. See #56 for the decision.
          maxAge: 15552000,
          includeSubDomains: true,
          preload: false,
        },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // CORS — same-origin SPA served by Fastify, reject all cross-origin
  // requests. origin:false means no Access-Control-Allow-Origin header
  // is sent, so browsers block cross-origin fetches.
  app.register(cors, {
    origin: false,
  });

  // Rate limiting — registered globally so individual routes can apply
  // overrides via route-level config. Disabled in tests to avoid flaky
  // failures from rapid sequential requests.
  if (opts.rateLimit !== false) {
    app.register(rateLimit, {
      global: false, // Only routes with explicit config are limited
    });
  }

  if (opts.db) {
    // Resolve VAPID material once at boot: derives the public key from
    // the private half, handles the dev auto-bootstrap, and decides
    // no-op vs real-transport. Both the dispatcher and the public-key
    // endpoint consume this single result.
    const vapid = resolveVapidKeyMaterial({
      env: getEnv(),
      logger: {
        info: (msg) => app.log.info(msg),
        warn: (msg) => app.log.warn(msg),
      },
    });

    app.register(authRoutes(opts.db));
    app.register(projectRoutes(opts.db));
    app.register(customerRoutes(opts.db));
    app.register(userRoutes(opts.db));
    app.register(workerRoutes(opts.db));
    app.register(dataExchangeRoutes(opts.db));
    app.register(exportJobRoutes(opts.db));
    app.register(importJobRoutes(opts.db));
    app.register(extractRoutes(opts.db));
    app.register(auditRoutes(opts.db));
    app.register(notificationRuleRoutes(opts.db));
    app.register(pushSubscriptionRoutes(opts.db));
    app.register(attachmentRoutes(opts.db));
    app.register(storageUsageRoutes(opts.db));
    app.register(invoiceRoutes(opts.db));
    app.register(companyProfileRoutes(opts.db));
    // Wire the SSE bus singleton with the Fastify logger BEFORE registering
    // the route — otherwise the bus runs without a logger and the spec-
    // required structured-output on subscriber-write failures
    // (architecture.md §11.13) is silently dead. Same composition shape
    // as registerNotificationPublisher below.
    configureSseBus({
      logger: {
        error: (ctx, msg) => app.log.error(ctx, msg),
      },
    });
    app.register(eventsRoutes(opts.db));
    // The VAPID public-key endpoint is unauthenticated (the public key
    // is public by design). Keeping it in its own plugin isolates it
    // from the authenticated push-subscriptions plugin's preHandler
    // hook — see routes/push.ts header for the encapsulation note.
    app.register(pushPublicRoutes(vapid?.publicKey ?? null));

    // Wire the notification publisher to the audit bus. Composition
    // happens AFTER the audit-publisher logger is set in start.ts, so
    // a throwing subscriber surfaces through that logger rather than
    // being swallowed (AC-183).
    registerNotificationPublisher({ db: opts.db, dispatcher: pickPushDispatcher(vapid) });

    // Fan every committed audit row to the SSE bus as `audit_changed`
    // so the per-project ActivityFeed (and any future audit consumer)
    // refreshes on every mutation — not just the ones that bump the
    // parent project's `updatedAt`. The notification publisher is the
    // first subscriber and remains independent; the audit publisher
    // uses a Set for fan-out, so adding this second subscriber cannot
    // interfere with that path (architecture.md §11.13, ADR-0021).
    onAuditCommitted(() => {
      emitAuditChanged();
    });
  }

  return app;
}
