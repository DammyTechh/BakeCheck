/**
 * One analysis, in full.
 *
 * The design's version of this screen led with a large red "Critical". That
 * is a stronger statement than the data supports: the result is the nearest
 * band on a chart that is still marked illustrative, with no confirmed
 * measurement behind it. So the headline here states what was observed, the
 * qualifier says what that does and does not mean, and the reference ladder
 * shows the reader how close the call actually was.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { analysisClaim, modeExplanation, modeLabel } from '../lib/claims';
import type { Analysis, ReferenceChart } from '../lib/types';
import { PageHead } from '../components/AppShell';
import { ReferenceLadder, type LadderBand } from '../components/ReferenceLadder';
import { InterpretationScalePanel } from '../components/InterpretationScale';
import {
  Banner,
  Button,
  DataList,
  ErrorNote,
  Icon,
  Panel,
  Pill,
  Spinner,
} from '../components/ui';
import { SampleImage } from '../components/SampleImage';
import { formatDateTime } from '../lib/format';
import './AnalysisDetail.css';

export function AnalysisDetail() {
  const { analysisId = '' } = useParams();

  const analysisQuery = useQuery({
    queryKey: ['analysis', analysisId],
    queryFn: () => api.get<Analysis>(`/analyses/${analysisId}`),
  });

  const analysis = analysisQuery.data;

  // The chart is fetched separately so the ladder can show every band, not
  // just the ones that happened to be returned as alternatives.
  const chartQuery = useQuery({
    queryKey: ['reference-chart', analysis?.referenceChart?.id],
    queryFn: () => api.get<ReferenceChart>(`/reference-charts/${analysis!.referenceChart!.id}`),
    enabled: Boolean(analysis?.referenceChart?.id),
  });

  if (analysisQuery.isLoading) return <Spinner label="Loading the analysis…" />;
  if (analysisQuery.error) return <ErrorNote error={analysisQuery.error} />;
  if (!analysis) return null;

  const claim = analysisClaim(analysis);
  const { prediction, imageQuality, measuredColor, model, testMethod } = analysis;

  const bands: LadderBand[] =
    chartQuery.data?.levels.map((level) => ({
      id: level.id,
      label: level.label,
      concentrationValue: level.concentrationValue,
      rgb: level.colorRgb,
    })) ?? [];

  return (
    <>
      <PageHead
        breadcrumb={[
          { label: 'Results', to: '/results' },
          { label: analysis.sampleCode, to: `/samples/${analysis.sampleId}` },
        ]}
        title="Analysis"
        actions={
          <Button icon="print" onClick={() => window.print()} type="button">
            Print
          </Button>
        }
      />

      <div className="split">
        <div className="stack-lg">
          {/* ── The claim ───────────────────────────────────────────────── */}
          <Panel>
            <div className="verdict">
              <div className="verdict-top">
                <div>
                  <p className="verdict-eyebrow">
                    {claim.strength === 'confirmed'
                      ? 'Confirmed measurement'
                      : claim.strength === 'screening'
                        ? 'Observed colour'
                        : 'No reading'}
                  </p>
                  <h2 className="verdict-headline">{claim.headline}</h2>
                </div>
                <Pill
                  tone={
                    imageQuality.verdict === 'USABLE'
                      ? 'ok'
                      : imageQuality.verdict === 'MARGINAL'
                        ? 'caution'
                        : 'stop'
                  }
                  icon={
                    imageQuality.verdict === 'USABLE' ? 'check_circle' : 'warning'
                  }
                >
                  Image {imageQuality.verdict.toLowerCase()}
                </Pill>
              </div>

              <p className="verdict-qualifier">{claim.qualifier}</p>

              <div className="verdict-figures">
                <Figure
                  label="Concentration"
                  value={
                    claim.concentration
                      ? `${claim.concentration.value} ${claim.concentration.unit}`
                      : null
                  }
                  absent="Not reported"
                  note={
                    claim.concentration
                      ? undefined
                      : 'Requires a validated method and chart.'
                  }
                />
                <Figure
                  label="Confidence"
                  value={
                    claim.confidence === null
                      ? null
                      : `${Math.round(claim.confidence * 100)}%`
                  }
                  absent="Not applicable"
                  note={
                    claim.confidence === null
                      ? 'A colour distance is not a probability.'
                      : undefined
                  }
                />
                <Figure
                  label="Colour distance"
                  value={claim.distance === null ? null : `ΔE ${claim.distance.toFixed(1)}`}
                  absent="—"
                  note={
                    claim.distance !== null && claim.distance > 5
                      ? 'A visible difference from the band.'
                      : undefined
                  }
                />
              </div>
            </div>
          </Panel>

          {/* ── The ladder ──────────────────────────────────────────────── */}
          {claim.strength === 'screening' || claim.strength === 'confirmed' ? (
            <Panel
              title="Where this colour sat on the chart"
              description={
                analysis.referenceChart
                  ? `${chartQuery.data?.name ?? 'Reference chart'} · version ${analysis.referenceChart.version}`
                  : undefined
              }
            >
              {chartQuery.isLoading ? (
                <Spinner label="Loading the reference chart…" />
              ) : bands.length > 0 ? (
                <ReferenceLadder
                  bands={bands}
                  matchedId={prediction.referenceLevelId}
                  measuredRgb={measuredColor?.rgbMedian ?? null}
                  distance={prediction.colorDistance}
                  alternatives={prediction.alternatives}
                  unit={prediction.referenceUnit ?? 'ppm'}
                />
              ) : (
                <p className="muted">
                  The reference chart for this analysis is unavailable.
                </p>
              )}
            </Panel>
          ) : null}

          {/* ── Limitations ─────────────────────────────────────────────── */}
          {claim.limitations.length > 0 ? (
            <Panel title="What limits this result">
              <ul className="limits">
                {claim.limitations.map((limitation) => (
                  <li key={limitation}>
                    <Icon name="info" className="icon-sm limits-icon" />
                    <span>{limitation}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
        </div>

        {/* ── Side column ───────────────────────────────────────────────── */}
        <div className="stack-lg">
          <Panel title="Image" padded={false}>
            <SampleImage imageId={analysis.sampleImageId} alt={`Sample ${analysis.sampleCode}`} />
            {imageQuality.warnings.length > 0 ? (
              <div className="image-warnings">
                {imageQuality.warnings.map((warning) => (
                  <div className="image-warning" key={warning.code}>
                    <Icon
                      name={warning.severity === 'critical' ? 'error' : 'info'}
                      className={`icon-sm warn-${warning.severity}`}
                    />
                    <span>{warning.message}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </Panel>

          <Panel title="How this was produced">
            <DataList
              items={[
                { label: 'Method', value: modeLabel(analysis.mode) },
                { label: 'Sample', value: analysis.sampleCode, mono: true },
                {
                  label: 'Test method',
                  value: `${testMethod.code} ${testMethod.version}`,
                  mono: true,
                },
                { label: 'Analyte', value: testMethod.targetAnalyte },
                {
                  label: 'Method status',
                  value: <Pill tone={testMethod.validationStatus === 'VALIDATED' ? 'ok' : 'caution'}>
                    {testMethod.validationStatus}
                  </Pill>,
                },
                ...(analysis.referenceChart
                  ? [
                      {
                        label: 'Chart status',
                        value: (
                          <Pill
                            tone={
                              analysis.referenceChart.validationStatus === 'VALIDATED'
                                ? 'ok'
                                : 'caution'
                            }
                          >
                            {analysis.referenceChart.validationStatus}
                          </Pill>
                        ),
                      },
                    ]
                  : []),
                {
                  label: 'Model',
                  value: model.name ? `${model.name} ${model.version ?? ''}` : '—',
                  mono: true,
                },
                {
                  label: 'Model validated',
                  value: <Pill tone={model.validated ? 'ok' : 'caution'}>
                    {model.validated ? 'Yes' : 'No'}
                  </Pill>,
                },
                { label: 'Analysed', value: formatDateTime(analysis.createdAt) },
                ...(measuredColor?.roi
                  ? [
                      {
                        label: 'Region measured',
                        value: `${measuredColor.roi.width} x ${measuredColor.roi.height} px`,
                        mono: true,
                      },
                    ]
                  : []),
              ]}
            />
            <p className="mode-note">{modeExplanation(analysis.mode)}</p>
          </Panel>

          {/* Shown whether or not a concentration exists. With none, it is
              the clearest available answer to "the lab gave us a ppm scale,
              so where is the ppm?" — the scale itself, marked as not
              applied. */}
          <InterpretationScalePanel />

          {!analysis.isConfirmedMeasurement ? (
            <Banner tone="caution" icon="science" title="Not a confirmed result">
              <p>
                Nothing here has been checked against a laboratory measurement.
                To act on this sample, run a confirmatory analysis and record
                the value against it.
              </p>
              <p>
                <Link to={`/samples/${analysis.sampleId}`}>
                  Open the sample to record one
                </Link>
              </p>
            </Banner>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * One figure, which may legitimately have no value.
 *
 * Absence is rendered as a word plus the reason, never as 0 or a dash that
 * could be mistaken for a measured zero.
 */
function Figure({
  label,
  value,
  absent,
  note,
}: {
  label: string;
  value: string | null;
  absent: string;
  note?: string;
}) {
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      {value === null ? (
        <span className="figure-absent">{absent}</span>
      ) : (
        <span className="figure-value mono">{value}</span>
      )}
      {note ? <span className="figure-note">{note}</span> : null}
    </div>
  );
}
