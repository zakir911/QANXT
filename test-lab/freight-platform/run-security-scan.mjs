/**
 * Runs QA NXT's security scan against Meridian Freight with more than one identity.
 *
 * ## What this corrects
 *
 * The scanner implements 24 checks, among them the ones a security engineer would reach for
 * first: authz.bola (broken object level authorization — IDOR), authz.vertical (privilege
 * escalation), authz.readonly (a read-only account that can write), authz.token (a forged
 * token the application never issued), authz.missing, four injection families,
 * passive.cookies, passive.sensitive-data, passive.cors, passive.headers, and five API
 * checks including mass assignment and rate limiting.
 *
 * Every authorization check needs two identities to compare. Given one, they return
 * `inconclusive` with the reason said plainly — "A privileged and a lesser identity are
 * needed; both were not available" — which is the right answer and not a pass.
 *
 * No driver in this test lab ever supplied identities, so every authorization check in every
 * run reported inconclusive and the platform was recorded as having found no authorization
 * defects. It was never asked.
 *
 * Meridian Freight seeds eight accounts across distinct roles. Three of them are exactly what
 * the checks want: an administrator, an operator who owns records, and a read-only auditor.
 * They are synthetic accounts in a synthetic application on loopback; nothing here is real.
 *
 *   node run-security-scan.mjs [--profile standard|deep]
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  request, newTenant, createProject, registerApplication, runDiscovery
} from '../../verification/golden-tests/platform.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const PROFILE = arg('profile', 'standard');
const BUDGET = Number(arg('budget', 900));
const MAX_PAGES = Number(arg('max-pages', 160));
const FREIGHT = process.env.FREIGHT_URL ?? 'http://127.0.0.1:4400';

const line = (text = '') => console.log(text);
const section = (title) => {
  line(); line('─'.repeat(74)); line(`  ${title}`); line('─'.repeat(74));
};

/**
 * The three identities the authorization checks compare, by the role each check asks for.
 *
 * The passwords are the seed's, in a synthetic application bound to loopback. They are here
 * rather than in the environment because this script only ever points at that application;
 * pointed anywhere else it would be a credential-stuffing tool, which is why the target is
 * checked below rather than taken on trust.
 */
const IDENTITIES = [
  { label: 'administrator', username: 'admin', password: 'Freight!2026', role: 'privileged' },
  { label: 'operations', username: 'ops.lead', password: 'Freight!2026', role: 'owner' },
  { label: 'audit viewer', username: 'readonly', password: 'Freight!2026', role: 'readonly' }
];

const host = new URL(FREIGHT).hostname;
if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) {
  console.error(`Refusing to run: ${FREIGHT} is not loopback. This script carries seeded `
    + `credentials for the local test lab and must not be pointed at anything else.`);
  process.exit(2);
}

const groundTruth = JSON.parse(
  await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const securityDefects = groundTruth.defects.list.filter(d => d.category === 'security'
  || d.category === 'authorization');

const result = { startedAt: new Date().toISOString(), target: FREIGHT, profile: PROFILE, stages: {} };

line(`\nMeridian Freight at ${FREIGHT}`);
line(`${securityDefects.length} planted security or authorization defect(s) to measure against:`);
for (const d of securityDefects) line(`  ${d.id}  ${d.screen}`);

// ---- 1. tenant, application, discovery ---------------------------------------
section('1. Sign up, register, discover');
const tenant = await newTenant('Security');
const project = await createProject(tenant, 'Meridian Freight — security',
  { aiEnabled: false, aiProvider: 'local' });
const application = await registerApplication(tenant, project.id, {
  name: 'Meridian Freight', baseUrl: FREIGHT, loginUrl: `${FREIGHT}/auth/sign-in`,
  username: 'ops.lead', password: 'Freight!2026', maxPages: MAX_PAGES
});
await request(`/api/v1/applications/${application.id}`, {
  token: tenant.token, method: 'PATCH',
  body: { maxPages: MAX_PAGES, maxCrawlDepth: 6, explorationTimeoutSeconds: BUDGET,
          interactionMode: 'navigation' }
});
const discovery = await runDiscovery(tenant, application.id, {
  maxPages: MAX_PAGES, maxDepth: 6, timeoutSeconds: BUDGET, timeoutMs: (BUDGET + 300) * 1000
});
line(`  discovery ${discovery.status}, ${discovery.pagesDiscovered ?? '?'} page(s)`);
result.stages.discovery = { status: discovery.status, pages: discovery.pagesDiscovered ?? null };

// ---- 2. authorize the scan ----------------------------------------------------
section('2. Authorize the scan');
const scope = await request(`/api/v1/security/applications/${application.id}/scope`, {
  token: tenant.token, method: 'PUT',
  body: {
    enabled: true, allowedDomains: '127.0.0.1',
    authorizationNote: 'Synthetic freight application on loopback, built for this exercise '
      + 'and authorized for security testing. No real system and no real data is involved.'
  }
});
line(`  scope ${scope.status}`);

// ---- 3. scan, with the identities the authz checks need -----------------------
section('3. Scan with three identities');
for (const identity of IDENTITIES) line(`  ${identity.role.padEnd(11)} ${identity.label}`);

const started = await request('/api/v1/security/scans/start', {
  token: tenant.token, method: 'POST',
  body: { applicationId: application.id, profile: PROFILE, identities: IDENTITIES }
});
if (!started.ok) {
  line(`\n  REFUSED ${started.status}: ${started.text.slice(0, 400)}`);
  result.stages.scan = { ok: false, status: started.status, body: started.text.slice(0, 800) };
  await writeFile(new URL('./security-result.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n');
  process.exit(1);
}
const scanId = started.json?.securityScanId ?? started.json?.id;
line(`\n  scan ${scanId}`);
line(`  ${started.json?.targets ?? '?'} target(s), ${started.json?.checksToRun ?? '?'} check(s) to run `
  + `of ${started.json?.checksConfigured ?? '?'} configured`);
if (started.json?.summary) line(`  "${started.json.summary}"`);

// ---- 4. wait -------------------------------------------------------------------
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'abandoned', 'partiallycompleted']);
const deadline = Date.now() + 45 * 60 * 1000;
let scan = null;
while (Date.now() < deadline) {
  const current = await request(`/api/v1/security/scans/${scanId}`, { token: tenant.token });
  scan = current.json?.scan ?? current.json ?? scan;
  if (scan && TERMINAL.has(String(scan.status).toLowerCase())) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}
