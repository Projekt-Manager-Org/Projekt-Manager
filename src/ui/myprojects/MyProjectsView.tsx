/**
 * "Meine Projekte" — worker landing surface.
 *
 * Lists projects assigned to the logged-in user, grouped by recency
 * relevance: today, upcoming, then everything else. Each row is a
 * single tap target that deep-links to `/projects/:id` (no modal
 * preview — workers want the action surface immediately on phones).
 *
 * The view is worker-only by route gating (`routes.ts canAccess`); a
 * defensive check here would be redundant (the route guard renders
 * `NotPermittedView` before this component mounts).
 */
import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { useAuthStore } from '@/state/authStore';
import { useProjectStore } from '@/state/projectStore';
import { STATE_CONFIG_MAP } from '@/config/stateConfig';
import { STRINGS } from '@/config/strings';
import { formatDateRange } from '@/domain/dateFormat';
import type { Project } from '@/domain/types';
import styles from './MyProjectsView.module.css';

/**
 * Bucket projects by date relevance. "Today" wins when either planned
 * start or planned end falls on the current calendar day. "Upcoming"
 * is anything with a future plannedStart. The "Other" bucket catches
 * projects with no dates and projects whose dates are in the past —
 * still assigned, still visible, just not the top of the list.
 */
function partitionByRelevance(
  projects: Project[],
  now: Date,
): { today: Project[]; upcoming: Project[]; other: Project[] } {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);

  const today: Project[] = [];
  const upcoming: Project[] = [];
  const other: Project[] = [];

  for (const p of projects) {
    const start = p.plannedStart ? new Date(p.plannedStart) : null;
    const end = p.plannedEnd ? new Date(p.plannedEnd) : null;

    const todayHit =
      (start !== null && start >= startOfDay && start <= endOfDay) ||
      (end !== null && end >= startOfDay && end <= endOfDay) ||
      (start !== null && end !== null && start <= startOfDay && end >= endOfDay);

    if (todayHit) {
      today.push(p);
      continue;
    }
    if (start !== null && start > endOfDay) {
      upcoming.push(p);
      continue;
    }
    other.push(p);
  }

  // Within each bucket, sort by plannedStart ascending; nulls last.
  const byStart = (a: Project, b: Project): number => {
    if (!a.plannedStart && !b.plannedStart) return 0;
    if (!a.plannedStart) return 1;
    if (!b.plannedStart) return -1;
    return new Date(a.plannedStart).getTime() - new Date(b.plannedStart).getTime();
  };
  today.sort(byStart);
  upcoming.sort(byStart);
  other.sort(byStart);

  return { today, upcoming, other };
}

interface ProjectRowProps {
  project: Project;
}

function ProjectRow({ project }: ProjectRowProps) {
  const config = STATE_CONFIG_MAP[project.status];
  const dateRange = formatDateRange(
    project.plannedStart ?? undefined,
    project.plannedEnd ?? undefined,
  );
  return (
    <Link
      to={`/projects/${project.id}`}
      className={styles.row}
      data-testid={`my-project-row-${project.id}`}
    >
      <span className={styles.statusDot} style={{ backgroundColor: config.color }} aria-hidden />
      <div className={styles.rowBody}>
        <div className={styles.rowTitle}>
          <span className={styles.projectNumber}>{project.number}</span>
          <span className={styles.projectName}>{project.title}</span>
        </div>
        <div className={styles.rowMeta}>
          <span className={styles.statusLabel}>{config.label}</span>
          <span className={dateRange === STRINGS.projects.noDate ? styles.noDates : styles.dates}>
            {dateRange}
          </span>
        </div>
        {project.customer && <div className={styles.customer}>{project.customer.name}</div>}
      </div>
    </Link>
  );
}

interface SectionProps {
  title: string;
  projects: Project[];
}

function Section({ title, projects }: SectionProps) {
  if (projects.length === 0) return null;
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        {title} <span className={styles.sectionCount}>({projects.length})</span>
      </h2>
      <ul className={styles.list}>
        {projects.map((p) => (
          <li key={p.id}>
            <ProjectRow project={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MyProjectsView() {
  const authUser = useAuthStore((s) => s.authUser);
  const projects = useProjectStore((s) => s.projects);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const myProjects = useMemo(() => {
    if (!authUser) return [];
    return projects.filter((p) => (p.assignedWorkers ?? []).some((w) => w.userId === authUser.id));
  }, [projects, authUser]);

  const { today, upcoming, other } = useMemo(
    () => partitionByRelevance(myProjects, new Date()),
    [myProjects],
  );

  return (
    <div className={styles.container} data-testid="my-projects-view">
      {myProjects.length === 0 ? (
        <p className={styles.empty}>{STRINGS.ui.myProjectsEmpty}</p>
      ) : (
        <>
          <Section title={STRINGS.ui.myProjectsToday} projects={today} />
          <Section title={STRINGS.ui.myProjectsUpcoming} projects={upcoming} />
          <Section title={STRINGS.ui.myProjectsOther} projects={other} />
        </>
      )}
    </div>
  );
}
