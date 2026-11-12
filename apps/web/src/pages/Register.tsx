import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthLayout } from './AuthLayout';
import { Banner, Button, Field, Input } from '../components/ui';

/** Mirrors the API's rule, so the message appears before a round trip. */
const MIN_PASSWORD = 12;

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    jobTitle: '',
    laboratoryCode: '',
    password: '',
    confirm: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: '' }));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (form.password.length < MIN_PASSWORD) {
      setFieldErrors({ password: `Use at least ${MIN_PASSWORD} characters.` });
      return;
    }
    if (form.password !== form.confirm) {
      setFieldErrors({ confirm: 'This does not match the password above.' });
      return;
    }

    setBusy(true);
    try {
      await register({
        email: form.email.trim(),
        password: form.password,
        fullName: form.fullName.trim(),
        ...(form.jobTitle.trim() ? { jobTitle: form.jobTitle.trim() } : {}),
        ...(form.laboratoryCode.trim()
          ? { laboratoryCode: form.laboratoryCode.trim().toUpperCase() }
          : {}),
      });
      navigate('/dashboard', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fields = caught.fieldErrors();
        if (Object.keys(fields).length > 0) setFieldErrors(fields);
        else if (caught.code === 'ALREADY_EXISTS') {
          setError('An account already exists for that email address.');
        } else setError(caught.message);
      } else {
        setError('Could not create the account.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="You will be added to a laboratory by its administrator after you sign up."
    >
      <form onSubmit={onSubmit} noValidate>
        {error ? (
          <div style={{ marginBottom: 'var(--s4)' }}>
            <Banner tone="stop" icon="error">
              {error}
            </Banner>
          </div>
        ) : null}

        <Field label="Full name" htmlFor="fullName" error={fieldErrors.fullName}>
          <Input
            id="fullName"
            autoComplete="name"
            required
            value={form.fullName}
            onChange={(e) => set('fullName', e.target.value)}
            invalid={Boolean(fieldErrors.fullName)}
          />
        </Field>

        <Field label="Work email" htmlFor="email" error={fieldErrors.email}>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            invalid={Boolean(fieldErrors.email)}
          />
        </Field>

        <Field
          label="Job title"
          htmlFor="jobTitle"
          hint="Optional. Appears beside your name on records you create."
          error={fieldErrors.jobTitle}
        >
          <Input
            id="jobTitle"
            autoComplete="organization-title"
            value={form.jobTitle}
            onChange={(e) => set('jobTitle', e.target.value)}
            placeholder="Laboratory technician"
          />
        </Field>

        <Field
          label="Laboratory code"
          htmlFor="laboratoryCode"
          hint="Optional. If your laboratory gave you a code, entering it joins you straight away. Otherwise an administrator adds you later."
          error={fieldErrors.laboratoryCode}
        >
          <Input
            id="laboratoryCode"
            className="mono"
            value={form.laboratoryCode}
            onChange={(e) => set('laboratoryCode', e.target.value.toUpperCase())}
            placeholder="CFSL-LAGOS"
            invalid={Boolean(fieldErrors.laboratoryCode)}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          error={fieldErrors.password}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            invalid={Boolean(fieldErrors.password)}
          />
        </Field>

        <Field label="Confirm password" htmlFor="confirm" error={fieldErrors.confirm}>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            required
            value={form.confirm}
            onChange={(e) => set('confirm', e.target.value)}
            invalid={Boolean(fieldErrors.confirm)}
          />
        </Field>

        <div style={{ marginTop: 'var(--s5)' }}>
          <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
            Create account
          </Button>
        </div>

        <p className="auth-alt">
          Already have an account? <Link to="/sign-in">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
