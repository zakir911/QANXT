/** BUG-0001 reproduction: link-local accepted when ALLOW_PRIVATE_NETWORK_TARGETS=true. */
import { request, newTenant, saveEvidence, API } from './harness.mjs';

const attempt = Number(process.argv[2] ?? 1);
const tenant = await newTenant('Repro');
const project = await request('/api/v1/projects', {
  token: tenant.token, method: 'POST',
  body: { name: 'BUG-0001', key: `B${Math.random().toString(36).slice(2, 8).toUpperCase()}` }
});

const targets = [
  'http://169.254.169.254/latest/meta-data/',
  'http://[::ffff:169.254.169.254]/',
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
];

const rows = [];
for (const baseUrl of targets) {
  const response = await request('/api/v1/applications', {
    token: tenant.token, method: 'POST',
    body: { projectId: project.json.id, name: 'metadata probe', baseUrl, authStrategy: 'none' }
  });
  rows.push({ baseUrl, status: response.status, accepted: response.status < 400,
              body: response.text.slice(0, 200) });
  console.log(`${response.status < 400 ? 'ACCEPTED' : 'refused '} ${response.status}  ${baseUrl}`);
}

const accepted = rows.filter(r => r.accepted).length;
const path = saveEvidence(`failures/BUG-0001/api/attempt-${attempt}.json`, {
  attempt, api: API, at: new Date().toISOString(),
  allowPrivateNetworkTargets: true, accepted, total: rows.length, rows
});
console.log(`\nattempt ${attempt}: ${accepted}/${rows.length} accepted -> ${path}`);
process.exitCode = accepted > 0 ? 0 : 1;   // exits 0 while the bug reproduces
