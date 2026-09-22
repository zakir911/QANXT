import { readFile } from 'node:fs/promises';
import type { RunTrigger } from '@aira/shared-types';
import { ApiClient } from '../api.js';
import { boolFlag, flag, flagAll, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';
import { gatherReport, writeReports } from '../report-gather.js';
import type { RunSummary } from '../types.js';
import {
  ciContext, printSummary, reportTargets, verdictExitCode, waitForRun
} from './run.js';

export const API_TEST_FLAGS = [
  'project', 'file', 'suite', 'name', 'timeout', 'poll', 'parallelism', 'retries',
  'junit', 'json', 'html', 'report-dir', 'ci-provider', 'ci-build', 'ci-commit',
  'ci-branch', 'app-build', 'dry-run',
  'app', 'endpoint', 'max', 'include-mutating', 'no-negative'
] as const;

export const API_TEST_HELP = `
${bold('aira api-test')} — author and run API tests

  ${bold('aira api-test add --file <path>')}
      Creates API tests from a definition file (JSON). One or more tests, each a
      sequence of HTTP requests with assertions over their responses.

  ${bold('aira api-test generate --app <id>')}
      Writes API tests from the endpoints discovery observed: that each still
      answers as it did, that each that required credentials still refuses
      without them, and that a templated endpoint answers 404 for an identifier
      nothing owns. Deterministic — no model is involved, and everything a
      generated test asserts is something AIRA watched the application do.

  ${bold('aira api-test run')}
      Runs every enabled API test in the project and waits for the verdict.

  --project <id>         Project to work in (or AIRA_PROJECT_ID)
  --file <path>          The definition file, for "add"
  --dry-run              Validate the file against the platform without saving
  --app <id>             Application to generate for
  --endpoint <id>        Generate for one endpoint; repeat for several
  --max <n>              Generate at most n tests
  --no-negative          Positive tests only
  --include-mutating     Also generate tests for POST/PUT/PATCH/DELETE endpoints.
                         Off by default: such a test changes the application's data
  --suite <id>           For "run", restrict to one suite
  --name <text>          Name the run
  --timeout <seconds>    Give up waiting (default 1800)
  --poll <seconds>       How often to check progress (default 3)
  --parallelism <n>      Executions in flight at once
  --retries <n>          Retries for a failing execution

  --junit <path>         Write JUnit XML
  --json <path>          Write the machine-readable report
  --html <path>          Write the human-readable report
  --report-dir <dir>     Write all three into a directory

The definition file:

  {
    "tests": [{
      "name": "Accounts list answers for a signed-in customer",
      "objective": "…", "priority": "high", "tags": "smoke,api",
      "steps": [{
        "description": "List the customer's accounts",
        "request": {
          "method": "GET", "path": "/api/accounts",
          "auth": { "mode": "bearer", "token": "\${secret:api_token}" },
          "capture": { "firstAccountId": "accounts[0].id" }
        },
        "assertions": [
          { "type": "httpStatusEquals", "expected": "200" },
          { "type": "responseJsonPathExists", "subject": "accounts[0].id" },
          { "type": "responseTimeUnderMs", "expected": "2000" }
        ]
      }]
    }]
  }

Credentials are written as \${secret:name} references, never as literals; the platform
refuses a test that inlines one. A captured value is available to later requests in the
same test as \${data:name}.

Exit status is the same contract as "aira run": 0 PASS, 1 TEST_FAILURE,
2 QUALITY_GATE_FAILURE, 7 HUMAN_REVIEW_REQUIRED.
`;

interface ApiTestDefinitionFile {
  suiteName?: string;
  applicationId?: string;
  tests: ApiTestDefinition[];
}

interface ApiTestDefinition {
  name: string;
  objective?: string;
  priority?: string;
  risk?: string;
  tags?: string;
  requirementReference?: string;
  testSuiteId?: string;
  suiteName?: string;
  applicationId?: string;
  steps: unknown[];
}

interface ApiTestCreated {
  testCaseId: string;
  reference: string;
  name: string;
  testSuiteId: string;
  testSuiteName: string;
  stepCount: number;
  assertionCount: number;
  notes: string[];
}

interface TestCaseRow {
  id: string;
  reference: string;
  name: string;
  kind: string;
  isEnabled: boolean;
  testSuiteId: string;
}

export async function apiTestCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, API_TEST_FLAGS);

  const sub = args.positionals[0] ?? 'run';
  if (sub !== 'add' && sub !== 'run' && sub !== 'list' && sub !== 'generate') {
    throw usage(`"aira api-test ${sub}" is not a subcommand.`,
      'Use "add", "generate", "run" or "list".');
  }

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  if (!context.projectId) {
    throw usage('A project is required.', 'Pass --project <id>, or set AIRA_PROJECT_ID.');
  }

  if (sub === 'add') return addTests(api, context.projectId, args);
  if (sub === 'generate') return generateTests(api, args);
  if (sub === 'list') return listTests(api, context.projectId, args);
  return runTests(api, context, args);
}

