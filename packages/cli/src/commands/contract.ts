import { ApiClient } from '../api.js';
import { boolFlag, flag, flagAll, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';

export const CONTRACT_FLAGS = [
  'project', 'app', 'run', 'discovery', 'endpoint', 'replace', 'note', 'json',
  'fail-on', 'max'
] as const;

export const CONTRACT_HELP = `
${bold('qanxt contract')} — API contract baselines and what has moved since

  ${bold('qanxt contract inventory --app <id>')}
      Every endpoint QA NXT has observed, with whether it has a baseline, how many
      API tests call it, and how many breaking changes are open against it.

  ${bold('qanxt contract baseline --app <id>')}
      Accepts the currently observed shapes as the contract to compare against.
      Use --replace --note "why" to accept a change to an existing baseline.

  ${bold('qanxt contract check --run <id>')}
      Compares the responses a finished run observed against the baselines and
      classifies each difference. Also runs automatically when a run completes.

  ${bold('qanxt contract changes --run <id>')}
      What a run's contract check found, without running it again.

  --app <id>             Application to work on
  --run <id>             A finished test run
  --discovery <id>       A finished discovery run, instead of a test run
  --endpoint <id>        Restrict to one endpoint; repeat for several
  --replace              Replace an existing baseline (requires --note)
  --note <text>          Why the new shape is acceptable
  --fail-on <kind>       breaking (default) | potentially-breaking | none
  --max <n>              Show at most n changes (default 50)
  --json                 Emit the result on stdout as JSON

A difference is classified by what it means for a caller:

  ${red('breaking')}              a field is gone, a type changed, a 200 became a 500
  ${yellow('potentially breaking')}  a field can now be null, or has gained a second type
  ${green('non-breaking')}          a field is new; nobody was reading it

Exit status: 0 nothing above the --fail-on threshold · 2 QUALITY_GATE_FAILURE when
there is · 3 CONFIGURATION_ERROR for a usage or configuration problem.
`;

type ChangeKind = 'breaking' | 'potentiallyBreaking' | 'nonBreaking';

interface ContractChange {
  id: string;
  method: string;
  urlTemplate: string;
  kind: ChangeKind;
  path: string;
  baselineType?: string;
  observedType?: string;
  description: string;
  isAcknowledged: boolean;
}

interface ContractCheckResult {
  testRunId?: string;
  discoveryRunId?: string;
  endpointsObserved: number;
  endpointsWithBaseline: number;
  endpointsWithoutBaseline: number;
  breakingCount: number;
  potentiallyBreakingCount: number;
  nonBreakingCount: number;
  changes: ContractChange[];
  notes: string[];
}

interface InventoryEntry {
  id: string;
  method: string;
  urlTemplate: string;
  timesObserved: number;
  lastStatusCode?: number;
  averageDurationMs: number;
  requiresAuthentication: boolean;
  hasBaseline: boolean;
  baselineVersion?: number;
  testCount: number;
  openBreakingChangeCount: number;
}

interface Inventory {
  applicationName: string;
  endpointCount: number;
  coveredEndpointCount: number;
  baselinedEndpointCount: number;
  endpoints: InventoryEntry[];
}

interface CapturedBaselines {
  captured: number;
  replaced: number;
  skipped: number;
  baselines: Array<{ method: string; urlTemplate: string; version: number; fieldCount: number }>;
  notes: string[];
}

export async function contractCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, CONTRACT_FLAGS);

  const sub = args.positionals[0];
  if (sub !== 'inventory' && sub !== 'baseline' && sub !== 'check' && sub !== 'changes') {
    throw usage(
      sub === undefined ? 'A subcommand is required.' : `"qanxt contract ${sub}" is not a subcommand.`,
      'Use "inventory", "baseline", "check" or "changes".');
  }

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token'),
    projectId: flag(args, 'project')
  });
  const api = new ApiClient(context.apiUrl, context.token);
  const asJson = boolFlag(args, 'json');

  if (sub === 'inventory') return inventory(api, args, asJson);
  if (sub === 'baseline') return baseline(api, args, asJson);
  if (sub === 'check') return check(api, args, asJson);
  return changes(api, args, asJson);
}

