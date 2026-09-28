/**
 * The scaffolding every security lab application shares.
 *
 * These applications are **deliberately vulnerable**. Each one exists so that QA NXT's
 * security engine has something with a known answer to find, and every vulnerability in
 * them is written down in that application's ground-truth file before QA NXT ever runs.
 * A scanner verified against an application whose flaws nobody enumerated first is a
 * scanner verified against its own output.
 *
 * They are local-only by construction: they bind to 127.0.0.1, they hold nothing but
 * synthetic data, and there is no code path in any of them that reaches the network. The
 * brief's rule — never use real vulnerable internet systems for automated verification —
 * is satisfied by there being nothing to reach.
 *
 * Two kinds of switch live here.
 *
 * A **vulnerability** is on by default. That is the point of the application: the access
 * control lab really does let user A read user B's account, and QA NXT is expected to find
 * it. Turning one off is how a false-positive test is built — the lab becomes correct, and
 * QA NXT reporting the finding anyway is a defect in QA NXT.
 *
 * A **security fault** is off by default and breaks a control that is otherwise sound, so a
 * run can prove QA NXT noticed a change rather than merely agreed with a fixture.
 */
import { createFaultEngine } from '../../shared/faults.js';
import { createLabApp } from '../../shared/http.js';

/**
 * Security faults, per the brief's list. Every one of them removes or weakens a control
 * that the application otherwise implements correctly.
 */
export const SECURITY_FAULTS = [
  { id: 'DISABLE_AUTH', description: 'Protected routes stop requiring a session.' },
  { id: 'DISABLE_AUTHORIZATION', description: 'Ownership and role checks stop being applied.' },
  { id: 'REMOVE_CSRF', description: 'State-changing requests stop requiring an anti-CSRF token.' },
  { id: 'WEAK_CORS', description: 'Any origin is reflected, with credentials allowed.' },
  { id: 'REMOVE_SECURITY_HEADERS', description: 'The browser security headers are not sent.' },
  { id: 'EXPOSE_DEBUG', description: 'A debug endpoint and verbose errors are exposed.' },
  { id: 'EXPOSE_SOURCE_MAP', description: 'A JavaScript source map is served.' },
  { id: 'WEAK_COOKIE', description: 'The session cookie loses Secure, HttpOnly and SameSite.' },
  { id: 'DISABLE_RATE_LIMIT', description: 'Sign-in stops being rate limited.' },
  { id: 'BROKEN_SESSION_EXPIRY', description: 'Sessions outlive their stated expiry and survive sign-out.' },
  { id: 'EXPOSE_SENSITIVE_RESPONSE', description: 'A response includes a password hash and a token.' }
];

/**
 * The synthetic identities every access-control test needs.
 *
 * Six of them, because the interesting cases are between roles rather than inside one:
 * two peers at the same level (horizontal), a privileged account (vertical), an account
 * that may read but not write, and no account at all.
 *
 * The passwords are obviously fake and identical by design. Nothing here is a credential;
 * an application that cannot be signed into is an application whose authorization cannot be
 * tested, and inventing plausible-looking secrets would only invite somebody to treat a lab
 * fixture as one.
 */
export const IDENTITIES = [
  { id: 'u-alice', username: 'alice', password: 'lab-password', role: 'customer', accountId: 'acc-1001', displayName: 'Alice Customer' },
  { id: 'u-bob', username: 'bob', password: 'lab-password', role: 'customer', accountId: 'acc-1002', displayName: 'Bob Customer' },
  { id: 'u-mallory', username: 'mallory', password: 'lab-password', role: 'readonly', accountId: 'acc-1003', displayName: 'Mallory ReadOnly' },
  { id: 'u-manager', username: 'manager', password: 'lab-password', role: 'manager', accountId: 'acc-1004', displayName: 'Mo Manager' },
  { id: 'u-admin', username: 'admin', password: 'lab-password', role: 'admin', accountId: 'acc-1005', displayName: 'Ada Admin' }
];

/** Synthetic accounts. Balances are round numbers so a leak is obvious in evidence. */
export const ACCOUNTS = [
  { id: 'acc-1001', owner: 'u-alice', name: 'Alice Current', balance: 1000, sortCode: '11-11-11' },
  { id: 'acc-1002', owner: 'u-bob', name: 'Bob Current', balance: 2000, sortCode: '22-22-22' },
  { id: 'acc-1003', owner: 'u-mallory', name: 'Mallory Savings', balance: 3000, sortCode: '33-33-33' },
  { id: 'acc-1004', owner: 'u-manager', name: 'Manager Ops', balance: 4000, sortCode: '44-44-44' },
  { id: 'acc-1005', owner: 'u-admin', name: 'Admin Control', balance: 5000, sortCode: '55-55-55' }
];

