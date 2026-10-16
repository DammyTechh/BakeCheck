import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InterpretationScalePanel } from './InterpretationScale';
import type { InterpretationScale } from '../lib/types';

/**
 * What the panel actually puts on screen.
 *
 * The unit test above covers which row would be highlighted. This one covers
 * the thing a reader at a showcase will take away: that with no confirmed
 * measurement, the scale is on screen as reference and says so, and no row
 * is lit up as though it were a result.
 */
const SCALE: InterpretationScale = {
  unit: 'ppm',
  min: 0,
  max: 1000,
  provenance: 'Supplied by the laboratory technician on 16 October 2026.',
  bracketRuleConfirmedByLaboratory: false,
  notAColorCalibration: true,
  appliesTo: 'A concentration determined by a validated analytical method.',
  points: [
    { concentration: 0, interpretation: 'Negative' },
    { concentration: 10, interpretation: 'Trace' },
    { concentration: 200, interpretation: 'High' },
    { concentration: 250, interpretation: 'Very High' },
  ],
};

vi.mock('../lib/api', () => ({ api: { get: vi.fn(async () => SCALE) } }));

function mount(concentration: number | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <InterpretationScalePanel appliedToConcentration={concentration} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('the scale panel on screen', () => {
  it('states it is not applied when there is no measurement', async () => {
    mount(null);
    expect(await screen.findByText(/Not applied to this result/i)).toBeTruthy();
    // The reason, not just the disclaimer.
    expect(screen.getByText(/no colour in it/i)).toBeTruthy();
  });

  it('highlights no row when there is no measurement', async () => {
    const { container } = mount(null);
    await screen.findByText('Negative');
    expect(container.querySelectorAll('.scale-row-match')).toHaveLength(0);
    expect(container.querySelector('.scale-list-inactive')).toBeTruthy();
  });

  it('highlights exactly one row for a confirmed measurement', async () => {
    const { container } = mount(249);
    // Wait on the row itself rather than the word "High", which also appears
    // in the footnote about the between-points rule.
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.scale-row-match')).toHaveLength(1),
    );
    const matched = container.querySelectorAll('.scale-row-match');
    // 249 words as "High", never rounded up to "Very High".
    expect(matched[0]!.querySelector('.scale-word')!.textContent).toBe('High');
    expect(matched[0]!.querySelector('.scale-ppm')!.textContent).toBe('200');
    // And the "not applied" notice is gone.
    expect(screen.queryByText(/Not applied to this result/i)).toBeNull();
  });

  it('shows the value alongside the row when it was not an exact point', async () => {
    mount(249);
    expect(await screen.findByText(/this measurement \(249 ppm\)/)).toBeTruthy();
  });

  it('carries the provenance and the unconfirmed-rule note', async () => {
    mount(null);
    expect(await screen.findByText(/16 October 2026/)).toBeTruthy();
    expect(screen.getByText(/has not been confirmed by the laboratory/i)).toBeTruthy();
  });
});
