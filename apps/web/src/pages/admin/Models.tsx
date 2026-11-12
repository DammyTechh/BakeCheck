/**
 * Trained models, and the decision to release one.
 *
 * Approval is deliberately not a one-click affair. The API refuses to
 * approve a model whose evaluation does not meet the release criteria unless
 * an override reason is supplied, and that reason is written to the audit
 * log. This screen shows the blockers before the button, so the person
 * clicking it has read what they are overriding.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { ModelVersion } from '../../lib/types';
import { PageHead } from '../../components/AppShell';
import {
  Banner,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Panel,
  Pill,
  Spinner,
  Textarea,
} from '../../components/ui';
import { formatDateTime } from '../../lib/format';

export function Models() {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<ModelVersion[] | { data: ModelVersion[] }>('/ai/models'),
    select: (raw) => (Array.isArray(raw) ? raw : raw.data),
  });

  return (
    <>
      <PageHead
        title="Models"
        description="Every model trained for this deployment, and which one is serving results."
      />

      {models.isLoading ? (
        <Spinner label="Loading models…" />
      ) : models.error ? (
        <ErrorNote error={models.error} />
      ) : models.data && models.data.length > 0 ? (
        <div className="stack-lg">
          {models.data.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              expanded={expanded === model.id}
              onToggle={() => setExpanded((id) => (id === model.id ? null : model.id))}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: ['models'] })}
            />
          ))}
        </div>
      ) : (
        <Panel>
          <EmptyState icon="model_training" title="No models yet">
            Models appear here once a training job has produced one. Until
            then every result comes from the reference chart comparison.
          </EmptyState>
        </Panel>
      )}
    </>
  );
}

function ModelCard({
  model,
  expanded,
  onToggle,
  onChanged,
}: {
  model: ModelVersion;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [override, setOverride] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsOverride, setNeedsOverride] = useState(false);

  const detail = useQuery({
    queryKey: ['model', model.id],
    queryFn: () => api.get<ModelVersion>(`/ai/models/${model.id}`),
    enabled: expanded,
  });

  const approve = useMutation({
    mutationFn: () =>
      api.post(`/ai/models/${model.id}/approve`, {
        ...(override.trim() ? { overrideReason: override.trim() } : {}),
      }),
    onSuccess: () => {
      setError(null);
      setNeedsOverride(false);
      setOverride('');
      onChanged();
    },
    onError: (caught) => {
      if (caught instanceof ApiError && caught.code === 'INSUFFICIENT_DATA') {
        setNeedsOverride(true);
        setError(caught.message);
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not approve it.');
    },
  });

  const evaluation = detail.data?.evaluations?.[0];
  const metrics = model.validationMetrics ?? {};

  return (
    <Panel
      title={
        <span className="row">
          <span className="mono">{model.name}</span>
          <span className="mono dim">{model.version}</span>
          {model.isActive ? <Pill tone="ok" icon="check_circle">Active</Pill> : null}
          <Pill tone={model.status === 'RELEASED' ? 'ok' : 'neutral'}>
            {model.status.toLowerCase()}
          </Pill>
        </span>
      }
      description={`Trained ${formatDateTime(model.createdAt)}`}
      actions={
        <Button size="sm" onClick={onToggle} icon={expanded ? 'expand_less' : 'expand_more'}>
          {expanded ? 'Less' : 'Details'}
        </Button>
      }
    >
      <div className="row" style={{ gap: 'var(--s5)' }}>
        <Figure label="Macro F1" value={metrics.macro_f1} />
        <Figure label="Accuracy" value={metrics.accuracy} />
        <Figure label="Balanced accuracy" value={metrics.balanced_accuracy} />
      </div>

      {expanded ? (
        <div className="stack" style={{ marginTop: 'var(--s5)' }}>
          {detail.isLoading ? <Spinner label="Loading the evaluation…" /> : null}

          {evaluation ? (
            <>
              <Banner
                tone={
                  evaluation.releaseRecommendation === 'APPROVE'
                    ? 'accent'
                    : 'caution'
                }
                icon={
                  evaluation.releaseRecommendation === 'APPROVE' ? 'check_circle' : 'warning'
                }
                title={`Release recommendation: ${evaluation.releaseRecommendation.replace('_', ' ').toLowerCase()}`}
              >
                {evaluation.evaluationLimitations.length > 0 ? (
                  <ul className="limits">
                    {evaluation.evaluationLimitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                ) : (
                  <p>Evaluated on {evaluation.sampleSize} test examples.</p>
                )}
              </Banner>
            </>
          ) : null}

          {model.limitations && model.limitations.length > 0 ? (
            <Panel title="Limitations">
              <ul className="limits">
                {model.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {!model.isActive && model.status !== 'REJECTED' ? (
            <div>
              {needsOverride ? (
                <Field
                  label="Override reason"
                  htmlFor={`override-${model.id}`}
                  hint="Recorded in the audit log with your name. Releasing a model the evaluation does not support is a deliberate, attributable decision."
                >
                  <Textarea
                    id={`override-${model.id}`}
                    value={override}
                    onChange={(e) => setOverride(e.target.value)}
                  />
                </Field>
              ) : null}

              {error ? (
                <div style={{ margin: 'var(--s3) 0' }}>
                  <Banner tone="caution" icon="warning">{error}</Banner>
                </div>
              ) : null}

              <Button
                variant="primary"
                loading={approve.isPending}
                disabled={needsOverride && override.trim().length < 10}
                onClick={() => approve.mutate()}
              >
                {needsOverride ? 'Release anyway' : 'Approve and release'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function Figure({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="figure">
      <span className="figure-label">{label}</span>
      {value === null || value === undefined ? (
        <span className="figure-absent">Not measured</span>
      ) : (
        <span className="figure-value mono">{value.toFixed(3)}</span>
      )}
    </div>
  );
}
