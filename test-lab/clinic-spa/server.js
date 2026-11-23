/**
 * A third target: nothing in the HTML.
 *
 * Meridian Freight renders its pages on the server; token-api is an API with one HTML
 * page. Both hand a crawler markup to read. This one does not. The server returns an empty
 * shell and a script; every screen, every form and every table is built by JavaScript from
 * JSON after load, and routing is client-side through the History API.
 *
 * That is most of the software written in the last ten years, and it is the shape that
 * breaks a crawler which reads responses instead of driving a browser. If discovery finds
 * one page here and the form extractor finds no forms, that is the finding.
 *
 * Domain: clinical appointment scheduling, deliberately unlike freight and orders.
 *
 * Planted, written down here rather than inferred later:
 *
 *   CS_D01  /api/appointments accepts an end time before the start time
 *   CS_D02  the patient search reflects its term into the DOM with innerHTML
 *   CS_D03  a clinician can read any patient's record by id, not only their own patients
 *   CS_D04  the "cancel" control is hidden for a receptionist and the endpoint allows it
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4600);

const USERS = new Map([
  ['dr.okafor', { password: 'Clinic!2026', role: 'clinician', clinician: 'cl-1' }],
  ['dr.nilsen', { password: 'Clinic!2026', role: 'clinician', clinician: 'cl-2' }],
  ['reception', { password: 'Clinic!2026', role: 'receptionist', clinician: null }]
]);

const PATIENTS = new Map([
  ['pat-1', { id: 'pat-1', name: 'A. Mensah', nhsNumber: '401 023 1199', clinician: 'cl-1' }],
  ['pat-2', { id: 'pat-2', name: 'B. Keane', nhsNumber: '660 884 2031', clinician: 'cl-2' }]
]);

const APPOINTMENTS = new Map([
  ['apt-1', { id: 'apt-1', patient: 'pat-1', start: '2026-12-01T09:00', end: '2026-12-01T09:30', status: 'booked' }]
]);

const SESSIONS = new Map();

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const session = (req) => {
  const raw = req.headers.cookie ?? '';
  const match = /clinic_session=([^;]+)/.exec(raw);
  if (!match) return null;
  const username = SESSIONS.get(match[1]);
  return username ? { username, ...USERS.get(username) } : null;
};

const body = (req) => new Promise(resolve => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

/** The shell. No content, no links, no forms — the application is the script. */
const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Clinic Scheduler</title></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>`;

const APP_JS = `
const api = (path, options) => fetch(path, { credentials: 'same-origin', ...options })
  .then(r => r.json().then(body => ({ status: r.status, body })));
const root = () => document.getElementById('root');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function go(path) { history.pushState({}, '', path); render(); }

