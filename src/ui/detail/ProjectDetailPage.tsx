/**
 * Project detail page — full-context view of a single project at
 * `/projects/:id`. Primary surface for project work: core fields are
 * editable in place, attachments, activity feed.
 *
 * Edits commit on blur / enter — no modal save dialog. Each field owns
 * a local draft so transient invalid states (e.g. `<input type="date">`
 * emitting empty mid-edit) don't clobber unrelated fields.
 *
 * Out-of-scope workers land here via the server returning
 * NOT_PERMITTED — render the AC-149 mirror surface.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { STRINGS } from '@/config/strings';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { useProjectStore, type FetchProjectOutcome } from '@/state/projectStore';
import { useAttachmentStore } from '@/state/attachmentStore';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useConfirmStore } from '@/state/confirmStore';
import { useToastStore } from '@/state/toastStore';
import { usePermission } from '@/hooks/usePermission';
import { ATTACHMENT_MIME_WHITELIST } from '@/domain/attachments';
import { formatDateDE } from '@/domain/dateFormat';
import { buildProjectBundleFilename } from '@/domain/filename';
import { ActivityFeed } from '@/ui/audit/ActivityFeed';
import { NotPermittedView } from '@/ui/common/NotPermittedView';
import { triggerBlobDownload } from '@/ui/utils/downloadFile';
import { CustomerEditForm } from '@/ui/management/CustomerEditForm';
import { PhotoGallery } from './PhotoGallery';
import { BinaryList } from './BinaryList';
import { Papierkorb } from './Papierkorb';
import { AssignedWorkerEditor } from './AssignedWorkerEditor';
import { UploadCta } from './UploadCta';
import { dateInputValue } from './dateInputValue';
import { SiteAddressLine } from './SiteAddressLine';
import { SiteAddressEditModal } from './SiteAddressEditModal';
import { InvoiceSection } from './invoice/InvoiceSection';
import styles from './ProjectDetail.module.css';

type LoadState = { kind: 'loading' } | FetchProjectOutcome;

// The camera FAB is photo-only (a construction worker tapping it wants
// to capture the scene, not attach a PDF). Gate on the whitelist's
// image subset so an exotic MIME from a custom camera app — HEIC,
// DNG, some vendor preview format — is rejected client-side with the
// same "Dateityp nicht unterstützt" copy UploadCta shows for the
// document picker. Without this gate the file reaches uploadFile and
// trips the per-file size cap, surfacing the misleading
// "Datei zu groß" banner.
const CAMERA_ALLOWED_MIMES = new Set<string>(
  ATTACHMENT_MIME_WHITELIST.filter((m) => m.startsWith('image/')),
);

/**
 * Some mobile browsers (Android Chrome on certain camera apps, iOS
 * WebView shells) emit `file.type === ""` for camera captures even
 * though the payload is a standard JPEG. The raw MIME-set check would
 * reject those with the generic "unsupported type" toast, which reads
 * to the user as "my phone's camera is broken." Infer the MIME from
 * the filename extension as a fallback before the whitelist check so
 * the common "empty type but .jpg" case uploads cleanly. Only three
 * extensions are honoured — the same closed set the server validates
 * against. `classifyKind` downstream still pins the MIME against the
 * whitelist, so an unmapped extension reaches the gate and is
 * rejected with the concrete "what's supported" copy.
 */
const EXTENSION_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

