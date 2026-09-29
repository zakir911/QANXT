import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useAuth } from '../lib/auth';
import { ErrorNotice } from '../components/ui';

interface Meta { product: string; tagline: string }

export default function LoginPage() {
  const { isAuthenticated, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => apiRequest<Meta>('/api/v1/meta', { authenticated: false }),
    staleTime: Infinity
  });

  if (isAuthenticated) {
    const from = (location.state as { from?: Location })?.from?.pathname ?? '/';
    return <Navigate to={from} replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      if (mode === 'login') {
        await login(
          String(form.get('email') ?? ''),
          String(form.get('password') ?? ''),
          String(form.get('organizationSlug') ?? '') || undefined
        );
      } else {
        await register(
          String(form.get('organizationName') ?? ''),
          String(form.get('email') ?? ''),
          String(form.get('password') ?? ''),
          String(form.get('displayName') ?? '')
        );
      }
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-ink">{meta?.product ?? 'QA NXT'}</h1>
          <p className="text-sm text-ink-muted mt-1">{meta?.tagline ?? 'Your AI Quality Engineer'}</p>
        </div>

        <div className="card-pad">
          <div className="flex gap-1 mb-5 p-1 bg-surface-sunken rounded-lg" role="tablist">
            {(['login', 'register'] as const).map(option => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={mode === option}
                onClick={() => { setMode(option); setError(null); }}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                  mode === option ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {option === 'login' ? 'Sign in' : 'Create an organization'}
              </button>
            ))}
          </div>

          {/* key={mode} remounts the form when the tab changes, so the fields start empty.
              Both tabs render the same uncontrolled Email and Password inputs, so without
              it React kept the nodes and their values: typing a password on Sign in and
              then switching to Create an organization carried that password into the
              registration form, ready to submit, without the person retyping it. */}
          <form key={mode} onSubmit={handleSubmit} className="space-y-3.5">
            {mode === 'register' && (
              <>
                <div>
                  <label className="label" htmlFor="organizationName">Organization name</label>
                  <input id="organizationName" name="organizationName" required className="input"
                         placeholder="Northwind Bank" autoComplete="organization" />
                </div>
                <div>
                  <label className="label" htmlFor="displayName">Your name</label>
                  <input id="displayName" name="displayName" required className="input"
                         placeholder="Alex Fernandes" autoComplete="name" />
                </div>
              </>
            )}

            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required className="input"
                     placeholder="you@example.com" autoComplete="email" />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <input id="password" name="password" type="password" required className="input"
                     autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
              {mode === 'register' && (
                <p className="mt-1 text-xs text-ink-muted">
                  At least 12 characters, containing both letters and digits.
                </p>
              )}
            </div>

            {mode === 'login' && (
              <div>
                <label className="label" htmlFor="organizationSlug">Organization</label>
                <input id="organizationSlug" name="organizationSlug" className="input"
                       placeholder="northwind-bank"
                       aria-describedby="organizationSlug-hint" />
                <p id="organizationSlug-hint" className="mt-1 text-xs text-ink-muted">
                  Only needed when the same address belongs to more than one organization.
                </p>
              </div>
            )}

            {error !== null && <ErrorNotice error={error} />}

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create organization'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
