/**
 * Centralized API client.
 *
 * All HTTP communication with the backend goes through this module.
 * Handles: request construction, response parsing, session expiry detection,
 * and error normalization.
 *
 * The store layer calls these functions instead of raw fetch().
 */

import { STRINGS } from '@/config/strings';
import type { ThemePreference } from '@/config/themeStorage';

export interface ApiError {
  code: string;
  message: string;
}

/**
 * Error categories from `docs/spec/api.md §14.4.1`. The client classifies
 * every failure into one of these so the state/UI layers can branch on
 * category rather than on individual error codes. Without this, only
 * SESSION_EXPIRED was handled specially and every other code collapsed
 * into the same generic path.
 */
export type ErrorCategory =
  | 'authentication' // INVALID_CREDENTIALS, UNAUTHENTICATED, SESSION_EXPIRED
  | 'authorization' // NOT_PERMITTED
  | 'validation' // VALIDATION_ERROR
  | 'not_found' // NOT_FOUND
  | 'rate_limited' // RATE_LIMITED
  | 'server_error' // SERVER_ERROR, unknown server codes
  | 'network' // NETWORK_ERROR (client-side, fetch rejection)
  | 'invalid_response'; // INVALID_RESPONSE (client-side, malformed 2xx body)

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiError;
  category: ErrorCategory;
  /**
   * True iff the failure indicates the user must return to the login
   * screen — `SESSION_EXPIRED` (the session existed but aged out) or
   * `UNAUTHENTICATED` (no cookie at all on a protected endpoint). The
   * `INVALID_CREDENTIALS` sub-case of authentication is NOT included
   * because it only reaches the client from the login screen itself,
   * where a redirect would be a no-op.
   */
  sessionExpired: boolean;
  /**
   * Server-supplied machine-readable detail block (api.md §14.4 — every
   * `AppError` may carry an opaque `details` field, e.g. `missingFields`
   * for `VALIDATION_ERROR` / `COMPANY_PROFILE_REQUIRED`). Surfaced raw
   * so consumers can branch on the shape they expect; absent when the
   * server omitted the key.
   */
  details?: unknown;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

