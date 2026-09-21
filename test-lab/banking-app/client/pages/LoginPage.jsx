import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { lab, domId, testId } from '../lab.js';
import { useSession } from '../App.jsx';

/**
 * The sign-in page, and the lab's main locator-drift surface.
 *
 * Three faults change what is on this page: the submit control can be relabelled, it can
 * be removed altogether, and the sign-in API can fail in four different ways. Everything
 * else about the page stays the same, which is what makes it a fair test of whether an
 * automated test can survive the change.
 */
export function LoginPage() {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!username || !password) {
      setError({ message: lab.invalidValidation
        ? 'Enter a username of at least 12 characters.'   // a rule this form does not apply
        : 'Enter your username and password.' });
      return;
    }

    setBusy(true);
    try {
      const result = await api.signIn(username, password, remember);
      setUser(result.user);
      navigate('/dashboard');
    } catch (failure) {
      setError({ message: failure.message, kind: failure.kind, status: failure.status ?? null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <h1 {...testId('login-title')}>AIRA Demo Bank</h1>
        <p className="sub">Sign in to your online banking.</p>

        <form onSubmit={submit} noValidate {...testId('login-form')}>
          <div className="field">
            <label htmlFor={domId('username')}>Username</label>
            <input id={domId('username')} name="username" autoComplete="username"
              value={username} onChange={event => setUsername(event.target.value)}
              {...testId('username')} />
          </div>

          <div className="field">
            <label htmlFor={domId('password')}>Password</label>
            <input id={domId('password')} name="password" type="password" autoComplete="current-password"
              value={password} onChange={event => setPassword(event.target.value)}
              {...testId('password')} />
          </div>

          <div className="field-inline">
            <input id={domId('remember')} type="checkbox" checked={remember}
              onChange={event => setRemember(event.target.checked)} {...testId('remember-me')} />
            <label htmlFor={domId('remember')}>Remember me on this device</label>
          </div>

          {/* The submit control: present and labelled "Log in", relabelled "Sign In", or
              absent entirely. Nothing else about the form changes with it. */}
          {lab.removedSignIn ? (
            <p className="notice" {...testId('signin-unavailable')}>
              Sign-in is temporarily unavailable. Please try again later.
            </p>
          ) : (
            <button type="submit" className="primary" disabled={busy}
              {...testId(lab.renamedSignIn ? 'signin-submit' : 'login-submit')}>
              {busy ? 'Signing in…' : lab.renamedSignIn ? 'Sign In' : 'Log in'}
            </button>
          )}

          {error && (
            <p className="error" role="alert" {...testId('login-error')}>{error.message}</p>
          )}
        </form>

        <p className="help">
          <Link to="/login?forgot=1" {...testId('forgot-password')}>Forgotten your password?</Link>
        </p>
        <p className="hint">Try <code>alice</code> / <code>Password123!</code>. Three wrong passwords lock the account.</p>
      </div>
    </div>
  );
}
