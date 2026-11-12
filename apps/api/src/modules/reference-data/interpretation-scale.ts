/**
 * The laboratory's ppm interpretation scale.
 *
 * Supplied by the laboratory technician on 16 October 2026 as sixteen
 * ppm → wording pairs, from 0 ("Negative") to 1000 ("Extremely High").
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS, AND THE ONE THING IT IS NOT
 * ──────────────────────────────────────────────────────────────────────────
 * This is a *reporting* scale. It turns a concentration that has already been
 * determined into the word the laboratory uses for it. It is a vocabulary.
 *
 * It is NOT a calibration. It says nothing whatsoever about colour. Given a
 * photograph, or a measured colour, or a ΔE to a chart patch, this scale
 * cannot produce a ppm value — there is no colour in it to match against.
 *
 * So it does not unlock concentration reporting, and
 * `estimatedConcentration` stays null for every image-derived result exactly
 * as before. It applies in one situation only: a concentration obtained by a
 * validated analytical method and entered against the sample. Then this scale
 * decides what to call it.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE RANGE CONFLICT — read this before presenting anything
 * ──────────────────────────────────────────────────────────────────────────
 * The seeded reference chart (sampled from an illustration, marked
 * ILLUSTRATIVE) spans 0–10 ppm across six patches. This scale spans 0–1000
 * ppm. They disagree by two orders of magnitude, and the words collided:
 * the chart called 10 ppm "Very High Level", while on this scale 10 ppm is
 * "Trace" and "Very High" means 250 ppm — a 25× overstatement from reading
 * one in terms of the other.
 *
 * The chart's patches were therefore renamed to describe their colour rather
 * than a level, so a colour match can no longer be mistaken for a verdict on
 * this scale. The two vocabularies are now disjoint on purpose. Do not
 * reintroduce a shared word.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * VALUES BETWEEN TWO POINTS
 * ──────────────────────────────────────────────────────────────────────────
 * The laboratory gave discrete points, not ranges, and did not say what to do
 * with 15 ppm. Rather than silently inventing a rule, this module applies the
 * conventional one — the highest point the value reaches or exceeds — AND
 * returns the bracket it sits in, with `exact: false` so a caller can see
 * that the wording was derived rather than read off. `BRACKET_RULE_CONFIRMED`
 * records that the laboratory has not yet confirmed this choice.
 */

/** Unit every point on this scale is expressed in. */
export const SCALE_UNIT = 'ppm';

/**
 * Has the laboratory confirmed how to word a value that falls between two
 * points? Not yet. Flip this only when they have said so in writing.
 */
export const BRACKET_RULE_CONFIRMED = false;

/** Provenance, carried into the API response so it travels with the data. */
export const SCALE_PROVENANCE =
  'Supplied by the laboratory technician on 16 October 2026 as sixteen ' +
  'concentration-to-wording pairs. A reporting vocabulary for a ' +
  'concentration already determined by a validated method — not a ' +
  'colour calibration, and not a regulatory limit.';

export interface ScalePoint {
  /** Concentration at this point, in `SCALE_UNIT`. */
  concentration: number;
  /** The laboratory's wording for it. */
  interpretation: string;
}

/**
 * The scale verbatim. Order is ascending and relied upon below; the test
 * suite asserts it rather than trusting it.
 */
export const INTERPRETATION_SCALE: readonly ScalePoint[] = Object.freeze([
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
] as const satisfies readonly ScalePoint[]);

/** Lowest and highest points the scale defines. */
export const SCALE_MIN = INTERPRETATION_SCALE[0]!.concentration;
export const SCALE_MAX =
  INTERPRETATION_SCALE[INTERPRETATION_SCALE.length - 1]!.concentration;

