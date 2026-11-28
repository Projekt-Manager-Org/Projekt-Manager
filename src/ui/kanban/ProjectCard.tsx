import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import type { Project } from '@/domain/types';
import { formatDateRange, formatDateDE } from '@/domain/dateFormat';
import { isAgingBold, getAgingText } from '@/domain/aging';
import { useProjectTransition } from '@/hooks/useProjectTransition';
import { usePermission } from '@/hooks/usePermission';
import { useOpenProject } from '@/hooks/useOpenProject';
import styles from './ProjectCard.module.css';

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const { canForward, canBackward, forward, backward, inFlight } = useProjectTransition(project);
  const canTransition = usePermission('project:transition');
  const openProject = useOpenProject();
  const config = STATE_CONFIG_MAP[project.status];
  const bold = isAgingBold(project.status, project.statusChangedAt);
  const agingText = getAgingText(project.status, project.statusChangedAt);
  const dateRange = formatDateRange(
    project.plannedStart ?? undefined,
    project.plannedEnd ?? undefined,
  );
  const entryDate = formatDateDE(project.statusChangedAt);

  const handleCardClick = () => {
    openProject(project.id);
  };

  const handleForwardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    forward();
  };

  const handleBackwardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    backward();
  };

  return (
    <div
      className={styles.card}
      onClick={handleCardClick}
      data-testid={`project-card-${project.id}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') handleCardClick();
      }}
    >
      <div className={styles.topRow}>
        <span
          className={styles.dot}
          style={{ backgroundColor: config.color }}
          data-testid={`card-dot-${project.id}`}
        />
        <span className={styles.projectNumber}>{project.number}</span>
      </div>
      <div className={styles.title}>{project.title}</div>
      <div className={styles.customer}>{project.customer?.name ?? '—'}</div>
      <div
        className={dateRange === STRINGS.projects.noDate ? styles.noDates : styles.dates}
        data-testid={`card-dates-${project.id}`}
      >
        {dateRange}
      </div>
      <div
        className={`${styles.entryDate} ${bold ? styles.entryDateBold : ''}`}
        data-testid={`entry-date-${project.id}`}
      >
        {entryDate}
      </div>
      <div className={styles.bottomRow}>
        {agingText ? (
          <span className={styles.agingText} data-testid={`aging-text-${project.id}`}>
            {agingText}
          </span>
        ) : (
          <span />
        )}
        <div className={styles.transitionButtons}>
          {canTransition && canBackward && (
            <button
              className={styles.backwardButton}
              onClick={handleBackwardClick}
              data-testid={`backward-button-${project.id}`}
              aria-label={STRINGS.ui.prevStep}
              disabled={inFlight}
            >
              &larr;
            </button>
          )}
          {canTransition && canForward && (
            <button
              className={styles.forwardButton}
              onClick={handleForwardClick}
              data-testid={`forward-button-${project.id}`}
              aria-label={STRINGS.ui.statusForward(config.label)}
              disabled={inFlight}
            >
              &rarr;
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
