import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Paginated, Sample } from '../lib/types';
import { PageHead } from '../components/AppShell';
import { SampleTable } from '../components/SampleTable';
import { Button, EmptyState, ErrorNote, Icon, Input, Panel, Spinner } from '../components/ui';
import './Results.css';

const PAGE_SIZE = 20;

export function Results() {
  const { laboratory } = useAuth();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');

  const query = useQuery({
    queryKey: ['samples', laboratory?.laboratoryId, { page, search: applied }],
    queryFn: () =>
      api.get<Paginated<Sample>>(
        `/samples?laboratoryId=${laboratory!.laboratoryId}` +
          `&page=${page}&limit=${PAGE_SIZE}` +
          (applied ? `&search=${encodeURIComponent(applied)}` : ''),
      ),
    enabled: Boolean(laboratory),
    placeholderData: keepPreviousData,
  });

  const meta = query.data?.meta;

  return (
    <>
      <PageHead
        title="Results"
        description="Every sample registered by your laboratory, newest first."
        actions={
          <Link to="/analyze">
            <Button variant="primary" icon="science">
              Analyse a sample
            </Button>
          </Link>
        }
      />

      <Panel padded={false}>
        <div className="results-toolbar">
          <form
            className="results-search"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setApplied(search.trim());
            }}
          >
            <Icon name="search" className="icon-sm results-search-icon" />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by sample code or product"
              aria-label="Search samples"
            />
            <Button type="submit" size="sm">
              Search
            </Button>
          </form>
          {meta ? (
            <span className="results-count">
              <span className="mono">{meta.total}</span>{' '}
              {meta.total === 1 ? 'sample' : 'samples'}
            </span>
          ) : null}
        </div>

        {query.isLoading ? (
          <Spinner label="Loading results…" />
        ) : query.error ? (
          <div style={{ padding: 'var(--s5)' }}>
            <ErrorNote error={query.error} />
          </div>
        ) : query.data && query.data.data.length > 0 ? (
          <SampleTable samples={query.data.data} />
        ) : applied ? (
          <EmptyState icon="search_off" title="Nothing matched that search">
            No sample code or product name contains “{applied}”.
          </EmptyState>
        ) : (
          <EmptyState
            icon="lab_profile"
            title="No samples yet"
            action={
              <Link to="/analyze">
                <Button variant="primary" icon="add">
                  Analyse your first sample
                </Button>
              </Link>
            }
          >
            Results appear here once you have registered a sample and attached
            a photograph.
          </EmptyState>
        )}

        {meta && meta.totalPages > 1 ? (
          <div className="pager">
            <Button
              size="sm"
              icon="chevron_left"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="pager-state mono">
              {meta.page} / {meta.totalPages}
            </span>
            <Button
              size="sm"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
              <Icon name="chevron_right" className="icon-sm" />
            </Button>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