function signInScreen(message) {
  root().innerHTML = \`<h1>Clinic Scheduler</h1>
    <form id="signin" novalidate>
      <label for="u">Username</label><input id="u" name="username" />
      <label for="p">Password</label><input id="p" name="password" type="password" />
      <button type="submit" data-testid="signin-submit">Sign in</button>
      <p class="error" data-testid="signin-error">\${message ? esc(message) : ''}</p>
    </form>\`;
  document.getElementById('signin').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('/api/session', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u.value, password: p.value }) });
    if (r.status === 200) go('/schedule'); else signInScreen('Those details were not recognised.');
  });
}

async function scheduleScreen() {
  const me = await api('/api/me');
  if (me.status !== 200) return signInScreen('');
  const appts = await api('/api/appointments');
  root().innerHTML = \`<h1>Schedule</h1>
    <nav><a href="/schedule" data-testid="nav-schedule">Schedule</a>
         <a href="/patients" data-testid="nav-patients">Patients</a></nav>
    <table data-testid="appointments"><thead><tr><th>Patient</th><th>Start</th><th>End</th><th>Status</th></tr></thead>
    <tbody>\${appts.body.map(a => \`<tr><td>\${esc(a.patient)}</td><td>\${esc(a.start)}</td>
      <td>\${esc(a.end)}</td><td>\${esc(a.status)}</td>
      <td>\${me.body.role === 'receptionist' ? '' :
        \`<button data-testid="cancel-\${a.id}">Cancel</button>\`}</td></tr>\`).join('')}</tbody></table>
    <h2>Book</h2>
    <form id="book" novalidate>
      <label for="pt">Patient</label><input id="pt" name="patient" value="pat-1" />
      <label for="st">Start</label><input id="st" name="start" type="datetime-local" required />
      <label for="en">End</label><input id="en" name="end" type="datetime-local" required />
      <button type="submit" data-testid="book-submit">Book</button>
      <p class="error" data-testid="book-error"></p>
    </form>\`;
  document.querySelectorAll('nav a').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); go(a.getAttribute('href')); }));
  // The cancel control, wired to the endpoint it represents.
  //
  // It was drawn and connected to nothing. CS_D04 is "the control is hidden for a
  // receptionist and the endpoint allows it anyway", and this screen rendered the button,
  // the server implemented the route, and no line of client code ever joined the two. So the
  // application never issued POST /api/appointments/:id/cancel, the crawl never observed it,
  // and the endpoint never reached the attack surface — which left the defect unreachable for
  // a reason that was nothing to do with the product under test. A fixture that does not do
  // the thing its ground truth describes measures nothing.
  document.querySelectorAll('[data-testid^="cancel-"]').forEach(button =>
    button.addEventListener('click', async () => {
      const id = button.getAttribute('data-testid').slice('cancel-'.length);
      await api(\`/api/appointments/\${id}/cancel\`, { method: 'POST' });
      scheduleScreen();
    }));
  document.getElementById('book').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('/api/appointments', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patient: pt.value, start: st.value, end: en.value }) });
    document.querySelector('[data-testid="book-error"]').textContent =
      r.status === 201 ? '' : (r.body.error ?? 'Could not book');
    if (r.status === 201) scheduleScreen();
  });
}

async function patientsScreen() {
  const url = new URL(location.href);
  const q = url.searchParams.get('q') ?? '';
  const found = await api('/api/patients?q=' + encodeURIComponent(q));
  // CS_D02: the term goes in as markup.
  root().innerHTML = '<h1>Patients</h1>' +
    '<form id="search"><label for="q">Find a patient</label>' +
    '<input id="q" name="q" value="' + esc(q) + '" />' +
    '<button type="submit" data-testid="search-submit">Search</button></form>' +
    '<p data-testid="search-echo">Showing matches for ' + q + '</p>' +
    '<table data-testid="patients"><tbody>' +
    found.body.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.nhsNumber) + '</td></tr>').join('') +
    '</tbody></table>';
  document.getElementById('search').addEventListener('submit', e => {
    e.preventDefault(); go('/patients?q=' + encodeURIComponent(document.getElementById('q').value));
  });
}

function render() {
  const path = location.pathname;
  if (path === '/patients') return patientsScreen();
  if (path === '/schedule') return scheduleScreen();
  return scheduleScreen();
}
window.addEventListener('popstate', render);
render();
`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // Returns the application to its seeded state. Present so that a test run starts from
  // the same application every time rather than from whatever the last run left behind.
  if (path === '/__reset' && req.method === 'POST') {
    APPOINTMENTS.clear();
    APPOINTMENTS.set('apt-1', { id: 'apt-1', patient: 'pat-1',
      start: '2026-12-01T09:00', end: '2026-12-01T09:30', status: 'booked' });
    SESSIONS.clear();
    return json(res, 200, { ok: true, appointments: APPOINTMENTS.size });
  }

  if (path === '/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    return res.end(APP_JS);
  }

  if (path === '/api/session' && req.method === 'POST') {
    const sent = await body(req);
    const user = USERS.get(String(sent.username ?? ''));
    if (!user || user.password !== sent.password) return json(res, 401, { error: 'invalid' });
    const id = randomUUID();
    SESSIONS.set(id, String(sent.username));
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `clinic_session=${id}; Path=/; HttpOnly; SameSite=Lax`
    });
    return res.end(JSON.stringify({ ok: true, role: user.role }));
  }

  if (path === '/api/me') {
    const me = session(req);
    return me ? json(res, 200, { username: me.username, role: me.role })
              : json(res, 401, { error: 'unauthenticated' });
  }

  if (path === '/api/appointments' && req.method === 'GET') {
    if (!session(req)) return json(res, 401, { error: 'unauthenticated' });
    return json(res, 200, [...APPOINTMENTS.values()]);
  }

  if (path === '/api/appointments' && req.method === 'POST') {
    const me = session(req);
    if (!me) return json(res, 401, { error: 'unauthenticated' });
    const sent = await body(req);
    // CS_D01: no comparison of end against start.
    if (!sent.patient || !sent.start || !sent.end) {
      return json(res, 400, { error: 'patient, start and end are required' });
    }
    const id = `apt-${APPOINTMENTS.size + 1}`;
    APPOINTMENTS.set(id, { id, patient: sent.patient, start: sent.start, end: sent.end, status: 'booked' });
    return json(res, 201, APPOINTMENTS.get(id));
  }

  const cancel = /^\/api\/appointments\/([^/]+)\/cancel$/.exec(path);
  if (cancel && req.method === 'POST') {
    const me = session(req);
    if (!me) return json(res, 401, { error: 'unauthenticated' });
    // CS_D04: the control is not drawn for a receptionist; the endpoint does not care.
    const appointment = APPOINTMENTS.get(cancel[1]);
    if (!appointment) return json(res, 404, { error: 'not_found' });
    appointment.status = 'cancelled';
    return json(res, 200, appointment);
  }

  if (path === '/api/patients') {
    if (!session(req)) return json(res, 401, { error: 'unauthenticated' });
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return json(res, 200, [...PATIENTS.values()].filter(p => p.name.toLowerCase().includes(q)));
  }

  const patient = /^\/api\/patients\/([^/]+)$/.exec(path);
  if (patient) {
    const me = session(req);
    if (!me) return json(res, 401, { error: 'unauthenticated' });
    const found = PATIENTS.get(patient[1]);
    if (!found) return json(res, 404, { error: 'not_found' });
    // CS_D03: no check that this patient belongs to this clinician.
    return json(res, 200, found);
  }

  // Every other path is the shell: client-side routing owns them all.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(SHELL);
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`clinic-spa listening on http://127.0.0.1:${PORT}`));
