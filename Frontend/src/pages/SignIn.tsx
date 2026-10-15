import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AuthLayout } from './AuthLayout';
import { Banner, Button, Field, Input } from '../components/ui';

export function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user = await signIn(email.trim(), password);
      const from = (location.state as { from?: string } | null)?.from;
      const fallback =
        user.role === 'SUPER_ADMIN' || user.role === 'LAB_ADMIN'
          ? '/admin'
          : '/dashboard';
      navigate(from ?? fallback, { replace: true });
    } catch (caught) {
      // The API returns the same code for a wrong password and an unknown
      // address, deliberately — saying which would confirm who has an
      // account here. The wording matches that.
      setError(
        caught instanceof ApiError && caught.code === 'RATE_LIMITED'
          ? 'Too many attempts. Wait a minute and try again.'
          : caught instanceof ApiError && caught.code === 'INVALID_CREDENTIALS'
            ? 'That email and password do not match an account.'
            : caught instanceof Error
              ? caught.message
              : 'Could not sign in.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Analyse bromate screening samples for your laboratory."
    >
      <form onSubmit={onSubmit} noValidate>
        {error ? (
          <div style={{ marginBottom: 'var(--s4)' }}>
            <Banner tone="stop" icon="error">
              {error}
            </Banner>
          </div>
        ) : null}

        <Field label="Work email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@laboratory.org"
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <div style={{ marginTop: 'var(--s5)' }}>
          <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
            Sign in
          </Button>
        </div>

        <p className="auth-alt">
          No account yet? <Link to="/register">Create one</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