export const findIdentity = username => IDENTITIES.find(i => i.username === username);
export const findIdentityById = id => IDENTITIES.find(i => i.id === id);
export const findAccount = id => ACCOUNTS.find(a => a.id === id);

/**
 * Creates a security lab application with the fault registry, session handling and the
 * common administrative routes already wired.
 *
 * `vulnerabilities` are the flaws this application ships with, each defaulting to on. They
 * appear in the same `/__faults` registry as the security faults so a test discovers them
 * rather than keeping its own list, and so a false-positive scenario is built by switching
 * one off through the same API.
 */
export function createSecurityLab({ name, version = '1.0.0', vulnerabilities = [], extraFaults = [] }) {
  const catalogue = [
    ...SECURITY_FAULTS,
    ...extraFaults,
    // Vulnerabilities are registered with defaultEnabled so the fault engine reports them
    // truthfully in /__faults rather than claiming a vulnerable app is clean.
    ...vulnerabilities.map(v => ({ ...v, defaultEnabled: true }))
  ];

  // defaultEnabled carries the vulnerabilities through construction *and* through
  // /__faults/reset. Forcing them on after construction would have worked for the first
  // case and silently failed for the second, which is the one a suite actually relies on.
  const faults = createFaultEngine(catalogue);

  const app = createLabApp({ name, faults, version });
  const sessions = new Map();

  /** Cookie attributes, which WEAK_COOKIE removes. */
  const cookieAttributes = () => faults.on('WEAK_COOKIE')
    ? ['Path=/']
    : ['Path=/', 'HttpOnly', 'SameSite=Strict'];

  app.signIn = (ctx, identity, { ttlSeconds = 900 } = {}) => {
    const token = `sess-${Math.random().toString(36).slice(2, 18)}`;
    sessions.set(token, {
      identity: identity.id,
      csrf: `csrf-${Math.random().toString(36).slice(2, 18)}`,
      expiresAt: Date.now() + ttlSeconds * 1000,
      signedOut: false
    });
    const parts = [`session=${token}`, ...cookieAttributes(), `Max-Age=${ttlSeconds}`];
    const existing = ctx.res.getHeader('Set-Cookie');
    ctx.res.setHeader('Set-Cookie', existing ? [].concat(existing, parts.join('; ')) : parts.join('; '));
    return sessions.get(token);
  };

  app.signOut = ctx => {
    const token = ctx.cookies.session;
    const session = token ? sessions.get(token) : null;
    if (session) {
      // BROKEN_SESSION_EXPIRY leaves the session usable after sign-out, which is the
      // "session reuse after logout" case the brief asks for.
      if (faults.on('BROKEN_SESSION_EXPIRY')) session.signedOut = true;
      else sessions.delete(token);
    }
    ctx.res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  };

  /** The current session, or null. Honours DISABLE_AUTH and BROKEN_SESSION_EXPIRY. */
  app.currentSession = ctx => {
    const bearer = (ctx.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const token = ctx.cookies.session ?? (bearer.length > 0 ? bearer : null);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.signedOut && !faults.on('BROKEN_SESSION_EXPIRY')) return null;
    if (session.expiresAt < Date.now() && !faults.on('BROKEN_SESSION_EXPIRY')) {
      sessions.delete(token);
      return null;
    }
    return session;
  };

  app.currentIdentity = ctx => {
    if (faults.on('DISABLE_AUTH')) return findIdentityById('u-alice');
    const session = app.currentSession(ctx);
    return session ? findIdentityById(session.identity) : null;
  };

  /** Writes the browser security headers, unless REMOVE_SECURITY_HEADERS says otherwise. */
  app.writeSecurityHeaders = ctx => {
    if (faults.on('REMOVE_SECURITY_HEADERS')) return;
    ctx.res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
    ctx.res.setHeader('x-content-type-options', 'nosniff');
    ctx.res.setHeader('x-frame-options', 'DENY');
    ctx.res.setHeader('referrer-policy', 'no-referrer');
    ctx.res.setHeader('permissions-policy', 'geolocation=(), camera=(), microphone=()');
    ctx.res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  };

  app.sessions = sessions;
  app.resetSessions = () => sessions.clear();
  return app;
}
