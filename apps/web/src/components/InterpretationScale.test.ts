import { describe, expect, it } from 'vitest';
import { matchedPointIndex } from './InterpretationScale';
import type { ScalePoint } from '../lib/types';

/**
 * The highlight must name the same word the API did for the same value.
 *
 * `matchedPointIndex` duplicates the server's `interpretConcentration`, so
 * these are the server's own cases, repeated here. If one side changes its
 * rule, this file is what should go red.
 */
const POINTS: ScalePoint[] = [
  { concentration: 0, interpretation: 'Negative' },
  { concentration: 10, interpretation: 'Trace' },
  { concentration: 20, interpretation: 'Scanty' },
  { concentration: 30, interpretation: 'Very Low' },
  { concentration: 40, interpretation: 'Low' },
  { concentration: 50, interpretation: 'Mild' },
  { concentration: 100, interpretation: 'Moderate' },
  { concentration: 150, interpretation: 'Moderately High' },
  { concentration: 200, interpretation: 'High' },
  { concentration: 250, interpretation: 'Very High' },
  { concentration: 300, interpretation: 'Heavy' },
  { concentration: 350, interpretation: 'Very Heavy' },
  { concentration: 400, interpretation: 'Severe' },
  { concentration: 450, interpretation: 'Very Severe' },
  { concentration: 500, interpretation: 'Intense' },
  { concentration: 1000, interpretation: 'Extremely High' },
];

const wordFor = (value: number | null): string | null => {
  const index = matchedPointIndex(POINTS, value);
  return index === -1 ? null : POINTS[index]!.interpretation;
};

describe('which scale row a measurement highlights', () => {
  it('lands on the exact point when the value is one', () => {
    for (const point of POINTS) {
      expect(wordFor(point.concentration)).toBe(point.interpretation);
    }
  });

  it('takes the highest point reached, never rounding up a grade', () => {
    // Same case the server test pins: 249 is "High", not "Very High".
    expect(wordFor(249)).toBe('High');
    expect(wordFor(15)).toBe('Trace');
    expect(wordFor(900)).toBe('Intense');
    expect(wordFor(4)).toBe('Negative');
  });

  it('highlights nothing when there is no measurement', () => {
    expect(wordFor(null)).toBeNull();
    expect(matchedPointIndex(POINTS, Number.NaN)).toBe(-1);
  });

  it('highlights nothing for a negative value', () => {
    // Clamping to "Negative" would present a broken input as a clean result.
    expect(wordFor(-5)).toBeNull();
  });

  it('highlights nothing above the top of the scale', () => {
    // The API words 5000 as "Extremely High" but sets aboveScale. Lighting up
    // that row would present it as an ordinary in-range match and bury the
    // flag, so the row stays unhighlighted and the caveat carries it.
    expect(wordFor(5000)).toBeNull();
    expect(wordFor(1000)).toBe('Extremely High');
  });

  it('does not throw on an empty scale', () => {
    expect(matchedPointIndex([], 200)).toBe(-1);
  });
});