function classifyCode(code: string): ErrorCategory {
  switch (code) {
    case 'INVALID_CREDENTIALS':
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      return 'authentication';
    case 'NOT_PERMITTED':
      return 'authorization';
    case 'VALIDATION_ERROR':
      return 'validation';
    case 'NOT_FOUND':
      return 'not_found';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'NETWORK_ERROR':
      return 'network';
    case 'INVALID_RESPONSE':
      return 'invalid_response';
    case 'SERVER_ERROR':
    default:
      // Unknown codes fall into server_error so the UI shows a generic
      // message — never leak an unknown-code string to the user.
      return 'server_error';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /**
   * Optional `AbortSignal`. When fired mid-flight the fetch rejects
   * with an `AbortError`; the rejection is caught below and returned
   * as a `network`-category ApiResult so callers see a consistent
   * shape. Transport-level cancellation; no UI side effects here.
   */
  signal?: AbortSignal;
  /**
   * Optional bearer token. When set, the request carries
   * `Authorization: Bearer <token>` and the server's import-token-aware
   * middleware will accept the call without a session cookie. Used by
   * the takeout-zip restore orchestrator on the override-with-users
   * path, after the operator's session has CASCADEd away with the
   * imported user set (issue #230). The session cookie is still sent
   * (`credentials: 'same-origin'`); the server treats the header as
   * authoritative on routes that opt into the token-aware middleware.
   */
  authToken?: string;
}

/**
 * Make an authenticated API call.
 * - Attaches correct headers and credentials
 * - Detects session expiry (401 + SESSION_EXPIRED code)
 * - Normalizes errors into a consistent shape
 * - Handles network failures gracefully
 */
export async function apiCall<T>(url: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (opts.authToken !== undefined) {
    headers['Authorization'] = `Bearer ${opts.authToken}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message);
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
        message: isNetwork ? STRINGS.errors.networkError : STRINGS.errors.mutationFailed,
      },
      category: 'network',
      sessionExpired: false,
    };
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({ code: 'UNKNOWN', message: '' }));
    const rawCode = (data.code as string | undefined) ?? 'API_ERROR';
    const category = classifyCode(rawCode);

    // Authentication-category with a *pre-existing* session context
    // (SESSION_EXPIRED or UNAUTHENTICATED) means the user must be bounced
    // to the login screen. INVALID_CREDENTIALS is authentication-category
    // but only reaches the client from the login screen itself, so we
    // deliberately do NOT flag it as sessionExpired.
    const sessionExpired = rawCode === 'SESSION_EXPIRED' || rawCode === 'UNAUTHENTICATED';

    // Rate-limited and generic server errors get the canonical German
    // message from strings.ts if the server didn't supply one — the
    // handlers above try to always supply one, but a reverse-proxy
    // intercept (e.g., Caddy returning an HTML 503) might not. Never
    // show the user a raw code or an empty string.
    let fallbackMessage: string = STRINGS.errors.mutationFailed;
    if (category === 'rate_limited') fallbackMessage = STRINGS.errors.rateLimited;
    else if (category === 'server_error') fallbackMessage = STRINGS.errors.serverError;
    else if (sessionExpired) fallbackMessage = STRINGS.auth.sessionExpired;
    else if (category === 'authorization') fallbackMessage = STRINGS.auth.notPermitted;

    return {
      ok: false,
      error: {
        code: rawCode,
        message: (data.message as string | undefined) || fallbackMessage,
      },
      category,
      sessionExpired,
      details: data.details,
    };
  }

  // Success path.
  //
  // We distinguish three cases that previously all collapsed to `data=null`:
  //   1. 204 No Content (or explicit Content-Length: 0) — legitimately empty.
  //      res.json() would throw; short-circuit to `{ ok: true, data: null }`.
  //   2. 2xx with a JSON body that parses — return the parsed value, including
  //      a literal `null` payload (JSON.parse("null") is valid JSON).
  //   3. 2xx with a body that FAILS to parse — this is an error, not success.
  //      Surface it as ok=false with code INVALID_RESPONSE so callers can
  //      distinguish a malformed response from a legitimately null payload.
  if (res.status === 204 || res.headers.get('Content-Length') === '0') {
    return { ok: true, data: null as T };
  }

  try {
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_RESPONSE',
        message: STRINGS.errors.invalidResponse,
      },
      category: 'invalid_response',
      sessionExpired: false,
    };
  }
}

// --- Typed API functions -----------------------------------------------------

import type { Address, Project, Customer, User, Attachment, AttachmentLabel } from '@/domain/types';
import type { WorkflowState } from '@/config/stateConfig';
import type { Envelope, DryRunPreview, ImportResult } from '@/domain/dataExchange';
import type { BackupStatus } from '@/domain/backupBadge';
import type { AuditEntry, AuditListParams, AuditListResponse } from '@/domain/audit';
import type { NotificationRule, NotificationRuleInput } from '@/domain/notifications';
import type {
  CompanyProfile,
  Invoice,
  InvoiceLine,
  InvoiceRecipientSnapshot,
  InvoiceStatus,
  TaxMode,
} from '@/domain/invoice';

interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  themePreference: ThemePreference;
  /**
   * Server-authoritative push-mute flag (data-model.md §5.3). When true,
   * the dispatcher skips every subscription the user owns but the row is
   * retained — unmuting restores delivery without a re-subscribe.
   * Updated via the self-update API (§14.2.1).
   */
  pushMuted: boolean;
}

/**
 * Response envelope for /api/auth/login and /api/auth/me.
 *
 * The server includes `backupStatus` only when the caller holds the
 * `owner` role (api.md §14.2.1, verification.md AC-170). Other roles
 * get an envelope without the key — absence drives the UI's "no badge
 * on this surface" branch without requiring a separate role check.
 */
interface LoginResponse {
  user: AuthUser;
  backupStatus?: BackupStatus;
}

interface ProjectListResponse {
  data: Project[];
  total: number;
}

interface CustomerListResponse {
  customers: Customer[];
  total: number;
}

interface UserListResponse {
  users: User[];
  total: number;
}

/**
 * Build a query string from an object, skipping undefined values.
 * Array values are emitted as repeated `key=v1&key=v2&...` parameters
 * (matches Fastify's default querystring parser, which surfaces those as
 * `string[]` on the server side — see `/api/projects?status=...&status=...`
 * and the Mitarbeiter filter's `assignedWorkerIds`).
 */
function toQuery(
  params?: Record<string, string | number | boolean | string[] | undefined>,
): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) usp.append(k, item);
    } else {
      usp.append(k, String(v));
    }
  }
  const s = usp.toString();
  return s ? '?' + s : '';
}

export const authApi = {
  login: (username: string, password: string) =>
    apiCall<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    }),

  logout: () => apiCall<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => apiCall<LoginResponse>('/api/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiCall<{ success: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),

  updateSelf: (patch: { themePreference?: ThemePreference; pushMuted?: boolean }) =>
    apiCall<LoginResponse>('/api/auth/me', { method: 'PATCH', body: patch }),
};

/**
 * Sortable columns for the project list. Mirrors the server-side
 * `PROJECT_SORT_KEYS` allowlist — keep them in sync.
 */
export type ProjectSortKey =
  | 'number'
  | 'title'
  | 'customer'
  | 'status'
  | 'plannedStart'
  | 'estimatedValue';

/** Sortable columns for the customer list. Mirrors `CUSTOMER_SORT_KEYS`. */
export type CustomerSortKey = 'name' | 'phone' | 'email' | 'city';

export type SortDir = 'asc' | 'desc';

export const projectApi = {
  list: (params?: {
    status?: string;
    search?: string;
    customerId?: string;
    hasNoDates?: boolean;
    includeArchived?: boolean;
    /**
     * Mitarbeiter (assignee) filter — OR semantics across the supplied
     * user ids (see ListProjectsOpts.assignedWorkerIds on the server).
     * Combine with `includeUnassigned` to OR a "Nicht zugewiesen" branch.
     */
    assignedWorkerIds?: string[];
    includeUnassigned?: boolean;
    sortBy?: ProjectSortKey;
    sortDir?: SortDir;
  }) => apiCall<ProjectListResponse>('/api/projects' + toQuery(params)),

  get: (id: string) => apiCall<Project>(`/api/projects/${id}`),

  create: (data: {
    id?: string;
    number: string;
    title: string;
    customerId: string;
    status?: string;
    plannedStart?: string | null;
    plannedEnd?: string | null;
    assignedWorkerIds?: string[];
    estimatedValue?: number | null;
    notes?: string | null;
    /**
     * Baustelle (work-site) address. `null` (or omitted) means the
     * project's site is the customer's billing address by the
     * fallback rule (data-model.md §5.1). A populated triple is
     * persisted on the row. See AC-278 / AC-280.
     */
    siteAddress?: Address | null;
  }) => apiCall<Project>('/api/projects', { method: 'POST', body: data }),

  update: (
    id: string,
    data: {
      title?: string;
      customerId?: string;
      assignedWorkerIds?: string[];
      estimatedValue?: number | null;
      notes?: string | null;
      /**
       * Baustelle (work-site) address. PATCH semantics: omit to leave
       * unchanged, `null` to clear (project reverts to fallback), a
       * populated triple to overwrite. See AC-279 / AC-280.
       */
      siteAddress?: Address | null;
    },
  ) => apiCall<Project>(`/api/projects/${id}`, { method: 'PATCH', body: data }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  /**
   * Hard-delete an already-archived project. 204 on success. A
   * non-archived target returns 409 CONFLICT with German copy
   * directing the user to archive first; a non-existent target
   * returns 404 NOT_FOUND. Requires `project:purge` (owner-only).
   */
  purge: (id: string) => apiCall<null>(`/api/projects/${id}/purge`, { method: 'DELETE' }),

  /**
   * Inverse of delete — flips deleted=true back to false on an archived
   * project. 200 with the now-active project body. An already-active
   * target returns 409 CONFLICT; a non-existent target returns 404.
   * Requires `project:delete` (symmetric — same role can archive and
   * restore). See ADR-0017.
   */
  restore: (id: string) => apiCall<Project>(`/api/projects/${id}/restore`, { method: 'POST' }),

  transitionForward: (id: string, expectedStatus: WorkflowState) =>
    apiCall<Project>(`/api/projects/${id}/transition/forward`, {
      method: 'POST',
      body: { expectedStatus },
    }),

  transitionBackward: (id: string, expectedStatus: WorkflowState) =>
    apiCall<Project>(`/api/projects/${id}/transition/backward`, {
      method: 'POST',
      body: { expectedStatus },
    }),

  updateDates: (id: string, dates: { plannedStart?: string | null; plannedEnd?: string | null }) =>
    apiCall<Project>(`/api/projects/${id}/dates`, {
      method: 'PATCH',
      body: dates,
    }),
};

export const customerApi = {
  list: (params?: {
    offset?: number;
    limit?: number;
    search?: string;
    sortBy?: CustomerSortKey;
    sortDir?: SortDir;
  }) =>
    apiCall<CustomerListResponse>(
      '/api/customers' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) =>
    apiCall<Customer & { projectCount: number; archivedProjectCount: number }>(
      `/api/customers/${id}`,
    ),

  create: (data: {
    id?: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    address?: { street: string; zip: string; city: string } | null;
    notes?: string | null;
  }) => apiCall<Customer>('/api/customers', { method: 'POST', body: data }),

  update: (
    id: string,
    data: {
      name?: string;
      phone?: string | null;
      email?: string | null;
      address?: { street: string; zip: string; city: string } | null;
      notes?: string | null;
    },
  ) => apiCall<Customer>(`/api/customers/${id}`, { method: 'PATCH', body: data }),

  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/customers/${id}`, { method: 'DELETE' }),
};

/**
 * Assignee (Mitarbeiter) pool for the project-management filter dropdown.
 * Distinct from `userApi` because the gate is `project:read` (every role
 * that can list projects can populate the filter), not `user:read`
 * (admin-only). The shape matches `Project.assignedWorkers`.
 */
interface WorkerListResponse {
  data: { userId: string; displayName: string }[];
}

export const workerApi = {
  list: () => apiCall<WorkerListResponse>('/api/workers'),
};

export const userApi = {
  list: (params?: { offset?: number; limit?: number }) =>
    apiCall<UserListResponse>(
      '/api/users' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) => apiCall<User>(`/api/users/${id}`),

  create: (data: {
    username: string;
    displayName: string;
    password: string;
    roles: string[];
    email?: string | null;
  }) => apiCall<User>('/api/users', { method: 'POST', body: data }),

  update: (
    id: string,
    data: {
      displayName?: string;
      roles?: string[];
      email?: string | null;
    },
  ) => apiCall<User>(`/api/users/${id}`, { method: 'PATCH', body: data }),

  deactivate: (id: string) => apiCall<User>(`/api/users/${id}/deactivate`, { method: 'POST' }),

  reactivate: (id: string) => apiCall<User>(`/api/users/${id}/reactivate`, { method: 'POST' }),

  delete: (id: string) => apiCall<void>(`/api/users/${id}`, { method: 'DELETE' }),

  resetPassword: (id: string, newPassword: string) =>
    apiCall<{ success: boolean }>(`/api/users/${id}/reset-password`, {
      method: 'POST',
      body: { newPassword },
    }),
};

/**
 * Unified business-data export/import (ADR-0018, api.md §14.2.4).
 *
 * Export is GET /api/export (permission: data:export).
 * Import is POST /api/import?dry_run=&override= (permission: data:restore).
 * The dry-run response is a DryRunPreview; the non-dry response is an
 * ImportResult. The caller disambiguates via the `dryRun` option.
 */
export const dataApi = {
  export: () => apiCall<Envelope>('/api/export'),

  import: (
    envelope: Envelope,
    opts: { dryRun: boolean; override: boolean; confirmationPhrase?: string | null },
  ) => {
    const params = new URLSearchParams();
    if (opts.dryRun) params.set('dry_run', 'true');
    if (opts.override) params.set('override', 'true');
    const qs = params.toString();
    const body =
      opts.confirmationPhrase != null
        ? { ...envelope, confirmation_phrase: opts.confirmationPhrase }
        : envelope;
    return apiCall<ImportResult | DryRunPreview>('/api/import' + (qs ? '?' + qs : ''), {
      method: 'POST',
      body,
    });
  },
};

export interface ExtractionResult {
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
  };
  project: {
    title: string | null;
    description: string | null;
    /**
     * Baustellen-/Leistungsadresse — the project's work-site address,
     * distinct from the customer's Rechnungsadresse (data-model.md
     * §5.1). `null` means the email only mentioned one address (the
     * common case — falls back to the customer's address by the
     * standard ERP/CRM rule). A full triple is only emitted when the
     * email mentions a separate site address.
     */
    siteAddress: Address | null;
  };
}

