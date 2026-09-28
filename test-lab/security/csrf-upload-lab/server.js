/**
 * CSRF, file upload and open redirect.
 *
 * Grouped because all three are about a state-changing request the application should have
 * refused: one forged from another origin, one carrying a file it should not accept, one
 * sending a visitor somewhere it should not.
 *
 * Every upload here is discarded. Nothing is written to disk, nothing is executed, and the
 * largest thing the application will hold is a filename. "Never upload malware" is easy to
 * honour when there is nowhere for a file to land.
 */
import { createSecurityLab, findIdentity } from '../shared/security-lab.js';

const PORT = Number(process.env.CSRF_UPLOAD_LAB_PORT ?? 4404);

const app = createSecurityLab({
  name: 'QA NXT CSRF, Upload and Redirect Lab',
  vulnerabilities: [
    { id: 'VULN_NO_CSRF_TOKEN', description: 'POST /api/transfer accepts a state-changing request with no anti-CSRF token.' },
    { id: 'VULN_NO_ORIGIN_CHECK', description: 'POST /api/transfer does not check Origin or Referer.' },
    { id: 'VULN_UPLOAD_ANY_TYPE', description: 'Uploads accept any extension and any declared content type.' },
    { id: 'VULN_UPLOAD_NO_SIZE_LIMIT', description: 'Uploads are never bounded by size.' },
    { id: 'VULN_UPLOAD_PATH_TRAVERSAL', description: 'The supplied filename is used unsanitised, so ../ survives.' },
    { id: 'VULN_SSRF', description: 'GET /api/fetch takes a URL from the caller and never validates the destination.' },
    { id: 'VULN_OPEN_REDIRECT', description: '/redirect?next= sends the visitor to any absolute URL.' }
  ]
});

app.use(ctx => { app.writeSecurityHeaders(ctx); });

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.pdf', '.txt', '.csv'];
const MAX_UPLOAD_BYTES = 64 * 1024;
let uploads = [];

app.post('/api/session', async ctx => {
  const { username, password } = await ctx.body();
  const identity = findIdentity(String(username ?? ''));
  if (!identity || identity.password !== password) return ctx.json(401, { error: 'invalid_credentials' });
  const session = app.signIn(ctx, identity);
  return ctx.json(200, { user: { id: identity.id, username: identity.username }, csrfToken: session.csrf });
});

// ---- CSRF --------------------------------------------------------------------

app.post('/api/transfer', async ctx => {
  const session = app.currentSession(ctx);
  if (!session) return ctx.json(401, { error: 'unauthenticated' });

  const suppliedToken = ctx.req.headers['x-csrf-token'];
  const tokenRequired = !app.faults.on('VULN_NO_CSRF_TOKEN') && !app.faults.on('REMOVE_CSRF');
  if (tokenRequired && suppliedToken !== session.csrf) {
    return ctx.json(403, { error: 'csrf_token_missing_or_invalid' });
  }

  const originRequired = !app.faults.on('VULN_NO_ORIGIN_CHECK') && !app.faults.on('REMOVE_CSRF');
  if (originRequired) {
    const origin = ctx.req.headers.origin ?? ctx.req.headers.referer ?? '';
    // Same-origin only. An absent Origin on a cross-site form post is the case that matters.
    if (!origin.startsWith(`http://127.0.0.1:${PORT}`) && !origin.startsWith(`http://localhost:${PORT}`)) {
      return ctx.json(403, { error: 'origin_not_allowed', origin: origin || null });
    }
  }

  const body = await ctx.body();
  return ctx.json(201, {
    transfer: { id: `txn-${Date.now()}`, to: body.to ?? null, amount: body.amount ?? null },
    note: 'Synthetic. No balance was changed.'
  });
});

// ---- Upload -------------------------------------------------------------------

