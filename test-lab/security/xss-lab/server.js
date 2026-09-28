/**
 * Cross-site scripting, and — just as important — input that is reflected safely.
 *
 * The brief is explicit: do not report XSS solely because a string was reflected. So this
 * application reflects input four different ways, and only two of them are vulnerable:
 *
 *   /search?q=            reflected raw into HTML          VULNERABLE
 *   /greet?name=          reflected HTML-escaped           SAFE — a detector firing here is wrong
 *   /profile?bio=         stored, then rendered raw        VULNERABLE (stored)
 *   /echo?value=          reflected into a JSON response   SAFE — not an HTML context
 *
 * The safe ones are not filler. A detector that cannot tell escaped reflection from unsafe
 * reflection produces findings nobody trusts, and the two safe endpoints are what measures
 * that.
 *
 * Payloads are markers, never destructive. Nothing here executes anything on its own.
 */
import { createSecurityLab } from '../shared/security-lab.js';

const PORT = Number(process.env.XSS_LAB_PORT ?? 4403);

const app = createSecurityLab({
  name: 'QA NXT XSS Lab',
  vulnerabilities: [
    { id: 'VULN_REFLECTED_XSS', description: '/search reflects the q parameter into HTML without encoding.' },
    { id: 'VULN_STORED_XSS', description: '/profile stores a bio and renders it without encoding.' },
    { id: 'VULN_DOM_XSS', description: '/dom writes location.hash into innerHTML on the client.' }
  ]
});

app.use(ctx => { app.writeSecurityHeaders(ctx); });

const escapeHtml = v => String(v ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

let storedBio = 'A synthetic biography.';

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`;

// VULNERABLE: raw reflection into an HTML context.
app.get('/search', ctx => {
  const q = ctx.query.q ?? '';
  const rendered = app.faults.on('VULN_REFLECTED_XSS') ? q : escapeHtml(q);
  return ctx.html(200, page('Search', `
    <form method="get" action="/search">
      <input name="q" data-testid="q" value="${escapeHtml(q)}">
      <button type="submit" data-testid="search-submit">Search</button>
    </form>
    <p data-testid="results">No results for ${rendered}</p>`));
});

// SAFE by construction. A detector reporting XSS here is producing a false positive, and
// that is precisely what this endpoint is for.
app.get('/greet', ctx => ctx.html(200, page('Greeting',
  `<p data-testid="greeting">Hello, ${escapeHtml(ctx.query.name ?? 'stranger')}</p>`)));

// SAFE: a JSON response is not an HTML context. Reflection here is not XSS, and a scanner
// that flags it does not understand context.
app.get('/echo', ctx => ctx.json(200, { value: ctx.query.value ?? '', note: 'Reflected into JSON, not HTML.' }));

// VULNERABLE (stored): written once, rendered raw on every later read.
app.post('/profile', async ctx => {
  const body = await ctx.body();
  storedBio = String(body.bio ?? '');
  return ctx.json(200, { saved: true });
});

app.get('/profile', ctx => {
  const rendered = app.faults.on('VULN_STORED_XSS') ? storedBio : escapeHtml(storedBio);
  return ctx.html(200, page('Profile', `
    <div data-testid="bio">${rendered}</div>
    <form method="post" action="/profile">
      <input name="bio" data-testid="bio-input">
      <button type="submit" data-testid="bio-submit">Save</button>
    </form>`));
});

// VULNERABLE (DOM): the sink is in the browser, not the response body, so this is the case
// a response-only scanner cannot see and a browser-driven one can.
//
// This route relaxes the shared Content-Security-Policy to allow inline script, in BOTH fault
// states, and that is deliberate on both counts.
//
// It has to allow inline script at all because the lab's default policy — default-src 'self',
// no 'unsafe-inline' — blocks this page's own <script> block. With it, the sink never runs, the
// output div stays empty, and the application declares a DOM XSS in its ground truth that
// cannot be exploited because nothing executes. A ground truth that names a flaw the running
// application does not have is a broken ruler: every detector measured against it is marked
// down for missing something that was not there.
//
// It has to relax it in BOTH states so that the sink is the only thing that differs between
// them. If only the vulnerable variant allowed inline script, a detector could score a perfect
// result by noticing the header and never looking at the page, which is precisely the kind of
// shortcut this lab exists to catch.
//
// 'unsafe-inline' is, for what it is worth, what a great many real applications send.
app.get('/dom', ctx => {
  ctx.res.setHeader('content-security-policy',
    "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  return ctx.html(200, page('DOM', `
  <div id="output" data-testid="output"></div>
  <script>
    var raw = decodeURIComponent(location.hash.slice(1));
    ${app.faults.on('VULN_DOM_XSS')
      ? 'document.getElementById("output").innerHTML = raw;'
      : 'document.getElementById("output").textContent = raw;'}
  </script>`));
});

app.get('/', ctx => ctx.html(200, page('XSS Lab', `
  <p>Deliberately vulnerable in some places and deliberately correct in others.</p>
  <ul>
    <li><a href="/search?q=hello" data-testid="search-link">/search — raw reflection</a></li>
    <li><a href="/greet?name=hello" data-testid="greet-link">/greet — escaped reflection</a></li>
    <li><a href="/profile" data-testid="profile-link">/profile — stored</a></li>
    <li><a href="/dom#hello" data-testid="dom-link">/dom — DOM sink</a></li>
  </ul>`)));

app.post('/__reset', ctx => { storedBio = 'A synthetic biography.'; return ctx.json(200, { reset: true }); });

await app.listen(PORT);
