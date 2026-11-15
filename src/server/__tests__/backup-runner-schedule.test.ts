/**
 * Unit tests for the croner schedule wiring in `backup-runner.ts`
 * (#199 — replaces dcron + `scripts/backup/crontab`). AC-616 [crit]:
 * backups and drills start at their scheduled times.
 *
 * Covers what a typo in the cron expression or a swapped handler
 * dispatch would silently break:
 *   - The 4 jobs are created with the canonical names + patterns
 *     (weekday/weekend × backup/drill).
 *   - Each pattern's next tick at a fixed reference time matches the
 *     schedule in ADR-0020 §Decision — and is computed in Europe/Berlin
 *     local time, not the host TZ.
 *   - Triggering a job invokes the right handler (backup-weekday must
 *     not accidentally call the drill handler).
 *
 * Does NOT cover the actual backup pipeline — that lives in
 * `backup.test.ts` / `backup-drill.test.ts` / the CI smoke job.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildScheduleJobs, SCHEDULES, SCHEDULE_TZ } from '../backup-runner.js';

describe('backup-runner schedule constants', () => {
  it('matches the canonical schedule from ADR-0020 / former scripts/backup/crontab', () => {
    // Lock the cron expressions against ADR-0020 §Decision. A change
    // here is a schedule change — must be paired with an ADR update.
    expect(SCHEDULES).toEqual({
      backupWeekday: '0 9,12,15,18,21 * * 1-5',
      backupWeekend: '0 12 * * 6,0',
      drillWeekday: '2 9,12,15,18,21 * * 1-5',
      drillWeekend: '2 12 * * 6,0',
    });
    expect(SCHEDULE_TZ).toBe('Europe/Berlin');
  });
});

describe('buildScheduleJobs', () => {
  function makeHandlers() {
    return {
      backupHandler: vi.fn<() => Promise<number>>().mockResolvedValue(0),
      drillHandler: vi.fn<() => Promise<number>>().mockResolvedValue(0),
    };
  }

  it('returns four named jobs in the documented order', () => {
    const jobs = buildScheduleJobs(makeHandlers());
    expect(jobs).toHaveLength(4);
    expect(jobs.map((j) => j.name)).toEqual([
      'backup-weekday',
      'backup-weekend',
      'drill-weekday',
      'drill-weekend',
    ]);
    // Clean up so subsequent tests are not racing real timers.
    for (const job of jobs) job.stop();
  });

  it('round-trips the cron patterns via getPattern()', () => {
    const jobs = buildScheduleJobs(makeHandlers());
    expect(jobs[0].getPattern()).toBe(SCHEDULES.backupWeekday);
    expect(jobs[1].getPattern()).toBe(SCHEDULES.backupWeekend);
    expect(jobs[2].getPattern()).toBe(SCHEDULES.drillWeekday);
    expect(jobs[3].getPattern()).toBe(SCHEDULES.drillWeekend);
    for (const job of jobs) job.stop();
  });

  it('computes next-tick in Europe/Berlin local time, not UTC', () => {
    // Pick a reference point where the difference between TZs is
    // unambiguous: Tuesday 2026-06-02 06:00 UTC. In Europe/Berlin
    // that's 08:00 CEST (DST active in June). The backup-weekday
    // pattern fires at 09:00 Berlin = 07:00 UTC on the same day.
    // If the TZ option were missing or wrong, croner would compute
    // the next tick as 09:00 UTC = 11:00 Berlin → wrong by 2h.
    const ref = new Date('2026-06-02T06:00:00Z');
    const jobs = buildScheduleJobs(makeHandlers());
    const next = jobs[0].nextRun(ref);
    expect(next).not.toBeNull();
    expect(next?.toISOString()).toBe('2026-06-02T07:00:00.000Z');
    for (const job of jobs) job.stop();
  });

  it('weekend pattern fires only on Sat/Sun at 12:00 Berlin', () => {
    // Reference: Saturday 2026-06-06 06:00 UTC = 08:00 CEST. Next
    // weekend-backup tick is the SAME DAY at 12:00 Berlin (10:00 UTC).
    const refSat = new Date('2026-06-06T06:00:00Z');
    const jobs = buildScheduleJobs(makeHandlers());
    expect(jobs[1].nextRun(refSat)?.toISOString()).toBe('2026-06-06T10:00:00.000Z');

    // Reference: Monday 2026-06-08 06:00 UTC. Next weekend-backup tick
    // must skip to the following Saturday (2026-06-13 12:00 Berlin =
    // 10:00 UTC), not fire mid-week.
    const refMon = new Date('2026-06-08T06:00:00Z');
    expect(jobs[1].nextRun(refMon)?.toISOString()).toBe('2026-06-13T10:00:00.000Z');
    for (const job of jobs) job.stop();
  });

  it('drill schedule trails the backup schedule by exactly two minutes', () => {
    // Same reference for backup-weekday and drill-weekday next-tick;
    // the difference must be 120s. Catches a "+2 hours instead of
    // +2 minutes" or "wrong offset" typo in the cron pattern.
    const ref = new Date('2026-06-02T06:00:00Z');
    const jobs = buildScheduleJobs(makeHandlers());
    const backupNext = jobs[0].nextRun(ref);
    const drillNext = jobs[2].nextRun(ref);
    expect(backupNext).not.toBeNull();
    expect(drillNext).not.toBeNull();
    expect((drillNext as Date).getTime() - (backupNext as Date).getTime()).toBe(2 * 60 * 1000);
    for (const job of jobs) job.stop();
  });

  it('dispatches backup-weekday and backup-weekend to the backup handler', async () => {
    const handlers = makeHandlers();
    const jobs = buildScheduleJobs(handlers);
    await jobs[0].trigger();
    await jobs[1].trigger();
    expect(handlers.backupHandler).toHaveBeenCalledTimes(2);
    expect(handlers.drillHandler).not.toHaveBeenCalled();
    for (const job of jobs) job.stop();
  });

  it('dispatches drill-weekday and drill-weekend to the drill handler', async () => {
    const handlers = makeHandlers();
    const jobs = buildScheduleJobs(handlers);
    await jobs[2].trigger();
    await jobs[3].trigger();
    expect(handlers.drillHandler).toHaveBeenCalledTimes(2);
    expect(handlers.backupHandler).not.toHaveBeenCalled();
    for (const job of jobs) job.stop();
  });
});
