/**
 * The laboratory's ppm interpretation scale, shown as reference.
 *
 * This panel exists to answer a question out loud rather than leave someone
 * to answer it wrongly: the laboratory has a sixteen-point ppm scale, so why
 * does the result screen show no ppm?
 *
 * Because the scale has no colour in it. It words a concentration that has
 * already been determined by a validated method. It cannot be run backwards
 * from a photograph, and showing it beside a colour match without saying so
 * would invite exactly the inference it cannot support.
 *
 * So the panel renders the scale greyed and explicitly marked as not applied,
 * unless a confirmed laboratory measurement exists — in which case the API
 * has already worded that measurement and the matching row is highlighted.
 */
import { useQuery } from '@tanstack/react-query';
import { Icon, Panel, Spinner } from './ui';
import { api } from '../lib/api';
import type { InterpretationScale as Scale, ScalePoint } from '../lib/types';
import './InterpretationScale.css';

/**
 * Which row a confirmed concentration falls on: the highest point it reaches.
 *
 * This duplicates `interpretConcentration` on the server, which is a real
 * hazard — if the two drift, the highlighted row would name a different word
 * from the one the API returned for the same measurement. Exported and tested
 * against the same cases for that reason.
 *
 * Returns -1 when nothing should be highlighted: no value, a negative one, or
 * a value above the top of the scale (the API words that as the top point but
 * flags `aboveScale`, and highlighting the row would hide the flag).
 */
export function matchedPointIndex(
  points: readonly ScalePoint[],
  value: number | null,
): number {
  if (value === null || !Number.isFinite(value)) return -1;
  if (points.length === 0) return -1;
  if (value < points[0]!.concentration) return -1;
  if (value > points[points.length - 1]!.concentration) return -1;

  let match = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (points[i]!.concentration <= value) match = i;
    else break;
  }
  return match;
}

export function InterpretationScalePanel({
  /** Set only when a validated measurement produced this value. */
  appliedToConcentration = null,
}: {
  appliedToConcentration?: number | null;
}) {
  const query = useQuery({
    queryKey: ['interpretation-scale'],
    queryFn: () => api.get<Scale>('/reference-data/interpretation-scale'),
    // Laboratory-supplied constant. Fetch once per session.
    staleTime: Infinity,
  });

  if (query.isPending) return <Spinner label="Loading the scale" />;
  if (query.isError || !query.data) return null;

  const scale = query.data;
  const applied = appliedToConcentration !== null;

  // The row a confirmed value falls on: the highest point it reaches. Kept
  // identical to the server rule on purpose — if the two ever disagree, the
  // highlight would point at a different word from the one the API returned.
  const matchedIndex = matchedPointIndex(scale.points, appliedToConcentration);

  return (
    <Panel
      title="Laboratory interpretation scale"
      description={`${scale.points.length} points, ${scale.min}–${scale.max} ${scale.unit}`}
    >
      {!applied ? (
        <div className="scale-notice">
          <Icon name="info" />
          <div>
            <strong>Not applied to this result.</strong>
            <p>
              This scale turns a concentration into the laboratory&rsquo;s
              wording for it. There is no colour in it, so a photograph cannot
              be read against it. It is shown here as reference only.
            </p>
          </div>
        </div>
      ) : null}

      <ol className={`scale-list${applied ? '' : ' scale-list-inactive'}`}>
        {scale.points.map((point, index) => (
          <li
            key={point.concentration}
            className={index === matchedIndex ? 'scale-row scale-row-match' : 'scale-row'}
            aria-current={index === matchedIndex ? 'true' : undefined}
          >
            <span className="scale-ppm mono">{point.concentration}</span>
            <span className="scale-word">{point.interpretation}</span>
            {index === matchedIndex ? (
              <span className="scale-flag">
                {point.concentration === appliedToConcentration
                  ? 'this measurement'
                  : `this measurement (${appliedToConcentration} ${scale.unit})`}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="scale-provenance">{scale.provenance}</p>

      {!scale.bracketRuleConfirmedByLaboratory ? (
        <p className="scale-provenance">
          The laboratory supplied discrete points, not ranges. A value between
          two of them is worded with the highest point it reaches, so 249{' '}
          {scale.unit} reads as <em>High</em> rather than <em>Very High</em>.
          That rule is ours and has not been confirmed by the laboratory.
        </p>
      ) : null}
    </Panel>
  );
}
