import { describe, expect, it } from 'vitest';
import { formatConcentration } from './format';

describe('formatConcentration', () => {
  it('writes every level of the laboratory scale as a whole number', () => {
    const scale = [0, 10, 20, 30, 40, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 1000];
    for (const ppm of scale) {
      expect(formatConcentration(ppm)).toBe(String(ppm));
    }
  });

  it('drops the trailing zeros Postgres numeric(14,6) brings back', () => {
    // "350.000000" parsed is 350; the risk is anything that renders the raw
    // string, which would claim six digits of precision the chart lacks.
    expect(formatConcentration(Number('350.000000'))).toBe('350');
    expect(formatConcentration(350.0)).toBe('350');
  });

  it('absorbs floating-point noise', () => {
    expect(formatConcentration(350.0000000001)).toBe('350');
    expect(formatConcentration(9.999999999)).toBe('10');
  });

  it('keeps a real decimal from a laboratory measurement', () => {
    // 12.5 ppm from a validated method is a genuine number. Rounding it to
    // 13 would be inventing precision in the other direction.
    expect(formatConcentration(12.5)).toBe('12.5');
    expect(formatConcentration(0.25)).toBe('0.25');
  });

  it('does not print a number it was not given', () => {
    expect(formatConcentration(Number.NaN)).toBe('—');
    expect(formatConcentration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
