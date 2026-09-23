/**
 * Security headers, cookies, CORS and the misconfigurations that travel with them.
 *
 * Four concerns in one application because they are all properties of a response rather
 * than of a flow, and a passive scan reads them all from the same request. Splitting them
 * across four servers would multiply processes without adding a single distinct case.
 *
 * As with the XSS lab, some of this is deliberately correct. /strict returns every header
 * properly set and a correctly-attributed cookie; a scanner reporting a problem there is
 * producing a false positive.
 */
import { createSecurityLab } from '../shared/security-lab.js';

const PORT = Number(process.env.HEADERS_LAB_PORT ?? 4406);

const app = createSecurityLab({
  name: 'AIRA Headers and CORS Lab',
  vulnerabilities: [
    { id: 'VULN_NO_CSP', description: '/weak omits Content-Security-Policy.' },
    { id: 'VULN_WEAK_COOKIE', description: '/weak sets a session cookie with no Secure, HttpOnly or SameSite.' },
    { id: 'VULN_REFLECTED_CORS', description: '/api/data reflects any Origin and allows credentials.' },
    { id: 'VULN_DIRECTORY_LISTING', description: '/files lists a directory.' },
    { id: 'VULN_VERBOSE_ERROR', description: '/boom returns a stack trace.' },
    { id: 'VULN_SOURCE_MAP', description: '/app.js.map is served.' }
  ]
});

// ---- Deliberately correct ---------------------------------------------------

app.get('/strict', ctx => {
  app.writeSecurityHeaders(ctx);
  ctx.res.setHeader('Set-Cookie', 'session=synthetic; Path=/; HttpOnly; Secure; SameSite=Strict');
  return ctx.html(200, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Strict</title></head><body><p>Every header set. Nothing to report here.</p></body></html>');
});

// ---- Deliberately weak ------------------------------------------------------

app.get('/weak', ctx => {
  if (!app.faults.on('VULN_NO_CSP') && !app.faults.on('REMOVE_SECURITY_HEADERS')) {
    app.writeSecurityHeaders(ctx);
  }
  const cookie = app.faults.on('VULN_WEAK_COOKIE') || app.faults.on('WEAK_COOKIE')
    ? 'session=synthetic; Path=/'
    : 'session=synthetic; Path=/; HttpOnly; Secure; SameSite=Strict';
  ctx.res.setHeader('Set-Cookie', cookie);
  return ctx.html(200, '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Weak</title></head><body><p>Headers and cookie attributes are weak here.</p></body></html>');
});

// ---- CORS -------------------------------------------------------------------

const applyCors = ctx => {
  const origin = ctx.req.headers.origin;
  if (!origin) return;
  if (app.faults.on('VULN_REFLECTED_CORS') || app.faults.on('WEAK_CORS')) {
    // Reflecting an arbitrary origin *and* allowing credentials is the dangerous pair.
    // Either alone is often fine, which is why a detector has to look at both.
    ctx.res.setHeader('access-control-allow-origin', origin);
    ctx.res.setHeader('access-control-allow-credentials', 'true');
    ctx.res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    ctx.res.setHeader('access-control-allow-headers', '*');
  } else {
    ctx.res.setHeader('access-control-allow-origin', 'https://trusted.test');
    ctx.res.setHeader('vary', 'Origin');
  }
};

app.get('/api/data', ctx => { applyCors(ctx); return ctx.json(200, { data: 'synthetic', items: [1, 2, 3] }); });
app.get('/api/public', ctx => {
  // A wildcard with no credentials on genuinely public data. Correct, and commonly
  // mis-flagged, so it measures precision rather than recall.
  ctx.res.setHeader('access-control-allow-origin', '*');
  return ctx.json(200, { notice: 'Public reference data. No credentials accepted.' });
});

// ---- Misconfiguration -------------------------------------------------------

app.get('/files', ctx => {
  if (!app.faults.on('VULN_DIRECTORY_LISTING')) return ctx.json(403, { error: 'forbidden' });
  return ctx.html(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Index of /files</title></head>
<body><h1>Index of /files</h1><ul>
<li><a href="/files/report.csv">report.csv</a></li>
<li><a href="/files/backup.sql">backup.sql</a></li>
<li><a href="/files/.env">.env</a></li>
</ul></body></html>`);
});

app.get('/boom', ctx => {
  if (!app.faults.on('VULN_VERBOSE_ERROR') && !app.faults.on('EXPOSE_DEBUG')) {
    return ctx.json(500, { error: 'internal_error' });
  }
  return ctx.text(500, `System.NullReferenceException: Object reference not set to an instance of an object.
   at Lab.Controllers.ReportController.Generate(Int32 id) in /srv/lab/src/Controllers/ReportController.cs:line 87
   at Lab.Middleware.RequestPipeline.Invoke(HttpContext context) in /srv/lab/src/Middleware/RequestPipeline.cs:line 42
   Server: lab-web-03  Framework: SyntheticStack 4.2.1  Environment: Development`);
});

app.get('/app.js', ctx => {
  ctx.res.setHeader('content-type', 'application/javascript');
  const map = app.faults.on('VULN_SOURCE_MAP') || app.faults.on('EXPOSE_SOURCE_MAP')
    ? '\n//# sourceMappingURL=/app.js.map' : '';
  return ctx.text(200, `console.log("synthetic lab bundle");${map}`);
});

app.get('/app.js.map', ctx => {
  if (!app.faults.on('VULN_SOURCE_MAP') && !app.faults.on('EXPOSE_SOURCE_MAP')) {
    return ctx.json(404, { error: 'not_found' });
  }
  return ctx.json(200, {
    version: 3, file: 'app.js', sources: ['src/index.ts', 'src/internal/billing.ts'],
    sourcesContent: ['// synthetic source', '// synthetic internal source'], mappings: 'AAAA'
  });
});

app.get('/debug', ctx => {
  if (!app.faults.on('EXPOSE_DEBUG')) return ctx.json(404, { error: 'not_found' });
  return ctx.json(200, {
    environment: 'development', debug: true,
    config: { database: 'postgres://lab:synthetic@localhost/lab', featureFlags: ['x', 'y'] }
  });
});

app.get('/', ctx => { app.writeSecurityHeaders(ctx); return ctx.html(200,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Headers Lab</title></head><body>
  <h1>Headers, cookies, CORS and misconfiguration</h1>
  <ul>
    <li><a href="/strict" data-testid="strict-link">/strict — correct</a></li>
    <li><a href="/weak" data-testid="weak-link">/weak — weak</a></li>
    <li><a href="/api/data" data-testid="data-link">/api/data</a></li>
    <li><a href="/api/public" data-testid="public-link">/api/public — correctly public</a></li>
  </ul></body></html>`); });

app.post('/__reset', ctx => ctx.json(200, { reset: true }));

await app.listen(PORT);
