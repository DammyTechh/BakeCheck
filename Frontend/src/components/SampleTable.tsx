import { Link } from 'react-router-dom';
import type { Sample } from '../lib/types';
import { Icon, Pill, type PillTone } from './ui';
import { formatRelative } from '../lib/format';

/**
 * Status wording, chosen for a technician rather than for the schema.
 *
 * None of these are coloured green for "safe" or red for "unsafe". A sample
 * status describes where the sample is in the workflow; nothing in this list
 * has been confirmed against a laboratory measurement, and colouring a row
 * by its observed colour band would imply otherwise.
 */
const STATUS: Record<Sample['status'], { label: string; tone: PillTone }> = {
  REGISTERED: { label: 'Registered', tone: 'neutral' },
  PREPARED: { label: 'Prepared', tone: 'neutral' },
  ANALYZED: { label: 'Screened', tone: 'accent' },
  UNDER_REVIEW: { label: 'Under review', tone: 'caution' },
  CONFIRMED: { label: 'Confirmed', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'stop' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
};

export function SampleTable({ samples }: { samples: Sample[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Product</th>
            <th scope="col">Analyses</th>
            <th scope="col">Measurements</th>
            <th scope="col">Status</th>
            <th scope="col">Registered</th>
          </tr>
        </thead>
        <tbody>
          {samples.map((sample) => {
            const status = STATUS[sample.status] ?? {
              label: sample.status.toLowerCase(),
              tone: 'neutral' as PillTone,
            };
            return (
              <tr key={sample.id}>
                <td>
                  <Link to={`/samples/${sample.id}`} className="table-link mono">
                    {sample.sampleCode}
                  </Link>
                </td>
                <td>{sample.productName ?? <span className="dim">—</span>}</td>
                <td className="mono">
                  {sample.analysisCount > 0 ? (
                    sample.analysisCount
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>
                  {sample.measurementCount > 0 ? (
                    <span className="row" style={{ gap: 'var(--s1)' }}>
                      <Icon name="biotech" className="icon-sm confirmed-icon" />
                      <span className="mono">{sample.measurementCount}</span>
                    </span>
                  ) : (
                    <span className="dim">None</span>
                  )}
                </td>
                <td>
                  <Pill tone={status.tone}>{status.label}</Pill>
                </td>
                <td className="dim">{formatRelative(sample.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
