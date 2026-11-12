import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Paginated, Sample } from '../lib/types';
import { PageHead } from '../components/AppShell';
import { Button, EmptyState, ErrorNote, Icon, Panel, Spinner } from '../components/ui';
import { SampleTable } from '../components/SampleTable';
import './Dashboard.css';

export function Dashboard() {
  const { user, laboratory } = useAuth();

  const samples = useQuery({
    queryKey: ['samples', laboratory?.laboratoryId, { page: 1, limit: 8 }],
    queryFn: () =>
      api.get<Paginated<Sample>>(
        `/samples?laboratoryId=${laboratory!.laboratoryId}&page=1&limit=8`,
      ),
    enabled: Boolean(laboratory),
  });

  const rows = samples.data?.data ?? [];
  const total = samples.data?.meta.total ?? 0;
  const analysed = rows.filter((s) => s.analysisCount > 0).length;
  // Screened but with nothing from an analytical method behind it. This is
  // the number that actually needs someone's attention.
  const awaitingConfirmation = rows.filter(
    (s) => s.analysisCount > 0 && s.measurementCount === 0,
  ).length;

  return (
    <>
      <PageHead
        title={firstName(user?.fullName)}
        description={
          laboratory
            ? `${laboratory.laboratoryName} · screening samples for potassium bromate`
            : 'You are not a member of a laboratory yet. An administrator needs to add you.'
        }
        actions={
          <Link to="/analyze">
            <Button variant="primary" icon="science">
              Analyse a sample
            </Button>
          </Link>
        }
      />

      {!laboratory ? (
        <Panel>
          <EmptyState icon="apartment" title="No laboratory yet">
            Ask your laboratory administrator to add you to their laboratory in
            BakeCheck. Until then you can sign in, but there is nothing to see.
          </EmptyState>
        </Panel>
      ) : (
        <div className="stack-lg">
          <div className="grid-stats">
            <Stat label="Samples registered" value={total} icon="inventory_2" />
            <Stat
              label="Screened"
              value={analysed}
              icon="colorize"
              note="Of the most recent 8."
            />
            <Stat
              label="Awaiting confirmation"
              value={awaitingConfirmation}
              icon="pending_actions"
              note="Screened, with no laboratory measurement recorded against them."
            />
          </div>

          <Panel
            title="Recent samples"
            actions={
              <Link to="/results" className="panel-link">
                View all
              </Link>
            }
            padded={false}
          >
            {samples.isLoading ? (
              <Spinner label="Loading samples…" />
            ) : samples.error ? (
              <div style={{ padding: 'var(--s5)' }}>
                <ErrorNote error={samples.error} />
              </div>
            ) : samples.data && samples.data.data.length > 0 ? (
              <SampleTable samples={samples.data.data} />
            ) : (
              <EmptyState
                icon="science"
                title="No samples yet"
                action={
                  <Link to="/analyze">
                    <Button variant="primary" icon="add">
                      Analyse your first sample
                    </Button>
                  </Link>
                }
              >
                Register a sample and attach a photograph of the developed tube
                to get your first reading.
              </EmptyState>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

function firstName(fullName: string | undefined): string {
  if (!fullName) return 'Dashboard';
  return `Welcome back, ${fullName.split(' ')[0]}`;
}

function Stat({
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
    <div className="stat">
      <div className="stat-head">
        <Icon name={icon} className="icon-sm stat-icon" />
        <span className="stat-label">{label}</span>
      </div>
      <span className="stat-value mono">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}
