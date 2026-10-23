/**
 * Component test for the CalendarView week label (AC-468): a week
 * within one year shortens its start, a week across New Year does not.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { CalendarView } from '@/ui/calendar/CalendarView';

afterEach(() => {
  vi.useRealTimers();
});

describe('CalendarView — week label (AC-468)', () => {
  it('shortens the start only when the week stays within one year', () => {
    // Thursday; its Monday-start week is 21.–27.12.2026, the next one
    // runs into 2027.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 24, 12));

    render(
      <MemoryRouter>
        <CalendarView />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('calendar-toggle-week'));
    const label = screen.getByTestId('calendar-month-label');
    expect(label.textContent).toBe('21.12. – 27.12.2026');

    fireEvent.click(screen.getByTestId('calendar-next'));
    expect(label.textContent).toBe('28.12.2026 – 03.01.2027');
  });
});
