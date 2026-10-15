import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { Laboratory, LaboratoryMember, Role } from '../../lib/types';
import { PageHead } from '../../components/AppShell';
import {
  Banner,
  Button,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Panel,
  Pill,
  Select,
  Spinner,
} from '../../components/ui';
import { formatDate } from '../../lib/format';

export function Laboratories() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const labs = useQuery({
    queryKey: ['laboratories'],
    queryFn: () => api.get<Laboratory[] | { data: Laboratory[] }>('/laboratories'),
    select: (raw) => (Array.isArray(raw) ? raw : raw.data),
  });

  return (
    <>
      <PageHead
        title="Laboratories"
        description="Laboratories using BakeCheck, and who works in them."
        actions={
          <Button
            variant="primary"
            icon={creating ? 'close' : 'add'}
            onClick={() => setCreating((v) => !v)}
          >
            {creating ? 'Cancel' : 'Register laboratory'}
          </Button>
        }
      />

      <div className="stack-lg">
        {creating ? (
          <CreateLaboratory
            onCreated={() => {
              setCreating(false);
              void queryClient.invalidateQueries({ queryKey: ['laboratories'] });
            }}
          />
        ) : null}

        <Panel padded={false}>
          {labs.isLoading ? (
            <Spinner label="Loading laboratories…" />
          ) : labs.error ? (
            <div style={{ padding: 'var(--s5)' }}>
              <ErrorNote error={labs.error} />
            </div>
          ) : labs.data && labs.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Laboratory</th>
                    <th scope="col">Type</th>
                    <th scope="col">Location</th>
                    <th scope="col">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {labs.data.map((lab) => (
                    <tr key={lab.id}>
                      <td>
                        <Link to={`/admin/laboratories/${lab.id}`} className="table-link">
                          {lab.name}
                        </Link>
                      </td>
                      <td className="dim">{lab.laboratoryType ?? '—'}</td>
                      <td className="dim">
                        {[lab.city, lab.country].filter(Boolean).join(', ') || '—'}
                      </td>
                      <td className="dim">{formatDate(lab.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="apartment" title="No laboratories yet">
              Register a laboratory, then add the technicians who will use it.
            </EmptyState>
          )}
        </Panel>
      </div>
    </>
  );
}

function CreateLaboratory({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<Laboratory>('/laboratories', {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        ...(country.trim() ? { country: country.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
      }),
    onSuccess: onCreated,
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not create it.'),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Give the laboratory a name.');
      return;
    }
    if (!code.trim()) {
      setError('Give the laboratory a short code. Technicians use it to join.');
      return;
    }
    create.mutate();
  }

  return (
    <Panel title="Register a laboratory">
      <form onSubmit={onSubmit} noValidate style={{ maxWidth: 480 }}>
        <Field label="Laboratory name" htmlFor="labName">
          <Input
            id="labName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Central Food Safety Laboratory"
            required
          />
        </Field>
        <Field
          label="Short code"
          htmlFor="labCode"
          hint="Technicians enter this when they register, to join this laboratory."
        >
          <Input
            id="labCode"
            className="mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="CFSL-LAGOS"
            required
          />
        </Field>
        <div className="field-row">
          <Field label="City" htmlFor="labCity" hint="Optional.">
            <Input id="labCity" value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
          <Field label="Country" htmlFor="labCountry" hint="Optional.">
            <Input
              id="labCountry"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          </Field>
        </div>
        {error ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="stop" icon="error">{error}</Banner>
          </div>
        ) : null}

        <div style={{ marginTop: 'var(--s4)' }}>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Register laboratory
          </Button>
        </div>
      </form>
    </Panel>
  );
}

const ROLES: Array<{ value: Role; label: string }> = [
  { value: 'LAB_TECHNICIAN', label: 'Technician' },
  { value: 'LAB_REVIEWER', label: 'Reviewer' },
  { value: 'LAB_ADMIN', label: 'Administrator' },
];

export function LaboratoryDetail() {
  const { laboratoryId = '' } = useParams();
  const queryClient = useQueryClient();

  const lab = useQuery({
    queryKey: ['laboratory', laboratoryId],
    queryFn: () => api.get<Laboratory>(`/laboratories/${laboratoryId}`),
  });

  const members = useQuery({
    queryKey: ['laboratory-members', laboratoryId],
    queryFn: () =>
      api.get<LaboratoryMember[] | { data: LaboratoryMember[] }>(
        `/laboratories/${laboratoryId}/members`,
      ),
    select: (raw) => (Array.isArray(raw) ? raw : raw.data),
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('LAB_TECHNICIAN');
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api.post(`/laboratories/${laboratoryId}/members`, { email: email.trim(), role }),
    onSuccess: () => {
      setEmail('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['laboratory-members', laboratoryId] });
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiError && caught.code === 'NOT_FOUND'
          ? 'No BakeCheck account uses that email. They need to create one first.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not add them.',
      ),
  });

  if (lab.isLoading) return <Spinner label="Loading the laboratory…" />;
  if (lab.error) return <ErrorNote error={lab.error} />;

  return (
    <>
      <PageHead
        breadcrumb={[{ label: 'Laboratories', to: '/admin/laboratories' }]}
        title={lab.data?.name ?? 'Laboratory'}
        description={[lab.data?.city, lab.data?.country].filter(Boolean).join(', ')}
      />

      <div className="split">
        <Panel title="Technicians" padded={false}>
          {members.isLoading ? (
            <Spinner label="Loading members…" />
          ) : members.data && members.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {members.data.map((member) => (
                    <tr key={member.userId}>
                      <td>{member.fullName}</td>
                      <td className="mono dim">{member.email}</td>
                      <td>
                        {ROLES.find((r) => r.value === member.role)?.label ?? member.role}
                      </td>
                      <td>
                        <Pill tone={member.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                          {member.status.toLowerCase()}
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="group" title="No members yet">
              Add a technician by the email address they registered with.
            </EmptyState>
          )}
        </Panel>

        <Panel title="Add a technician">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (!email.trim()) {
                setError('Enter the email address they registered with.');
                return;
              }
              add.mutate();
            }}
            noValidate
          >
            <Field
              label="Email address"
              htmlFor="memberEmail"
              hint="They must already have a BakeCheck account."
            >
              <Input
                id="memberEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Role" htmlFor="memberRole">
              <Select
                id="memberRole"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>

            {error ? (
              <div style={{ marginTop: 'var(--s3)' }}>
                <Banner tone="stop" icon="error">{error}</Banner>
              </div>
            ) : null}

            <div style={{ marginTop: 'var(--s4)' }}>
              <Button type="submit" variant="primary" loading={add.isPending}>
                Add to laboratory
              </Button>
            </div>
          </form>
        </Panel>
      </div>
    </>
  );
}
