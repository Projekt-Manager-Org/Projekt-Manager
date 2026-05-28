import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import type { Project } from '@/domain/types';
import { formatDateDE, formatCurrencyDE } from '@/domain/dateFormat';
import { usePermission } from '@/hooks/usePermission';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useProjectStore } from '@/state/projectStore';
import { ActivityFeed } from '@/ui/audit/ActivityFeed';
import { dateInputValue } from './dateInputValue';
import { SiteAddressLine } from './SiteAddressLine';
import styles from './ProjectDetailPanel.module.css';

interface ProjectDetailPanelProps {
  project: Project;
  onClose: () => void;
}

export function ProjectDetailPanel({ project, onClose }: ProjectDetailPanelProps) {
  const updateDates = useProjectStore((s) => s.updateDates);
  const projects = useProjectStore((s) => s.projects);
  const navigate = useNavigate();

  // Close on Escape, consistent with every other dismissable surface
  // (stack-aware via the shared escape registry). The panel also closes
  // on backdrop click and the close button.
  useEscapeKey(onClose);

  // Always get fresh project data from store
  const currentProject = projects.find((p) => p.id === project.id) ?? project;
  const config = STATE_CONFIG_MAP[currentProject.status];
  const canUpdateDates = usePermission('project:dates');
  const canReadAudit = usePermission('audit:read');

  // Local draft for date inputs. Native `<input type="date">` emits
  // onChange with value="" mid-edit (segmented input goes through a
  // transient invalid state). Committing each onChange to the store
  // destroys the other date when the "clear start → clear end" rule
  // trips on a transient empty. We mirror the store value locally,
  // commit on blur, and let the server see only the user's final
  // intent.
  //
  // Sync uses React's "adjust state during render" pattern — driven by
  // prop-change comparison with the last observed server value — so
  // the draft stays in sync with the store without the cascading-render
  // penalty of `useEffect` + `setState` (react-hooks/set-state-in-effect).
  const [startDraft, setStartDraft] = useState(dateInputValue(currentProject.plannedStart));
  const [endDraft, setEndDraft] = useState(dateInputValue(currentProject.plannedEnd));
  const [lastStart, setLastStart] = useState(currentProject.plannedStart);
  const [lastEnd, setLastEnd] = useState(currentProject.plannedEnd);
  if (currentProject.plannedStart !== lastStart) {
    setLastStart(currentProject.plannedStart);
    setStartDraft(dateInputValue(currentProject.plannedStart));
  }
  if (currentProject.plannedEnd !== lastEnd) {
    setLastEnd(currentProject.plannedEnd);
    setEndDraft(dateInputValue(currentProject.plannedEnd));
  }

  const commitStart = () => {
    const storeValue = dateInputValue(currentProject.plannedStart);
    if (startDraft === storeValue) return;
    if (!startDraft && currentProject.plannedEnd) {
      // Explicit clear of start while end exists → clear both
      // (spec §8.4, data-model §6.8). The intermediate-empty case is
      // excluded by the blur gate: by the time blur fires the user has
      // left the field, so an empty value reflects a deliberate clear.
      updateDates(currentProject.id, null, null);
      setEndDraft('');
    } else {
      updateDates(currentProject.id, startDraft || null, undefined);
    }
  };

  const commitEnd = () => {
    const storeValue = dateInputValue(currentProject.plannedEnd);
    if (endDraft === storeValue) return;
    updateDates(currentProject.id, undefined, endDraft || null);
  };

  const handleOpenDetailPage = () => {
    onClose();
    navigate(`/projects/${currentProject.id}`);
  };

  const handleCloseClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <>
      <div className={styles.overlay} onClick={onClose} data-testid="detail-overlay" />
      <div className={styles.panel} data-testid="detail-panel">
        <div className={styles.headerRow}>
          <button
            type="button"
            className={styles.header}
            onClick={handleOpenDetailPage}
            data-testid="detail-open-page"
            aria-label={STRINGS.attachments.openDetailPage}
          >
            <div className={styles.headerInfo}>
              <div className={styles.projectNumber}>{currentProject.number}</div>
              <div className={styles.projectTitle}>{currentProject.title}</div>
              <div className={styles.headerHint}>{STRINGS.attachments.openDetailPage} →</div>
            </div>
          </button>
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleCloseClick}
            data-testid="detail-close"
            aria-label={STRINGS.ui.close}
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          {/* Status */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{STRINGS.ui.status}</div>
            <span
              className={styles.badge}
              style={{ backgroundColor: config.color }}
              data-testid="detail-status-badge"
            >
              {config.label}
            </span>
          </div>

          {/* Customer */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{STRINGS.ui.customer}</div>
            <div className={styles.fieldValue}>{currentProject.customer?.name ?? '—'}</div>
            {currentProject.customer?.phone && (
              <a className={styles.link} href={`tel:${currentProject.customer.phone}`}>
                {currentProject.customer.phone}
              </a>
            )}
            {currentProject.customer?.email && (
              <a className={styles.link} href={`mailto:${currentProject.customer.email}`}>
                {currentProject.customer.email}
              </a>
            )}
          </div>

          {/* Baustelle (work-site address) — shared with the detail page
              via SiteAddressLine. Renders project.siteAddress when set,
              falls back to customer.address with a "(Kundenadresse)"
              hint when null, and shows "Keine Adresse" when both are
              absent. AC-282 / AC-283. */}
          <SiteAddressLine project={currentProject} variant="panel" />

          {/* Dates */}
          {canUpdateDates && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.dates}</div>
              <div className={styles.dateInputs}>
                <div className={styles.dateField}>
                  <label className={styles.dateLabel}>{STRINGS.ui.dateStart}</label>
                  <input
                    type="date"
                    className={styles.dateInput}
                    value={startDraft}
                    onChange={(e) => setStartDraft(e.target.value)}
                    onBlur={commitStart}
                    data-testid="detail-date-start"
                  />
                </div>
                <div className={styles.dateField}>
                  <label className={styles.dateLabel}>{STRINGS.ui.dateEnd}</label>
                  <input
                    type="date"
                    className={styles.dateInput}
                    value={endDraft}
                    onChange={(e) => setEndDraft(e.target.value)}
                    onBlur={commitEnd}
                    data-testid="detail-date-end"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Workers */}
          {currentProject.assignedWorkers && currentProject.assignedWorkers.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.workers}</div>
              <div className={styles.workerList}>
                {currentProject.assignedWorkers.map((w) => (
                  <span key={w.userId} className={styles.workerTag}>
                    {w.displayName}
                  </span>
                ))}
              </div>
            </div>
          )}

          {currentProject.estimatedValue != null && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.estimatedValue}</div>
              <div className={styles.fieldValue}>
                {formatCurrencyDE(currentProject.estimatedValue)}
              </div>
            </div>
          )}

          {currentProject.notes && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>{STRINGS.ui.notes}</div>
              <div className={styles.notes}>{currentProject.notes}</div>
            </div>
          )}

          {/* Timestamps */}
          <div className={styles.timestamps}>
            <span>
              {STRINGS.ui.created} {formatDateDE(currentProject.createdAt)}
            </span>
            <span>
              {STRINGS.ui.updated} {formatDateDE(currentProject.updatedAt)}
            </span>
            <span>
              {STRINGS.ui.statusSince} {formatDateDE(currentProject.statusChangedAt)}
            </span>
          </div>

          {/* Activity feed — inner scroll so a long history does not
              push other sections out of reach. The `updatedAt` stamp is
              part of the filterKey so the feed refetches whenever any
              project mutation (dates, workers, …) lands. */}
          {canReadAudit && (
            <div className={styles.activityBlock}>
              <div className={styles.sectionLabel}>{STRINGS.audit.heading}</div>
              <div className={styles.activityScroll}>
                <ActivityFeed
                  filters={{ ancestorType: 'project', ancestorId: currentProject.id }}
                  filterKey={`project:${currentProject.id}:${currentProject.updatedAt}`}
                  testId="project-activity-feed"
                  inline
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