app.post('/api/upload', async ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });

  const body = await ctx.body();
  const filename = String(body.filename ?? body.name ?? 'unnamed');
  const declaredType = String(body.contentType ?? 'application/octet-stream');
  const size = Number(body.size ?? (typeof body.content === 'string' ? body.content.length : 0));

  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')).toLowerCase() : '';

  if (!app.faults.on('VULN_UPLOAD_ANY_TYPE')) {
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      return ctx.json(400, { error: 'extension_not_allowed', extension, allowed: ALLOWED_EXTENSIONS });
    }
    // Extension and declared type have to agree; trusting either alone is the usual mistake.
    const expected = { '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv' }[extension];
    if (expected && declaredType !== expected) {
      return ctx.json(400, { error: 'content_type_mismatch', extension, declaredType, expected });
    }
  }

  if (!app.faults.on('VULN_UPLOAD_NO_SIZE_LIMIT') && size > MAX_UPLOAD_BYTES) {
    return ctx.json(413, { error: 'too_large', size, maxBytes: MAX_UPLOAD_BYTES });
  }

  // The stored name. Unsanitised, "../../etc/passwd" survives intact — which is the
  // indicator, without anything ever being written anywhere.
  const storedAs = app.faults.on('VULN_UPLOAD_PATH_TRAVERSAL')
    ? filename
    : filename.replaceAll('\\', '/').split('/').pop().replace(/[^a-zA-Z0-9._-]/g, '_');

  uploads.push({ filename, storedAs, declaredType, size, owner: identity.id });
  return ctx.json(201, {
    upload: { filename, storedAs, declaredType, size },
    note: 'Synthetic. Nothing was written to disk.'
  });
});

app.get('/api/uploads', ctx => ctx.json(200, { uploads }));

// ---- Open redirect --------------------------------------------------------------

app.get('/redirect', ctx => {
  const next = String(ctx.query.next ?? ctx.query.returnUrl ?? ctx.query.redirect ?? '/');
  if (app.faults.on('VULN_OPEN_REDIRECT')) return ctx.redirect(next);

  // Relative destinations only — the correct behaviour, and the one a detector must not
  // report.
  if (next.startsWith('/') && !next.startsWith('//')) return ctx.redirect(next);
  return ctx.json(400, { error: 'redirect_not_allowed', next });
});

// ---- SSRF ----------------------------------------------------------------------

/**
 * A "fetch this URL for me" endpoint, which is where SSRF lives.
 *
 * Nothing is ever actually fetched, by design. A lab that made real outbound requests on
 * behalf of whatever a test put in a query string would be a tool for reaching things, and
 * the point here is to reproduce the *decision* an application makes — accept the
 * destination or refuse it — not the connection that follows.
 *
 * Vulnerable: any destination is taken seriously and a connection failure is reported.
 * Correct: anything that is not this application's own origin is refused outright.
 */
app.get('/api/fetch', ctx => {
  const target = String(ctx.query.url ?? '');
  let parsed = null;
  try { parsed = new URL(target); } catch { /* not absolute */ }

  const sameOrigin = parsed !== null
    && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    && parsed.port === String(PORT);

  if (!app.faults.on('VULN_SSRF') && !sameOrigin) {
    return ctx.json(400, { error: 'url_not_allowed', url: target || null });
  }
  if (parsed === null) return ctx.json(400, { error: 'invalid_url', url: target || null });

  if (sameOrigin) {
    return ctx.json(200, { fetched: target, status: 200, note: 'Synthetic. Nothing was actually fetched.' });
  }
  // The vulnerable path: the destination was accepted. The failure reported is synthetic —
  // no socket was opened and nothing left this process.
  return ctx.json(502, {
    error: 'fetch_failed',
    attempted: target,
    message: `connect ECONNREFUSED ${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`,
    note: 'Synthetic. The destination was accepted but no request was made.'
  });
});

app.get('/', ctx => ctx.html(200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CSRF, Upload and Redirect Lab</title></head>
<body>
  <h1>CSRF, upload and redirect</h1>
  <p>Deliberately vulnerable. Nothing is written to disk.</p>
  <form method="post" action="/api/transfer" data-testid="transfer-form">
    <input name="to" data-testid="to"><input name="amount" data-testid="amount">
    <button type="submit" data-testid="transfer-submit">Transfer</button>
  </form>
</body></html>`));

app.post('/__reset', ctx => { uploads = []; app.resetSessions(); return ctx.json(200, { reset: true }); });

await app.listen(PORT);
