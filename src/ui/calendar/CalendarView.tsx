import { useState } from 'react';
import { addMonths, subMonths, addWeeks, subWeeks, startOfWeek, endOfWeek, format } from 'date-fns';
import { LOCALE } from '@/config/localeConfig';
import { useProjectStore } from '@/state/projectStore';
import { useUIStore } from '@/state/uiStore';
import { useRouterNav, pathFromView } from '@/hooks/useRouterNav';
import { STRINGS } from '@/config/strings';
import { CalendarGrid } from './CalendarGrid';
import styles from './CalendarView.module.css';

type CalendarViewMode = 'month' | 'week';

export function CalendarView() {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const projects = useProjectStore((s) => s.projects);
  const getSummary = useProjectStore((s) => s.getSummary);
  const { navigateTo } = useRouterNav();

  const summary = getSummary();

  let navigationLabel: string;
  if (viewMode === 'week') {
    const weekStart = startOfWeek(currentMonth, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(currentMonth, { weekStartsOn: 1 });
    const startStr = format(weekStart, 'dd.MM.', { locale: LOCALE.dateFns });
    const endStr = format(weekEnd, 'dd.MM.yyyy', { locale: LOCALE.dateFns });
    navigationLabel = `${startStr} – ${endStr}`;
  } else {
    const label = format(currentMonth, 'MMMM yyyy', { locale: LOCALE.dateFns });
    navigationLabel = label.charAt(0).toUpperCase() + label.slice(1);
  }

  // Only show projects with at least plannedStart.
  const calendarProjects = projects.filter((p) => p.plannedStart);

  const setFilterNoDates = useUIStore((s) => s.setFilterNoDates);

  const handleNoDatesClick = () => {
    // Switch to kanban and apply the "no dates" filter so only projects
    // missing both planned dates are visible. Order matters: navigateTo
    // calls setView which clears filters, so the filter must be set AFTER
    // the navigation.
    navigateTo(pathFromView('kanban'));
    setFilterNoDates(true);
  };

  const handlePrev = () => {
    setCurrentMonth(viewMode === 'week' ? subWeeks(currentMonth, 1) : subMonths(currentMonth, 1));
  };
  const handleNext = () => {
    setCurrentMonth(viewMode === 'week' ? addWeeks(currentMonth, 1) : addMonths(currentMonth, 1));
  };

  return (
    <div className={styles.container} data-testid="calendar-view">
      <div className={styles.navigation}>
        <button className={styles.navButton} onClick={handlePrev} data-testid="calendar-prev">
          &larr;
        </button>
        <span className={styles.monthLabel} data-testid="calendar-month-label">
          {navigationLabel}
        </span>
        <button className={styles.navButton} onClick={handleNext} data-testid="calendar-next">
          &rarr;
        </button>
        <div className={styles.viewToggle} data-testid="calendar-view-toggle">
          <button
            className={`${styles.toggleButton} ${viewMode === 'month' ? styles.toggleActive : ''}`}
            onClick={() => setViewMode('month')}
            data-testid="calendar-toggle-month"
          >
            {STRINGS.ui.viewMonth}
          </button>
          <button
            className={`${styles.toggleButton} ${viewMode === 'week' ? styles.toggleActive : ''}`}
            onClick={() => setViewMode('week')}
            data-testid="calendar-toggle-week"
          >
            {STRINGS.ui.viewWeek}
          </button>
        </div>
      </div>
      <CalendarGrid month={currentMonth} projects={calendarProjects} view={viewMode} />
      {summary.projectsWithoutDates > 0 && (
        <div
          className={styles.noDatesCounter}
          onClick={handleNoDatesClick}
          data-testid="no-dates-counter"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') handleNoDatesClick();
          }}
        >
          {STRINGS.ui.projectsNoDates(summary.projectsWithoutDates)}
        </div>
      )}
    </div>
  );
}