export const extractApi = {
  extract: (text: string) =>
    apiCall<ExtractionResult>('/api/extract', { method: 'POST', body: { text } }),
};

/**
 * Audit read surface (api.md §14.2.8).
 *
 * Read-only: `list` and `get` only. The per-role response shaping and
 * scope filtering happen server-side; the client receives the already-
 * redacted entries.
 */
export const auditApi = {
  list: (params?: AuditListParams) =>
    apiCall<AuditListResponse>(
      '/api/audit' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  get: (id: string) => apiCall<AuditEntry>(`/api/audit/${id}`),
};

interface NotificationRuleListResponse {
  data: NotificationRule[];
  total: number;
}

/**
 * Notification rules CRUD (api.md §14.2.9). Every endpoint is admin-only
 * and gated server-side by `notifications:manage`; the UI layer mirrors
 * the gate via `usePermission('notifications:manage')` for nav + surface
 * hiding only.
 */
export const notificationRuleApi = {
  list: () => apiCall<NotificationRuleListResponse>('/api/notification-rules'),

  get: (id: string) => apiCall<NotificationRule>(`/api/notification-rules/${id}`),

  create: (data: NotificationRuleInput) =>
    apiCall<NotificationRule>('/api/notification-rules', { method: 'POST', body: data }),

  update: (id: string, data: Partial<NotificationRuleInput>) =>
    apiCall<NotificationRule>(`/api/notification-rules/${id}`, { method: 'PATCH', body: data }),

  delete: (id: string) => apiCall<null>(`/api/notification-rules/${id}`, { method: 'DELETE' }),
};

/**
 * Server response for a subscribe call. The transport-only fields
 * (`p256dh`, `auth`) are never echoed back — they are stored server-
 * side and are opaque to the client after registration (see
 * data-model.md §5.12).
 */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  createdAt: string;
}

