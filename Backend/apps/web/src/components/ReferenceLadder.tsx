/**
 * The reference ladder: the measured colour placed on the chart it was
 * compared against.
 *
 * This is the one piece of this interface that is not a generic dashboard
 * part, and it is doing real work. A bromate screen is a colorimetric assay —
 * the whole claim is "this blue is nearest that blue" — so showing the ladder
 * with the sample's own colour against it says exactly what happened.
 *
 * It also makes the uncertainty visible instead of hiding it. The mockup put
 * a red "Critical" headline on this screen; a headline cannot show you that
 * the runner-up band was 1.4 ΔE away, or that the colour sat 12 ΔE from
 * anything on the chart. The ladder can, and a technician can judge the call
 * for themselves rather than taking a word for it.
 */
import type { ReferenceCandidate } from '../lib/types';
import './ReferenceLadder.css';

export interface LadderBand {
  id: string;
  label: string;
  concentrationValue: number | null;
  rgb: [number, number, number] | null;
}

function css(rgb: [number, number, number] | null): string {
  return rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : 'transparent';
}

/** Relative luminance, to pick readable text over a swatch. */
function isDark(rgb: [number, number, number] | null): boolean {
  if (!rgb) return false;
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

export function ReferenceLadder({
  bands,
  matchedId,
  measuredRgb,
  distance,
  alternatives = [],
  unit = 'ppm',
}: {
  bands: LadderBand[];
  matchedId: string | null;
  measuredRgb: [number, number, number] | null;
  distance: number | null;
  alternatives?: ReferenceCandidate[];
  unit?: string;
}) {
  const runnerUpIds = new Set(alternatives.slice(0, 1).map((a) => a.referenceLevelId));

  return (
    <div className="ladder">
      {measuredRgb ? (
        <div className="ladder-measured">
          <div
            className="ladder-measured-swatch"
            style={{ background: css(measuredRgb) }}
            // The colour is the content here, so it needs a text equivalent.
            role="img"
            aria-label={`Measured colour, RGB ${measuredRgb.join(', ')}`}
          />
          <div className="ladder-measured-meta">
            <span className="ladder-measured-title">Colour measured in this tube</span>
            <span className="mono ladder-measured-rgb">
              rgb({measuredRgb.join(', ')})
            </span>
          </div>
        </div>
      ) : null}

      <ol className="ladder-bands">
        {bands.map((band) => {
          const matched = band.id === matchedId;
          const runnerUp = runnerUpIds.has(band.id);
          const alt = alternatives.find((a) => a.referenceLevelId === band.id);

          return (
            <li
              key={band.id}
              className={`ladder-band ${matched ? 'is-matched' : ''} ${
                runnerUp ? 'is-runner-up' : ''
              }`}
            >
              <div
                className={`ladder-swatch ${isDark(band.rgb) ? 'is-dark' : ''}`}
                style={{ background: css(band.rgb) }}
                aria-hidden="true"
              />
              <div className="ladder-band-text">
                <span className="ladder-band-label">{band.label}</span>
                <span className="mono ladder-band-conc">
                  {band.concentrationValue === null
                    ? '—'
                    : `${band.concentrationValue} ${unit}`}
                </span>
              </div>
              <div className="ladder-band-mark">
                {matched ? (
                  <span className="ladder-chip ladder-chip-match">
                    Nearest
                    {distance !== null ? (
                      <span className="mono"> ΔE {distance.toFixed(1)}</span>
                    ) : null}
                  </span>
                ) : runnerUp && alt ? (
                  <span className="ladder-chip ladder-chip-next">
                    Next
                    <span className="mono"> ΔE {alt.colorDistance.toFixed(1)}</span>
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="ladder-note">
        ΔE is how far apart two colours are. Around 1 is the smallest
        difference a person can see; 5 or more reads as a different colour
        altogether.
      </p>
    </div>
  );
}
