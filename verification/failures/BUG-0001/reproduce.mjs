/** Probes the URL guard directly, with private-network targets disallowed. */
import { request, newTenant } from './harness.mjs';

const API_STRICT = 'http://127.0.0.1:5099';
const at = (path, options) => request(`${API_STRICT}${path}`, options);

const unique = Math.random().toString(36).slice(2, 12);
const reg = await at('/api/v1/auth/register', {
  method: 'POST',
  body: { organizationName: `SSRF ${unique}`, email: `ssrf-${unique}@example.test`,
          password: 'Str0ngPassphrase!2026', displayName: 'SSRF Probe' }
});
const token = reg.json.accessToken;
const project = await at('/api/v1/projects', {
  token, method: 'POST', body: { name: 'SSRF', key: `S${unique.slice(0,7).toUpperCase()}` }
});

const targets = [
  ['decimal loopback',        'http://2130706433/'],
  ['octal loopback',          'http://0177.0.0.1/'],
  ['hex loopback',            'http://0x7f.0x0.0x0.0x1/'],
  ['short loopback',          'http://127.1/'],
  ['plain metadata',          'http://169.254.169.254/latest/meta-data/'],
  ['ipv6-mapped metadata',    'http://[::ffff:169.254.169.254]/'],
  ['ipv6 loopback',           'http://[::1]/'],
  ['metadata hostname',       'http://metadata.google.internal/'],
  ['private 10.x',            'http://10.0.0.5/'],
  ['private 192.168.x',       'http://192.168.1.1/'],
  ['private 172.16.x',        'http://172.16.0.1/'],
  ['localhost by name',       'http://localhost:4200/'],
  ['userinfo trick',          'http://169.254.169.254@example.com/'],
  ['public control',          'https://bank.example.test/']
];

const rows = [];
for (const [label, baseUrl] of targets) {
  const response = await at('/api/v1/applications', {
    token, method: 'POST',
    body: { projectId: project.json.id, name: `probe ${label}`, baseUrl, authStrategy: 'none' }
  });
  const reason = response.json?.title ?? response.text.slice(0, 90);
  rows.push({ label, baseUrl, status: response.status, accepted: response.status < 400, reason });
}

console.log('ALLOW_PRIVATE_NETWORK_TARGETS=false');
console.log('');
for (const r of rows) {
  console.log(`${r.accepted ? 'ACCEPTED' : 'refused '}  ${String(r.status).padEnd(4)} ${r.label.padEnd(22)} ${r.baseUrl}`);
  if (!r.accepted) console.log(`            ${r.reason.slice(0, 100)}`);
}
console.log('');
console.log(JSON.stringify(rows, null, 2));
