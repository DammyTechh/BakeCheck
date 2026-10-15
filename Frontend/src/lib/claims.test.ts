import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_DELTA_E, analysisClaim } from './claims';
import type { Analysis } from './types';
import real from './__fixtures__/analysis-screening.json';

/**
 * These tests guard one property: the interface must not claim more than the
 * API gave it. Everything the backend is careful about — null concentrations,
 * null confidence, unvalidated charts — can be undone by one hopeful line of
 * presentation code, and nothing else in this app would notice.
 *
 * The base case is a REAL response, captured from the running API after
 * analysing one of the laboratory's own photographs and scrubbed of
 * identifiers. That matters more than it sounds: the first version of this
 * file used a hand-written fixture carrying an `imageQuality.usable` field
 * that the API does not return. `!undefined` is `true`, so every result in
 * the live app rendered as "could not be measured" — while all eighteen
 * tests here passed, because they were written against the same invented
 * shape. A fixture that agrees with the code instead of with the server
 * tests nothing.
 */

const BASE = real as unknown as Analysis;

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return { ...BASE, ...overrides };
}

describe('the fixture is a real API response', () => {
  it('has no `usable` flag, because the API does not send one', () => {
    expect('usable' in BASE.imageQuality).toBe(false);
  });

  it('carries a verdict, which is what usability is derived from', () => {
    expect(['USABLE', 'MARGINAL', 'UNUSABLE']).toContain(BASE.imageQuality.verdict);
  });

  it('is a completed screening result with no concentration', () => {
    expect(BASE.status).toBe('COMPLETED');
    expect(BASE.prediction.estimatedConcentration).toBeNull();
  });

  it('reads as measurable, not as a rejected image', () => {
    // The regression this file exists for.
    expect(analysisClaim(BASE).strength).toBe('screening');
  });
});

describe('what the interface may claim', () => {
  it('never invents a concentration when the API withheld one', () => {
    const claim = analysisClaim(analysis());
    expect(claim.concentration).toBeNull();
  });

  it('never invents a confidence for a colour comparison', () => {
    // A colour distance is not a probability. Showing one would imply the
    // system knows how likely it is to be right, which it does not.
    expect(analysisClaim(analysis()).confidence).toBeNull();
  });

  it('shows a concentration only when the API supplied one with a unit', () => {
    const claim = analysisClaim(
      analysis({
        prediction: {
          ...analysis().prediction,
          estimatedConcentration: 4.2,
          concentrationUnit: 'ppm',
        },
      }),
    );
    expect(claim.concentration).toEqual({ value: 4.2, unit: 'ppm' });
  });

  it('withholds the concentration if a unit is missing', () => {
    // A bare number with no unit is not a measurement.
    const claim = analysisClaim(
      analysis({
        prediction: {
          ...analysis().prediction,
          estimatedConcentration: 4.2,
          concentrationUnit: null,
        },
      }),
    );
    expect(claim.concentration).toBeNull();
  });

  it('says the result names a colour band, not a concentration', () => {
    const claim = analysisClaim(analysis());
    expect(claim.strength).toBe('screening');
    expect(claim.qualifier).toMatch(/not a bromate concentration/i);
  });

  it('stays visually neutral for a screening result, however dark the tube', () => {
    // The mockup put a red "Critical" banner here. An unvalidated chart has
    // not earned one.
    expect(analysisClaim(analysis()).tone).toBe('neutral');
  });

  it('reports a confirmed measurement differently from a screening one', () => {
    const claim = analysisClaim(analysis({ isConfirmedMeasurement: true }));
    expect(claim.strength).toBe('confirmed');
    expect(claim.qualifier).toMatch(/confirmed by a laboratory measurement/i);
  });
});

