import {
  BRACKET_RULE_CONFIRMED,
  INTERPRETATION_SCALE,
  SCALE_MAX,
  SCALE_MIN,
  interpretConcentration,
} from '../src/modules/reference-data/interpretation-scale';

/**
 * The scale is laboratory-supplied data, so these tests do two jobs: they
 * assert the transcription is faithful, and they pin the behaviour at every
 * edge where a wrong answer would put an authoritative-sounding word next to
 * a number that does not support it.
 */
describe('the laboratory ppm interpretation scale', () => {
  describe('the transcribed data', () => {
    it('holds the sixteen points the laboratory supplied', () => {
      expect(INTERPRETATION_SCALE).toHaveLength(16);
      expect(SCALE_MIN).toBe(0);
      expect(SCALE_MAX).toBe(1000);
    });

    it('matches the laboratory message verbatim, in order', () => {
      // Typed out again from the technician's message rather than derived
      // from the module, so a mistake in one does not hide in the other.
      expect(
        INTERPRETATION_SCALE.map((p) => [p.concentration, p.interpretation]),
      ).toEqual([
        [0, 'Negative'],
        [10, 'Trace'],
        [20, 'Scanty'],
        [30, 'Very Low'],
        [40, 'Low'],
        [50, 'Mild'],
        [100, 'Moderate'],
        [150, 'Moderately High'],
        [200, 'High'],
        [250, 'Very High'],
        [300, 'Heavy'],
        [350, 'Very Heavy'],
        [400, 'Severe'],
        [450, 'Very Severe'],
        [500, 'Intense'],
        [1000, 'Extremely High'],
      ]);
    });

    it('ascends, which the lookup depends on', () => {
      const values = INTERPRETATION_SCALE.map((p) => p.concentration);
      expect(values).toEqual([...values].sort((a, b) => a - b));
      expect(new Set(values).size).toBe(values.length);
    });

    it('uses no wording that also names a reference chart patch', () => {
      // The collision this scale exposed: the illustrative chart called
      // 10 ppm "Very High Level" while this scale calls 10 ppm "Trace".
      // Chart patches are now described by colour, so the two vocabularies
      // must stay disjoint. A shared word here would reopen the trap.
      const chartPatchWords = ['patch', 'blue', 'white', 'colourless'];
      for (const point of INTERPRETATION_SCALE) {
        const lowered = point.interpretation.toLowerCase();
        for (const word of chartPatchWords) {
          expect(lowered).not.toContain(word);
        }
      }
    });
  });

  describe('a value exactly on a point', () => {
    it.each(INTERPRETATION_SCALE.map((p) => [p.concentration, p.interpretation]))(
      '%s ppm reads as "%s" with no caveats',
      (concentration, interpretation) => {
        const result = interpretConcentration(concentration as number);
        expect(result.interpretation).toBe(interpretation);
        expect(result.exact).toBe(true);
        expect(result.bracket).toBeNull();
        expect(result.aboveScale).toBe(false);
        expect(result.caveats).toEqual([]);
      },
    );
  });

  describe('a value between two points', () => {
    it('takes the highest point reached and reports the bracket', () => {
      const result = interpretConcentration(15);
      expect(result.interpretation).toBe('Trace');
      expect(result.matchedConcentration).toBe(10);
      expect(result.exact).toBe(false);
      expect(result.bracket).toEqual({
        lower: { concentration: 10, interpretation: 'Trace' },
        upper: { concentration: 20, interpretation: 'Scanty' },
      });
    });

    it('never rounds upward into a more alarming word', () => {
      // 249 ppm is one short of "Very High". Rounding to nearest would word
      // it as "Very High"; that would overstate the result by one grade on a
      // scale a reader will take at face value.
      const result = interpretConcentration(249);
      expect(result.interpretation).toBe('High');
      expect(result.matchedConcentration).toBe(200);
    });

    it('handles the wide gap between the top two points', () => {
      const result = interpretConcentration(900);
      expect(result.interpretation).toBe('Intense');
      expect(result.matchedConcentration).toBe(500);
      expect(result.bracket?.upper.concentration).toBe(1000);
      expect(result.aboveScale).toBe(false);
    });

    it('words a value just above zero as "Negative", and says why', () => {
      // Worth pinning: 0 is the only point below 10, so anything in (0, 10)
      // inherits "Negative". The caveat is what stops that reading as a
      // clean negative result.
      const result = interpretConcentration(4);
      expect(result.interpretation).toBe('Negative');
      expect(result.exact).toBe(false);
      expect(result.caveats[0]).toContain('between');
      expect(result.caveats[0]).toContain('10');
    });

    it('flags that the between-points rule is ours, not the laboratory’s', () => {
      expect(BRACKET_RULE_CONFIRMED).toBe(false);
      const result = interpretConcentration(15);
      expect(result.caveats.join(' ')).toContain('not yet confirmed');
    });
  });

  describe('a value the scale cannot describe', () => {
    it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
      'returns no wording for %p',
      (value) => {
        const result = interpretConcentration(value as number | null);
        expect(result.interpretation).toBeNull();
        expect(result.matchedConcentration).toBeNull();
        expect(result.caveats).toHaveLength(1);
      },
    );

    it('refuses a negative concentration rather than clamping it to zero', () => {
      // Clamping would word -5 ppm as "Negative", which reads as a clean
      // result when the real situation is a broken input.
      const result = interpretConcentration(-5);
      expect(result.interpretation).toBeNull();
      expect(result.caveats[0]).toContain('not a measurement');
    });

    it('refuses a value in a unit the scale is not defined in', () => {
      const result = interpretConcentration(200, 'mg/kg');
      expect(result.interpretation).toBeNull();
      expect(result.caveats[0]).toContain('no conversion');
    });

    it('accepts the unit in any casing or padding', () => {
      expect(interpretConcentration(200, ' PPM ').interpretation).toBe('High');
    });
  });

  describe('a value above the top of the scale', () => {
    it('words it as the top point and says it is above the scale', () => {
      const result = interpretConcentration(5000);
      expect(result.interpretation).toBe('Extremely High');
      expect(result.matchedConcentration).toBe(1000);
      expect(result.aboveScale).toBe(true);
      expect(result.exact).toBe(false);
      expect(result.caveats[0]).toContain('above the highest point');
    });

    it('does not mark 1000 itself as above the scale', () => {
      const result = interpretConcentration(1000);
      expect(result.aboveScale).toBe(false);
      expect(result.exact).toBe(true);
    });
  });

  describe('what this scale must never be used for', () => {
    it('has no entry point that accepts a colour, a ΔE or a band', () => {
      // The whole risk is a colour-derived number being passed through here
      // and coming out in laboratory language. The only required argument is
      // a concentration; `unit` is defaulted, which is why arity reads as 1
      // (Function.length stops at the first defaulted parameter). If someone
      // adds a band or a ΔE parameter, this is the test that should fail.
      expect(interpretConcentration).toHaveLength(1);
    });

    it('produces nothing at all for the screening path', () => {
      // Image-derived analyses carry estimatedConcentration: null. Feeding
      // that through must yield no wording whatsoever.
      expect(interpretConcentration(null).interpretation).toBeNull();
    });
  });
});