/**
 * Push-subscription endpoints (api.md §14.2.10). Self-scope — the server
 * derives `userId` from the session, so the client never sends one.
 */
export const pushApi = {
  subscribe: (body: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string | null;
  }) =>
    apiCall<PushSubscriptionRecord>('/api/push-subscriptions', {
      method: 'POST',
      body,
    }),

  unsubscribeByEndpoint: (endpoint: string) => {
    const qs = toQuery({ endpoint });
    return apiCall<null>('/api/push-subscriptions' + qs, { method: 'DELETE' });
  },
};

/**
 * Presigned PUT descriptor returned by the init endpoint for each blob.
 * The client must PUT the body to `url` with these exact `headers`;
 * SigV4 binds Content-Type, Content-Length, and Content-MD5 into the
 * signature, so any divergence is rejected by the storage provider.
 */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface AttachmentInitResponse {
  attachment: Attachment;
  originalUpload: PresignedUpload;
  thumbnailUpload?: PresignedUpload;
}

/**
 * Download-URL response — ADR-0024 / api.md §14.2.11. The server
 * unwraps `wrappedDek` (or `wrappedThumbDek` for the thumbnail variant)
 * per request and returns the raw 32-byte DEK as base64 alongside the
 * presigned-GET URL. The Service Worker fetches `url` and decrypts with
 * `dekMaterial`.
 */
