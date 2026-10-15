/**
 * One sample: its analyses, and the place a confirmed laboratory measurement
 * is recorded against it.
 *
 * That form is the most consequential thing in this app. A recorded
 * measurement is what turns a screening observation into ground truth, and
 * it is the only route by which the system can ever learn anything. So it
 * asks for the method and the value, defaults the status to PRELIMINARY, and
 * says plainly what marking something CONFIRMED means.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { Analysis, Sample } from '../lib/types';
import { PageHead } from '../components/AppShell';
import {
  Banner,
  Button,
  DataList,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Panel,
  Pill,
  Select,
  Spinner,
  Textarea,
} from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';

interface Measurement {
  id: string;
  measurementMethod: string;
  instrument: string | null;
  concentrationValue: number | null;
  concentrationUnit: string;
  belowDetectionLimit: boolean;
  confirmationStatus: string;
  measuredAt: string;
  notes: string | null;
}

export function SampleDetail() {
  const { sampleId = '' } = useParams();
  const queryClient = useQueryClient();

  const sample = useQuery({
    queryKey: ['sample', sampleId],
    queryFn: () => api.get<Sample>(`/samples/${sampleId}`),
  });

  const analyses = useQuery({
    queryKey: ['sample-results', sampleId],
    queryFn: () => api.get<Analysis[]>(`/samples/${sampleId}/results`),
  });

  const measurements = useQuery({
    queryKey: ['sample-measurements', sampleId],
    queryFn: () => api.get<Measurement[]>(`/samples/${sampleId}/laboratory-measurements`),
  });

  if (sample.isLoading) return <Spinner label="Loading the sample…" />;
  if (sample.error) return <ErrorNote error={sample.error} />;
  if (!sample.data) return null;

  const record = sample.data;

  return (
    <>
      <PageHead
        breadcrumb={[{ label: 'Results', to: '/results' }]}
        title={record.sampleCode}
        description={record.productName ?? undefined}
      />

      <div className="split">
        <div className="stack-lg">
          <Panel title="Analyses" padded={false}>
            {analyses.isLoading ? (
              <Spinner label="Loading analyses…" />
            ) : analyses.data && analyses.data.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Observed band</th>
                      <th scope="col">Distance</th>
                      <th scope="col">Image</th>
                      <th scope="col">Analysed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analyses.data.map((analysis) => (
                      <tr key={analysis.id}>
                        <td>
                          <Link to={`/analyses/${analysis.id}`} className="table-link">
                            {analysis.prediction.label ?? 'No reading'}
                          </Link>
                        </td>
                        <td className="mono dim">
                          {analysis.prediction.colorDistance === null
                            ? '—'
                            : `ΔE ${analysis.prediction.colorDistance.toFixed(1)}`}
                        </td>
                        <td>
                          <Pill
                            tone={
                              analysis.imageQuality.verdict === 'USABLE'
                                ? 'ok'
                                : analysis.imageQuality.verdict === 'MARGINAL'
                                  ? 'caution'
                                  : 'stop'
                            }
                          >
                            {analysis.imageQuality.verdict.toLowerCase()}
                          </Pill>
                        </td>
                        <td className="dim">{formatRelative(analysis.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon="colorize" title="No analysis yet">
                Attach a photograph of the developed tube to get a reading.
              </EmptyState>
            )}
          </Panel>

          <Panel
            title="Laboratory measurements"
            description="Confirmed values from an analytical method. These are what BakeCheck can learn from."
            padded={false}
          >
            {measurements.isLoading ? (
              <Spinner label="Loading measurements…" />
            ) : measurements.data && measurements.data.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Method</th>
                      <th scope="col">Value</th>
                      <th scope="col">Status</th>
                      <th scope="col">Measured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {measurements.data.map((m) => (
                      <tr key={m.id}>
                        <td>{m.measurementMethod}</td>
                        <td className="mono">
                          {m.belowDetectionLimit
                            ? 'Below detection limit'
                            : m.concentrationValue === null
                              ? '—'
                              : `${m.concentrationValue} ${m.concentrationUnit}`}
                        </td>
                        <td>
                          <Pill tone={m.confirmationStatus === 'CONFIRMED' ? 'ok' : 'caution'}>
                            {m.confirmationStatus.toLowerCase()}
                          </Pill>
                        </td>
                        <td className="dim">{formatDateTime(m.measuredAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon="biotech" title="No measurement recorded">
                Until a confirmed measurement exists, every reading for this
                sample is a screening observation only.
              </EmptyState>
            )}
          </Panel>
        </div>

        <div className="stack-lg">
          <Panel title="Sample">
            <DataList
              items={[
                { label: 'Code', value: record.sampleCode, mono: true },
                { label: 'Type', value: record.sampleType },
                { label: 'Product', value: record.productName ?? '—' },
                { label: 'Batch', value: record.batchReference ?? '—', mono: true },
                { label: 'Manufacturer', value: record.manufacturer ?? '—' },
                { label: 'Status', value: <Pill>{record.status.toLowerCase()}</Pill> },
                { label: 'Registered', value: formatDateTime(record.createdAt) },
              ]}
            />
            {record.notes ? <p className="mode-note">{record.notes}</p> : null}
          </Panel>

          <RecordMeasurement
            sampleId={sampleId}
            onRecorded={() => {
              void queryClient.invalidateQueries({ queryKey: ['sample-measurements', sampleId] });
              void queryClient.invalidateQueries({ queryKey: ['sample', sampleId] });
            }}
          />
        </div>
      </div>
    </>
  );
}

function RecordMeasurement({
  sampleId,
  onRecorded,
}: {
  sampleId: string;
  onRecorded: () => void;
}) {
  const [method, setMethod] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('ppm');
  const [belowLod, setBelowLod] = useState(false);
  const [status, setStatus] = useState('PRELIMINARY');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/samples/${sampleId}/laboratory-measurements`, {
        measurementMethod: method.trim(),
        concentrationUnit: unit.trim(),
        belowDetectionLimit: belowLod,
        ...(belowLod ? {} : { concentrationValue: Number(value) }),
        measuredAt: new Date().toISOString(),
        confirmationStatus: status,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: () => {
      setDone(true);
      setMethod('');
      setValue('');
      setNotes('');
      onRecorded();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not record it.'),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (!method.trim()) {
      setError('Name the analytical method used.');
      return;
    }
    if (!belowLod && value.trim() === '') {
      setError('Give the measured value, or mark it below the detection limit.');
      return;
    }
    save.mutate();
  }

  return (
    <Panel title="Record a measurement">
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Analytical method"
          htmlFor="measMethod"
          hint="The confirmatory technique, for example IC-ICP-MS."
        >
          <Input
            id="measMethod"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            placeholder="IC-ICP-MS"
          />
        </Field>

        <div className="field-row">
          <Field label="Value" htmlFor="measValue">
            <Input
              id="measValue"
              className="mono"
              type="number"
              step="any"
              min="0"
              disabled={belowLod}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <Field label="Unit" htmlFor="measUnit">
            <Input
              id="measUnit"
              className="mono"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
          </Field>
        </div>

        <label className="checkline">
          <input
            type="checkbox"
            checked={belowLod}
            onChange={(e) => setBelowLod(e.target.checked)}
          />
          <span>Below the detection limit</span>
        </label>

        <Field
          label="Confirmation status"
          htmlFor="measStatus"
          hint="Mark CONFIRMED only once the result has been reviewed. Confirmed measurements become training ground truth."
        >
          <Select
            id="measStatus"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="PRELIMINARY">Preliminary</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="DISPUTED">Disputed</option>
          </Select>
        </Field>

        <Field label="Notes" htmlFor="measNotes" hint="Optional.">
          <Textarea id="measNotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="stop" icon="error">{error}</Banner>
          </div>
        ) : null}
        {done ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="accent" icon="check_circle">Measurement recorded.</Banner>
          </div>
        ) : null}

        <div style={{ marginTop: 'var(--s4)' }}>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Record measurement
          </Button>
        </div>
      </form>
    </Panel>
  );
}