/**
 * Creates the tests a definition file describes.
 *
 * Each test is sent separately and reported separately. A file of twelve tests where the
 * fourth is malformed should save eleven and say precisely what is wrong with the fourth —
 * rejecting the file whole would mean an author fixes one problem per round trip, and
 * saving silently would mean they never learn of it.
 */
async function addTests(api: ApiClient, projectId: string, args: ParsedArgs): Promise<number> {
  const path = flag(args, 'file');
  if (!path) throw usage('A definition file is required.', 'Pass --file <path>.');

  const file = await parseDefinitionFile(path);
  const dryRun = boolFlag(args, 'dry-run');

  let created = 0;
  let rejected = 0;

  for (const test of file.tests) {
    const body = {
      projectId,
      applicationId: test.applicationId ?? file.applicationId,
      testSuiteId: test.testSuiteId,
      suiteName: test.suiteName ?? file.suiteName,
      name: test.name,
      objective: test.objective,
      priority: test.priority,
      risk: test.risk,
      tags: test.tags,
      requirementReference: test.requirementReference,
      steps: test.steps
    };

    if (dryRun) {
      // There is no validate-only endpoint, and inventing one that re-implemented the
      // checks would be worse than useless: it could pass what the real path rejects.
      // What a dry run can honestly do is name what it would send.
      note(`  ${dim('would create')} ${test.name} ${dim(`(${test.steps.length} request(s))`)}`);
      created++;
      continue;
    }

    try {
      const result = await api.post<ApiTestCreated>('/api/v1/testcases/api-tests', body);
      note(`  ${green('✓')} ${bold(result.reference)} ${result.name} `
        + dim(`${result.stepCount} request(s), ${result.assertionCount} assertion(s) → ${result.testSuiteName}`));
      for (const advisory of result.notes ?? []) note(`      ${yellow('note')} ${advisory}`);
      created++;
    } catch (error) {
      rejected++;
      note(`  ${red('✗')} ${test.name}`);
      for (const line of problemLines(error)) note(`      ${dim(line)}`);
    }
  }

  note('');
  note(`  ${created} ${dryRun ? 'would be created' : 'created'}${rejected > 0 ? `, ${rejected} rejected` : ''}.`);

  // A rejected definition is a configuration error: the file, not the application,
  // is what needs fixing.
  return rejected > 0 ? ExitCode.ConfigurationError : ExitCode.Success;
}

interface GeneratedApiTests {
  testSuiteId: string;
  testSuiteName: string;
  endpointsConsidered: number;
  endpointsSkipped: number;
  testsCreated: number;
  tests: ApiTestCreated[];
  notes: string[];
}

/**
 * Generates tests from what discovery observed.
 *
 * Mutating endpoints are excluded unless asked for, and the reason is printed rather than
 * left implicit: a generated POST against an application changes that application's data,
 * and someone running this for the first time should find that out from the output and not
 * from their staging database.
 */
async function generateTests(api: ApiClient, args: ParsedArgs): Promise<number> {
  const applicationId = flag(args, 'app');
  if (!applicationId) {
    throw usage('An application is required.', 'Pass --app <id>. "aira apps" lists them.');
  }

  const negative = !boolFlag(args, 'no-negative');
  const result = await api.post<GeneratedApiTests>('/api/v1/testcases/api-tests/generate', {
    applicationId,
    apiEndpointIds: flagAll(args, 'endpoint'),
    includePositive: true,
    includeUnauthenticated: negative,
    includeNotFound: negative,
    includeMutating: boolFlag(args, 'include-mutating'),
    maxTests: intFlag(args, 'max')
  });

  if (boolFlag(args, 'json')) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }

  for (const test of result.tests) {
    note(`  ${green('✓')} ${bold(test.reference)} ${test.name} `
      + dim(`${test.assertionCount} assertion(s)`));
  }
  for (const advisory of result.notes) note(`      ${dim(advisory)}`);

  note('');
  note(`  ${result.testsCreated} test(s) written from ${result.endpointsConsidered} observed endpoint(s)`
    + (result.endpointsSkipped > 0 ? `, ${result.endpointsSkipped} endpoint(s) skipped` : '')
    + ` → ${result.testSuiteName}`);
  note(dim('  Read them before you trust them: they assert what the application was observed to do.'));

  return ExitCode.Success;
}

