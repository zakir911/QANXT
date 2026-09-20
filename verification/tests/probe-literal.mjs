import { newTenant, request } from './harness.mjs';
const t = await newTenant('Lit');
const p = await request('/api/v1/projects', { token: t.token, method: 'POST',
  body: { name: 'Lit', key: `L${Math.random().toString(36).slice(2,8).toUpperCase()}` } });
const a = await request('/api/v1/applications', { token: t.token, method: 'POST',
  body: { projectId: p.json.id, name: 'Bank', baseUrl: 'http://localhost:4200/dashboard',
    allowedDomains: 'localhost', authStrategy: 'formLogin',
    loginUrl: 'http://localhost:4200/login',
    credentials: { username: 'alice', password: 'Password123!' } } });

const imported = await request('/api/v1/journeys/import', { token: t.token, method: 'POST',
  body: { projectId: p.json.id, applicationId: a.json.id, journey: {
    schemaVersion: 1, name: 'Literal password', startUrl: 'http://localhost:4200/login',
    recordedAt: new Date().toISOString(), recorderVersion: '0.1.0',
    steps: [
      { order: 1, action: 'navigate', description: 'open', url: 'http://localhost:4200/login', timestampMs: 1 },
      { order: 2, action: 'fill', description: 'password',
        target: { strategy: 'testId', value: 'password', exact: false, fallbacks: [] },
        value: 'Password123!', url: 'http://localhost:4200/login', timestampMs: 1 }
    ] } } });

console.log('import status:', imported.status);
console.log('warnings:', JSON.stringify(imported.json?.warnings ?? []));
const tc = await request(`/api/v1/testcases/${imported.json.testCaseId}`, { token: t.token });
const step = tc.json.steps.find(s => s.action === 'fill');
console.log('stored value returned by the API:', JSON.stringify(step?.value));
console.log('literal present in the test-case response:', tc.text.includes('Password123!'));
