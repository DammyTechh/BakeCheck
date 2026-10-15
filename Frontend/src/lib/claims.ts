/**
 * What the interface is allowed to say about a result.
 *
 * The backend is careful: it returns `estimatedConcentration: null` unless
 * the method, the chart and the model are all validated, and
 * `confidence: null` whenever the answer came from colour matching rather
 * than a trained model. A front end can throw all of that away with one
 * `?? 0` or a confident headline, and the person reading the screen would
 * never know.
 *
 * So the decision is made once, here, as a pure function over the response —
 * and tested. Screens render a Claim; they do not interpret an Analysis.
 *
 * The distinction this file exists to preserve: BakeCheck observes a colour
 * and reports which reference band that colour is nearest. It does not
 * measure bromate. Those are different statements and only the first one is
 * true.
 */
import type { Analysis } from './types';

export type ClaimStrength =
  /** A confirmed laboratory measurement is attached to this sample. */
  | 'confirmed'
  /** A colour was measured and matched against a chart. No concentration. */
  | 'screening'
  /** The image could not be measured. There is no reading at all. */
  | 'unmeasurable'
  /** The analysis itself failed. */
  | 'failed';

export interface Claim {
  strength: ClaimStrength;
  /** The headline. Describes what was observed, never what the sample "is". */
  headline: string;
  /** One sentence qualifying the headline. Always present. */
  qualifier: string;
  /** Shown only when a validated chain genuinely produced a number. */
  concentration: { value: number; unit: string } | null;
  /** Null for reference matching — a colour distance is not a probability. */
  confidence: number | null;
  /** How far the measured colour sat from the band it matched, in ΔE. */
  distance: number | null;
  /** True when the colour sat beyond the ends of the chart. */
  outOfRange: boolean;
  /** True when the runner-up band was nearly as close as the match. */
  ambiguous: boolean;
  /** Everything limiting this result, deduplicated and ordered. */
  limitations: string[];
  /** Whether the UI may use status colour at all for this result. */
  tone: 'neutral' | 'caution' | 'stop';
}

/**
 * How close a runner-up has to be before a match is called ambiguous.
 *
 * CIEDE2000 is built so that ~1.0 is a just-noticeable difference. If the
 * second-best band is within 2 ΔE of the best, the two are closer to each
 * other than a person could reliably tell apart, and presenting the winner
 * alone would overstate how clear the call was.
 */
export const AMBIGUOUS_DELTA_E = 2.0;

/**
 * Above this, the measured colour is not really *on* any band.
 *
 * ~5 ΔE is a difference anyone would describe as a different colour. A match
 * reported at 12 ΔE means "nearest of a bad set", and saying so matters more
 * than the label does.
 */
export const LOOSE_MATCH_DELTA_E = 5.0;

function sentenceList(items: string[]): string[] {
  // Preserve order, drop exact repeats — the API can legitimately report the
  // same limitation from two stages.
  return [...new Set(items.filter((s) => s.trim().length > 0))];
}