async function listTests(api: ApiClient, projectId: string, args: ParsedArgs): Promise<number> {
  const rows = await api.get<TestCaseRow[]>(`/api/v1/testcases?projectId=${projectId}&kind=api`);

  if (boolFlag(args, 'json')) { out(JSON.stringify(rows, null, 2)); return ExitCode.Success; }

  if (rows.length === 0) {
    note(dim('No API tests yet. Create some with "aira api-test add --file <path>".'));
    return ExitCode.Success;
  }

  for (const row of rows) {
    note(`  ${row.isEnabled ? ' ' : dim('·')} ${bold(row.reference)} ${row.name}`);
  }
  note('');
  note(`  ${rows.length} API test(s).`);
  return ExitCode.Success;
}

async function runTests(
  api: ApiClient,
  context: { projectId?: string; consoleUrl?: string },
  args: ParsedArgs
): Promise<number> {
  const suiteId = flag(args, 'suite');
  const candidates = await api.get<TestCaseRow[]>(
    `/api/v1/testcases?projectId=${context.projectId}&kind=api`
    + (suiteId ? `&testSuiteId=${suiteId}` : ''));

  const testCaseIds = candidates.filter(row => row.isEnabled).map(row => row.id);
  if (testCaseIds.length === 0) {
    // Not a pass. "There were no tests" and "the tests passed" are different answers, and
    // a pipeline that treats the first as the second is green for the wrong reason.
    note(red('There are no enabled API tests in this project.'));
    note(dim('Create some with "aira api-test add --file <path>".'));
    return ExitCode.ConfigurationError;
  }

  note(`${bold('Running')} ${testCaseIds.length} API test(s)`);

  const started = await api.post<RunSummary>('/api/v1/testruns', {
    projectId: context.projectId,
    testCaseIds,
    name: flag(args, 'name') ?? 'API tests',
    parallelism: intFlag(args, 'parallelism'),
    maxRetries: intFlag(args, 'retries'),
    trigger: 'cicd' satisfies RunTrigger,
    ci: ciContext(args)
  });

  note(`${bold('Run queued')} ${started.name} ${dim(started.id)}`);

  const run = await waitForRun(api, started.id, {
    timeoutMs: (intFlag(args, 'timeout') ?? 1800) * 1000,
    pollMs: (intFlag(args, 'poll') ?? 3) * 1000
  });

  const report = await gatherReport(api, run.id, context.consoleUrl);
  const targets = reportTargets(args);
  if (targets.junit || targets.json || targets.html) {
    note('');
    await writeReports(report, targets);
  }

  printSummary(report.run, report);

  if (!['passed', 'failed', 'completed'].includes(run.status)) {
    note(red(`\nThe run ended as "${run.status}" rather than producing a verdict.`));
    return ExitCode.InfrastructureError;
  }

  return verdictExitCode(report);
}

async function parseDefinitionFile(path: string): Promise<ApiTestDefinitionFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw usage(`Could not read ${path}.`, String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usage(`${path} is not valid JSON.`, String(error));
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw usage(`${path} should contain an object with a "tests" array.`);
  }

  const file = parsed as Partial<ApiTestDefinitionFile>;
  if (!Array.isArray(file.tests) || file.tests.length === 0) {
    throw usage(`${path} contains no tests.`, 'It needs a "tests" array with at least one entry.');
  }

  for (const [index, test] of file.tests.entries()) {
    if (typeof test?.name !== 'string' || test.name.trim() === '') {
      throw usage(`Test ${index + 1} in ${path} has no name.`);
    }
    if (!Array.isArray(test.steps) || test.steps.length === 0) {
      throw usage(`Test "${test.name}" in ${path} has no requests.`, 'Each test needs a "steps" array.');
    }
  }

  return file as ApiTestDefinitionFile;
}

/**
 * Pulls the individual problems out of a validation failure.
 *
 * The platform answers with a problem document whose `errors.requests` holds one message
 * per thing wrong with the definition. Printing them one per line is the difference between
 * a fixable error and "400 Bad Request".
 */
function problemLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const detail = (error as { details?: Record<string, string[]> } | undefined)?.details;
  const lines = Object.values(detail ?? {}).flat();
  return lines.length > 0 ? lines : [message];
}