export interface AttachmentDownloadUrlResponse {
  url: string;
  expiresAt: string;
  dekMaterial: string;
}

/**
 * One row in a bulk-fetch response (api.md §14.2.11 `BulkFetchEntry`).
 * Photos carry both the original and thumbnail triplet; binaries omit
 * the thumbnail fields. Ordered by request: the response array's
 * indices align with the supplied `attachmentIds` indices.
 */
export interface BulkFetchEntry {
  attachmentId: string;
  originalUrl: string;
  originalDekMaterial: string;
  ciphertextSizeBytes: number;
  thumbUrl?: string;
  thumbDekMaterial?: string;
  ciphertextThumbSizeBytes?: number;
}

export interface BulkFetchResponse {
  data: BulkFetchEntry[];
}

export interface AttachmentListResponse {
  data: Attachment[];
}

export const attachmentApi = {
  list: (projectId: string) =>
    apiCall<AttachmentListResponse>(`/api/projects/${projectId}/attachments`),

  initUpload: (
    projectId: string,
    input: {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      label: AttachmentLabel;
      hasThumbnail: boolean;
      dekMaterial: string;
      ciphertextSizeBytes: number;
      ciphertextContentMd5: string;
      thumbDekMaterial?: string;
      ciphertextThumbSizeBytes?: number;
      ciphertextThumbContentMd5?: string;
      /**
       * Optional import-mode block (issue #163, api.md §14.2.11). When
       * present, the takeout-zip restore orchestrator pins the new
       * row's identity to the source envelope's values; gated on the
       * caller holding BOTH `data:restore` AND `attachment:write`.
       * Standard upload paths omit this field; the server treats
       * absence as the default server-minted identity branch.
       */
      restore?: { id: string; createdBy: string; createdAt: string };
    },
    signal?: AbortSignal,
    authToken?: string,
  ) =>
    apiCall<AttachmentInitResponse>(`/api/projects/${projectId}/attachments/init`, {
      method: 'POST',
      body: input,
      signal,
      authToken,
    }),

  completeUpload: (
    projectId: string,
    attachmentId: string,
    signal?: AbortSignal,
    authToken?: string,
  ) =>
    apiCall<Attachment>(`/api/projects/${projectId}/attachments/${attachmentId}/complete`, {
      method: 'POST',
      signal,
      authToken,
    }),

  delete: (projectId: string, attachmentId: string, authToken?: string) =>
    apiCall<null>(`/api/projects/${projectId}/attachments/${attachmentId}`, {
      method: 'DELETE',
      authToken,
    }),

  listTrash: (projectId: string) =>
    apiCall<AttachmentListResponse>(`/api/projects/${projectId}/attachments/trash`),

  restore: (projectId: string, attachmentId: string) =>
    apiCall<Attachment>(`/api/projects/${projectId}/attachments/${attachmentId}/restore`, {
      method: 'POST',
    }),

  downloadUrl: (projectId: string, attachmentId: string, variant: 'original' | 'thumbnail') =>
    apiCall<AttachmentDownloadUrlResponse>(
      `/api/projects/${projectId}/attachments/${attachmentId}/download-url` + toQuery({ variant }),
    ),

  bulkFetch: (projectId: string, attachmentIds: string[]) =>
    apiCall<BulkFetchResponse>(`/api/projects/${projectId}/attachments/bulk-fetch`, {
      method: 'POST',
      body: { attachmentIds },
    }),
};