export function analysisClaim(analysis: Analysis): Claim {
  const { prediction, imageQuality, testMethod, referenceChart, model } = analysis;
  const limitations = sentenceList(analysis.limitations);

  if (analysis.status === 'FAILED') {
    return {
      strength: 'failed',
      headline: 'Analysis did not finish',
      qualifier:
        analysis.errorMessage ??
        'Something went wrong while processing this image. Upload it again.',
      concentration: null,
      confidence: null,
      distance: null,
      outOfRange: false,
      ambiguous: false,
      limitations,
      tone: 'neutral',
    };
  }

  if (analysis.status === 'REJECTED_QUALITY' || imageQuality.verdict === 'UNUSABLE') {
    const critical = imageQuality.warnings.filter((w) => w.severity === 'critical');
    return {
      strength: 'unmeasurable',
      headline: 'This image could not be measured',
      qualifier:
        critical[0]?.message ??
        'The image did not meet the quality needed for a colour reading.',
      concentration: null,
      confidence: null,
      distance: null,
      outOfRange: false,
      ambiguous: false,
      limitations,
      tone: 'caution',
    };
  }

  const distance = prediction.colorDistance;
  const runnerUp = prediction.alternatives[0];
  const ambiguous =
    distance !== null &&
    runnerUp !== undefined &&
    Math.abs(runnerUp.colorDistance - distance) < AMBIGUOUS_DELTA_E;

  const extra: string[] = [];
  if (prediction.outOfRange) {
    extra.push(
      'The measured colour sits beyond the ends of the reference chart, so ' +
        'the nearest band is a boundary rather than a bracket.',
    );
  }
  if (distance !== null && distance > LOOSE_MATCH_DELTA_E) {
    extra.push(
      `The measured colour is ${distance.toFixed(1)} ΔE from the band it ` +
        'matched — a visible difference, so this is the nearest band rather ' +
        'than a close match.',
    );
  }
  if (ambiguous && runnerUp) {
    extra.push(
      `${runnerUp.label} was almost equally close. These two bands cannot be ` +
        'reliably told apart from this image.',
    );
  }

  // A concentration is only ever shown when the backend supplied one, which
  // it does only when the whole chain is validated. The UI never derives it.
  const concentration =
    prediction.estimatedConcentration !== null && prediction.concentrationUnit
      ? { value: prediction.estimatedConcentration, unit: prediction.concentrationUnit }
      : null;

  if (analysis.isConfirmedMeasurement) {
    return {
      strength: 'confirmed',
      headline: prediction.label ?? 'Measured',
      qualifier:
        'Confirmed by a laboratory measurement recorded against this sample.',
      concentration,
      confidence: prediction.confidence,
      distance,
      outOfRange: prediction.outOfRange,
      ambiguous,
      limitations: sentenceList([...limitations, ...extra]),
      tone: 'neutral',
    };
  }

  const chartIsIllustrative =
    referenceChart !== null && referenceChart.validationStatus !== 'VALIDATED';
  const methodIsDraft = testMethod.validationStatus !== 'VALIDATED';

  const qualifier = (() => {
    if (methodIsDraft || chartIsIllustrative) {
      return (
        'Screening observation only. The colour was matched against a chart ' +
        'that has not been validated against known standards, so this names ' +
        'a colour band — not a bromate concentration.'
      );
    }
    if (!model.validated) {
      return (
        'Screening observation only. The model producing this result has not ' +
        'been validated against confirmed measurements.'
      );
    }
    return 'Screening observation. Confirm with a laboratory measurement before acting on it.';
  })();

  return {
    strength: 'screening',
    headline: prediction.label ?? 'No band matched',
    qualifier,
    concentration,
    confidence: prediction.confidence,
    distance,
    outOfRange: prediction.outOfRange,
    ambiguous,
    limitations: sentenceList([...limitations, ...extra]),
    // Deliberately neutral. A screening observation against an unvalidated
    // chart has not earned a red banner, however dark the tube looked.
    tone: imageQuality.verdict === 'MARGINAL' ? 'caution' : 'neutral',
  };
}

/** Human wording for an analysis mode, for a reader who is not an engineer. */
export function modeLabel(mode: Analysis['mode']): string {
  switch (mode) {
    case 'REFERENCE_MATCHING':
      return 'Colour comparison';
    case 'MODEL_INFERENCE':
      return 'Trained model';
    case 'HYBRID':
      return 'Model with colour comparison';
  }
}

export function modeExplanation(mode: Analysis['mode']): string {
  switch (mode) {
    case 'REFERENCE_MATCHING':
      return (
        'The colour in the tube was measured and compared with each band on ' +
        'the reference chart. No model was involved, and the arithmetic can ' +
        'be checked by hand.'
      );
    case 'MODEL_INFERENCE':
      return (
        'A trained model produced this result from the measured colour. The ' +
        'colour comparison is shown alongside it so the two can be compared.'
      );
    case 'HYBRID':
      return 'A trained model and the colour comparison were combined.';
  }
}