function inferMimeFromFile(file: File): string {
  if (file.type) return file.type;
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = match?.[1] ?? '';
  return EXTENSION_MIME_MAP[ext] ?? '';
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const projectId = id ?? '';
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const canReadAudit = usePermission('audit:read');
  const canWrite = usePermission('attachment:write');
  const canTrash = usePermission('attachment:trash');
  const canUpdate = usePermission('project:update');
  const canUpdateDates = usePermission('project:dates');
  const canDelete = usePermission('project:delete');
  const canPurge = usePermission('project:purge');
  const canEditCustomer = usePermission('customer:write');

  const fetchProject = useProjectStore((s) => s.fetchProject);
  const updateDates = useProjectStore((s) => s.updateDates);
  const storeProject = useProjectStore((s) => s.projects.find((p) => p.id === projectId));

  const updateProject = useProjectManagementStore((s) => s.updateProject);
  const deleteProject = useProjectManagementStore((s) => s.deleteProject);
  const purgeProject = useProjectManagementStore((s) => s.purgeProject);
  const restoreProject = useProjectManagementStore((s) => s.restoreProject);
  const requestConfirm = useConfirmStore((s) => s.request);

  const requestBulkZipBlob = useAttachmentStore((s) => s.requestBulkZipBlob);
  const attachmentsByProject = useAttachmentStore((s) => s.byProject[projectId]);
  const trashCount = useAttachmentStore((s) => s.hiddenByProject[projectId]?.length ?? 0);
  const fetchTrashForProject = useAttachmentStore((s) => s.fetchTrashForProject);

  // Active attachment tab. Workers / bookkeepers never see the tab
  // strip; for owner / office the default lands on the live "Anhänge"
  // view. Switching to Papierkorb is a one-click toggle, no URL state
  // — same level of persistence as the gallery / list scroll position.
  const [attachmentTab, setAttachmentTab] = useState<'attachments' | 'papierkorb'>('attachments');

  // Modal-open flags for the inline-edit affordances on the Kunde and
  // Baustelle cards. Both modals own their own form state and submit
  // lifecycle (see CustomerEditForm + SiteAddressEditModal); the page
  // just holds the open/closed bit. Replaces the old inline Baustelle
  // edit panel — see ui/project-detail.md §8.15.2.
  const [customerModalOpen, setCustomerModalOpen] = useState(false);
  const [siteAddressModalOpen, setSiteAddressModalOpen] = useState(false);

  // Eagerly fetch the Papierkorb count for owner / office so the tab
  // badge is accurate on first render. Workers don't have the
  // permission and would just 403; skip the GET for them.
  useEffect(() => {
    if (!canTrash) return;
    void fetchTrashForProject(projectId);
  }, [canTrash, fetchTrashForProject, projectId]);

  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const outcome = await fetchProject(projectId);
      if (cancelled) return;
      setState(outcome);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, fetchProject]);

  // Abort in-flight uploads when the user navigates away or the project
  // id changes. Reading the action via `getState` keeps the cleanup
  // effect from re-running on every store update.
  useEffect(() => {
    return () => {
      useAttachmentStore.getState().cancelUploadsForProject(projectId);
    };
  }, [projectId]);

  // Prefer the freshest copy from the store once it has arrived. The
  // local `state` is only the fallback for the initial load / error
  // surfaces; all inline edits flow through the store.
  const project = storeProject ?? (state.kind === 'ok' ? state.project : null);

  if (state.kind === 'loading' && !project) {
    return <div className={styles.loading}>{STRINGS.ui.loading}</div>;
  }

  if (state.kind === 'not_permitted') {
    return <NotPermittedView />;
  }

  if (state.kind === 'not_found') {
    return (
      <article className={styles.notFound} data-testid="project-detail-not-found">
        <h1>{STRINGS.attachments.notFoundHeading}</h1>
        <p>{STRINGS.attachments.notFoundBody}</p>
      </article>
    );
  }

  if (state.kind === 'error' && !project) {
    return <div className={styles.errorBanner}>{state.message}</div>;
  }

  if (!project) {
    return <div className={styles.loading}>{STRINGS.ui.loading}</div>;
  }

  // Archived projects are returned by GET as a regular 200 with
  // `deleted: true`. The page renders them in preview mode: every
  // editable surface is forced read-only and mutation affordances
  // collapse to the purge action. AC-95 immutability is enforced
  // server-side regardless, but suppressing the controls keeps the
  // user from staring at a button that always 404s.
  const isArchived = project.deleted;

  const config = STATE_CONFIG_MAP[project.status];
  const customer = project.customer;

  // A click anywhere on a clickable detail card opens the corresponding
  // modal — EXCEPT when the click lands on an inner anchor (tel: /
  // mailto: / map link). Those anchors should follow their native
  // behaviour; the modal-open click is delegated rather than wired onto
  // each child to avoid nested-interactive markup.
  const cardClickShouldOpen = (e: React.MouseEvent | React.KeyboardEvent): boolean => {
    const target = e.target as HTMLElement | null;
    if (!target) return true;
    return target.closest('a') === null;
  };

  const cardKeyToggle = (onOpen: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!cardClickShouldOpen(e)) return;
    e.preventDefault();
    onOpen();
  };

  const customerCardClickable = canEditCustomer && customer !== null && !isArchived;
  const siteAddressCardClickable = canUpdate && !isArchived;

  const handleArchive = async () => {
    const confirmed = await requestConfirm(
      STRINGS.projects.archiveConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    const ok = await deleteProject(project.id);
    if (ok) navigate('/projects');
  };

  const handlePurge = async () => {
    const confirmed = await requestConfirm(
      STRINGS.projects.purgeConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    const ok = await purgeProject(project.id);
    if (ok) navigate('/projects');
  };

  const handleRestore = async () => {
    const confirmed = await requestConfirm(
      STRINGS.projects.restoreConfirm(`${project.number} — ${project.title}`),
    );
    if (!confirmed) return;
    // Stay on the page on success — the store flips deleted → false on
    // the cached project, the read-only banner disappears, and editable
    // surfaces re-enable in place. No navigation needed.
    await restoreProject(project.id);
  };

  const handleDownloadAll = async () => {
    const rows = (attachmentsByProject ?? []).filter((a) => a.status === 'ready');
    if (rows.length === 0) return;
    // Store-side: bulk-fetch + decrypt-each + streaming-zip → single
    // Blob (ADR-0024 § Bulk download). `null` on cap breach / network /
    // decrypt failure — the store has set the page-banner error; the
    // click is a no-op here.
    const blob = await requestBulkZipBlob(
      project.id,
      rows.map((a) => a.id),
    );
    if (!blob) return;
    triggerBlobDownload(blob, bundleFileName);
  };

  const readyAttachmentCount = (attachmentsByProject ?? []).filter(
    (a) => a.status === 'ready',
  ).length;

  const bundleFileName = buildProjectBundleFilename(project);

  return (
    <article
      aria-label={STRINGS.ui.viewDetails}
      data-testid="project-detail-page"
      className={styles.page}
    >
      <header data-testid="project-detail-header" className={styles.header}>
        <div className={styles.headerTopRow}>
          <div className={styles.headerIdentity}>
            <div className={styles.projectNumber}>{project.number}</div>
            <InlineTitle
              value={project.title}
              readOnly={!canUpdate || isArchived}
              onCommit={(next) => void updateProject(project.id, { title: next })}
            />
            <span
              className={styles.statusBadge}
              style={{ backgroundColor: config?.color }}
              data-testid="project-detail-status"
            >
              {config?.label ?? project.status}
            </span>
            {isArchived && (
              <span className={styles.archivedBadge} data-testid="project-archived-badge">
                {STRINGS.projects.archivedBadge}
              </span>
            )}
          </div>

          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.downloadAllButton}
              onClick={() => void handleDownloadAll()}
              disabled={readyAttachmentCount === 0}
              data-testid="project-download-all"
              title={readyAttachmentCount === 0 ? STRINGS.attachments.noAttachments : undefined}
            >
              {STRINGS.attachments.downloadAll}
            </button>
            {canDelete && !isArchived && (
              <button
                type="button"
                className={styles.archiveButton}
                onClick={() => void handleArchive()}
                data-testid="project-detail-archive"
              >
                {STRINGS.projects.archive}
              </button>
            )}
            {canDelete && isArchived && (
              <button
                type="button"
                className={styles.restoreButton}
                onClick={() => void handleRestore()}
                data-testid="project-detail-restore"
              >
                {STRINGS.projects.restore}
              </button>
            )}
            {canPurge && isArchived && (
              <button
                type="button"
                className={styles.purgeButton}
                onClick={() => void handlePurge()}
                data-testid="project-detail-purge"
              >
                {STRINGS.projects.purge}
              </button>
            )}
          </div>
        </div>
        {isArchived && (
          <div
            className={styles.archivedNotice}
            role="status"
            data-testid="project-detail-archived-notice"
          >
            {STRINGS.attachments.archivedReadOnlyNotice}
          </div>
        )}
      </header>

      {/* Floating camera-capture button — fixed top-right of the page.
          Only mounts when the user can upload; the UploadCta's own
          Foto-aufnehmen control has moved here so a worker standing on
          a roof doesn't hunt for it in the form layout. */}
      {canWrite && !isArchived && (
        <label className={styles.cameraFab} data-testid="detail-camera-capture">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            multiple
            className={styles.cameraFabInput}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length === 0) return;
              const store = useAttachmentStore.getState();
              const toast = useToastStore.getState();
              for (const file of files) {
                const effectiveMime = inferMimeFromFile(file);
                if (!CAMERA_ALLOWED_MIMES.has(effectiveMime)) {
                  // Diagnostic: without this log, a user reporting "camera
                  // doesn't work" has no way to tell us which MIME the
                  // browser actually produced (HEIC? empty? image/jpg
                  // typo?). `console.warn` shows up in the browser
                  // console + PWA remote-debugging session and costs
                  // nothing in the happy path.
                  console.warn(
                    '[camera] rejected file: name=%s reportedType=%s effectiveType=%s size=%d',
                    file.name,
                    file.type || '(empty)',
                    effectiveMime || '(unresolved)',
                    file.size,
                  );
                  toast.show('error', STRINGS.attachments.uploadMimeNotAllowed);
                  continue;
                }
                // If file.type is empty but we inferred a valid MIME, hand
                // the pipeline a new File with the corrected type. The
                // pipeline / store / server all validate by `file.type`
                // — a blank type would trip `classifyKind` downstream and
                // short-circuit the re-encode path.
                const corrected =
                  file.type === effectiveMime
                    ? file
                    : new File([file], file.name, {
                        type: effectiveMime,
                        lastModified: file.lastModified,
                      });
                void store.uploadFile(project.id, corrected, {
                  label: 'foto',
                  hasThumbnail: true,
                });
              }
              e.target.value = '';
            }}
          />
          {/* Inline SVG (Material "camera_alt") — `fill: currentColor`
              via the CSS module lets the icon tint follow `--color-text`
              and adjust between themes. Emojis are OS-coloured and
              cannot theme. */}
          <svg
            aria-hidden="true"
            className={styles.cameraFabIcon}
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M20 4h-3.17l-1.84-2.01A2 2 0 0 0 13.52 1h-3.04a2 2 0 0 0-1.47.99L7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
          </svg>
          <span className={styles.visuallyHidden}>{STRINGS.attachments.takePhoto}</span>
        </label>
      )}

      <section
        aria-label={STRINGS.attachments.coreFields}
        data-testid="project-detail-core"
        className={styles.coreSection}
      >
        <div className={styles.coreGrid}>
          {/* KUNDE card — name + phone + email (matching the panel).
              Clickable when the user has customer:write and the project
              is not archived; opens the same CustomerEditForm modal the
              Kunden tab uses. Inner tel:/mailto: anchors are delegated
              past the card-open handler so a tap still places a call. */}
          <div
            className={customerCardClickable ? styles.coreFieldClickable : styles.coreField}
            data-testid="project-detail-customer"
            {...(customerCardClickable
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': `${STRINGS.ui.customer} ${STRINGS.ui.edit}`,
                  onClick: (e: React.MouseEvent) => {
                    if (cardClickShouldOpen(e)) setCustomerModalOpen(true);
                  },
                  onKeyDown: cardKeyToggle(() => setCustomerModalOpen(true)),
                }
              : {})}
          >
            <span className={styles.coreLabel}>{STRINGS.ui.customer}</span>
            <span className={styles.coreValue}>{customer?.name ?? '—'}</span>
            {customer?.phone && (
              <a
                className={styles.coreContactLink}
                href={`tel:${customer.phone}`}
                data-testid="project-detail-customer-phone"
              >
                {customer.phone}
              </a>
            )}
            {customer?.email && (
              <a
                className={styles.coreContactLink}
                href={`mailto:${customer.email}`}
                data-testid="project-detail-customer-email"
              >
                {customer.email}
              </a>
            )}
          </div>
          {/* Baustelle (work-site address) — read-only line via
              SiteAddressLine (shared with the panel; AC-282 / AC-283).
              Wrapped in a clickable surface when the user can edit so
              the whole row taps through to SiteAddressEditModal. The
              inner map anchor is delegated past the card-open handler. */}
          {siteAddressCardClickable ? (
            <div
              className={styles.coreCardWrapClickable}
              role="button"
              tabIndex={0}
              aria-label={`${STRINGS.projects.siteAddressLabel} ${STRINGS.ui.edit}`}
              data-testid="project-detail-site-address-edit"
              onClick={(e) => {
                if (cardClickShouldOpen(e)) setSiteAddressModalOpen(true);
              }}
              onKeyDown={cardKeyToggle(() => setSiteAddressModalOpen(true))}
            >
              <SiteAddressLine project={project} variant="page" />
            </div>
          ) : (
            <SiteAddressLine project={project} variant="page" />
          )}
          <div className={styles.coreField}>
            <span className={styles.coreLabel}>{STRINGS.ui.dateStart}</span>
            {canUpdateDates && !isArchived ? (
              <DateField
                initial={project.plannedStart}
                otherDate={project.plannedEnd}
                role="start"
                testId="project-detail-start"
                onCommit={(start) => {
                  if (!start && project.plannedEnd) {
                    updateDates(project.id, null, null);
                  } else {
                    updateDates(project.id, start, undefined);
                  }
                }}
              />
            ) : (
              <span className={styles.coreValue}>
                {project.plannedStart ? formatDateDE(project.plannedStart) : '—'}
              </span>
            )}
          </div>
          <div className={styles.coreField}>
            <span className={styles.coreLabel}>{STRINGS.ui.dateEnd}</span>
            {canUpdateDates && !isArchived ? (
              <DateField
                initial={project.plannedEnd}
                otherDate={project.plannedStart}
                role="end"
                testId="project-detail-end"
                onCommit={(end) => {
                  updateDates(project.id, undefined, end);
                }}
              />
            ) : (
              <span className={styles.coreValue}>
                {project.plannedEnd ? formatDateDE(project.plannedEnd) : '—'}
              </span>
            )}
          </div>
          <div className={styles.coreField}>
            <span className={styles.coreLabel}>{STRINGS.ui.estimatedValue}</span>
            <InlineNumberField
              initial={project.estimatedValue}
              readOnly={!canUpdate || isArchived}
              testId="project-value-edit"
              onCommit={(value) => void updateProject(project.id, { estimatedValue: value })}
            />
          </div>
          <div className={styles.coreFieldFull}>
            <span className={styles.coreLabel}>{STRINGS.ui.notes}</span>
            <InlineTextareaField
              initial={project.notes}
              readOnly={!canUpdate || isArchived}
              testId="project-notes-input"
              onCommit={(notes) => void updateProject(project.id, { notes })}
            />
          </div>
        </div>
      </section>

      {customerModalOpen && customer && (
        <CustomerEditForm
          customer={customer}
          onClose={() => setCustomerModalOpen(false)}
          // Refresh the project so the embedded customer snapshot —
          // which is what the page renders — picks up the new values.
          onSaved={() => {
            void fetchProject(project.id);
          }}
        />
      )}

      {siteAddressModalOpen && (
        <SiteAddressEditModal
          projectId={project.id}
          initial={project.siteAddress}
          customerAddress={project.customer?.address ?? null}
          onClose={() => setSiteAddressModalOpen(false)}
        />
      )}

      <AssignedWorkerEditor projectId={project.id} archived={isArchived} />

      {canWrite && !isArchived && <UploadCta projectId={project.id} />}

      {canTrash ? (
        <>
          <div
            role="tablist"
            aria-label={STRINGS.attachments.tabAttachments}
            className={styles.attachmentTabs}
          >
            <button
              type="button"
              role="tab"
              aria-selected={attachmentTab === 'attachments'}
              onClick={() => setAttachmentTab('attachments')}
              data-testid="attachment-tab-anhaenge"
              className={
                attachmentTab === 'attachments' ? styles.attachmentTabActive : styles.attachmentTab
              }
            >
              {STRINGS.attachments.tabAttachments}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={attachmentTab === 'papierkorb'}
              onClick={() => setAttachmentTab('papierkorb')}
              data-testid="attachment-tab-papierkorb"
              className={
                attachmentTab === 'papierkorb' ? styles.attachmentTabActive : styles.attachmentTab
              }
            >
              {trashCount > 0
                ? STRINGS.attachments.tabPapierkorbWithCount(trashCount)
                : STRINGS.attachments.tabPapierkorb}
            </button>
          </div>
          {attachmentTab === 'attachments' ? (
            <>
              <PhotoGallery projectId={project.id} archived={isArchived} />
              <BinaryList
                projectId={project.id}
                bundleFileName={bundleFileName}
                archived={isArchived}
              />
            </>
          ) : (
            <Papierkorb projectId={project.id} />
          )}
        </>
      ) : (
        <>
          <PhotoGallery projectId={project.id} archived={isArchived} />
          <BinaryList
            projectId={project.id}
            bundleFileName={bundleFileName}
            archived={isArchived}
          />
        </>
      )}

      <InvoiceSection projectId={project.id} projectStatus={project.status} />

      <section
        aria-label={STRINGS.attachments.activity}
        data-testid="project-detail-activity"
        className={styles.activitySection}
      >
        <h3 className={styles.regionHeading}>{STRINGS.attachments.activity}</h3>
        {canReadAudit && (
          <ActivityFeed
            filters={{ ancestorType: 'project', ancestorId: project.id }}
            filterKey={`project-detail:${project.id}:${project.updatedAt}`}
            testId="project-detail-activity-feed"
            inline
          />
        )}
      </section>
    </article>
  );
}