describe('how close the match actually was', () => {
  it('flags a loose match rather than presenting it as a hit', () => {
    // The real laboratory photographs matched at 9-14 ΔE.
    const claim = analysisClaim(
      analysis({
        prediction: { ...analysis().prediction, colorDistance: 11.9 },
      }),
    );
    expect(claim.limitations.join(' ')).toMatch(/11\.9 ΔE/);
    expect(claim.limitations.join(' ')).toMatch(/nearest band rather than a close match/i);
  });

  it('does not add that caveat for a genuinely close match', () => {
    const claim = analysisClaim(
      analysis({ prediction: { ...analysis().prediction, colorDistance: 1.2 } }),
    );
    expect(claim.limitations.join(' ')).not.toMatch(/nearest band rather than/i);
  });

  it('calls a match ambiguous when the runner-up is nearly as close', () => {
    const claim = analysisClaim(
      analysis({
        prediction: {
          ...analysis().prediction,
          colorDistance: 4.0,
          alternatives: [
            {
              referenceLevelId: 'lv4',
              label: 'Very High Level',
              concentrationValue: 10,
              colorDistance: 4.0 + AMBIGUOUS_DELTA_E - 0.1,
            },
          ],
        },
      }),
    );
    expect(claim.ambiguous).toBe(true);
    expect(claim.limitations.join(' ')).toMatch(/cannot be reliably told apart/i);
  });

  it('does not call a clear win ambiguous', () => {
    const claim = analysisClaim(
      analysis({
        prediction: {
          ...BASE.prediction,
          colorDistance: 2.0,
          alternatives: [
            {
              referenceLevelId: 'lv-other',
              label: 'High Level',
              concentrationValue: 5,
              colorDistance: 9.0,
            },
          ],
        },
      }),
    );
    expect(claim.ambiguous).toBe(false);
  });

  it('calls the real captured result ambiguous, because it is', () => {
    /*
     * Worth pinning down rather than treating as incidental. This is one of
     * the laboratory's own photographs: it matched "Very High Level" at
     * 11.8 ΔE with "High Level" only ~1.6 further away. Both numbers are
     * large, and the gap between them is smaller than a person could judge
     * by eye. Presenting the winner alone would turn a genuinely unclear
     * reading into a confident one.
     */
    const claim = analysisClaim(BASE);
    expect(claim.ambiguous).toBe(true);
    expect(claim.limitations.join(' ')).toMatch(/cannot be reliably told apart/i);
    expect(claim.limitations.join(' ')).toMatch(/nearest band rather than a close match/i);
  });

  it('explains an out-of-range reading as a boundary, not a bracket', () => {
    const claim = analysisClaim(
      analysis({ prediction: { ...analysis().prediction, outOfRange: true } }),
    );
    expect(claim.outOfRange).toBe(true);
    expect(claim.limitations.join(' ')).toMatch(/beyond the ends of the reference chart/i);
  });
});

describe('results that are not readings', () => {
  it('reports an unusable image as unmeasurable, with the reason', () => {
    const claim = analysisClaim(
      analysis({
        status: 'REJECTED_QUALITY',
        imageQuality: {
          verdict: 'UNUSABLE',
          score: 0.2,
          warnings: [
            {
              code: 'blur',
              severity: 'critical',
              message:
                'The image is badly out of focus. Retake it with the tube in sharp focus.',
            },
          ],
        },
      }),
    );
    expect(claim.strength).toBe('unmeasurable');
    expect(claim.qualifier).toMatch(/out of focus/i);
    expect(claim.concentration).toBeNull();
  });

  it('does not present a band for an unusable image', () => {
    // The prediction object may still carry a stale label; the claim must not.
    const claim = analysisClaim(
      analysis({
        status: 'REJECTED_QUALITY',
        imageQuality: { verdict: 'UNUSABLE', score: 0.2, warnings: [] },
      }),
    );
    expect(claim.headline).not.toMatch(/High Level/);
  });

  it('reports a failed analysis without a reading', () => {
    const claim = analysisClaim(
      analysis({ status: 'FAILED', errorMessage: 'The analysis service timed out.' }),
    );
    expect(claim.strength).toBe('failed');
    expect(claim.qualifier).toMatch(/timed out/);
  });
});

describe('limitations', () => {
  it('keeps every limitation the API reported', () => {
    const claim = analysisClaim(
      analysis({ limitations: ['One.', 'Two.', 'Three.'] }),
    );
    expect(claim.limitations).toEqual(expect.arrayContaining(['One.', 'Two.', 'Three.']));
  });

  it('removes duplicates without reordering', () => {
    const claim = analysisClaim(
      analysis({ limitations: ['Same.', 'Other.', 'Same.'], prediction: {
        ...analysis().prediction, colorDistance: 1.0 } }),
    );
    expect(claim.limitations).toEqual(['Same.', 'Other.']);
  });

  it('always gives a qualifier, for every outcome', () => {
    const cases: Analysis[] = [
      analysis(),
      analysis({ isConfirmedMeasurement: true }),
      analysis({ status: 'FAILED' }),
      analysis({
        status: 'REJECTED_QUALITY',
        imageQuality: { verdict: 'UNUSABLE', score: 0, warnings: [] },
      }),
    ];
    for (const a of cases) {
      expect(analysisClaim(a).qualifier.length).toBeGreaterThan(20);
    }
  });
});
