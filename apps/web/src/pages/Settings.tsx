import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHead } from '../components/AppShell';
import { Banner, Button, DataList, Field, Input, Panel, Pill } from '../components/ui';
import { formatDateTime } from '../lib/format';

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super administrator',
  LAB_ADMIN: 'Laboratory administrator',
  LAB_TECHNICIAN: 'Technician',
  LAB_REVIEWER: 'Reviewer',
};

export function Settings() {
  const { user, refreshProfile } = useAuth();

  if (!user) return null;

  return (
    <>
      <PageHead title="Settings" description="Your account and laboratory access." />

      <div className="split">
        <div className="stack-lg">
          <ProfileForm
            fullName={user.fullName}
            jobTitle={user.jobTitle ?? ''}
            onSaved={refreshProfile}
          />
          <PasswordForm />
        </div>

        <div className="stack-lg">
          <Panel title="Account">
            <DataList
              items={[
                { label: 'Email', value: user.email, mono: true },
                { label: 'Role', value: ROLE_LABEL[user.role] ?? user.role },
                { label: 'Status', value: <Pill tone="ok">{user.status.toLowerCase()}</Pill> },
                {
                  label: 'Last signed in',
                  value: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—',
                },
              ]}
            />
          </Panel>

          <Panel
            title="Laboratories"
            description="Membership is managed by a laboratory administrator."
          >
            {user.memberships.length === 0 ? (
              <p className="muted">You are not a member of any laboratory yet.</p>
            ) : (
              <DataList
                items={user.memberships.map((m) => ({
                  label: m.laboratoryName,
                  value: ROLE_LABEL[m.role] ?? m.role,
                }))}
              />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function ProfileForm({
  fullName,
  jobTitle,
  onSaved,
}: {
  fullName: string;
  jobTitle: string;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(fullName);
  const [title, setTitle] = useState(jobTitle);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch('/auth/me', { fullName: name.trim(), jobTitle: title.trim() || null }),
    onSuccess: async () => {
      setSaved(true);
      setError(null);
      await onSaved();
    },
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not save.'),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    save.mutate();
  }

  return (
    <Panel title="Your details">
      <form onSubmit={onSubmit} noValidate>
        <Field label="Full name" htmlFor="name">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="Job title" htmlFor="title" hint="Optional.">
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>

        {error ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="stop" icon="error">{error}</Banner>
          </div>
        ) : null}
        {saved ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="accent" icon="check_circle">Details saved.</Banner>
          </div>
        ) : null}

        <div style={{ marginTop: 'var(--s4)' }}>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword: current,
        newPassword: next,
      }),
    onSuccess: () => {
      setDone(true);
      setError(null);
      setCurrent('');
      setNext('');
      setConfirm('');
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS'
          ? 'That is not your current password.'
          : caught instanceof ApiError
            ? caught.message
            : 'Could not change the password.',
      ),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setDone(false);
    setError(null);
    if (next.length < 12) {
      setError('Use at least 12 characters for the new password.');
      return;
    }
    if (next !== confirm) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    change.mutate();
  }

  return (
    <Panel
      title="Password"
      description="Changing your password signs out every other session."
    >
      <form onSubmit={onSubmit} noValidate>
        <Field label="Current password" htmlFor="current">
          <Input
            id="current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </Field>
        <Field label="New password" htmlFor="next" hint="At least 12 characters.">
          <Input
            id="next"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </Field>
        <Field label="Confirm new password" htmlFor="confirmPassword">
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>

        {error ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="stop" icon="error">{error}</Banner>
          </div>
        ) : null}
        {done ? (
          <div style={{ marginTop: 'var(--s3)' }}>
            <Banner tone="accent" icon="check_circle">Password changed.</Banner>
          </div>
        ) : null}

        <div style={{ marginTop: 'var(--s4)' }}>
          <Button type="submit" variant="primary" loading={change.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}