line(`  status ${scan?.status ?? 'unknown'} — ${scan?.requestsIssued ?? '?'} request(s), `
  + `${scan?.testsExecuted ?? '?'} check(s) executed, ${scan?.testsSkipped ?? '?'} skipped`);

// ---- 5. findings ----------------------------------------------------------------
section('4. Findings');
const findings = await request(
  `/api/v1/security/applications/${application.id}/findings?pageSize=500`, { token: tenant.token });
const list = findings.json?.items ?? findings.json ?? [];
line(`  ${list.length} finding(s)`);

const bySeverity = {};
for (const f of list) bySeverity[f.severity ?? '?'] = (bySeverity[f.severity ?? '?'] ?? 0) + 1;
if (list.length) line(`  by severity: ${JSON.stringify(bySeverity)}`);

for (const f of list) {
  line(`\n  [${f.severity ?? '?'}] ${(f.title ?? '').slice(0, 92)}`);
  line(`      category ${f.category ?? '?'}  ${f.httpMethod ?? ''} ${(f.endpoint ?? '').slice(0, 56)}`);
  if (f.observedAsRole) line(`      observed as ${f.observedAsRole}`);
  if (f.cwe) line(`      ${f.cwe}${f.owaspWebCategory ? ` · ${f.owaspWebCategory}` : ''}`);
  if (f.reproductionSteps) line(`      repro: ${String(f.reproductionSteps).slice(0, 110)}`);
}

// What it says it did NOT establish, which is the half a scan usually leaves out.
//
// The scan detail response carries no `untestedAreas` field: the per-check reasons are
// stored on the scan and reach this endpoint only as prose appended to the gate's reason.
// Reading only the structured field printed nothing after a scan that had recorded 204
// reasons — including that 120 checks were refused outright — so a run that established
// almost nothing read as a clean one. Fall back to the gate rather than print silence.
const untested = (scan?.untestedAreas ?? []);
const gateReason = scan?.gate?.reason ?? scan?.gate?.summary ?? '';

if (untested.length || /untested/i.test(gateReason)) {
  section('5. What the scan says it did not establish');
  if (untested.length) {
    for (const area of untested) line(`  ${String(area).slice(0, 110)}`);
  } else {
    line('  (no untestedAreas field on the scan; read from the gate\'s reason)');
    for (const part of gateReason.split(/(?<=\.)\s+/)) {
      if (part.trim()) line(`  ${part.trim().slice(0, 160)}`);
    }
  }
} else if ((scan?.testsSkipped ?? 0) > 0) {
  // Never let "N skipped" stand with no account of what N was.
  section('5. What the scan says it did not establish');
  line(`  ${scan.testsSkipped} check(s) did not run and this run could not learn why:`);
  line('  the scan detail response carries no untestedAreas field and the gate said nothing.');
}

result.stages.scan = {
  ok: true, scanId, status: scan?.status ?? null,
  requestsIssued: scan?.requestsIssued ?? null,
  testsExecuted: scan?.testsExecuted ?? null, testsSkipped: scan?.testsSkipped ?? null,
  checksConfigured: started.json?.checksConfigured ?? null,
  untestedAreas: scan?.untestedAreas ?? [],
  gate: scan?.gate ?? null,
  findings: list.map(f => ({
    category: f.category, title: f.title, severity: f.severity, confidence: f.confidence,
    endpoint: f.endpoint, httpMethod: f.httpMethod, parameter: f.parameter,
    observedAsRole: f.observedAsRole, cwe: f.cwe, owasp: f.owaspWebCategory,
    reproductionSteps: f.reproductionSteps
  }))
};

await writeFile(new URL('./security-result.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n');
line(`\nWritten to test-lab/freight-platform/security-result.json\n`);