/**
 * Inline editable title. Renders a borderless textarea that looks like
 * a heading until it gets focus. Commits on blur or Enter. Reads fresh
 * from props so a store-driven update (reflecting the server response)
 * swaps in without leaving the user's half-typed draft untouched.
 *
 * `<textarea>` instead of `<input>` — titles like "Malerarbeiten Praxis
 * Dr. Braun" exceed the available width on phones; an `<input>` clips
 * mid-word ("Dr.B") with no visible wrap, which reads as a truncation
 * bug. A textarea wraps the long title across lines inside the same
 * visual chrome, so the full identifier stays visible. The textarea
 * is kept visually single-line via auto-sizing (`rows=1` + JS height
 * adjust to scrollHeight) and Enter is still a commit (never a newline).
 */
function InlineTitle({
  value,
  readOnly,
  onCommit,
}: {
  value: string;
  readOnly: boolean;
  onCommit: (next: string) => void;
}) {
  // "Adjust state during render" pattern — re-seed the draft when the
  // underlying prop changes (server-commit, store refetch) without a
  // useEffect cascade.
  const [draft, setDraft] = useState(value);
  const [lastSeen, setLastSeen] = useState(value);
  if (value !== lastSeen) {
    setLastSeen(value);
    setDraft(value);
  }

  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize to content height. `useLayoutEffect` runs before paint
  // so the textarea never flashes at its default 2-row height before
  // shrinking/growing to the content. Resetting `height` to `auto` first
  // lets `scrollHeight` report the unconstrained content height; pinning
  // `height` to that value then sizes the box exactly.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [draft]);

  const commit = () => {
    // Paste can inject newlines; collapse any internal whitespace runs
    // (including the paste-introduced newlines) to a single space so
    // a stray \n doesn't land in the stored title.
    const normalized = draft.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized === value) {
      setDraft(value);
      return;
    }
    onCommit(normalized);
  };

  return (
    <textarea
      ref={ref}
      className={styles.titleInput}
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Titles are single-line — Enter commits rather than inserting
          // a newline, matching the prior input-element behaviour.
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      readOnly={readOnly}
      data-testid="project-title-edit"
      aria-label={STRINGS.ui.title}
    />
  );
}