export interface Interpretation {
  /** The wording to show. Null when the value cannot be worded at all. */
  interpretation: string | null;
  /** The scale point the wording came from, or null. */
  matchedConcentration: number | null;
  /** True when the value landed exactly on a defined point. */
  exact: boolean;
  /**
   * The two points the value sits between, when it sits between two.
   * Null when it was exact, or outside the scale.
   */
  bracket: { lower: ScalePoint; upper: ScalePoint } | null;
  /** True when the value exceeds `SCALE_MAX`. */
  aboveScale: boolean;
  /** Anything a reader needs in order not to over-read the wording. */
  caveats: string[];
}

/**
 * Words a concentration using the laboratory's scale.
 *
 * The input must be a concentration in ppm that was actually determined by a
 * validated analytical method. Passing a colour-derived guess through here
 * would launder it into authoritative-sounding laboratory language, which is
 * the precise failure this whole module is written to avoid. There is no
 * overload that accepts a ΔE or a band.
 */
export function interpretConcentration(
  value: number | null | undefined,
  unit: string = SCALE_UNIT,
): Interpretation {
  const none = (caveat: string): Interpretation => ({
    interpretation: null,
    matchedConcentration: null,
    exact: false,
    bracket: null,
    aboveScale: false,
    caveats: [caveat],
  });

  if (value === null || value === undefined || !Number.isFinite(value)) {
    return none('No concentration has been determined for this sample.');
  }

  // A scale in ppm cannot word a value in mg/kg-of-something-else without an
  // explicit conversion the laboratory has not given us.
  if (unit.trim().toLowerCase() !== SCALE_UNIT) {
    return none(
      `This scale is defined in ${SCALE_UNIT}. The value supplied is in ` +
        `${unit}, and no conversion between the two has been established.`,
    );
  }

  if (value < SCALE_MIN) {
    return none(
      `A negative concentration (${value}) is not a measurement this scale ` +
        'can describe.',
    );
  }

  if (value > SCALE_MAX) {
    return {
      interpretation: INTERPRETATION_SCALE[INTERPRETATION_SCALE.length - 1]!
        .interpretation,
      matchedConcentration: SCALE_MAX,
      exact: false,
      bracket: null,
      aboveScale: true,
      caveats: [
        `${value} ${SCALE_UNIT} is above the highest point on the scale ` +
          `(${SCALE_MAX} ${SCALE_UNIT}). The wording is the top of the ` +
          'scale, not a description of how far above it the value sits.',
      ],
    };
  }

  const exactPoint = INTERPRETATION_SCALE.find(
    (point) => point.concentration === value,
  );
  if (exactPoint) {
    return {
      interpretation: exactPoint.interpretation,
      matchedConcentration: exactPoint.concentration,
      exact: true,
      bracket: null,
      aboveScale: false,
      caveats: [],
    };
  }

  // Between two points. Take the highest point reached, and say so.
  let lowerIndex = 0;
  for (let i = 0; i < INTERPRETATION_SCALE.length; i += 1) {
    if (INTERPRETATION_SCALE[i]!.concentration <= value) {
      lowerIndex = i;
    } else {
      break;
    }
  }
  const lower = INTERPRETATION_SCALE[lowerIndex]!;
  const upper = INTERPRETATION_SCALE[lowerIndex + 1]!;

  const caveats = [
    `${value} ${SCALE_UNIT} falls between the scale's ` +
      `${lower.concentration} (${lower.interpretation}) and ` +
      `${upper.concentration} (${upper.interpretation}) points. It is ` +
      `reported as "${lower.interpretation}" because that is the highest ` +
      'point the value reaches.',
  ];
  if (!BRACKET_RULE_CONFIRMED) {
    caveats.push(
      'The laboratory supplied discrete points and has not yet confirmed ' +
        'how a value between two of them should be worded, so this rule is ' +
        'ours rather than theirs.',
    );
  }

  return {
    interpretation: lower.interpretation,
    matchedConcentration: lower.concentration,
    exact: false,
    bracket: { lower, upper },
    aboveScale: false,
    caveats,
  };
}
