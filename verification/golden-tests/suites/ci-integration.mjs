/**
 * The CI surface: the artifact layout, the pull request summary, and the pipeline files.
 *
 * What a pipeline depends on is narrow and specific — fixed artifact names, a summary that
 * leads with the verdict, and exit codes that separate "your application is broken" from
 * "the tooling could not run". All of that is executed here against real runs.
 *
 * What is *not* executed here is the pipeline files themselves inside GitHub Actions, Azure
 * DevOps, GitLab CI or Jenkins: each needs credentials for that system and a deployment of
 * AIRA it can reach, and neither exists in this environment. CI-005 checks what can be
 * checked about them without one — that every flag they pass is a flag the CLI accepts, and
 * that each handles every exit code the CLI documents — and says plainly that it is not a
 * substitute for running them.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { golden, suite, ROOT } from '../harness.mjs';
import {
  API, LAB, createEnvironment, createGateRule, createProject, lab, newTenant,
  registerApplication, requireApiTest, request
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };
const EXAMPLES = resolve(ROOT, 'infrastructure/ci/examples');

/** Every exit code the CLI documents. A pipeline that handles only some is handling none. */
const EXIT_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function cli(args, { token, projectId } = {}) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'packages/cli/dist/aira.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000,
    env: {
      ...process.env, AIRA_API_URL: API, AIRA_TOKEN: token ?? '',
      AIRA_PROJECT_ID: projectId ?? '', NO_COLOR: '1'
    }
  });
  return {
    code: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

export default async function run() {
  suite('CI integration');
  await lab.reset(BANK);

  const tenant = await newTenant('CiIntegration');
  const project = await createProject(tenant, 'Golden CI integration');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank CI', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  const health = await requireApiTest(tenant, {
    projectId: project.id, applicationId: application.id,
    suiteName: 'CI — passing', name: 'The application is up', tags: 'smoke',
    steps: [{
      description: 'Health check',
      request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  const failing = await requireApiTest(tenant, {
    projectId: project.id, applicationId: application.id,
    suiteName: 'CI — failing', name: 'The accounts endpoint answers anonymously',
    steps: [{
      description: 'Read the accounts with no credentials',
      request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }]
  });

  /** Runs one test through the CLI into a fresh artifact directory. */
  function runInto(testCaseIds, extraArgs = []) {
    const directory = mkdtempSync(join(tmpdir(), 'aira-ci-'));
    const args = ['run', '--report-dir', directory, '--timeout', '240'];
    for (const id of testCaseIds) args.push('--test', id);
    const result = cli([...args, ...extraArgs], { token: tenant.token, projectId: project.id });
    return { ...result, directory, files: existsSync(directory) ? readdirSync(directory).sort() : [] };
  }

  const read = (directory, name) => readFileSync(join(directory, name), 'utf8');

  // ---- CI-001: the artifact layout ---------------------------------------
  await golden({
    id: 'CI-001',
    objective: 'A run writes exactly the four documented artifacts, under fixed names',
    preconditions: ['the CLI is built', 'the lab bank is running'],
    input: 'aira run --report-dir <dir>',
    expected: 'junit.xml, report.json, report.html and summary.md, each non-empty and each '
      + 'valid in its own format — so a pipeline can publish the directory without knowing '
      + 'what is in it',
    evidence: ['files.json', 'junit.xml', 'summary.md'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const result = runInto([health.testCaseId]);

      const expected = ['junit.xml', 'report.html', 'report.json', 'summary.md'];
      const junit = result.files.includes('junit.xml') ? read(result.directory, 'junit.xml') : '';
      const json = result.files.includes('report.json') ? read(result.directory, 'report.json') : '{}';
      const html = result.files.includes('report.html') ? read(result.directory, 'report.html') : '';
      const summary = result.files.includes('summary.md') ? read(result.directory, 'summary.md') : '';

      let parsedJson = null;
      try { parsedJson = JSON.parse(json); } catch { /* reported below */ }

      return {
        pass: result.code === 0
          && JSON.stringify(result.files) === JSON.stringify(expected)
          && junit.includes('<testsuites')
          && parsedJson?.run?.id !== undefined
          && html.includes('<!doctype html')
          && summary.startsWith('### '),
        detail: `exit ${result.code}; files ${result.files.join(', ')}; `
          + `junit ${junit.length}B, json ${json.length}B, html ${html.length}B, summary ${summary.length}B`,
        metrics: { files: result.files.length },
        evidence: {
          'files.json': result.files,
          'junit.xml': junit,
          'summary.md': summary
        }
      };
    }
  }, context);

  // ---- CI-002: the summary leads with the verdict ------------------------
  await golden({
    id: 'CI-002',
    objective: 'The pull request summary names the failure, its message and its diagnosis',
    preconditions: ['a test that fails against the lab bank'],
    input: 'A run of a test whose assertion does not hold',
    expected: 'A summary opening with the verdict, naming the failing test, quoting the '
      + "engine's message, and carrying the diagnosis beside it",
    evidence: ['summary.md'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const result = runInto([failing.testCaseId]);
      const summary = result.files.includes('summary.md') ? read(result.directory, 'summary.md') : '';

      return {
        // Written to be read on a phone by someone who did not start the build: the
        // verdict first, the failure next, everything else collapsed.
        pass: result.code === 1
          && summary.startsWith('### ❌ 1 test(s) failed')
          && summary.includes('#### What failed')
          && summary.includes(failing.reference)
          && summary.includes('401')
          && /Authentication issue \(\d+%\)/.test(summary)
          && summary.includes('#### Quality gate'),
        detail: `exit ${result.code}; summary ${summary.length}B; `
          + `headline "${summary.split('\n')[0]}"`,
        evidence: { 'summary.md': summary }
      };
    }
  }, context);

  // ---- CI-003: a passing run says so, and says nothing about failures ----
  await golden({
    id: 'CI-003',
    objective: 'A passing run produces a summary with no failure section at all',
    preconditions: ['a test that passes'],
    input: 'A run of the health check',
    expected: 'A pass headline, no "What failed" section, and the passing tests collapsed',
    evidence: ['summary.md'],
    severity: 'high',
    run: async () => {
      await lab.reset(BANK);
      const result = runInto([health.testCaseId]);
      const summary = read(result.directory, 'summary.md');

      return {
        pass: result.code === 0
          && summary.startsWith('### ✅ All tests passed')
          && !summary.includes('#### What failed')
          && summary.includes('<details><summary>1 passing test(s)</summary>'),
        detail: `exit ${result.code}; headline "${summary.split('\n')[0]}"`,
        evidence: { 'summary.md': summary }
      };
    }
  }, context);

  // ---- CI-004: REVIEW is its own answer, all the way to the pipeline -----
  await golden({
    id: 'CI-004',
    objective: 'A run the gate sends for review exits 7 and says so in the summary',
    preconditions: ['a gate rule whose action is review'],
    input: 'A passing run with a review rule that does not hold',
    expected: 'Exit 7 (HUMAN_REVIEW_REQUIRED), and a summary saying a person must look — '
      + 'not a pass, and not a failure',
    evidence: ['summary.md'],
    severity: 'critical',
    run: async () => {
      // A rule a passing run does not satisfy, whose action is review rather than fail.
      // The point is that REVIEW survives all the way to the pipeline's exit code instead
      // of being folded into one of the other two.
      //
      // It used to be "passRatePercent greaterThan 100", which is unsatisfiable by
      // construction — and is now refused, because a gate rule nothing can satisfy is a
      // permanent block rather than a check (BUG-0039). "greaterThanOrEqual 101" is refused
      // for the same reason. So the rule here is one a run genuinely could satisfy and this
      // one does not: a duration budget of zero milliseconds, which any real execution
      // exceeds. A rule that can pass and doesn't is a better fixture than one that never
      // could.
      const reviewProject = await createProject(tenant, 'CI review');
      const reviewApp = await registerApplication(tenant, reviewProject.id, {
        name: 'Lab Bank CI review', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
      });
      await createEnvironment(tenant, reviewProject.id, {
        name: 'QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
      });
      await createGateRule(tenant, reviewProject.id, {
        name: 'Someone checks the numbers on every release',
        metric: 'averageDurationMs', operator: 'lessThanOrEqual', threshold: 0,
        action: 'review',
        message: 'A person signs off every release in this project.'
      });

      const reviewTest = await requireApiTest(tenant, {
        projectId: reviewProject.id, applicationId: reviewApp.id,
        name: 'The application is up', tags: 'smoke',
        steps: [{
          description: 'Health check',
          request: { method: 'GET', path: '/health', auth: { mode: 'none' } },
          assertions: [{ type: 'httpStatusEquals', expected: '200' }]
        }]
      });

      await lab.reset(BANK);
      const directory = mkdtempSync(join(tmpdir(), 'aira-ci-review-'));
      const result = cli(
        ['run', '--test', reviewTest.testCaseId, '--report-dir', directory, '--timeout', '240'],
        { token: tenant.token, projectId: reviewProject.id });
      const summary = readFileSync(join(directory, 'summary.md'), 'utf8');

      return {
        pass: result.code === 7
          && summary.startsWith('### ⚠️ This run needs a person to look at it')
          && summary.includes('A person signs off every release'),
        detail: `exit ${result.code} (expected 7); headline "${summary.split('\n')[0]}"`,
        metrics: { exitCode: result.code },
        evidence: { 'summary.md': summary }
      };
    }
  }, context);

  // ---- CI-005: the pipeline files are consistent with the CLI ------------
  await golden({
    id: 'CI-005',
    objective: 'Every example pipeline passes only flags the CLI accepts and handles every '
      + 'exit code the CLI documents',
    preconditions: ['the example pipelines exist'],
    input: 'The five files in infrastructure/ci/examples',
    expected: 'No unknown flags, every exit code handled in each, and each file carrying '
      + 'the note that it has not been run in its CI system',
    evidence: ['checked.json'],
    severity: 'high',
    run: async () => {
      // This is a static check and says so. It cannot tell you the pipeline works inside
      // GitHub Actions; it can tell you the pipeline does not pass a flag that was removed
      // three commits ago, which is the way these files actually rot.
      const files = ['github-actions.yml', 'azure-pipelines.yml', 'gitlab-ci.yml', 'Jenkinsfile', 'generic.sh'];
      const help = cli(['regression', '--help']).output + cli(['run', '--help']).output;

      const findings = [];

      for (const file of files) {
        const path = join(EXAMPLES, file);
        if (!existsSync(path)) { findings.push({ file, problem: 'missing' }); continue; }
        const text = readFileSync(path, 'utf8');

        // Only the flags passed to `aira`. A file also runs git and curl, and their flags
        // are not AIRA's to recognise — scanning the whole file would report `--abbrev-ref`
        // as an unknown AIRA option, which is the kind of false finding that gets a check
        // switched off.
        const flags = new Set();
        for (const invocation of text.matchAll(/\baira\b[\s\S]*?(?=\n\s*\n|\n\s*[a-zA-Z#-]|$)/g)) {
          for (const match of invocation[0].matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)/gm)) {
            flags.add(match[1]);
          }
        }

        const unknown = [...flags].filter(flag => !help.includes(flag));

        const unhandled = EXIT_CODES.filter(code =>
          !new RegExp(`(^|[^0-9])${code}[)\\s:]`, 'm').test(text));

        const saysNotVerified = /NOT VERIFIED|not claimed to have been executed/i.test(text)
          || file === 'generic.sh';

        findings.push({ file, unknownFlags: unknown, unhandledExitCodes: unhandled, saysNotVerified });
      }

      const clean = findings.every(finding =>
        finding.problem === undefined
        && finding.unknownFlags.length === 0
        && finding.unhandledExitCodes.length === 0
        && finding.saysNotVerified);

      return {
        pass: clean,
        detail: clean
          ? `${findings.length} pipeline file(s): no unknown flags, every exit code handled, `
            + 'each marked as not executed in its CI system'
          : findings.filter(f => f.problem || f.unknownFlags?.length || f.unhandledExitCodes?.length || !f.saysNotVerified)
              .map(f => `${f.file}: ${f.problem ?? ''} flags ${JSON.stringify(f.unknownFlags)} codes ${JSON.stringify(f.unhandledExitCodes)} marked=${f.saysNotVerified}`)
              .join('; '),
        evidence: { 'checked.json': findings }
      };
    }
  }, context);

  // ---- CI-006: the JUnit matches the run ---------------------------------
  await golden({
    id: 'CI-006',
    objective: 'The JUnit XML reports the same counts as the run it came from',
    preconditions: ['a run with one pass and one failure'],
    input: 'A run of both tests',
    expected: 'A testsuites element whose tests and failures counts match the run, so the '
      + "CI system's own test view agrees with AIRA's",
    evidence: ['junit.xml', 'run.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const result = runInto([health.testCaseId, failing.testCaseId]);
      const junit = read(result.directory, 'junit.xml');
      const report = JSON.parse(read(result.directory, 'report.json'));

      const tests = Number(/tests="(\d+)"/.exec(junit)?.[1] ?? -1);
      const failures = Number(/failures="(\d+)"/.exec(junit)?.[1] ?? -1);

      return {
        pass: result.code === 1
          && tests === report.tests.length
          && failures === report.totals.failed
          && junit.includes(failing.reference)
          && junit.includes(health.reference),
        detail: `junit tests=${tests} failures=${failures}; `
          + `run ${report.tests.length} test(s), ${report.totals.failed} failed`,
        evidence: { 'junit.xml': junit, 'run.json': report.run }
      };
    }
  }, context);

  // ---- CI-007: the CI context reaches the run ----------------------------
  await golden({
    id: 'CI-007',
    objective: 'The build, commit and branch a pipeline passes are recorded on the run',
    preconditions: ['none'],
    input: 'A run started with --ci-provider, --ci-build, --ci-commit and --ci-branch',
    expected: 'The run records all four, so a failure months later can be traced to the '
      + 'commit that produced it',
    evidence: ['run.json'],
    severity: 'high',
    run: async () => {
      await lab.reset(BANK);
      const result = runInto([health.testCaseId], [
        '--ci-provider', 'github',
        '--ci-build', '99123',
        '--ci-commit', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        '--ci-branch', 'feature/accounts-filter'
      ]);

      const report = JSON.parse(read(result.directory, 'report.json'));
      const stored = await request(`/api/v1/testruns/${report.run.id}`, { token: tenant.token });
      const run = stored.json;

      return {
        pass: result.code === 0
          && run?.ciProvider === 'github'
          && run.ciBuildId === '99123'
          && run.ciCommitSha === 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
          && run.ciBranch === 'feature/accounts-filter',
        detail: `provider ${run?.ciProvider}, build ${run?.ciBuildId}, `
          + `commit ${String(run?.ciCommitSha).slice(0, 8)}, branch ${run?.ciBranch}`,
        evidence: { 'run.json': run }
      };
    }
  }, context);

  // ---- CI-008: a gate rule nothing could satisfy is refused ---------------
  await golden({
    id: 'CI-008',
    objective: 'A quality gate rule that no run could ever satisfy is refused, rather than blocking every build',
    preconditions: ['a project exists'],
    input: 'A rule of "failedCount less than 0", and the same rule with the operator omitted',
    expected: 'Both are refused with a message naming the rule that was probably meant; '
      + '"failedCount at most 0" is accepted',
    evidence: ['rules.json'],
    severity: 'high',
    run: async () => {
      const create = body => request(`/api/v1/quality-gates?projectId=${project.id}`, {
        token: tenant.token, method: 'POST', body
      });

      // Explicit, and the shape that arrives by accident: Operator is a non-nullable enum,
      // so an omitted or misspelled field becomes LessThan (0). That is how "no failing
      // tests" became "fewer than zero failing tests" and blocked a green build (BUG-0039).
      const explicit = await create({
        name: 'Unsatisfiable', metric: 'failedCount', operator: 'lessThan', threshold: 0
      });
      const omitted = await create({
        name: 'Operator omitted', metric: 'failedCount', threshold: 0
      });
      const correct = await create({
        name: 'No failing tests', metric: 'failedCount', operator: 'lessThanOrEqual', threshold: 0
      });

      const message = (response) => (response.json?.errors?.operator ?? [''])[0] ?? '';
      // The message has to help. "Invalid operator" sends somebody to the enum docs; naming
      // the rule they meant sends them to the fix.
      const suggests = message(explicit).includes('lessThanOrEqual')
        && message(omitted).includes('lessThanOrEqual');

      return {
        pass: explicit.status === 400 && omitted.status === 400
          && correct.ok && correct.json?.operator === 'lessThanOrEqual' && suggests,
        detail: `explicit lessThan 0: ${explicit.status}; operator omitted: ${omitted.status}; `
          + `lessThanOrEqual 0: ${correct.status} stored as ${correct.json?.operator}; `
          + `the refusal names the likely intention: ${suggests}`,
        metrics: { explicit: explicit.status, omitted: omitted.status, correct: correct.status },
        evidence: {
          'rules.json': JSON.stringify({
            explicitLessThanZero: { status: explicit.status, message: message(explicit) },
            operatorOmitted: { status: omitted.status, message: message(omitted) },
            lessThanOrEqualZero: { status: correct.status, storedOperator: correct.json?.operator }
          }, null, 2)
        }
      };
    }
  }, context);
}