/**
 * Storage usage read DTO (api.md §14.2.12). Each leaf is a non-negative
 * byte count; the four-bucket shape matches `StorageUsageService` server-
 * side. The deployment-wide endpoint is gated server-side by `data:export`;
 * the client method itself imposes no role check.
 */
export interface StorageUsageDto {
  ready: { plaintext: number; ciphertext: number };
  hidden: { plaintext: number; ciphertext: number };
}

export const storageUsageApi = {
  getGlobal: () => apiCall<StorageUsageDto>('/api/storage-usage'),
};

/**
 * Company-profile singleton (api.md §14.2.15, ADR-0026). GET is open
 * to every authenticated role; PUT is owner-only (enforced server-
 * side). The body excludes `id`, `updatedAt`, `updatedBy` — those are
 * server-managed projections on every response.
 */
export interface CompanyProfileInput {
  companyName: string;
  address: { street: string; zip: string; city: string };
  taxId: string;
  ustId: string | null;
  iban: string | null;
  accentColor: string | null;
  footerText: string | null;
  /**
   * Required — PUT semantics demand every writable field be present
   * (api.md §14.2.15). Callers that don't manage the descriptor must
   * pass through the value loaded by GET; sending `null` clears it.
   * The current UI has no upload affordance (#189), so the
   * `CompanyProfileSection` round-trips the loaded value unchanged.
   */
  logoBinaryDescriptorId: string | null;
  defaultTaxMode: TaxMode;
}