/**
 * Editable date field. Save-on-blur; an empty onBlur value is a
 * deliberate clear (intermediate `<input type="date">` empties during
 * typing never reach blur, so they don't trigger a commit). The
 * `otherDate` prop is currently only used to seed the commit decision
 * in the parent.
 */
function DateField({
  initial,
  otherDate: _otherDate,
  role,
  testId,
  onCommit,
}: {
  initial: string | null;
  otherDate: string | null;
  role: 'start' | 'end';
  testId: string;
  onCommit: (value: string | null) => void;
}) {
  const initialValue = dateInputValue(initial);
  const [draft, setDraft] = useState(initialValue);
  const [lastSeen, setLastSeen] = useState(initial);
  if (initial !== lastSeen) {
    setLastSeen(initial);
    setDraft(dateInputValue(initial));
  }

  const commit = () => {
    if (draft === dateInputValue(initial)) return;
    onCommit(draft || null);
  };

  return (
    <input
      type="date"
      className={styles.dateInput}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      data-testid={testId}
      aria-label={role === 'start' ? STRINGS.ui.dateStart : STRINGS.ui.dateEnd}
    />
  );
}

function InlineNumberField({
  initial,
  readOnly,
  testId,
  onCommit,
}: {
  initial: number | null;
  readOnly: boolean;
  testId: string;
  onCommit: (next: number | null) => void;
}) {
  const initialText = initial != null ? String(initial) : '';
  const [draft, setDraft] = useState(initialText);
  const [lastSeen, setLastSeen] = useState(initialText);
  if (initialText !== lastSeen) {
    setLastSeen(initialText);
    setDraft(initialText);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === lastSeen) return;
    if (!trimmed) {
      onCommit(null);
      return;
    }
    const parsed = parseFloat(trimmed.replace(',', '.'));
    if (Number.isNaN(parsed)) {
      setDraft(lastSeen);
      return;
    }
    onCommit(parsed);
  };

  return (
    <input
      className={styles.valueInput}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      readOnly={readOnly}
      data-testid={testId}
      placeholder="0,00"
      inputMode="decimal"
      aria-label={STRINGS.ui.estimatedValue}
    />
  );
}

function InlineTextareaField({
  initial,
  readOnly,
  testId,
  onCommit,
}: {
  initial: string | null;
  readOnly: boolean;
  testId: string;
  onCommit: (next: string | null) => void;
}) {
  const initialText = initial ?? '';
  const [draft, setDraft] = useState(initialText);
  const [lastSeen, setLastSeen] = useState(initialText);
  if (initialText !== lastSeen) {
    setLastSeen(initialText);
    setDraft(initialText);
  }

  const commit = () => {
    const trimmed = draft.trim();
    const normalized = trimmed || null;
    if ((normalized ?? '') === (initial ?? '')) return;
    onCommit(normalized);
  };

  return (
    <textarea
      className={styles.notesInput}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      readOnly={readOnly}
      data-testid={testId}
      aria-label={STRINGS.ui.notes}
      rows={4}
    />
  );
}