async function inventory(api: ApiClient, args: ParsedArgs, asJson: boolean): Promise<number> {
  const applicationId = requireApp(args);
  const result = await api.get<Inventory>(`/api/v1/api-contracts/inventory?applicationId=${applicationId}`);

  if (asJson) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }

  if (result.endpoints.length === 0) {
    note(dim('No API endpoints have been observed for this application yet. Run "qanxt discover" first.'));
    return ExitCode.Success;
  }

  const rows = result.endpoints.map(entry => [
    entry.method,
    entry.urlTemplate,
    String(entry.timesObserved),
    entry.requiresAuthentication ? 'auth' : '—',
    entry.hasBaseline ? `v${entry.baselineVersion}` : dim('none'),
    entry.testCount > 0 ? String(entry.testCount) : red('0'),
    entry.openBreakingChangeCount > 0 ? red(String(entry.openBreakingChangeCount)) : '—'
  ]);

  const headers = ['METHOD', 'ENDPOINT', 'SEEN', 'AUTH', 'BASELINE', 'TESTS', 'BREAKING'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => plain(row[index] ?? '').length)));

  note(bold(headers.map((header, index) => header.padEnd(widths[index]!)).join('  ')));
  for (const row of rows) {
    out(row.map((cell, index) => pad(cell, widths[index]!)).join('  ').trimEnd());
  }

  note('');
  note(`  ${result.endpointCount} endpoint(s) · ${result.coveredEndpointCount} called by an API test `
    + `· ${result.baselinedEndpointCount} with a contract baseline`);

  const uncovered = result.endpointCount - result.coveredEndpointCount;
  if (uncovered > 0) {
    // The gap is the point of the report. Naming it is more useful than a green tick.
    note(yellow(`  ${uncovered} endpoint(s) have no API test. `)
      + dim('Generate some with "qanxt api-test generate --app <id>".'));
  }
  return ExitCode.Success;
}

async function baseline(api: ApiClient, args: ParsedArgs, asJson: boolean): Promise<number> {
  const applicationId = requireApp(args);
  const replace = boolFlag(args, 'replace');
  const noteText = flag(args, 'note');

  if (replace && !noteText) {
    throw usage(
      'Replacing a baseline needs a reason.',
      'Pass --note "why the new shape is acceptable". Accepting a contract change is a '
      + 'decision, and it has to be attributable.');
  }

  const result = await api.post<CapturedBaselines>('/api/v1/api-contracts/baselines', {
    applicationId,
    apiEndpointIds: flagAll(args, 'endpoint'),
    replace,
    note: noteText
  });

  if (asJson) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }

  for (const captured of result.baselines) {
    note(`  ${green('✓')} ${captured.method} ${captured.urlTemplate} `
      + dim(`v${captured.version}, ${captured.fieldCount} field(s)`));
  }
  for (const advisory of result.notes) note(`  ${dim('·')} ${dim(advisory)}`);

  note('');
  note(`  ${result.captured} baseline(s) stored`
    + (result.replaced > 0 ? `, ${result.replaced} replacing an earlier version` : '')
    + (result.skipped > 0 ? `, ${result.skipped} skipped` : '')
    + '.');

  return ExitCode.Success;
}

async function check(api: ApiClient, args: ParsedArgs, asJson: boolean): Promise<number> {
  const runId = flag(args, 'run');
  const discoveryId = flag(args, 'discovery');

  if (!runId && !discoveryId) {
    throw usage('A run is required.', 'Pass --run <test-run-id>, or --discovery <discovery-run-id>.');
  }
  if (runId && discoveryId) {
    throw usage('Pass one of --run or --discovery, not both.');
  }

  const result = await api.post<ContractCheckResult>(
    runId
      ? `/api/v1/api-contracts/check/run/${runId}`
      : `/api/v1/api-contracts/check/discovery/${discoveryId}`);

  return report(result, args, asJson);
}