export const companyProfileApi = {
  get: () => apiCall<CompanyProfile>('/api/company-profile'),

  put: (payload: CompanyProfileInput) =>
    apiCall<CompanyProfile>('/api/company-profile', { method: 'PUT', body: payload }),
};

/**
 * Invoice endpoints (api.md §14.2.14, ADR-0026). The list endpoint
 * returns `{ data, total }` mirroring the server's repository shape;
 * the per-id read / mutation endpoints return a single `Invoice` row.
 * Cancel returns `{ original, storno }` — both rows in one envelope so
 * the client never has to round-trip for the Storno sibling.
 *
 * `pdfUrl` is a URL-builder helper (not a fetch); the caller drives the
 * download via an `<a download>` click handler so the browser surfaces
 * the file the same way as any other binary download.
 */
export interface InvoiceListResponse {
  data: Invoice[];
  total: number;
}

export interface InvoiceCreateDraftInput {
  lines?: InvoiceLine[];
  recipient?: InvoiceRecipientSnapshot;
  taxMode?: TaxMode;
  performanceDate?: string | null;
}

export interface InvoiceUpdateDraftInput {
  lines?: InvoiceLine[];
  recipient?: InvoiceRecipientSnapshot;
  taxMode?: TaxMode;
  performanceDate?: string | null;
}

export interface InvoiceCancelResult {
  original: Invoice;
  storno: Invoice;
}

/**
 * Query parameters for `GET /api/invoices` (api.md §14.2.14). Mirrors
 * the server's route schema in `src/server/routes/invoices.ts` — fields
 * are optional and AND-compose. The wire shape encodes `includeCancelled`
 * as a string enum to match the route's `{ enum: ['true', 'false'] }`
 * schema (Fastify rejects raw booleans on querystrings).
 */
export interface ListInvoicesParams {
  offset?: number;
  limit?: number;
  status?: InvoiceStatus;
  year?: number;
  projectId?: string;
  customerId?: string;
  includeCancelled?: 'true' | 'false';
  search?: string;
}

