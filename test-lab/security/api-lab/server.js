/**
 * API security: tokens, object- and function-level authorization, input validation and
 * HTTP behaviour.
 *
 * Where the access-control lab is about who owns what, this one is about how an API
 * mishandles the request itself — a token it does not really check, a field it lets a
 * caller set that it should not, a method it answers that it should not, a payload size it
 * never bounds.
 *
 * Everything is synthetic and nothing is persisted between requests beyond one in-memory
 * list that /__reset empties.
 */
import { ACCOUNTS, IDENTITIES, createSecurityLab, findAccount, findIdentity, findIdentityById } from '../shared/security-lab.js';

const PORT = Number(process.env.API_LAB_PORT ?? 4402);

const app = createSecurityLab({
  name: 'QA NXT API Security Lab',
  vulnerabilities: [
    { id: 'VULN_UNVERIFIED_TOKEN', description: 'Any string shaped like a token is accepted; the signature is never checked.' },
    { id: 'VULN_MASS_ASSIGNMENT', description: 'PATCH /api/users/:id lets a caller set their own role (broken object property level authorization).' },
    { id: 'VULN_NO_INPUT_VALIDATION', description: 'POST /api/notes accepts any type and any size without validation.' },
    { id: 'VULN_UNSAFE_METHODS', description: 'TRACE and an unauthenticated DELETE are answered.' },
    { id: 'VULN_NO_RATE_LIMIT', description: '/api/search is never rate limited.' },
    { id: 'VULN_EXCESSIVE_DATA', description: '/api/users returns password hashes and tokens alongside public fields.' }
  ]
});

app.use(ctx => { app.writeSecurityHeaders(ctx); });

let notes = [];
let searchHits = 0;
const publicUser = i => ({ id: i.id, username: i.username, role: i.role, displayName: i.displayName });

/** The token check. With the vulnerability on, shape is mistaken for validity. */
const identityFor = ctx => {
  const bearer = (ctx.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return app.currentIdentity(ctx);
  if (app.faults.on('VULN_UNVERIFIED_TOKEN')) {
    // "It looks like a token, so it is one." A forged value naming any user is accepted.
    const claimed = bearer.split('.')[0];
    return findIdentityById(claimed) ?? findIdentity(claimed) ?? findIdentityById('u-alice');
  }
  return app.currentIdentity(ctx);
};

app.post('/api/session', async ctx => {
  const { username, password } = await ctx.body();
  const identity = findIdentity(String(username ?? ''));
  if (!identity || identity.password !== password) return ctx.json(401, { error: 'invalid_credentials' });
  const session = app.signIn(ctx, identity);
  return ctx.json(200, { user: publicUser(identity), token: `${identity.id}.synthetic`, csrfToken: session.csrf });
});

// ---- Excessive data exposure ------------------------------------------------

app.get('/api/users', ctx => {
  const identity = identityFor(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  if (app.faults.on('VULN_EXCESSIVE_DATA') || app.faults.on('EXPOSE_SENSITIVE_RESPONSE')) {
    return ctx.json(200, {
      users: IDENTITIES.map(i => ({
        ...publicUser(i),
        passwordHash: '$2b$12$syntheticsynthetichashvaluefortestingonly000000',
        apiToken: `sk_test_synthetic_${i.id}`,
        email: `${i.username}@lab.invalid`
      }))
    });
  }
  return ctx.json(200, { users: IDENTITIES.map(publicUser) });
});

// ---- Mass assignment / object property level authorization ------------------

app.patch('/api/users/:id', async ctx => {
  const identity = identityFor(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  const target = findIdentityById(ctx.params.id);
  if (!target) return ctx.json(404, { error: 'not_found' });
  if (target.id !== identity.id && identity.role !== 'admin') return ctx.json(403, { error: 'forbidden' });

  const patch = await ctx.body();
  const applied = {};
  for (const [key, value] of Object.entries(patch)) {
    // role is the field that must never be self-assignable.
    if (key === 'role' && !app.faults.on('VULN_MASS_ASSIGNMENT') && identity.role !== 'admin') continue;
    if (!['displayName', 'role'].includes(key)) continue;
    applied[key] = value;
  }
  return ctx.json(200, { user: { ...publicUser(target), ...applied }, applied: Object.keys(applied) });
});

// ---- Input validation --------------------------------------------------------

app.post('/api/notes', async ctx => {
  const identity = identityFor(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  const body = await ctx.body();

  if (!app.faults.on('VULN_NO_INPUT_VALIDATION')) {
    if (typeof body.title !== 'string') return ctx.json(400, { error: 'invalid_type', field: 'title' });
    if (body.title.length === 0) return ctx.json(400, { error: 'required', field: 'title' });
    if (body.title.length > 200) return ctx.json(400, { error: 'too_long', field: 'title', max: 200 });
  }
  const note = { id: `note-${notes.length + 1}`, title: body.title, owner: identity.id };
  notes.push(note);
  return ctx.json(201, { note });
});

app.get('/api/notes', ctx => {
  const identity = identityFor(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  return ctx.json(200, { notes: notes.filter(n => n.owner === identity.id) });
});

// ---- Function level authorization on a destructive verb ----------------------

app.delete('/api/notes/:id', ctx => {
  if (!app.faults.on('VULN_UNSAFE_METHODS')) {
    const identity = identityFor(ctx);
    if (!identity) return ctx.json(401, { error: 'unauthenticated' });
    if (identity.role === 'readonly') return ctx.json(403, { error: 'forbidden' });
  }
  notes = notes.filter(n => n.id !== ctx.params.id);
  return ctx.json(204, {});
});

// ---- Rate limiting -----------------------------------------------------------

app.get('/api/search', ctx => {
  searchHits += 1;
  if (!app.faults.on('VULN_NO_RATE_LIMIT') && !app.faults.on('DISABLE_RATE_LIMIT') && searchHits > 10) {
    return ctx.json(429, { error: 'too_many_requests', retryAfterSeconds: 60 });
  }
  return ctx.json(200, { query: ctx.query.q ?? '', results: [], hits: searchHits });
});

// ---- Object level authorization, the API flavour -----------------------------

app.get('/api/accounts/:id', ctx => {
  const identity = identityFor(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  const account = findAccount(ctx.params.id);
  if (!account) return ctx.json(404, { error: 'not_found' });
  if (!app.faults.on('DISABLE_AUTHORIZATION') && account.owner !== identity.id && identity.role !== 'admin') {
    return ctx.json(403, { error: 'forbidden' });
  }
  return ctx.json(200, { account });
});

app.get('/', ctx => ctx.json(200, {
  application: 'QA NXT API Security Lab',
  notice: 'Deliberately vulnerable. Synthetic data only.',
  endpoints: ['/api/session', '/api/users', '/api/users/:id', '/api/notes', '/api/search', '/api/accounts/:id']
}));

app.post('/__reset', ctx => { notes = []; searchHits = 0; app.resetSessions(); return ctx.json(200, { reset: true }); });

await app.listen(PORT);
