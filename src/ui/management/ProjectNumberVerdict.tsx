import { STRINGS } from '@/config/strings';
import type { NumberPreflightStatus } from '@/hooks/useProjectNumberPreflight';
import styles from './Management.module.css';

interface Props {
  status: NumberPreflightStatus;
  /** The number the verdict is about. */
  number: string;
}

/** Free / taken verdict under a project number field (AC-478). */
export function ProjectNumberVerdict({ status, number }: Props) {
  if (status === 'taken') {
    return (
      <div className={styles.fieldHintError} data-testid="project-number-taken" role="status">
        {STRINGS.projects.numberTaken(number)}
      </div>
    );
  }
  if (status === 'available') {
    return (
      <div className={styles.fieldHintOk} data-testid="project-number-available" role="status">
        {STRINGS.projects.numberAvailable}
      </div>
    );
  }
  return null;
}