async function changes(api: ApiClient, args: ParsedArgs, asJson: boolean): Promise<number> {
  const runId = flag(args, 'run');
  if (!runId) throw usage('A run is required.', 'Pass --run <test-run-id>.');

  const result = await api.get<ContractCheckResult>(`/api/v1/api-contracts/changes/run/${runId}`);
  return report(result, args, asJson);
}

/**
 * Prints a check result and decides what it means for a pipeline.
 *
 * `--fail-on` exists because the right threshold is a team's decision, not the tool's. A
 * team adopting contract checking on an API that moves every week starts at `breaking`; one
 * with published clients sets `potentially-breaking` and means it.
 */
function report(result: ContractCheckResult, args: ParsedArgs, asJson: boolean): number {
  if (asJson) { out(JSON.stringify(result, null, 2)); return verdict(result, args); }

  const max = intFlag(args, 'max') ?? 50;
  const ordered = [...result.changes].sort((a, b) => rank(b.kind) - rank(a.kind));

  for (const change of ordered.slice(0, max)) {
    const label = change.kind === 'breaking' ? red('breaking')
      : change.kind === 'potentiallyBreaking' ? yellow('potentially breaking')
        : green('non-breaking');
    const acknowledged = change.isAcknowledged ? dim(' (acknowledged)') : '';
    note(`  ${label}${acknowledged} ${bold(`${change.method} ${change.urlTemplate}`)}`);
    note(`      ${change.path}: ${change.description}`);
  }

  if (ordered.length > max) note(dim(`  … and ${ordered.length - max} more.`));

  for (const advisory of result.notes) note(`  ${dim('·')} ${dim(advisory)}`);

  note('');
  note(`  ${result.endpointsWithBaseline} endpoint(s) compared`
    + (result.endpointsWithoutBaseline > 0
      ? `, ${result.endpointsWithoutBaseline} observed with no baseline`
      : '')
    + `: ${result.breakingCount} breaking, ${result.potentiallyBreakingCount} potentially breaking, `
    + `${result.nonBreakingCount} non-breaking.`);

  return verdict(result, args);
}

function verdict(result: ContractCheckResult, args: ParsedArgs): number {
  const threshold = flag(args, 'fail-on') ?? 'breaking';
  if (threshold === 'none') return ExitCode.Success;

  const unacknowledged = result.changes.filter(change => !change.isAcknowledged);
  const breaking = unacknowledged.filter(change => change.kind === 'breaking').length;
  const potential = unacknowledged.filter(change => change.kind === 'potentiallyBreaking').length;

  if (threshold === 'breaking') {
    return breaking > 0 ? ExitCode.QualityGateFailure : ExitCode.Success;
  }
  if (threshold === 'potentially-breaking') {
    return breaking + potential > 0 ? ExitCode.QualityGateFailure : ExitCode.Success;
  }

  throw usage(
    `--fail-on expects breaking, potentially-breaking or none, got "${threshold}".`);
}

function requireApp(args: ParsedArgs): string {
  const applicationId = flag(args, 'app');
  if (!applicationId) {
    throw usage('An application is required.', 'Pass --app <id>. "qanxt apps" lists them.');
  }
  return applicationId;
}

const rank = (kind: ChangeKind): number =>
  kind === 'breaking' ? 3 : kind === 'potentiallyBreaking' ? 2 : 1;

/** Column widths have to be measured on the text, not on the text plus its colour codes. */
const plain = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, '');
const pad = (value: string, width: number): string =>
  value + ' '.repeat(Math.max(0, width - plain(value).length));