/**
 * Body for `POST /api/invoices/export`. Exactly one of `ids` or
 * `filter` must be present — the server returns 422 otherwise.
 */
export type ExportInvoicesBody =
  | { ids: string[]; filter?: undefined }
  | { ids?: undefined; filter: Omit<ListInvoicesParams, 'offset' | 'limit'> };

export interface ExportInvoicesResult {
  blob: Blob;
  filename: string;
}

/** Parse the filename out of a `Content-Disposition` header. Accepts
 *  the `filename="..."` form and the RFC 5987 `filename*=UTF-8''...`
 *  form. Falls back to `null` if neither matches — caller picks a
 *  default. */
function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // ignore
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(header);
  if (quoted) return quoted[1];
  const bare = /filename=([^;]+)/i.exec(header);
  if (bare) return bare[1].trim();
  return null;
}

export const invoicesApi = {
  list: (params: ListInvoicesParams = {}) =>
    apiCall<InvoiceListResponse>(
      '/api/invoices' + toQuery(params as Record<string, string | number | boolean | undefined>),
    ),

  /** Distinct issue-date years (server-side) — drives the year filter
   *  dropdown independent of the current filter. */
  listYears: () => apiCall<{ years: number[] }>('/api/invoices/years'),

  /**
   * Bulk download. POST instead of GET because the body carries either
   * a list of UUIDs (potentially long) or a filter object — neither
   * fits cleanly into a query string. Returns a Blob the caller hands
   * to an anchor + `URL.createObjectURL`.
   */
  exportZip: async (body: ExportInvoicesBody): Promise<ApiResult<ExportInvoicesResult>> => {
    let res: Response;
    try {
      res = await fetch('/api/invoices/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch (err) {
      const isNetwork = err instanceof TypeError && /fetch|network/i.test(err.message);
      return {
        ok: false,
        error: {
          code: 'NETWORK_ERROR',
          message: isNetwork ? STRINGS.errors.networkError : STRINGS.errors.mutationFailed,
        },
        category: 'network',
        sessionExpired: false,
      };
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({ code: 'UNKNOWN', message: '' }));
      const rawCode = (data.code as string | undefined) ?? 'API_ERROR';
      const sessionExpired = rawCode === 'SESSION_EXPIRED' || rawCode === 'UNAUTHENTICATED';
      return {
        ok: false,
        error: {
          code: rawCode,
          message: (data.message as string | undefined) || STRINGS.errors.mutationFailed,
        },
        category: classifyCode(rawCode),
        sessionExpired,
        details: data.details,
      };
    }
    const blob = await res.blob();
    const filename =
      filenameFromContentDisposition(res.headers.get('Content-Disposition')) ?? 'Rechnungen.zip';
    return { ok: true, data: { blob, filename } };
  },

  listByProject: (projectId: string) =>
    apiCall<InvoiceListResponse>('/api/invoices' + toQuery({ projectId })),

  getById: (id: string) => apiCall<Invoice>(`/api/invoices/${id}`),

  createDraft: (projectId: string, payload: InvoiceCreateDraftInput) =>
    apiCall<Invoice>('/api/invoices', {
      method: 'POST',
      body: { projectId, ...payload },
    }),

  updateDraft: (id: string, payload: InvoiceUpdateDraftInput) =>
    apiCall<Invoice>(`/api/invoices/${id}`, { method: 'PATCH', body: payload }),

  deleteDraft: (id: string) => apiCall<null>(`/api/invoices/${id}`, { method: 'DELETE' }),

  issue: (id: string) => apiCall<Invoice>(`/api/invoices/${id}/issue`, { method: 'POST' }),

  cancel: (id: string, reason: string) =>
    apiCall<InvoiceCancelResult>(`/api/invoices/${id}/cancel`, {
      method: 'POST',
      body: { reason },
    }),

  pdfUrl: (id: string) => `/api/invoices/${id}/pdf`,
};

export type { AuthUser };
