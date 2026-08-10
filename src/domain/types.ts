import type { WorkflowState } from '@/config/stateConfig';
import type { ThemePreference } from '@/config/themeStorage';

export interface Address {
  street: string;
  zip: string;
  city: string;
}

/** Nested customer summary as returned in project API responses. */
export interface CustomerSummary {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: Address | null;
}

export interface Project {
  id: string;
  number: string;
  title: string;
  status: WorkflowState;
  statusChangedAt: string;

  customerId: string;
  customer: CustomerSummary | null;

  /**
   * Baustellen-/Leistungsadresse — where the work happens. Distinct from
   * `customer.address` (Rechnungsadresse). `null` indicates the project
   * is at the customer's billing address; the UI surfaces the fallback.
   * See data-model.md §5.1.
   */
  siteAddress: Address | null;

  plannedStart: string | null;
  plannedEnd: string | null;

  assignedWorkers: { userId: string; displayName: string }[] | null;
  estimatedValue: number | null;
  notes: string | null;
  deleted: boolean;

  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: Address | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  active: boolean;
  /**
   * Server-authoritative color-scheme preference — see data-model.md §5.7.
   * New users default to `'system'` at the DB level (see migration 0013
   * and the CHECK constraint `users_valid_theme_preference`).
   */
  themePreference: ThemePreference;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  createdBy: string | null;
  updatedBy: string | null;
}

/**
 * Profile shape returned by the authenticated-user endpoints (login,
 * GET /api/auth/me, PATCH /api/auth/me). A narrower projection than
 * `User`; see api.md §14.2.1 and the AuthUser interface in the server
 * middleware.
 */
export interface AuthUserProfile {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  email: string | null;
  themePreference: ThemePreference;
}

export interface SummaryData {
  agedBufferCounts: { state: WorkflowState; count: number; thresholdDays: number }[];
  projectsWithoutDates: number;
}

/**
 * Available view modes. Extend this union and App.tsx when adding new views.
 * See architecture.md §11.5.
 */
export type ViewMode =
  | 'meineProjekte'
  | 'kanban'
  | 'kalender'
  | 'kunden'
  | 'projekte'
  | 'rechnungen'
  | 'rechnungDetail'
  | 'benutzer'
  | 'daten'
  | 'aktivitaet'
  | 'benachrichtigungen'
  | 'projektDetail';

export type AttachmentStatus = 'pending' | 'ready' | 'hidden';

export type AttachmentKind = 'photo' | 'binary';

export type AttachmentLabel =
  'angebot' | 'auftragsbestaetigung' | 'rechnung' | 'aufmass' | 'foto' | 'sonstiges';

export interface Attachment {
  id: string;
  projectId: string;
  status: AttachmentStatus;
  kind: AttachmentKind;
  label: AttachmentLabel;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  originalKey: string;
  thumbKey: string | null;
  hasThumbnail: boolean;
  /** ISO 8601 — set iff status='hidden'; null otherwise. Drives the
   *  Papierkorb's "vor X Tagen gelöscht" label. */
  hiddenAt: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
}
