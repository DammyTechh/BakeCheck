/**
 * What the model is doing, and whether it could learn anything yet.
 *
 * The design's admin dashboard led with a usage chart. That is not the
 * question an administrator of this system actually has — which is whether
 * there is enough confirmed data to train on at all, and what the active
 * model is claiming. Readiness comes first here, and it is allowed to say no.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { AiStatus } from '../../lib/types';
import { PageHead } from '../../components/AppShell';
import { Banner, DataList, ErrorNote, Icon, Panel, Pill, Spinner } from '../../components/ui';
import './AdminOverview.css';

export function AdminOverview() {
  const status = useQuery({
    queryKey: ['ai-status'],
    queryFn: () => api.get<AiStatus>('/ai/status'),
    refetchInterval: 30_000,
  });

  if (status.isLoading) return <Spinner label="Checking the analysis service…" />;
  if (status.error) return <ErrorNote error={status.error} />;
  if (!status.data) return null;

  const { serviceReachable, mode, service, activeModel, dataReadiness } = status.data;
  const readiness = dataReadiness;
  const progress = Math.min(
    1,
    readiness.approvedExamples / Math.max(1, readiness.minimumExamplesForTraining),
  );

  return (
    <>
      <PageHead
        title="Model overview"
        description="What the analysis service is running, and whether there is data to improve it."
      />

      <div className="stack-lg">
        {!serviceReachable ? (
          <Banner tone="stop" icon="cloud_off" title="Analysis service unreachable">
            The API cannot reach the vision service, so no sample can be
            analysed right now.
          </Banner>
        ) : null}

        <div className="split">
          <div className="stack-lg">
            <Panel title="Training readiness">
              <p className="readiness-lead">
                {readiness.approvedExamples} of {readiness.minimumExamplesForTraining}{' '}
                approved examples needed before a model can be trained.
              </p>

              <div
                className="meter"
                role="progressbar"
                aria-valuenow={readiness.approvedExamples}
                aria-valuemin={0}
                aria-valuemax={readiness.minimumExamplesForTraining}
                aria-label="Approved training examples"
              >
                <div className="meter-fill" style={{ width: `${progress * 100}%` }} />
              </div>

              <div className="readiness-grid">
                <Metric
                  label="Approved examples"
                  value={readiness.approvedExamples}
                  icon="dataset"
                />
                <Metric
                  label="Confirmed measurements"
                  value={readiness.confirmedMeasurements}
                  icon="biotech"
                  note="Ground truth from an analytical method."
                />
                <Metric
                  label="Awaiting review"
                  value={readiness.pendingAnnotations}
                  icon="rate_review"
                />
                <Metric
                  label="Dataset versions"
                  value={readiness.datasetVersions}
                  icon="inventory_2"
                />
              </div>

              {readiness.readinessNote ? (
                <Banner tone="caution" icon="info">
                  {readiness.readinessNote}
                </Banner>
              ) : null}
            </Panel>
          </div>

          <div className="stack-lg">
            <Panel title="Active model">
              <DataList
                items={[
                  {
                    label: 'Mode',
                    value:
                      mode === 'REFERENCE_MATCHING' ? 'Colour comparison' : 'Trained model',
                  },
                  { label: 'Name', value: activeModel?.name ?? service?.activeModel?.name ?? '—', mono: true },
                  {
                    label: 'Version',
                    value: activeModel?.version ?? service?.activeModel?.version ?? '—',
                    mono: true,
                  },
                  {
                    label: 'Validated',
                    value: (
                      <Pill tone={service?.activeModel?.validated ? 'ok' : 'caution'}>
                        {service?.activeModel?.validated ? 'Yes' : 'No'}
                      </Pill>
                    ),
                  },
                  {
                    label: 'Pipeline',
                    value: service?.pipelineVersion ?? '—',
                    mono: true,
                  },
                ]}
              />

              {mode === 'REFERENCE_MATCHING' ? (
                <p className="mode-note">
                  Every result is produced by comparing the measured colour
                  with the reference chart. No trained model is in use, and
                  the arithmetic behind each result can be checked by hand.
                </p>
              ) : null}
            </Panel>

            <Panel title="Next">
              <ul className="tips">
                <li>
                  <Icon name="arrow_forward" className="icon-sm tips-icon" />
                  <Link to="/admin/models">Review trained models and releases</Link>
                </li>
                <li>
                  <Icon name="arrow_forward" className="icon-sm tips-icon" />
                  <Link to="/admin/laboratories">Manage laboratories and technicians</Link>
                </li>
              </ul>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  icon,
  note,
}: {
  label: string;
  value: number;
  icon: string;
  note?: string;
}) {
  return (
    <div className="metric">
      <Icon name={icon} className="icon-sm metric-icon" />
      <div>
        <span className="metric-value mono">{value}</span>
        <span className="metric-label">{label}</span>
        {note ? <span className="metric-note">{note}</span> : null}
      </div>
    </div>
  );
}
