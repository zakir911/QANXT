/**
 * Test data: the values a test uses, and whether they can be relied on.
 *
 * The entities and the generator have been here since the first migration and the run
 * dispatcher reads them; what was missing was any way to put data in. Same state schedules
 * and integrations were in.
 *
 * Two properties carry the weight. A seeded field must produce the same value on every run,
 * because that is the only reason a seed exists — without it a failure cannot be reproduced
 * and AIRA's own retry silently exercises different data from the attempt that failed. And
 * a credential must never be a literal, because a data set is readable by anyone who can
 * read the project and the CLI exports it in plain text.
 *
 * Both are checked through the platform against real runs, not against the generator in
 * isolation — the unit tests already cover the generator, and what these add is that the
 * value actually reaches the application.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { golden, suite, ROOT } from '../harness.mjs';
import {
  API, LAB, createEnvironment, createProject, lab, newTenant, registerApplication, request,
  requireApiTest
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

function cli(args, { token, projectId } = {}) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/cli/dist/aira.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    env: {
      ...process.env, AIRA_API_URL: API, AIRA_TOKEN: token ?? '',
      AIRA_PROJECT_ID: projectId ?? '', AIRA_ENVIRONMENT_ID: '', NO_COLOR: '1'
    }
  });
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const createSet = (tenant, body) =>
  request('/api/v1/test-data', { token: tenant.token, method: 'POST', body });

const previewSet = (tenant, id) =>
  request(`/api/v1/test-data/${id}/preview`, { token: tenant.token });

export default async function run() {
  suite('Test data');
  await lab.reset(BANK);

  const tenant = await newTenant('TestData');
  const project = await createProject(tenant, 'Golden test data');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank data', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });

  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // ---- DAT-001: a data set can be created and read back ------------------
  await golden({
    id: 'DAT-001',
    objective: 'A data set can be created with each kind of field and read back',
    preconditions: ['none'],
    input: 'A data set with a static, a generated, a seeded and a secret-reference field',
    expected: 'All four stored, and the secret reference returned as a name rather than a value',
    evidence: ['set.json'],
    severity: 'critical',
    run: async () => {
      const created = await createSet(tenant, {
        projectId: project.id,
        name: 'Every kind (DAT-001)',
        description: 'One of each',
        fields: [
          { key: 'orderReference', kind: 'static', value: 'AIRA-TEST-001' },
          { key: 'customerEmail', kind: 'generated', generatorJson: '{"type":"email"}' },
          { key: 'bookingDate', kind: 'seededRandom', generatorJson: '{"type":"date"}', seed: 42 },
          { key: 'password', kind: 'secretReference', value: '${secret:app_password}' }
        ]
      });

      if (!created.ok) {
        return { pass: false, detail: `refused: ${created.status} ${created.text.slice(0, 250)}` };
      }

      const fields = created.json.fields ?? [];
      const secret = fields.find(field => field.key === 'password');

      return {
        pass: fields.length === 4
          && secret?.kind === 'secretReference'
          && secret.value === '${secret:app_password}'
          && secret.isSensitive === true
          && fields.find(f => f.key === 'bookingDate')?.seed === 42,
        detail: `${fields.length} field(s): ${fields.map(f => `${f.key}=${f.kind}`).join(', ')}`,
        evidence: { 'set.json': created.json }
      };
    }
  }, context);

  // ---- DAT-002: a seeded field is the same every time --------------------
  await golden({
    id: 'DAT-002',
    objective: 'A seeded field resolves to the same value every time, through the platform',
    preconditions: ['a data set with seeded fields of every generator type'],
    input: 'The same data set previewed twice',
    expected: 'Identical values both times, for every type — a seed exists so that a '
      + 'failure can be reproduced, and a value that moves makes that impossible',
    evidence: ['first.json', 'second.json'],
    severity: 'critical',
    run: async () => {
      const { json: types } = await request('/api/v1/test-data/generator-types', { token: tenant.token });

      // Every type the platform says it supports, so one added later cannot quietly opt
      // out of the contract the way uuid did (BUG-0032).
      const created = await createSet(tenant, {
        projectId: project.id,
        name: 'Seeded, every type (DAT-002)',
        fields: (types ?? []).map((type, index) => ({
          key: `field_${type}`,
          kind: 'seededRandom',
          generatorJson: JSON.stringify({ type }),
          seed: 1000 + index
        }))
      });

      if (!created.ok) {
        return { pass: false, detail: `refused: ${created.status} ${created.text.slice(0, 250)}` };
      }

      const { json: first } = await previewSet(tenant, created.json.id);
      const { json: second } = await previewSet(tenant, created.json.id);

      const drifted = (first ?? []).filter((field, index) => field.value !== second?.[index]?.value);

      return {
        pass: (types?.length ?? 0) > 0
          && first?.length === types.length
          && drifted.length === 0,
        detail: drifted.length === 0
          ? `${types?.length ?? 0} generator type(s), every one reproducible`
          : `NOT REPRODUCIBLE: ${drifted.map(f => f.key).join(', ')}`,
        metrics: { types: types?.length ?? 0, drifted: drifted.length },
        evidence: { 'first.json': first, 'second.json': second }
      };
    }
  }, context);

  // ---- DAT-003: a literal credential is refused --------------------------
  await golden({
    id: 'DAT-003',
    objective: 'A field whose name is a credential is refused unless it references a secret',
    preconditions: ['none'],
    input: 'Data sets with password, apiKey, clientSecret and pin as literal values',
    expected: 'Each refused with the remedy named — a data set is readable by anyone who '
      + 'can read the project and is exported in plain text by the CLI',
    evidence: ['refusals.json'],
    severity: 'critical',
    run: async () => {
      const cases = [
        { key: 'password', kind: 'static', value: 'hunter2' },
        { key: 'apiKey', kind: 'static', value: 'sk-live-abc123' },
        { key: 'clientSecret', kind: 'static', value: 'shhh' },
        { key: 'userPin', kind: 'static', value: '1234' },
        // Must be accepted: refusing these teaches people to route around the guard.
        { key: 'shippingAddress', kind: 'static', value: '1 Test Street', shouldSucceed: true },
        { key: 'authorName', kind: 'static', value: 'A. Person', shouldSucceed: true },
        { key: 'password', kind: 'secretReference', value: '${secret:app_password}', shouldSucceed: true }
      ];

      const results = [];
      for (const testCase of cases) {
        const response = await createSet(tenant, {
          projectId: project.id,
          name: `DAT-003 ${testCase.key} ${testCase.kind}`,
          fields: [{ key: testCase.key, kind: testCase.kind, value: testCase.value }]
        });

        results.push({
          key: testCase.key,
          kind: testCase.kind,
          shouldSucceed: testCase.shouldSucceed === true,
          status: response.status,
          message: response.json?.title ?? response.text?.slice(0, 200)
        });

        if (response.ok && response.json?.id) {
          await request(`/api/v1/test-data/${response.json.id}`, { token: tenant.token, method: 'DELETE' });
        }
      }

      const refusedCorrectly = results
        .filter(result => !result.shouldSucceed)
        .every(result => result.status === 400 && /secretReference/.test(result.message ?? ''));
      const acceptedCorrectly = results
        .filter(result => result.shouldSucceed)
        .every(result => result.status === 201);

      return {
        pass: refusedCorrectly && acceptedCorrectly,
        detail: `${results.filter(r => !r.shouldSucceed && r.status === 400).length}/`
          + `${results.filter(r => !r.shouldSucceed).length} credentials refused; `
          + `${results.filter(r => r.shouldSucceed && r.status === 201).length}/`
          + `${results.filter(r => r.shouldSucceed).length} ordinary fields accepted`,
        evidence: { 'refusals.json': results }
      };
    }
  }, context);

  // ---- DAT-004: a secret reference must not contain a secret -------------
  await golden({
    id: 'DAT-004',
    objective: 'A field declared as a secret reference must name a secret, not hold one',
    preconditions: ['none'],
    input: 'A secretReference field whose value is a literal password',
    expected: 'Refused. Declaring a kind must not be a way to smuggle a literal past the guard',
    evidence: ['refusal.json'],
    severity: 'critical',
    run: async () => {
      const response = await createSet(tenant, {
        projectId: project.id,
        name: 'DAT-004 smuggled literal',
        fields: [{ key: 'password', kind: 'secretReference', value: 'hunter2' }]
      });

      if (response.ok && response.json?.id) {
        await request(`/api/v1/test-data/${response.json.id}`, { token: tenant.token, method: 'DELETE' });
      }

      return {
        pass: response.status === 400 && /must name a secret/.test(response.json?.title ?? ''),
        detail: `${response.status}: ${response.json?.title ?? response.text?.slice(0, 200)}`,
        evidence: { 'refusal.json': { status: response.status, body: response.json } }
      };
    }
  }, context);

  // ---- DAT-005: a preview never prints a secret --------------------------
  await golden({
    id: 'DAT-005',
    objective: 'Neither a read nor a preview ever returns a sensitive value',
    preconditions: ['a data set with a secret reference and a field marked sensitive'],
    input: 'GET the data set, and GET its preview',
    expected: 'The reference is shown by name; the sensitive value is masked. A preview '
      + 'that prints a password is a password in somebody\'s shell history',
    evidence: ['read.json', 'preview.json'],
    severity: 'critical',
    run: async () => {
      const marker = 'THIS-VALUE-MUST-NOT-APPEAR-ANYWHERE';
      const created = await createSet(tenant, {
        projectId: project.id,
        name: 'DAT-005 sensitive',
        fields: [
          { key: 'password', kind: 'secretReference', value: '${secret:app_password}' },
          // Not a credential by name, but marked sensitive by whoever wrote it. The mark
          // has to be honoured or it is decoration.
          { key: 'customerNote', kind: 'static', value: marker, isSensitive: true }
        ]
      });

      if (!created.ok) {
        return { pass: false, detail: `refused: ${created.status} ${created.text.slice(0, 250)}` };
      }

      const { json: read, text: readText } = await request(
        `/api/v1/test-data/${created.json.id}`, { token: tenant.token });
      const { json: preview, text: previewText } = await previewSet(tenant, created.json.id);

      return {
        pass: !readText.includes(marker)
          && !previewText.includes(marker)
          && preview?.find(field => field.key === 'password')?.value === '${secret:app_password}',
        detail: readText.includes(marker) || previewText.includes(marker)
          ? 'THE SENSITIVE VALUE WAS RETURNED'
          : 'neither the read nor the preview returned the sensitive value',
        evidence: { 'read.json': read, 'preview.json': preview }
      };
    }
  }, context);

  // ---- DAT-006: a data set in use cannot be deleted ----------------------
  await golden({
    id: 'DAT-006',
    objective: 'Deleting a data set a test case uses is refused rather than cascaded',
    preconditions: ['a test case pointed at a data set'],
    input: 'DELETE the data set',
    expected: 'Refused with a count. Cascading would leave the tests running with no data, '
      + 'which reads as an application defect',
    evidence: ['refusal.json'],
    severity: 'high',
    run: async () => {
      const created = await createSet(tenant, {
        projectId: project.id,
        name: 'DAT-006 in use',
        fields: [{ key: 'orderReference', kind: 'static', value: 'AIRA-TEST-006' }]
      });

      // An API test, because that is a real test case this platform can create directly.
      const testCase = await requireApiTest(tenant, {
        projectId: project.id, applicationId: application.id,
        name: 'Uses the data set (DAT-006)',
        steps: [{
          description: 'Health check',
          request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      // The attach path itself, which had no caller before BUG-0033.
      const attached = await request(`/api/v1/testcases/${testCase.testCaseId}`, {
        token: tenant.token, method: 'PATCH', body: { testDataSetId: created.json.id }
      });

      const refused = await request(`/api/v1/test-data/${created.json.id}`,
        { token: tenant.token, method: 'DELETE' });

      // Detached with the same endpoint, which must then let the delete through. Both
      // halves matter: a guard that never releases is as wrong as one that never holds.
      const detached = await request(`/api/v1/testcases/${testCase.testCaseId}`, {
        token: tenant.token, method: 'PATCH',
        body: { testDataSetId: '00000000-0000-0000-0000-000000000000' }
      });

      const afterwards = await request(`/api/v1/test-data/${created.json.id}`,
        { token: tenant.token, method: 'DELETE' });

      return {
        pass: attached.ok
          && refused.status === 409
          && /test case/i.test(refused.json?.title ?? '')
          && detached.ok
          && (afterwards.status === 204 || afterwards.ok),
        detail: `attach ${attached.status}; in use: ${refused.status} `
          + `"${refused.json?.title ?? ''}"; detach ${detached.status}; once freed: ${afterwards.status}`,
        evidence: {
          'refusal.json': {
            attach: attached.status, inUse: refused.json,
            detach: detached.status, afterwards: afterwards.status
          }
        }
      };
    }
  }, context);

  // ---- DAT-007: the CLI round-trips a data set ---------------------------
  await golden({
    id: 'DAT-007',
    objective: 'A data set exports to a file, imports back, and the export carries no secret',
    preconditions: ['the CLI is built'],
    input: 'aira test-data import / export / preview',
    expected: 'The round trip preserves every field, and the exported file contains the '
      + 'secret reference by name and no secret value',
    evidence: ['exported.json', 'cli.txt'],
    severity: 'high',
    run: async () => {
      const options = { token: tenant.token, projectId: project.id };
      const directory = mkdtempSync(join(tmpdir(), 'aira-data-'));
      const source = join(directory, 'data.json');
      const exported = join(directory, 'exported.json');
      const transcript = [];

      writeFileSync(source, JSON.stringify({
        name: 'Round trip (DAT-007)',
        description: 'Written by a person, read by the CLI',
        fields: [
          { key: 'customerEmail', kind: 'seededRandom', generatorJson: '{"type":"email"}', seed: 99 },
          { key: 'orderReference', kind: 'static', value: 'AIRA-TEST-007' },
          { key: 'password', kind: 'secretReference', value: '${secret:app_password}' }
        ]
      }, null, 2));

      const record = (label, result) => {
        transcript.push(`$ aira test-data ${label}\n[exit ${result.code}]\n${result.output}`);
        return result;
      };

      const imported = record('import', cli(['test-data', 'import', '--file', source, '--json'], options));
      let id = null;
      try { id = JSON.parse(imported.output).id; } catch { /* reported below */ }
      if (!id) {
        return {
          pass: false, detail: `import did not return a data set: ${imported.output.slice(0, 250)}`,
          evidence: { 'cli.txt': transcript.join('\n\n'), 'exported.json': {} }
        };
      }

      const previewed = record('preview', cli(['test-data', 'preview', id], options));
      record('export', cli(['test-data', 'export', id, '--out', exported], options));

      const document = JSON.parse(readFileSync(exported, 'utf8'));
      const reimported = record('import (round trip)',
        cli(['test-data', 'import', '--file', exported, '--name', 'Round trip again', '--json'], options));

      // Cleaned up.
      cli(['test-data', 'remove', id], options);
      try { cli(['test-data', 'remove', JSON.parse(reimported.output).id], options); } catch { /* best effort */ }

      const secretField = document.fields?.find(field => field.key === 'password');

      return {
        pass: imported.code === 0
          && previewed.code === 0
          && previewed.output.includes('AIRA-TEST-007')
          && reimported.code === 0
          && document.fields?.length === 3
          && secretField?.value === '${secret:app_password}'
          // The export is about to be committed somewhere. It must carry no identifiers
          // from the project it came from and no secret values.
          && document.id === undefined
          && document.projectId === undefined,
        detail: `import ${imported.code}, preview ${previewed.code}, re-import ${reimported.code}; `
          + `exported ${document.fields?.length ?? 0} field(s), secret carried as `
          + `"${secretField?.value}"`,
        evidence: { 'exported.json': document, 'cli.txt': transcript.join('\n\n') }
      };
    }
  }, context);

  // ---- DAT-008: a bad field list says everything wrong with it ----------
  await golden({
    id: 'DAT-008',
    objective: 'A data set with several problems reports all of them at once',
    preconditions: ['none'],
    input: 'A data set with a duplicate key, an unknown generator type, a seeded field '
      + 'with no seed and a static field with no value',
    expected: 'One response naming every problem — somebody pasting twenty fields should '
      + 'not submit twenty times to find twenty typos',
    evidence: ['problems.json'],
    severity: 'medium',
    run: async () => {
      const response = await createSet(tenant, {
        projectId: project.id,
        name: 'DAT-008 everything wrong',
        fields: [
          { key: 'orderReference', kind: 'static', value: 'a' },
          { key: 'orderReference', kind: 'static', value: 'b' },
          { key: 'thing', kind: 'seededRandom', generatorJson: '{"type":"notAType"}', seed: 1 },
          { key: 'other', kind: 'seededRandom', generatorJson: '{"type":"email"}' },
          { key: 'empty', kind: 'static', value: '' }
        ]
      });

      const problems = response.json?.errors?.fields ?? [];

      return {
        pass: response.status === 400
          && problems.length >= 4
          && problems.some(problem => /more than once/.test(problem))
          && problems.some(problem => /does not exist/.test(problem))
          && problems.some(problem => /no seed/.test(problem))
          && problems.some(problem => /no value/.test(problem)),
        detail: `${problems.length} problem(s) reported at once`,
        evidence: { 'problems.json': problems }
      };
    }
  }, context);
}
