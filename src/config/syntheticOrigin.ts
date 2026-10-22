/**
 * Path prefix of the synthetic origin the attachment Service Worker
 * intercepts (ADR-0024). Shared by the SW, the SPA's
 * URL builder and the server, which must never answer it with the app
 * shell. Not a tunable.
 */
export const SYNTHETIC_ORIGIN_PREFIX = '/encrypted-storage/';
